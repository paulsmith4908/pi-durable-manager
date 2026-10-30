/**
 * Codex CLI dispatcher for manager wakes.
 *
 * Runs OUTSIDE any LLM/provider loop: it spawns the documented Codex CLI
 * (`codex queue --thread <UUID> --message <TEXT>`) with an ARGV ARRAY (never a
 * shell), under a minimal trusted-host environment allowlist. It NEVER passes a
 * model API key or provider secret to the child, and it never bootstraps or
 * restarts a Codex daemon.
 *
 * The dispatcher is honest about delivery: a missing CLI, a non-zero exit, or a
 * timeout is surfaced as a failure (with bounded, redacted diagnostics) — it
 * never pretends success. Because a kill/timeout can land after the CLI already
 * queued the message, delivery is AT-LEAST-ONCE; the manager's ack + the durable
 * event ids prevent duplicated work. There is no exactly-once claim.
 */

import { execFile } from "node:child_process";
import type { KnownSecrets } from "./redact.js";
import { redactString } from "./redact.js";
import { deleteCodexQueuedMessage } from './codex-queue.js';

/** The trusted-host environment keys forwarded to the CLI (never secrets). */
export const MANAGER_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  // CODEX_HOME is a PATH to a user's Codex config dir (portable custom home),
  // NOT a credential; forwarding it lets a non-default install resolve its
  // thread store. No token/secret value is ever forwarded.
  "CODEX_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
  "SystemRoot",
  "USERPROFILE",
  "TERM",
];

/** Result of one CLI dispatch attempt. */
export interface DispatchResult {
  readonly ok: boolean;
  /** Parsed queue receipt (message id) on success, else null. */
  readonly receipt: string | null;
  /** Bounded, redacted diagnostic on failure, else null. */
  readonly error: string | null;
  /** True when the failure is permanent (missing binary) — do not retry fast. */
  readonly permanent: boolean;
}

export interface ManagerDispatcherOptions {
  /** Test/alternate CLI seam. Production uses the generated Codex queue API. */
  readonly retract?: (threadId:string,receipt:string,signal:AbortSignal)=>Promise<{deleted:boolean}>;
  /** Manager CLI executable: an absolute path or a bare name on PATH. */
  readonly executable: string;
  /** Base argv before the fixed `queue` subcommand; default `["queue"]`. */
  readonly baseArgs?: readonly string[];
  readonly timeoutMs?: number;
  readonly knownSecrets?: KnownSecrets;
  /** Test seam: inject a runner instead of `execFile`. */
  readonly exec?: (
    file: string,
    args: readonly string[],
    options: { env: Record<string, string>; timeout: number; signal?: AbortSignal },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

/** Build the child env from the allowlist, reading only from `process.env`. */
export function buildManagerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MANAGER_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

/**
 * Parse the documented success receipt. The CLI prints
 * `Queued message <UUID> for thread <UUID>.` on success; we extract the message
 * id. A trusted exit code of 0 is itself a valid receipt when no id is printed.
 */
export function parseQueueReceipt(stdout: string, code: number): { receipt: string | null; ok: boolean } {
  if (code !== 0) return { receipt: null, ok: false };
  const match = /Queued\s+message\s+(\S+)/i.exec(stdout);
  if (match !== null && match[1] !== undefined) return { receipt: match[1], ok: true };
  return { receipt: null, ok: true };
}

/** Default runner using `execFile` (no shell) with a bounded timeout. */
function defaultExec(
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeout: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        env: options.env,
        timeout: options.timeout,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: number | string; name?: string };
        // An abort surfaces as AbortError; keep it distinct so the caller never
        // treats a deliberate shutdown as a normal CLI failure.
        if (err.name === "AbortError") {
          reject(err);
          return;
        }
        const numeric = typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? err.message ?? ""), code: numeric });
      },
    );
  });
}

/** Drives `codex queue` for manager wakes. Tracks in-flight children for stop. */
export class ManagerDispatcher {
  private readonly executable: string;
  private readonly baseArgs: readonly string[];
  private readonly timeoutMs: number;
  private readonly knownSecrets: KnownSecrets | undefined;
  private readonly exec: NonNullable<ManagerDispatcherOptions["exec"]>;
  /** In-flight dispatches, so {@link stop} can abort AND join them. */
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Controllers for currently-running children; aborted on stop(). */
  private readonly controllers = new Set<AbortController>();
  private stopped = false;
  private readonly retractImpl: ManagerDispatcherOptions['retract'];

