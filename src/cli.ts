import { connectWorkflow } from './cli-connect.js';
/**
 * CLI entry point: `runCli(argv)` parses, dispatches, and returns an exit code.
 *
 * Output contract: stdout is data, stderr is diagnostics. With `--json`, stdout
 * is a single envelope `{ ok, result }` or `{ ok:false, error:{ code, message } }`
 * and never contains a raw stack trace or credential.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs, resolveConfigPath, CliUsageError } from "./cli-args.js";
import { mapCommandToMethod, isNamespaceCommand, readParamsFile, collectParams, parseTimeoutMs } from "./cli-rpc.js";
import { startDaemon, stopDaemon, statusDaemon, doctorReport } from "./cli-daemon.js";
import { errorEnvelope, okEnvelope, serializeEnvelope } from "./cli-status.js";
import { runSetupCommand, defaultSetupDeps } from "./cli-setup.js";
import { runCheckCommand } from "./cli-check.js";
import { BETA_VERSION } from "./setup.js";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.js";
import { buildModalModel, MODAL_PROVIDER_ID, configuredProviderId } from "./provider.js";
import { PiClient } from "./client.js";
import { redactError } from "./redact.js";
import { resolveSocketPath } from "./service.js";
import { serveMain } from "./service.js";
import { watchActivity, startLiveConsole } from "./live-console.js";
import { runRuntimeGuard } from "./runtime-guard.js";

const HELP = [
  "pi-durable — scriptable client for the local durable manager",
  "",
  "Usage:",
  "  pi-durable connect --path PATH --objective-file FILE --roadmap-file FILE --request-id ID [--thread-id UUID]",
  "  pi-durable connect --workflow-id ID    Reconnect an existing task and its live terminal",
  "  pi-durable setup [--endpoint URL --model ID --credential-env NAME] [--json]",
  "  pi-durable watch [--after N] [--project-id ID] [--once] [--json]   Read-only live terminal journal",
  "  pi-durable console [--port N] [--project-id ID]                 Read-only loopback live console",
  "  pi-durable guard --thread-id UUID                             Independent code-only daemon guard",
  "  pi-durable check [--offline] [--json]      End-to-end health check (offline fixture by default)",
  "  pi-durable check --online --thread-id UUID   Real endpoint check; records a wake receipt",
  "  pi-durable service start   [--config PATH] [--json]",
  "  pi-durable service stop    [--config PATH] [--json]",
  "  pi-durable service status  [--config PATH] [--json]",
  "  pi-durable service doctor  [--config PATH] [--json]",
  "  pi-durable config check <path> [--json]",
  "  pi-durable serve --config PATH [--socket PATH]   Run the service in the foreground",
  "  pi-durable call <method> [--params-file FILE|-] [--request-id ID] [--config PATH] [--json]",
  "  pi-durable <project|session|assignment|manager> <action> [args...] [--params-file FILE] [--json]",
  "  pi-durable --help",
  "",
  "Global flags:",
  "  --config PATH   Config file (else $PI_DURABLE_CONFIG, else ~/.config/pi-durable-manager/config.json)",
  "  --json          Emit one versioned JSON envelope on stdout",
  "",
  "Run `pi-durable setup --help` or `pi-durable check --help` for their options.",
  "",
].join("\n");

/**
 * Rebuild the `serve` argv that {@link serveMain} expects from parsed flags.
 * `parseArgs` consumes `--config/--socket` into the flag map, so the foreground
 * service would otherwise start with no config and exit immediately.
 */
export function buildServeArgs(flags: ReadonlyMap<string, string>): string[] {
  const args: string[] = ["--config", resolveConfigPath(flags)];
  const socket = flags.get("socket");
  if (socket !== undefined && socket.length > 0) args.push("--socket", socket);
  return args;
}

/** The help payload shared by text and `--json` output. */
export function helpEnvelope(): { ok: true; result: { help: string } } {
  return okEnvelope({ help: HELP }) as { ok: true; result: { help: string } };
}

