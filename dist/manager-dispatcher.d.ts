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
import type { KnownSecrets } from "./redact.js";
/** The trusted-host environment keys forwarded to the CLI (never secrets). */
export declare const MANAGER_ENV_ALLOWLIST: readonly string[];
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
    readonly retract?: (threadId: string, receipt: string, signal: AbortSignal) => Promise<{
        deleted: boolean;
    }>;
    /** Manager CLI executable: an absolute path or a bare name on PATH. */
    readonly executable: string;
    /** Base argv before the fixed `queue` subcommand; default `["queue"]`. */
    readonly baseArgs?: readonly string[];
    readonly timeoutMs?: number;
    readonly knownSecrets?: KnownSecrets;
    /** Test seam: inject a runner instead of `execFile`. */
    readonly exec?: (file: string, args: readonly string[], options: {
        env: Record<string, string>;
        timeout: number;
        signal?: AbortSignal;
    }) => Promise<{
        stdout: string;
        stderr: string;
        code: number;
    }>;
}
/** Build the child env from the allowlist, reading only from `process.env`. */
export declare function buildManagerEnv(source?: NodeJS.ProcessEnv): Record<string, string>;
/**
 * Parse the documented success receipt. The CLI prints
 * `Queued message <UUID> for thread <UUID>.` on success; we extract the message
 * id. A trusted exit code of 0 is itself a valid receipt when no id is printed.
 */
export declare function parseQueueReceipt(stdout: string, code: number): {
    receipt: string | null;
    ok: boolean;
};
/** Drives `codex queue` for manager wakes. Tracks in-flight children for stop. */
export declare class ManagerDispatcher {
    private readonly executable;
    private readonly baseArgs;
    private readonly timeoutMs;
    private readonly knownSecrets;
    private readonly exec;
    /** In-flight dispatches, so {@link stop} can abort AND join them. */
    private readonly inFlight;
    /** Controllers for currently-running children; aborted on stop(). */
    private readonly controllers;
    private stopped;
    private readonly retractImpl;
    constructor(options: ManagerDispatcherOptions);
    /** True once {@link stop} has run; no new dispatch is accepted afterwards. */
    get isStopped(): boolean;
    retract(threadId: string, receipt: string): Promise<{
        ok: boolean;
        deleted: boolean;
        error: string | null;
    }>;
    /** Dispatch one wake to a manager thread. The message text is the prompt. */
    dispatch(threadId: string, message: string): Promise<DispatchResult>;
    /**
     * Abort every in-flight child AND JOIN them before returning, so the caller
     * can safely close the metadata store afterwards. No unhandled rejections:
     * dispatch never rejects (aborts are turned into a result), so joining the
     * tracked promises is safe.
     */
    stop(): Promise<void>;
    private redact;
}
/**
 * Backoff for the Nth retry attempt (1-based). Exponential with a cap; the
 * jitter keeps concurrent projects from stampeding the CLI in lockstep.
 */
export declare function retryBackoffMs(attempt: number, baseMs?: number, capMs?: number): number;
//# sourceMappingURL=manager-dispatcher.d.ts.map