  constructor(options: ManagerDispatcherOptions) {
    this.executable = options.executable;
    this.baseArgs = options.baseArgs ?? ["queue"];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.knownSecrets = options.knownSecrets;
    this.exec = options.exec ?? defaultExec;
    // Custom dispatch executables are fixture/alternate transports; don't
    // accidentally invoke the host Codex API for their synthetic receipts.
    this.retractImpl = options.retract ?? (!options.exec && (!options.baseArgs || options.baseArgs.length===1 && options.baseArgs[0]==='queue') ?
      ((thread,receipt,signal)=>deleteCodexQueuedMessage(this.executable,buildManagerEnv(),thread,receipt,this.timeoutMs,signal)) : undefined);
  }

  /** True once {@link stop} has run; no new dispatch is accepted afterwards. */
  get isStopped(): boolean {
    return this.stopped;
  }

  async retract(threadId:string,receipt:string):Promise<{ok:boolean,deleted:boolean,error:string|null}> {
    if(this.stopped||!this.retractImpl)return {ok:false,deleted:false,error:'Queue cleanup unavailable for this transport'};
    const controller=new AbortController();this.controllers.add(controller);
    const op=(async()=>{
      try{return {ok:true,...await this.retractImpl!(threadId,receipt,controller.signal),error:null};}
      catch(e){return {ok:false,deleted:false,error:this.redact(String((e as Error).message).slice(0,500))};}
      finally{this.controllers.delete(controller);}
    })();
    this.inFlight.add(op);try{return await op;}finally{this.inFlight.delete(op);}
  }

  /** Dispatch one wake to a manager thread. The message text is the prompt. */
  async dispatch(threadId: string, message: string): Promise<DispatchResult> {
    if (this.stopped) {
      return { ok: false, receipt: null, error: "dispatcher stopped", permanent: true };
    }
    const args = [...this.baseArgs, "--thread", threadId, "--message", message];
    const env = buildManagerEnv();
    const controller = new AbortController();
    this.controllers.add(controller);
    const op = (async (): Promise<DispatchResult> => {
      try {
        const result = await this.exec(this.executable, args, {
          env,
          timeout: this.timeoutMs,
          signal: controller.signal,
        });
        const parsed = parseQueueReceipt(result.stdout, result.code);
        if (parsed.ok) return { ok: true, receipt: parsed.receipt, error: null, permanent: false };
        const diagnostic = result.stderr.trim() !== "" ? result.stderr : result.stdout;
        return {
          ok: false,
          receipt: null,
          error: this.redact(`codex queue exited ${result.code}: ${diagnostic.trim().slice(0, 500)}`),
          permanent: result.code === 127,
        };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.name === "AbortError") {
          return { ok: false, receipt: null, error: "dispatcher stopped during dispatch", permanent: true };
        }
        const permanent = err.code === "ENOENT";
        return {
          ok: false,
          receipt: null,
          error: this.redact(`codex queue failed: ${err.message}`),
          permanent,
        };
      } finally {
        this.controllers.delete(controller);
      }
    })();
    this.inFlight.add(op);
    // Swallow the join tracking only; the caller still receives the result.
    void op.catch(() => undefined).finally(() => this.inFlight.delete(op));
    return op;
  }

  /**
   * Abort every in-flight child AND JOIN them before returning, so the caller
   * can safely close the metadata store afterwards. No unhandled rejections:
   * dispatch never rejects (aborts are turned into a result), so joining the
   * tracked promises is safe.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
    // Join all in-flight dispatches (they resolve, not reject).
    await Promise.allSettled([...this.inFlight]);
  }

  private redact(text: string): string {
    return redactString(text, this.knownSecrets);
  }
}

/**
 * Backoff for the Nth retry attempt (1-based). Exponential with a cap; the
 * jitter keeps concurrent projects from stampeding the CLI in lockstep.
 */
export function retryBackoffMs(attempt: number, baseMs = 2000, capMs = 300_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(1000, exp));
  return Math.min(capMs, exp + jitter);
}