/** Write a human or JSON result. `json` selects the envelope form. */
function emit(json: boolean, envelope: Record<string, unknown>): void {
  if (json) process.stdout.write(serializeEnvelope(envelope as { ok: boolean }));
}

/**
 * Emit help. With `--json` this is a single, valid JSON envelope (the raw help
 * text is embedded as a field) so a `--help --json` invocation still parses as
 * JSON and never emits bare text on stdout.
 */
function emitHelp(json: boolean): void {
  if (json) emit(true, helpEnvelope());
  else process.stdout.write(HELP);
}

/** Build a single line reader over stdin, reusable for the whole session. */
function makeLineReader(promptOut: NodeJS.WritableStream = process.stdout): {
  ask: (q: string) => Promise<string>;
  close: () => void;
} {
  const rl = createInterface({ input: process.stdin, output: promptOut, terminal: process.stdin.isTTY === true });
  // Buffer every line as it arrives so piped input (all lines at once) is not
  // dropped when it precedes the corresponding question.
  const pending: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(line);
    else pending.push(line);
  });
  rl.on("close", () => {
    closed = true;
    // Resolve outstanding questions with an empty line so the flow fails fast
    // instead of hanging when input is exhausted.
    while (waiters.length > 0) waiters.shift()!("");
  });
  return {
    ask: (question: string) => {
      promptOut.write(question);
      if (pending.length > 0) return Promise.resolve(pending.shift() as string);
      if (closed) return Promise.resolve("");
      return new Promise((resolvePromise) => waiters.push(resolvePromise));
    },
    close: () => rl.close(),
  };
}

/** Resolve config + socket, reading the config file. */
async function resolveContext(flags: ReadonlyMap<string, string>) {
  const configPath = resolveConfigPath(flags);
  const config = await loadConfig(configPath);
  const override = flags.get("socket");
  const socketPath = resolveSocketPath(config.paths.stateDir, override);
  return { configPath, config, socketPath };
}

const SERVICE_ACTIONS = new Set(["start", "stop", "status", "doctor", "version"]);

/** Handle `service <action>`. */
async function runService(
  action: string,
  flags: ReadonlyMap<string, string>,
  json: boolean,
): Promise<number> {
  if (!SERVICE_ACTIONS.has(action)) {
    throw new CliUsageError("unknown_action", `Unknown service action: ${action}`, 2);
  }
  if (action === "version") {
    // Report the service version. Reads the config if present (to echo which
    // config the service would use) but is read-only and never fails on a
    // missing config — a version query must always answer.
    const configPath = resolveConfigPath(flags);
    let configured = false;
    try {
      await loadConfig(configPath);
      configured = true;
    } catch {
      configured = false;
    }
    const result = { version: BETA_VERSION, configPath, configured };
    if (json) emit(true, { ok: true, result });
    else process.stdout.write(`pi-durable service ${BETA_VERSION}\n`);
    return 0;
  }
  if (action === "doctor") {
    // Doctor is read-only and must work even when config is absent/unreadable,
    // but an INVALID config must flip the verdict to ok:false / exit 1.
    const configPath = resolveConfigPath(flags);
    let socketPath = "";
    let configOk = true;
    let configError: string | undefined;
    try {
      const config = await loadConfig(configPath);
      socketPath = resolveSocketPath(config.paths.stateDir, flags.get("socket"));
    } catch (error) {
      configOk = false;
      configError = redactError(error).message;
    }
    const report = doctorReport(socketPath, configPath);
    const ok = report.ok === true && configOk;
    const result = { ...report, ok, configOk, configError };
    if (json) emit(true, { ok, result });
    else process.stdout.write(`node ${report.node} (ok=${report.nodeOk}) configOk=${configOk} platform=${report.platform}\n`);
    return ok ? 0 : 1;
  }

  const { configPath, config, socketPath } = await resolveContext(flags);
  const binPath = resolve(process.argv[1] ?? fileURLToPath(import.meta.url));

  if (action === "start") {
    const result = await startDaemon({ binPath, configPath, socketPath, stateDir: config.paths.stateDir });
    if (json) emit(true, { ok: result.ok, result });
    else process.stdout.write(result.ok ? `service started (socket ${socketPath})\n` : `service failed: ${result.message}\n`);
    return result.ok ? 0 : 1;
  }
  if (action === "stop") {
    const result = await stopDaemon(socketPath);
    if (json) emit(true, { ok: result.ok, result });
    else process.stdout.write(result.ok ? "service stopped\n" : `service stop failed: ${result.message}\n`);
    return result.ok ? 0 : 1;
  }
  if (action === "status") {
    const result = await statusDaemon(socketPath);
    // Propagate the real verdict: a stale socket, permission error, or protocol
    // failure is NOT success and must exit non-zero with ok:false.
    const ok = result.ok === true;
    if (json) emit(true, { ok, result });
    else process.stdout.write(`${result.running ? "running" : "stopped"}${result.code ? ` (${result.code})` : ""} (socket ${socketPath})\n`);
    return ok ? 0 : 1;
  }
  // Unreachable: SERVICE_ACTIONS is validated at entry.
  throw new CliUsageError("unknown_action", `Unknown service action: ${action}`, 2);
}

/** Handle `config check <path>`. */
async function runConfigCheck(path: string, json: boolean): Promise<number> {
  const config = await loadConfig(path);
  const model = buildModalModel(config);
  const summary = {
    ok: true,
    providerId: configuredProviderId(config),
    model: model.id,
    endpoint: config.endpoint,
    contextWindow: config.limits.contextWindow,
    maxTokens: config.limits.maxTokens,
    credential: config.credential.none ? "none" : config.credential.apiKeyFile ? "apiKeyFile" : "env",
  };
  if (json) emit(true, { ok: true, result: summary });
  else process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

/**
 * Resolve the client call timeout (and the forwarded server wait) for a method.
 *
 * `--timeout-ms` maps to the CLIENT wait for every method. For
 * `assignments.wait` it is ALSO forwarded to the server as `params.timeoutMs`,
 * and the client waits `requested + 5s` (capped at 65s) so the server — which
 * caps waits at 60s — always replies before the client gives up. When the wait
 * bound came from a `--params-file` rather than the flag, the client still
 * waits longer than the requested `params.timeoutMs`.
 */
export function resolveWaitTimeouts(
  method: string,
  params: Record<string, unknown>,
  requestedMs: number | undefined,
): { clientTimeoutMs: number | undefined } {
  if (method !== "assignments.wait") return { clientTimeoutMs: requestedMs };
  if (requestedMs !== undefined) {
    params.timeoutMs = requestedMs;
    return { clientTimeoutMs: Math.min(requestedMs + 5_000, 65_000) };
  }
  const fromParams = Number(params.timeoutMs);
  if (Number.isFinite(fromParams) && fromParams > 0) {
    return { clientTimeoutMs: Math.min(fromParams + 5_000, 65_000) };
  }
  return { clientTimeoutMs: 65_000 };
}

/** Handle a generic `call` or a namespace helper. */
async function runRpc(
  method: string,
  flags: ReadonlyMap<string, string>,
  json: boolean,
  positionals: readonly string[],
  booleans: ReadonlySet<string> = new Set<string>(),
  booleanValues?: ReadonlyMap<string, boolean>,
): Promise<number> {
  // Parse/validate params BEFORE touching config so a malformed params file is a
  // usage error independent of config availability.
  const paramsPath = flags.get("params-file");
  let base: Record<string, unknown> = {};
  if (paramsPath !== undefined) {
    base = await readParamsFile(paramsPath, async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    });
  }
  // collectParams rejects unknown flags, reads task/criteria/content files, and
  // folds in common param flags + positional id.
  const params = await collectParams(flags, positionals, base, booleans, booleanValues);

  // The manager's bind TARGET is the CALLER's current Codex session, which is
  // exactly the CLI process's own CODEX_THREAD_ID — NOT the service's (the
  // service runs under the daemon's thread). Inject it here so `manager.bind`
  // never needs a server-side env fallback. A direct SDK caller must pass an
  // explicit threadId instead.
  if (method === "manager.bind" && params.threadId === undefined) {
    const callerThread = process.env.CODEX_THREAD_ID;
    if (typeof callerThread === "string" && callerThread.length > 0) params.threadId = callerThread;
  }

  // Client timeout: honour --timeout-ms. For `assignments.wait`, `--timeout-ms`
  // is BOTH the server-side wait bound (forwarded as `params.timeoutMs`) and the
  // client bound, which must exceed it (requested + 5s) so the server's reply
  // wins the race; the client is capped at 65s (the server caps waits at 60s).
  const requestedTimeout = parseTimeoutMs(flags, 65_000);
  const resolved = resolveWaitTimeouts(method, params, requestedTimeout);
  const timeoutMs = resolved.clientTimeoutMs;

  const { socketPath } = await resolveContext(flags);
  const requestId = flags.get("request-id");
  const client = await PiClient.connect({ socketPath, timeoutMs });
  try {
    const result = await client.call(method, params, requestId);
    // A restore that partially failed (some paths conflicted/errored) must NOT
    // be reported as a clean success: exit non-zero and flip the envelope to
    // `ok:false` so a script cannot mistake it for a complete restore.
    const partial = method === "assignments.restore"
      && result !== null
      && typeof result === "object"
      && (result as { ok?: unknown }).ok === false;
    if (json) emit(true, { ok: !partial, result });
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return partial ? 1 : 0;
  } finally {
    client.close();
  }
}

/** Top-level dispatch. Returns a process exit code. */
export async function runCli(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");
  try {
    // Top-level version query: `--version`, `-V`, or the `version` command.
    // Answered with exit 0 and never requires a config.
    if (
      argv.includes("--version") ||
      argv.includes("-V") ||
      argv.find((a) => !a.startsWith("-")) === "version"
    ) {
      if (json) {
        process.stdout.write(serializeEnvelope(okEnvelope({ version: BETA_VERSION, name: "pi-durable-manager" })));
      } else {
        process.stdout.write(`pi-durable-manager ${BETA_VERSION}\n`);
      }
      return 0;
    }
    // `setup` and `check` own their own, flag-value-aware parsers (e.g. bare
    // `--offline`), so dispatch them from RAW argv before the generic parser
    // runs. Otherwise the generic parser mistakes `--offline` for a value flag.
    const rawHead = argv.find((a) => !a.startsWith("-"));
    if (rawHead === "setup") {
      const json = argv.includes("--json");
      const reader = makeLineReader(json ? process.stderr : process.stdout);
      try {
        return await runSetupCommand(argv, {
          deps: defaultSetupDeps(),
          isTty: process.stdin.isTTY === true,
          forceInteractive: process.env.PI_DURABLE_SETUP_INTERACTIVE === "1",
          prompt: reader.ask,
        });
      } finally {
        reader.close();
      }
    }
    if (rawHead === "check") {
      return await runCheckCommand(argv);
    }
    const parsed = parseArgs(argv);
    const [head, ...rest] = parsed.command;
    if (head === undefined || parsed.booleans.has("help")) {
      emitHelp(json);
      return 0;
    }
    if (head === "connect") { const result = await connectWorkflow(argv); process.stdout.write(json ? serializeEnvelope(okEnvelope(result)) : JSON.stringify(result,null,2)+"\n"); return 0; }
    if (head === "watch" || head === "console" || head === "guard") {
      const controller = new AbortController();
      const stop = (): void => { controller.abort(); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        if (head === "guard") {
          const threadId = parsed.flags.get("thread-id");
          if (!threadId) throw new CliUsageError("missing_thread", "Guard requires an explicit --thread-id for an existing manager chat.");
          await runRuntimeGuard({ configPath: resolveConfigPath(parsed.flags),
            binPath: fileURLToPath(new URL("../bin/pi-durable.js", import.meta.url)), threadId, signal: controller.signal,
            ...(parsed.flags.has("interval-ms") ? { intervalMs: Number(parsed.flags.get("interval-ms")) } : {}),
            ...(parsed.flags.has("alert-after-ms") ? { alertAfterMs: Number(parsed.flags.get("alert-after-ms")) } : {}) });
        } else if (head === "watch") {
          const after = Number(parsed.flags.get("after") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new CliUsageError("invalid_cursor", "after must be a non-negative integer.");
          await watchActivity(resolveConfigPath(parsed.flags), { after, projectId: parsed.flags.get("project-id"), once: parsed.booleans.has("once"), json, signal: controller.signal });
        } else {
          const port = Number(parsed.flags.get("port") ?? 0);
          if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliUsageError("invalid_port", "Invalid loopback port.");
          const app = await startLiveConsole(resolveConfigPath(parsed.flags), { port, projectId: parsed.flags.get("project-id") });
          process.stdout.write(JSON.stringify({ url: app.url, readOnly: true }) + "\n");
          await new Promise<void>(resolve => { controller.signal.addEventListener("abort", () => { app.server.closeAllConnections(); app.server.close(() => resolve()); }, { once: true }); });
        }
        return 0;
      } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    }
    if (head === "service") {
      const action = rest[0];
      if (action === undefined) throw new CliUsageError("no_action", "Missing service action.", 2);
      return await runService(action, parsed.flags, json);
    }
    if (head === "serve") {
      // Foreground service run; used directly and by `service start`'s detached child.
      // serveMain parses `--config/--socket` from its OWN argv, but parseArgs has
      // already consumed those flags — reconstruct them explicitly.
      return await serveMain(buildServeArgs(parsed.flags));
    }
    if (head === "config") {
      if (rest[0] !== "check") throw new CliUsageError("unknown_action", "Usage: config check <path>", 2);
      const path = rest[1] ?? parsed.positionals[0];
      if (path === undefined) throw new CliUsageError("no_path", "config check requires a path.", 2);
      return await runConfigCheck(path, json);
    }
    if (head === "call") {
      const method = rest[0] ?? parsed.positionals[0];
      if (method === undefined) throw new CliUsageError("no_method", "call requires a method name.", 2);
      const extra = rest.length > 0 ? parsed.positionals : parsed.positionals.slice(1);
      return await runRpc(method, parsed.flags, json, extra, parsed.booleans, parsed.booleanValues);
    }
    if (isNamespaceCommand(parsed.command)) {
      const method = mapCommandToMethod(parsed.command);
      return await runRpc(method, parsed.flags, json, parsed.positionals, parsed.booleans, parsed.booleanValues);
    }
    // A two-token command with an unknown namespace should report the namespace
    // problem, not a generic unknown command.
    if (parsed.command.length === 2) {
      mapCommandToMethod(parsed.command); // throws unknown_namespace
    }
    throw new CliUsageError("unknown_command", `Unknown command: ${head}`, 2);
  } catch (error) {
    if (error instanceof CliUsageError) {
      if (json) process.stdout.write(serializeEnvelope(errorEnvelope(error.code, error.message)));
      else process.stderr.write(`error: ${error.message}\n`);
      return error.exitCode;
    }
    const redacted = redactError(error);
    if (json) process.stdout.write(serializeEnvelope(errorEnvelope("internal", redacted.message)));
    else process.stderr.write(`error: ${redacted.message}\n`);
    return 1;
  }
}
