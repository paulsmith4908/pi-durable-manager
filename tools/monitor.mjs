// tools/monitor.mjs — read-only Pi Durable browser monitor + code-only inactivity escalation.
//
// WHAT THIS IS
//   A standalone, dependency-free (Node ESM builtins only) tool for a HUMAN to
//   open in a browser and watch a single Pi Durable project. It:
//
//     1. Connects to the REAL service over its loopback unix socket using the
//        REAL PiClient (`@earendil-works/pi-durable-manager` client), handshakes,
//        and issues READ-ONLY RPC calls only:
//           projects.show, assignments.list, assignments.show,
//           sessions.tasks, sessions.transcript (bounded),
//           manager.status, manager.events
//        There is NO raw RPC proxy, NO config/key read, and NO mutating call.
//        (See READ_METHODS — the client wrapper refuses any method not on it.)
//
//     2. Serves a loopback-only dashboard (GET/HEAD) that renders untrusted
//        strings via `textContent` (never `innerHTML`) and performs NO external
//        asset loads and NO CORS. The JSON endpoint is scoped to the ONE fixed
//        project passed on the command line.
//
//     3. Optionally, when an assignment shows NO recorded progress for a while,
//        sends a ONE-SHOT `codex queue --thread <UUID> --message <TEXT>` wake to
//        an EXPLICITLY supplied manager thread. This is CODE-ONLY escalation: it
//        NEVER calls a model, never edits the repo, never issues control RPC, and
//        NEVER time-limits or kills the (possibly-legitimate) work it is warning
//        about. Warnings are deduplicated by (assignmentId, lastObservedActivity)
//        in a durable receipts file so the same stall is not re-queued every tick.
//
// WHAT THIS IS NOT
//   - Not a daemon: it is a foreground process you start and Ctrl-C.
//   - Not a controller: it cannot abort/cancel/steer/review anything.
//   - Not authoritative about liveness: "no recorded progress" is NOT proof of a
//     hang. A long-running command may be perfectly legitimate. The dashboard is
//     deliberately honest: it shows FRESH / STALE / UNKNOWN and a last-activity
//     AGE, and never asserts a bare "active".
//
// USAGE
//   node tools/monitor.mjs \
//     --state-dir  /path/to/private/pi-state \
//     --project-id proj-xxxxxxxx \
//     [--client    /abs/path/to/dist/client.js] \
//     [--host      127.0.0.1] \
//     [--port      5180] \
//     [--thread    <EXISTING codex session UUID>] \
//     [--codex     /abs/path/to/codex] \
//     [--idle-warning-ms 900000] \
//     [--receipts-file /path/to/private/receipts.json] \
//     [--interval-ms 4000] \
//     [--once]
//
//   Inactivity warnings are ENABLED only when BOTH --thread and --idle-warning-ms
//   are supplied (--codex defaults to "codex" on PATH). Without them the monitor
//   is a pure read-only dashboard.
//
// This file is intentionally import-safe: importing it exposes the pure helpers
// (arg parsing, redaction, HTML/JSON rendering, dedup logic) for tests and does
// NOT start the server. The server starts only when run as the main module.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The ONLY RPC methods this tool is ever allowed to call. Read-only. */
export const READ_METHODS = Object.freeze([
  "projects.show",
  "assignments.list",
  "assignments.show",
  "sessions.tasks",
  "sessions.transcript",
  "manager.status",
  "manager.events",
]);

/** Loopback hosts we accept for the dashboard bind. Anything else is refused. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Default dashboard refresh cadence for the human (milliseconds). */
export const DEFAULT_INTERVAL_MS = 4_000;

/** Default inactivity warning threshold when warnings are enabled (15 minutes). */
export const DEFAULT_IDLE_WARNING_MS = 15 * 60_000;

/** Hard cap on the codex child wall-clock time so a stuck CLI can't hang us. */
export const WARNING_CHILD_TIMEOUT_MS = 30_000;

/** Ceiling for a single inactivity threshold, to keep the value finite/sane. */
const MAX_IDLE_WARNING_MS = 24 * 60 * 60_000;

/** Redaction marker, kept identical to the service's own redactor. */
export const REDACTED = "[REDACTED]";

/** Bounded sizes so a single assigned payload can never bloat a frame/response. */
export const LIMITS = Object.freeze({
  assignmentList: 200, // most-recent summaries considered per tick
  transcriptEntries: 40, // newest transcript entries requested
  previewChars: 2_000, // per-preview text cap
  commandOutputChars: 4_000, // stdout/stderr tail cap
  events: 50, // manager events listed
  jsonBytes: 512 * 1024, // dashboard JSON endpoint byte cap
});

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Redact obvious secret material from a display string.
 *
 * The service already redacts server-side, but the monitor is defense-in-depth:
 * any value it prints — including ones it composes locally (errors, paths) — is
 * run through this first. Patterns mirror the service redactor's spirit without
 * importing it (this tool must stay dependency-free).
 */
export function redactText(input, extraSecrets = []) {
  if (input === null || input === undefined) return "";
  let text = typeof input === "string" ? input : safeStringify(input);
  for (const secret of extraSecrets) {
    if (typeof secret === "string" && secret.length >= 6) {
      text = text.split(secret).join(REDACTED);
    }
  }
  // OpenAI/Anthropic-ish bearer tokens and generic "key = value" secrets.
  text = text.replace(/\b(sk|ds|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, REDACTED);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, `Bearer ${REDACTED}`);
  text = text.replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, `Basic ${REDACTED}`);
  text = text.replace(
    /\b(api[_-]?key|secret|token|password|passwd|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (_m, name, sep) => `${name}${sep}${REDACTED}`,
  );
  return text;
}

/** JSON.stringify that never throws (cycles, BigInt) and is bounded. */
export function safeStringify(value, maxChars = LIMITS.previewChars) {
  const seen = new WeakSet();
  let out;
  try {
    out = JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      },
      0,
    );
  } catch (error) {
    return `[unserializable: ${String(error && error.message ? error.message : error).slice(0, 200)}]`;
  }
  if (out === undefined) return "";
  return out.length > maxChars ? `${out.slice(0, maxChars)}…[truncated]` : out;
}

/** Keep only the trailing `maxChars` of a string (tail is what usually matters). */
export function tail(text, maxChars) {
  const s = typeof text === "string" ? text : safeStringify(text);
  if (s.length <= maxChars) return s;
  return `…[${s.length - maxChars} earlier chars truncated]…\n${s.slice(s.length - maxChars)}`;
}

/** Parse a CLI flag value as a finite positive integer, or `undefined`. */
export function parsePositiveInt(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * Parse argv (already sliced past `node script`) into monitor options.
 *
 * Returns `{ ok:true, options }` or `{ ok:false, error }`. Unknown flags are a
 * hard error (never silently ignored) so a typo can't quietly disable a guard.
 */
export function parseArgs(argv) {
  const valueFlags = new Map([
    ["--state-dir", "stateDir"],
    ["--project-id", "projectId"],
    ["--client", "clientPath"],
    ["--host", "host"],
    ["--port", "port"],
    ["--thread", "thread"],
    ["--codex", "codexExec"],
    ["--idle-warning-ms", "idleWarningMs"],
    ["--receipts-file", "receiptsFile"],
    ["--interval-ms", "intervalMs"],
  ]);
  const boolFlags = new Map([["--once", "once"]]);

  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string" || arg.length === 0) {
      return { ok: false, error: `empty or non-string argument at position ${i}` };
    }
    if (arg === "-h" || arg === "--help") return { ok: false, error: "help" };
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    if (boolFlags.has(name)) {
      if (inline !== undefined) return { ok: false, error: `${name} takes no value` };
      raw[boolFlags.get(name)] = true;
      continue;
    }
    if (valueFlags.has(name)) {
      const key = valueFlags.get(name);
      let value = inline;
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          return { ok: false, error: `${name} requires a value` };
        }
        i += 1;
      }
      raw[key] = value;
      continue;
    }
    return { ok: false, error: `unknown argument: ${arg}` };
  }

  const options = {
    stateDir: raw.stateDir,
    projectId: raw.projectId,
    clientPath: raw.clientPath,
    host: raw.host ?? "127.0.0.1",
    port: parsePositiveInt(raw.port) ?? 5180,
    thread: raw.thread,
    codexExec: raw.codexExec ?? "codex",
    idleWarningMs: raw.idleWarningMs === undefined ? undefined : parsePositiveInt(raw.idleWarningMs),
    receiptsFile: raw.receiptsFile,
    intervalMs: parsePositiveInt(raw.intervalMs) ?? DEFAULT_INTERVAL_MS,
    once: raw.once === true,
  };

  // Required scoping.
  if (typeof options.stateDir !== "string" || options.stateDir.length === 0) {
    return { ok: false, error: "--state-dir is required" };
  }
  if (typeof options.projectId !== "string" || options.projectId.length === 0) {
    return { ok: false, error: "--project-id is required (scopes every read)" };
  }
  if (!LOOPBACK_HOSTS.has(options.host)) {
    return { ok: false, error: `--host must be loopback (${[...LOOPBACK_HOSTS].join(", ")}); got ${options.host}` };
  }
  if (raw.port !== undefined && parsePositiveInt(raw.port) === undefined) {
    return { ok: false, error: `--port must be a finite positive integer; got ${raw.port}` };
  }
  if (raw.idleWarningMs !== undefined && options.idleWarningMs === undefined) {
    return { ok: false, error: `--idle-warning-ms must be a finite positive integer; got ${raw.idleWarningMs}` };
  }
  if (options.idleWarningMs !== undefined && options.idleWarningMs > MAX_IDLE_WARNING_MS) {
    return { ok: false, error: `--idle-warning-ms must be <= ${MAX_IDLE_WARNING_MS}` };
  }
  if (options.thread !== undefined && typeof options.thread === "string" && options.thread.trim().length === 0) {
    return { ok: false, error: "--thread must not be empty" };
  }

  // Warnings are enabled ONLY when an explicit thread AND threshold are given.
  // --idle-warning-ms without --thread is a contradiction: refuse rather than
  // silently drop the warning the operator asked for.
  options.warningsEnabled = options.thread !== undefined && options.idleWarningMs !== undefined;
  if (raw.idleWarningMs !== undefined && options.thread === undefined) {
    return { ok: false, error: "--idle-warning-ms requires --thread <UUID> (nowhere to send the warning)" };
  }
  if (options.warningsEnabled && options.receiptsFile === undefined) {
    return {
      ok: false,
      error: "--thread with --idle-warning-ms requires --receipts-file (durable dedup is mandatory)",
    };
  }
  // `--thread` alone keeps warnings disabled (no threshold): a valid
  // "dashboard only" mode still scoped to the one project.

  return { ok: true, options };
}

// ---------------------------------------------------------------------------
// Inactivity assessment (pure)
// ---------------------------------------------------------------------------

/**
 * A stable activity watermark for an assignment snapshot.
 *
 * The watermark is the newest of the assignment's own `updatedAt` and any task
 * `updatedAt`/observed timestamp we can see. It MUST change when real progress
 * happens and stay identical while nothing progresses, so dedup is honest.
 */
export function activityWatermark(assignment, tasks) {
  let watermark = 0;
  if (assignment && Number.isFinite(assignment.updatedAt)) watermark = Math.max(watermark, assignment.updatedAt);
  if (Array.isArray(tasks)) {
    for (const t of tasks) {
      if (t && Number.isFinite(t.updatedAt)) watermark = Math.max(watermark, t.updatedAt);
      if (t && Number.isFinite(t.startedAt)) watermark = Math.max(watermark, t.startedAt);
    }
  }
  return watermark;
}

/**
 * Classify an assignment as fresh / stale / unknown relative to `now`.
 *
 * Never returns a bare "active": a running task with no recent timestamp is
 * reported as UNKNOWN, not "alive". `stale` requires a positive age over the
 * threshold AND the absence of a terminal state.
 */
export function classifyActivity({ now, watermark, thresholdMs, terminal }) {
  if (terminal) return { state: "terminal", ageMs: watermark > 0 ? now - watermark : null };
  if (!Number.isFinite(watermark) || watermark <= 0) return { state: "unknown", ageMs: null };
  const ageMs = Math.max(0, now - watermark);
  return { state: ageMs >= thresholdMs ? "stale" : "fresh", ageMs };
}

/**
 * Decide whether a stall warning should be sent for this assignment.
 *
 * Deduplicated by `${assignmentId}:${watermark}` so that a genuinely NEW burst
 * of activity (which advances the watermark) may warn again, while a static
 * stall warns exactly once. Returns `{ warn, reason }`.
 */
export function shouldWarn({ assignment, watermark, receipts, now, thresholdMs, terminal }) {
  if (!assignment || typeof assignment.id !== "string") return { warn: false, reason: "no-assignment" };
  if (terminal) return { warn: false, reason: "terminal" };
  if (!Number.isFinite(watermark) || watermark <= 0) return { warn: false, reason: "unknown-activity" };
  const ageMs = Math.max(0, now - watermark);
  if (ageMs < thresholdMs) return { warn: false, reason: "fresh" };
  const key = `${assignment.id}:${watermark}`;
  if (receipts && Object.prototype.hasOwnProperty.call(receipts, key)) {
    return { warn: false, reason: "already-warned" };
  }
  return { warn: true, reason: "stalled", key, ageMs };
}

/**
 * Reason string for a warning message. Written to be obviously non-definitive:
 * "no recorded progress" is not proof of a hang.
 */
export function buildWarningMessage({ projectId, assignment, ageMs, kind }) {
  const mins = Math.round(ageMs / 60_000);
  const lines = [
    `[pi-durable monitor] No recorded progress for ~${mins} min.`,
  ];
  if (projectId) lines.push(`project: ${projectId}`);
  if (assignment && assignment.id) lines.push(`assignment: ${assignment.id} (state=${assignment.state ?? "unknown"})`);
  if (kind) lines.push(`signal: ${kind}`);
  lines.push(
    "This is NOT proof of a hang: a long-running command may be legitimate.",
    "No execution deadline was applied and no work was aborted by this warning.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Receipts (durable dedup) — read/modify/write with atomic rename
// ---------------------------------------------------------------------------

/** Load the receipts object, tolerating a missing/corrupt file (start empty). */
export function loadReceipts(file) {
  if (typeof file !== "string" || !existsSync(file)) return { version: 1, warned: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.warned && typeof parsed.warned === "object") {
      return { version: typeof parsed.version === "number" ? parsed.version : 1, warned: parsed.warned };
    }
    return { version: 1, warned: {} };
  } catch {
    // A corrupt receipts file must never crash the dashboard; start fresh.
    return { version: 1, warned: {} };
  }
}

/**
 * Record a warning receipt atomically. Returns the persisted record.
 * Failures (e.g. read-only dir) are surfaced, never swallowed as success.
 */
export function recordReceipt(file, key, entry) {
  const receipts = loadReceipts(file);
  receipts.warned[key] = entry;
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(receipts, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return entry;
}

// ---------------------------------------------------------------------------
// Codex escalation (code-only, one-shot, bounded) — never kills/limits work
// ---------------------------------------------------------------------------

/**
 * Environment keys forwarded to the codex child. Mirrors the service's manager
 * dispatcher allowlist: paths and locale only, NEVER a credential value.
 */
export const CODEX_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "CODEX_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
  "SystemRoot",
  "USERPROFILE",
  "TERM",
]);

/** Build the child env from the allowlist, reading only trusted process env. */
export function buildCodexEnv(source = process.env) {
  const env = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/** Parse the documented `codex queue` success receipt. */
export function parseQueueReceipt(stdout, code) {
  if (code !== 0) return { ok: false, receipt: null };
  const match = /Queued\s+message\s+(\S+)/i.exec(String(stdout ?? ""));
  return { ok: true, receipt: match !== null ? match[1] : null };
}

/**
 * Spawn ONE `codex queue --thread <UUID> --message <TEXT>` child.
 *
 * - ARGV array (no shell): the message is a single argv element, not shell text.
 * - Clean env allowlist: no secrets forwarded.
 * - FINITE timeout: the child is killed after WARNING_CHILD_TIMEOUT_MS. This
 *   bounds the WARNING, never the monitored work.
 * - Honest result: a missing CLI (ENOENT) is `permanent`, a non-zero exit or
 *   timeout is a truthful failure. There is NO blind retry: a timeout/ambiguous
 *   outcome is recorded as a failure and NOT re-queued blindly.
 *
 * Test seam: pass `exec` to avoid spawning a real child.
 */
export function runCodexQueue(
  { executable, thread, message, timeoutMs = WARNING_CHILD_TIMEOUT_MS, env },
  exec = defaultExec,
) {
  const args = ["queue", "--thread", thread, "--message", message];
  return exec(executable, args, { env: env ?? buildCodexEnv(), timeout: timeoutMs }).then(
    (result) => {
      const parsed = parseQueueReceipt(result.stdout, result.code);
      if (parsed.ok) return { ok: true, receipt: parsed.receipt, error: null, permanent: false };
      const diagnostic = String(result.stderr || result.stdout || "").trim().slice(0, 500);
      return {
        ok: false,
        receipt: null,
        error: redactText(`codex queue exited ${result.code}: ${diagnostic}`),
        permanent: result.code === 127,
      };
    },
    (error) => {
      const code = error && error.code;
      const permanent = code === "ENOENT" || /timed out|ETIMEDOUT/i.test(String(error && error.message));
      return {
        ok: false,
        receipt: null,
        error: redactText(`codex queue failed: ${error && error.message ? error.message : String(error)}`),
        // A timeout is ambiguous: the CLI may have queued before we killed it.
        // We surface it as a failure and DO NOT retry blindly.
        permanent,
      };
    },
  );
}

function defaultExec(file, args, options) {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { env: options.env, timeout: options.timeout, maxBuffer: 256 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ stdout: String(stdout), stderr: String(stderr), code: 0 });
          return;
        }
        const err = error;
        const numeric = typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1;
        resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? err.message ?? ""), code: numeric });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Truthful view assembly (pure-ish: takes already-fetched RPC results)
// ---------------------------------------------------------------------------

/** Terminal assignment states never warrant a progress warning. */
export const TERMINAL_STATES = new Set([
  "needs_review",
  "failed",
  "unanswered",
  "budget",
  "timeout",
  "cancelled",
  "accepted",
  "revision_requested",
]);

/** Extract the latest command from a real evidence bundle (`evidence.commands`). */
export function latestEvidenceCommand(evidence) {
  if (!evidence || typeof evidence !== "object" || !Array.isArray(evidence.commands) || evidence.commands.length === 0) {
    return null;
  }
  const commands = evidence.commands.slice().sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  const c = commands[commands.length - 1];
  if (!c || typeof c !== "object") return null;
  return {
    entryId: null,
    command: redactText(String(c.command ?? "")).slice(0, LIMITS.previewChars),
    exitCode: typeof c.exitCode === "number" ? c.exitCode : null,
    stdout: c.stdoutTail === null || c.stdoutTail === undefined ? null : tail(redactText(String(c.stdoutTail)), LIMITS.commandOutputChars),
    stderr: c.stderrTail === null || c.stderrTail === undefined ? null : tail(redactText(String(c.stderrTail)), LIMITS.commandOutputChars),
    finished: typeof c.exitCode === "number" || c.timedOut === true,
    timedOut: c.timedOut === true,
    durationMs: Number.isFinite(c.durationMs) ? c.durationMs : null,
    source: "evidence",
  };
}

/** The latest useful assignment in a project: newest non-terminal, else newest. */
export function selectLatestAssignment(assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) return null;
  const withTime = assignments
    .filter((a) => a && typeof a.id === "string")
    .map((a) => ({ a, t: Number.isFinite(a.updatedAt) ? a.updatedAt : Number.isFinite(a.createdAt) ? a.createdAt : 0 }));
  if (withTime.length === 0) return null;
  const live = withTime.filter((x) => !TERMINAL_STATES.has(x.a.state));
  const pool = live.length > 0 ? live : withTime;
  pool.sort((x, y) => y.t - x.t);
  return pool[0].a;
}

/**
 * Extract the latest finished bash/command observation from bounded transcript
 * entries.
 *
 * Real pi-durable transcript entries are framed as
 *   `{ id, kind, model: Message[] | null, data: JsonValue | null }`
 * where each `Message` is one of `{role:"system"|"user"|"assistant", content}`
 * or `{role:"toolResult", toolName, content, isError, timestamp, durationMs}`.
 * Assistant `content[]` blocks are `{type:"text",text}` / `{type:"toolCall",
 * name,arguments}`; toolResult `content[]` blocks are `{type:"text",text}`.
 *
 * We also accept legacy/simple fixtures that put these fields directly on
 * `entry.data` (or the entry itself). Nothing is ever re-parsed by a shell and
 * no string is ever executed — we only read structured fields already present.
 */
export function extractLatestCommand(entries) {
  if (!Array.isArray(entries)) return null;
  const observations = [];
  // toolCall id -> {name, command}; shared ACROSS entries because an assistant
  // toolCall and its toolResult can land in different framed entries.
  const pendingCalls = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    observations.push(...commandsFromEntry(entry, pendingCalls));
  }
  if (observations.length === 0) return null;
  // Prefer the newest *finished* command (has an exit code); otherwise the
  // newest in-flight one (so a running command still shows up, marked not finished).
  const finished = observations.filter((o) => o.exitCode !== undefined && o.exitCode !== null);
  const chosen = (finished.length > 0 ? finished : observations)[
    (finished.length > 0 ? finished : observations).length - 1
  ];
  return {
    entryId: chosen.entryId,
    command: redactText(chosen.command).slice(0, LIMITS.previewChars),
    exitCode: chosen.exitCode,
    stdout: chosen.stdout === undefined || chosen.stdout === null ? null : tail(redactText(chosen.stdout), LIMITS.commandOutputChars),
    stderr: chosen.stderr === undefined || chosen.stderr === null ? null : tail(redactText(chosen.stderr), LIMITS.commandOutputChars),
    finished: chosen.exitCode !== undefined && chosen.exitCode !== null,
    timedOut: chosen.timedOut === true,
    durationMs: Number.isFinite(chosen.durationMs) ? chosen.durationMs : null,
  };
}

/** Walk one framed entry and pull out every command-ish observation. */
function commandsFromEntry(entry, pendingCalls) {
  const entryId = entry.id !== undefined ? String(entry.id) : null;
  const observations = [];
  const calls = pendingCalls instanceof Map ? pendingCalls : new Map();

  // (a) Real pi shape: model is an array of Messages.
  if (Array.isArray(entry.model)) {
    for (const message of entry.model) {
      if (!message || typeof message !== "object") continue;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block && block.type === "toolCall" && typeof block.name === "string") {
            const command = commandFromArguments(block.arguments);
            calls.set(String(block.id), { name: block.name, command });
            observations.push({
              entryId,
              command: command ?? block.name,
              exitCode: undefined,
              stdout: null,
              stderr: null,
            });
          }
        }
      } else if (message.role === "toolResult") {
        const name = typeof message.toolName === "string" ? message.toolName : "";
        const call = calls.get(String(message.toolCallId));
        const command = call && call.command ? call.command : commandFromToolResult(message, name);
        const text = contentText(message.content);
        observations.push({
          entryId,
          command: command ?? name,
          exitCode: undefined,
          stdout: message.isError === true ? null : text,
          stderr: message.isError === true ? text : null,
          isError: message.isError === true,
          durationMs: message.durationMs,
        });
      }
    }
    if (observations.length > 0) return observations;
  }

  // (b) Legacy/simple shape: structured fields on entry.data or the entry itself.
  const data = entry.data && typeof entry.data === "object" ? entry.data : entry;
  const simple = pickSimpleCommand(data);
  if (simple !== null) observations.push({ entryId, ...simple });
  return observations;
}

/** Pull a command string out of a ToolCall `arguments` object, if present. */
function commandFromArguments(args) {
  if (args && typeof args === "object" && typeof args.command === "string") return args.command;
  return null;
}

/** Best-effort command label from a toolResult block when no matching call is seen. */
function commandFromToolResult(message, name) {
  if (message.details && typeof message.details === "object" && typeof message.details.command === "string") {
    return message.details.command;
  }
  return /bash|shell|exec|command/i.test(name) ? name : null;
}

/** Concatenate text blocks from a Message content array. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Legacy/simple command extraction (fields directly on an object). */
function pickSimpleCommand(data) {
  const name = typeof data.name === "string" ? data.name : typeof data.toolName === "string" ? data.toolName : "";
  const input = data.input && typeof data.input === "object" ? data.input : data.arguments;
  const command =
    (input && typeof input.command === "string" && input.command) ||
    (typeof data.command === "string" && data.command) ||
    null;
  const exitCode =
    typeof data.exitCode === "number"
      ? data.exitCode
      : typeof data.exit_code === "number"
        ? data.exit_code
        : undefined;
  const stdout = typeof data.stdout === "string" ? data.stdout : undefined;
  const stderr = typeof data.stderr === "string" ? data.stderr : undefined;
  if (command === null && stdout === undefined && stderr === undefined) return null;
  if (command === null && !/bash|shell|exec|command/i.test(name)) return null;
  return { command: command ?? name, exitCode, stdout, stderr };
}

/** Summarize a raw tasks result into the small shape the dashboard renders. */
export function summarizeTasks(tasksResult) {
  const tasks = tasksResult && Array.isArray(tasksResult.tasks) ? tasksResult.tasks : [];
  const submissions = tasksResult && Array.isArray(tasksResult.submissions) ? tasksResult.submissions : [];
  return {
    scheduling: tasksResult && tasksResult.scheduling !== undefined ? redactText(safeStringify(tasksResult.scheduling)) : null,
    count: tasks.length,
    running: tasks.filter((t) => t && t.state === "running").length,
    tasks: tasks.slice(0, 30).map((t) => ({
      id: redactText(t.id),
      kind: redactText(t.kind),
      state: redactText(t.state),
      status: redactText(t.status),
      abortRequested: t.abortRequested === true,
    })),
    submissions: submissions.slice(0, 30).map((s) => ({
      id: redactText(s.id),
      type: redactText(s.type),
      status: redactText(s.status),
    })),
  };
}

// ---------------------------------------------------------------------------
// HTML rendering (untrusted strings go through textContent) and JSON
// ---------------------------------------------------------------------------

/** Escape for embedding inside a <script type="application/json"> block. */
export function escapeJsonForScript(json) {
  return String(json).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/**
 * The dashboard HTML. Static shell + a small inline poller that fetches
 * `/api/snapshot` and writes every field with `textContent` (never innerHTML).
 * No external assets, no inline JSON injection of data.
 */
export function renderHtml({ title }) {
  const safeTitle = redactText(title || "Pi Durable monitor");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" />
<title>${safeTitle.replace(/[<>&]/g, "")}</title>
<style>
:root { color-scheme: dark; }
body { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 16px; background: #10131a; color: #d7dbe0; }
h1 { font-size: 15px; margin: 0 0 4px; }
.sub { color: #8b94a3; margin-bottom: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
.card { background: #171b24; border: 1px solid #232a36; border-radius: 8px; padding: 10px 12px; }
.card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #8b94a3; margin: 0 0 8px; }
.row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
.k { color: #8b94a3; }
.v { text-align: right; word-break: break-word; }
pre { white-space: pre-wrap; word-break: break-word; background: #0c0f15; padding: 8px; border-radius: 6px; max-height: 260px; overflow: auto; margin: 6px 0 0; }
.badge { padding: 1px 6px; border-radius: 6px; font-size: 11px; }
.fresh { background: #12351f; color: #7fe0a8; }
.stale { background: #3a1d12; color: #ffab7a; }
.unknown, .terminal { background: #26303d; color: #aab6c5; }
.err { color: #ff9c9c; }
.muted { color: #8b94a3; }
</style>
</head>
<body>
<h1 id="title">Pi Durable monitor</h1>
<div class="sub" id="meta"></div>
<div id="status" class="err"></div>
<div class="grid">
  <div class="card"><h2>Project</h2><div id="project"></div></div>
  <div class="card"><h2>Assignment</h2><div id="assignment"></div></div>
  <div class="card"><h2>Activity</h2><div id="activity"></div></div>
  <div class="card"><h2>Tasks</h2><div id="tasks"></div></div>
  <div class="card"><h2>Latest command</h2><div id="command"></div></div>
  <div class="card"><h2>Manager wake health</h2><div id="manager"></div></div>
  <div class="card"><h2>Warnings</h2><div id="warnings"></div></div>
  <div class="card"><h2>Transcript preview</h2><pre id="transcript"></pre></div>
</div>
<script>
"use strict";
function row(parent, k, v) {
  var d = document.createElement("div"); d.className = "row";
  var a = document.createElement("span"); a.className = "k"; a.textContent = k;
  var b = document.createElement("span"); b.className = "v"; b.textContent = v == null ? "-" : String(v);
  d.appendChild(a); d.appendChild(b); parent.appendChild(d);
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function render(snap) {
  document.getElementById("title").textContent = snap.title || "Pi Durable monitor";
  document.getElementById("meta").textContent = "updated " + (snap.generatedAtIso || "-") + " · refresh " + (snap.intervalMs/1000) + "s";
  var statusEl = document.getElementById("status");
  statusEl.textContent = snap.error ? ("ERROR: " + snap.error) : "";
  var project = document.getElementById("project"); clear(project);
  row(project, "id", snap.project && snap.project.id);
  row(project, "name", snap.project && snap.project.name);
  row(project, "path", snap.project && snap.project.path);
  var a = snap.assignment || {};
  var asg = document.getElementById("assignment"); clear(asg);
  row(asg, "id", a.id); row(asg, "state", a.state); row(asg, "attempts", a.attemptCount);
  row(asg, "stopReason", a.stopReason); row(asg, "error", a.error);
  var act = document.getElementById("activity"); clear(act);
  var badge = document.createElement("div");
  var s = (snap.activity && snap.activity.state) || "unknown";
  badge.className = "badge " + s; badge.textContent = s;
  act.appendChild(badge);
  row(act, "last activity age", snap.activity && snap.activity.ageHuman);
  // These counters cover only the bounded recent transcript window — labelled as
  // such so a partial window is never read as a session total.
  row(act, "requests (recent transcript window)", snap.usage && snap.usage.requests);
  row(act, "tokens (recent transcript window)", snap.usage && snap.usage.tokens);
  row(act, "window entries scanned", snap.usage && snap.usage.windowEntries);
  var tk = document.getElementById("tasks"); clear(tk);
  row(tk, "total", snap.tasks && snap.tasks.count); row(tk, "running", snap.tasks && snap.tasks.running);
  row(tk, "scheduling", snap.tasks && snap.tasks.scheduling);
  (snap.tasks && snap.tasks.tasks || []).forEach(function (t) { row(tk, t.kind + " " + t.state, t.id + " " + (t.status||"")); });
  var cmd = document.getElementById("command"); clear(cmd);
  var c = snap.command;
  if (c) { row(cmd, "command", c.command); row(cmd, "exitCode", c.finished ? c.exitCode : "(running)"); }
  var pre = document.createElement("pre"); pre.textContent = c ? ("stdout:" + String.fromCharCode(10) + (c.stdout||"") + String.fromCharCode(10) + "stderr:" + String.fromCharCode(10) + (c.stderr||"")) : "(none)";
  cmd.appendChild(pre);
  var m = document.getElementById("manager"); clear(m);
  row(m, "enabled", snap.manager && snap.manager.enabled);
  row(m, "pending", snap.manager && snap.manager.pending);
  row(m, "parked", snap.manager && snap.manager.parked);
  row(m, "unacked", snap.manager && snap.manager.unacked);
  row(m, "nextAttemptAt", snap.manager && snap.manager.nextAttemptAt);
  (snap.manager && snap.manager.events || []).forEach(function (e) { row(m, e.kind + " " + e.state, e.assignmentId || "");
  });
  var w = document.getElementById("warnings"); clear(w);
  row(w, "warnings enabled", snap.warnings && snap.warnings.enabled);
  row(w, "threshold", snap.warnings && snap.warnings.thresholdHuman);
  (snap.warnings && snap.warnings.log || []).forEach(function (line) { row(w, line.atIso || "", line.text); });
  document.getElementById("transcript").textContent = snap.transcriptPreview || "(no transcript)";
}
var ticking = false;
function tick() {
  if (ticking) return;
  ticking = true;
  fetch("/api/snapshot", { headers: { accept: "application/json" } })
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function (e) {
      var statusEl = document.getElementById("status");
      statusEl.textContent = "ERROR: snapshot fetch failed: " + (e && e.message ? e.message : e);
    })
    .then(function () { ticking = false; }, function () { ticking = false; });
}
tick();
setInterval(tick, ${DEFAULT_INTERVAL_MS});
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The HTTP layer (loopback GET/HEAD only, safe host/origin, no CORS)
// ---------------------------------------------------------------------------

/** True when the Host header is a bare loopback host[:port] we bound to. */
export function isAllowedHostHeader(hostHeader, port) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return false;
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    "127.0.0.1",
    "localhost",
    "[::1]",
  ]);
  return allowed.has(hostHeader.toLowerCase());
}

/** Reject any cross-origin Origin header: this dashboard is same-origin only. */
export function isAllowedOriginHeader(originHeader, port) {
  if (originHeader === undefined) return true; // same-origin GETs often omit it
  if (typeof originHeader !== "string") return false;
  try {
    const url = new URL(originHeader);
    if (url.protocol !== "http:") return false;
    const host = url.host.toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}` ||
      host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Create the loopback dashboard server. All responses are `text/html` or
 * `application/json`, never CORS, never external. GET and HEAD only.
 */
export function createDashboardServer(state) {
  return createServer((req, res) => {
    const method = req.method || "GET";
    const port = state.port;

    const deny = (code, message) => {
      const body = JSON.stringify({ error: message });
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(method === "HEAD" ? undefined : body);
    };

    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      return deny(405, "method not allowed");
    }
    if (!isAllowedHostHeader(req.headers.host, port)) {
      return deny(403, "host not allowed");
    }
    if (!isAllowedOriginHeader(req.headers.origin, port)) {
      return deny(403, "cross-origin not allowed");
    }

    let pathname;
    try {
      pathname = new URL(req.url || "/", `http://127.0.0.1:${port}`).pathname;
    } catch {
      return deny(400, "bad request");
    }

    if (pathname === "/" || pathname === "/index.html") {
      const html = renderHtml({ title: state.title });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      return res.end(method === "HEAD" ? undefined : html);
    }

    if (pathname === "/api/snapshot") {
      const snapshot = state.getSnapshot ? state.getSnapshot() : { error: "no snapshot yet" };
      const json = escapeJsonForScript(safeStringify(snapshot, LIMITS.jsonBytes));
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(json),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      return res.end(method === "HEAD" ? undefined : json);
    }

    if (pathname === "/healthz") {
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      return res.end(method === "HEAD" ? undefined : body);
    }

    return deny(404, "not found");
  });
}

// ---------------------------------------------------------------------------
// Snapshot builder (calls the real client, read-only)
// ---------------------------------------------------------------------------

/** Resolve the PiClient module: explicit --client path or the sibling dist. */
export async function loadPiClient(clientPath) {
  const target =
    typeof clientPath === "string" && clientPath.length > 0
      ? resolve(clientPath)
      : pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "client.js")).href;
  const mod = await import(target);
  if (typeof mod.PiClient !== "function") {
    throw new Error(`PiClient not found in ${target}`);
  }
  return mod;
}

/**
 * Guard: refuse to call anything outside READ_METHODS. This is the structural
 * read-only boundary; there is no raw proxy.
 */
export function makeReadOnlyCaller(client) {
  return async function call(method, params) {
    if (!READ_METHODS.includes(method)) {
      throw new Error(`monitor: refusing non-read method ${method}`);
    }
    return client.call(method, params);
  };
}

/** Round a duration (ms) into a compact human string. */
export function humanAge(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Build one snapshot by issuing the read-only RPC calls. Never throws: any
 * failure is captured into `error` so the dashboard stays up and shows it.
 */
export async function buildSnapshot({ call, projectId, now = Date.now(), previous = null, warningThresholdMs = null }) {
  const snapshot = {
    generatedAtIso: new Date(now).toISOString(),
    intervalMs: DEFAULT_INTERVAL_MS,
    title: "Pi Durable monitor",
    error: null,
    project: null,
    assignment: null,
    activity: { state: "unknown", ageMs: null, ageHuman: "unknown" },
    tasks: null,
    command: null,
    manager: null,
    usage: { requests: null, tokens: null },
    transcriptPreview: "(no transcript)",
    warnings: { enabled: warningThresholdMs !== null, thresholdHuman: warningThresholdMs === null ? null : humanAge(warningThresholdMs), log: previous && previous.warnings ? previous.warnings.log : [] },
    _stallSignal: null,
  };

  try {
    const projectResult = await call("projects.show", { id: projectId });
    const project = projectResult && projectResult.project ? projectResult.project : null;
    if (project === null) {
      snapshot.error = "project not found in service";
      return snapshot;
    }
    snapshot.project = {
      id: redactText(project.id),
      name: redactText(project.name),
      path: redactText(project.path),
    };
    snapshot.title = `Pi Durable monitor — ${redactText(project.name || project.id)}`;

    // assignments.list is scoped to the ONE fixed project.
    const listResult = await call("assignments.list", { projectId });
    const assignments = listResult && Array.isArray(listResult.assignments) ? listResult.assignments : [];
    const latest = selectLatestAssignment(assignments.slice(0, LIMITS.assignmentList));
    snapshot.project.assignmentCount = assignments.length;

    if (latest === null) {
      snapshot.activity = { state: "unknown", ageMs: null, ageHuman: "no assignments" };
      snapshot.tasks = { count: 0, running: 0, tasks: [], submissions: [], scheduling: null };
      return snapshot;
    }

    // assignments.show is bounded: we surface a small, redacted summary only.
    const showResult = await call("assignments.show", { id: latest.id });
    const detail = showResult && typeof showResult === "object" ? showResult : {};
    snapshot.assignment = {
      id: redactText(detail.id ?? latest.id),
      state: redactText(detail.state ?? latest.state),
      attemptCount: detail.attemptCount ?? latest.attemptCount ?? null,
      stopReason: detail.stopReason === null || detail.stopReason === undefined ? null : redactText(detail.stopReason),
      error: detail.error === null || detail.error === undefined ? null : redactText(detail.error),
      updatedAt: detail.updatedAt ?? latest.updatedAt ?? null,
      createdAt: detail.createdAt ?? latest.createdAt ?? null,
      conversationId: detail.conversationId ?? latest.conversationId ?? null,
      sessionId: detail.sessionId ?? latest.sessionId ?? null,
    };
    // Real command evidence (authoritative) is available even without a session.
    snapshot.command = latestEvidenceCommand(detail.evidence);

    // Sessions tasks (only when we have a session id) — bounded, structured.
    let tasksResult = null;
    if (typeof snapshot.assignment.sessionId === "string" && snapshot.assignment.sessionId.length > 0) {
      try {
        tasksResult = await call("sessions.tasks", { id: snapshot.assignment.sessionId });
      } catch (error) {
        tasksResult = null;
        snapshot.error = `sessions.tasks failed: ${redactText(error && error.message ? error.message : error)}`;
      }
    }
    snapshot.tasks = summarizeTasks(tasksResult);

    // Transcript (bounded): newest entries, preview only.
    if (typeof snapshot.assignment.sessionId === "string" && snapshot.assignment.sessionId.length > 0) {
      try {
        const transcript = await call("sessions.transcript", {
          id: snapshot.assignment.sessionId,
          order: "descending",
          limit: LIMITS.transcriptEntries,
        });
        const entries = transcript && Array.isArray(transcript.entries) ? transcript.entries : [];
        // Prefer the real evidence command log (authoritative exit codes/tails);
        // fall back to parsing the bounded transcript.
        snapshot.command =
          latestEvidenceCommand(detail.evidence) ?? extractLatestCommand(entries.slice().reverse());
        snapshot.transcriptPreview = previewEntries(entries);
        // Usage if the transcript carries any model counters.
        snapshot.usage = extractUsage(entries);
      } catch (error) {
        snapshot.error = `sessions.transcript failed: ${redactText(error && error.message ? error.message : error)}`;
      }
    }

    // Manager wake health (read-only).
    try {
      const status = await call("manager.status", {});
      const events = await call("manager.events", { projectId, limit: LIMITS.events });
      snapshot.manager = {
        enabled: status && status.enabled,
        pending: status && status.pending,
        parked: status && status.parked,
        unacked: status && status.unacked,
        nextAttemptAt: status && status.nextAttemptAt,
        events: (events && Array.isArray(events.events) ? events.events : []).map((e) => ({
          eventId: redactText(e.eventId),
          kind: redactText(e.kind),
          state: redactText(e.state),
          assignmentId: redactText(e.assignmentId),
          deliveryState: redactText(e.deliveryState),
          acked: e.acked === true,
        })),
      };
    } catch (error) {
      snapshot.error = `manager read failed: ${redactText(error && error.message ? error.message : error)}`;
      snapshot.manager = { enabled: null, pending: null, parked: null, unacked: null, nextAttemptAt: null, events: [] };
    }

    // Activity classification (never a bare "active").
    const watermark = activityWatermark(snapshot.assignment, tasksResult && tasksResult.tasks);
    const threshold = warningThresholdMs ?? DEFAULT_IDLE_WARNING_MS;
    const terminal = TERMINAL_STATES.has(snapshot.assignment.state);
    const activity = classifyActivity({ now, watermark, thresholdMs: threshold, terminal });
    snapshot.activity = {
      state: activity.state,
      ageMs: activity.ageMs,
      ageHuman: activity.ageMs === null ? "unknown" : humanAge(activity.ageMs),
    };

    // Stall signal for the escalation layer (with and WITHOUT a child task).
    const hasRunningChild = snapshot.tasks && snapshot.tasks.running > 0;
    snapshot._stallSignal = {
      assignmentId: snapshot.assignment.id,
      state: snapshot.assignment.state,
      terminal,
      watermark,
      ageMs: activity.ageMs,
      stale: activity.state === "stale",
      hasRunningChild,
      // A stalled provider/compaction with NO running child is also a warning:
      // nothing is executing, yet no progress is recorded.
      stalledWithoutChild: activity.state === "stale" && !hasRunningChild,
    };
  } catch (error) {
    snapshot.error = redactText(error && error.message ? error.message : error);
  }

  return snapshot;
}

export function extractUsage(entries) {
  // NOTE (honesty): these counters are summed over the *bounded recent
  // transcript window* we fetched, NOT the whole session. We label that
  // explicitly in the UI so nobody mistakes a partial window for a total.
  const usage = { requests: null, tokens: null, windowEntries: Array.isArray(entries) ? entries.length : 0, scope: "recent-transcript-window" };
  const consider = (u) => {
    if (!u || typeof u !== "object") return;
    const req = numOrNull(u.requests) ?? numOrNull(u.requestCount);
    const tok =
      numOrNull(u.totalTokens) ??
      numOrNull(u.tokens) ??
      numOrNull(u.outputTokens) ??
      (numOrNull(u.input) !== null && numOrNull(u.output) !== null ? u.input + u.output : null);
    if (req !== null) usage.requests = req;
    if (tok !== null) usage.tokens = (usage.tokens ?? 0) + tok;
  };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    // Real pi shape: usage lives on assistant messages inside entry.model.
    if (Array.isArray(entry.model)) {
      for (const message of entry.model) {
        if (message && message.role === "assistant") {
          usage.requests = (usage.requests ?? 0) + 1;
          consider(message.usage);
        }
      }
      continue;
    }
    const data = entry.data && typeof entry.data === "object" ? entry.data : entry;
    consider(data.usage && typeof data.usage === "object" ? data.usage : data);
  }
  return usage;
}

/**
 * Build a compact, redacted transcript preview from framed entries. Each line
 * is `<id> <kind> <role>: <text>` where `<text>` is derived from the model
 * message content (text blocks / tool calls) — never from raw JSON dumps.
 *
 * `pi.compaction` entries carry the full prior history in their model array;
 * rendering them would drown the panel, so we collapse them to a single
 * one-line marker instead of dumping their contents.
 */
export function previewEntries(entries, maxLines = 12) {
  if (!Array.isArray(entries)) return "";
  const lines = [];
  for (const entry of entries) {
    if (lines.length >= maxLines) break;
    if (!entry || typeof entry !== "object") continue;
    const id = entry.id !== undefined ? String(entry.id) : "?";
    const kind = redactText(entry.kind || "entry");
    if (/compaction/i.test(kind)) {
      lines.push(`#${id} ${kind}: [compaction — full history retained, not rendered]`);
      continue;
    }
    if (Array.isArray(entry.model) && entry.model.length > 0) {
      for (const message of entry.model) {
        if (lines.length >= maxLines) break;
        const role = redactText((message && message.role) || "message");
        const text = summarizeMessage(message);
        lines.push(`#${id} ${kind} ${role}: ${tail(redactText(text), LIMITS.previewChars)}`);
      }
    } else if (entry.data !== undefined && entry.data !== null) {
      lines.push(`#${id} ${kind}: ${tail(redactText(safeStringify(entry.data)), LIMITS.previewChars)}`);
    } else {
      lines.push(`#${id} ${kind}`);
    }
  }
  return lines.join("\n");
}

/** One-line human summary of a pi Message (role/content), never raw JSON. */
function summarizeMessage(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(`[thinking] ${block.thinking}`);
    else if (block.type === "toolCall" && typeof block.name === "string") {
      const cmd = block.arguments && typeof block.arguments.command === "string" ? ` ${block.arguments.command}` : "";
      parts.push(`[tool ${block.name}${cmd}]`);
    }
  }
  return parts.join(" ");
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `pi durable monitor — read-only dashboard + optional one-shot inactivity warning

Usage:
  node tools/monitor.mjs --state-dir <dir> --project-id <id> [options]

Required:
  --state-dir <dir>       Private Pi state directory (contains the service socket).
  --project-id <id>       EXISTING project id to scope every read to.

Options:
  --client <path>         Absolute path to a dist/client.js (default: sibling ../dist/client.js).
  --host <host>           Loopback host (default 127.0.0.1). Non-loopback is refused.
  --port <n>              Port (default 5180).
  --interval-ms <n>       Dashboard refresh hint (default ${DEFAULT_INTERVAL_MS}).
  --once                  Print one JSON snapshot and exit (no server).

Inactivity warning (code-only; disabled unless BOTH are set):
  --thread <UUID>         EXISTING Codex manager session to notify.
  --idle-warning-ms <n>   Warn after this much silence (default ${DEFAULT_IDLE_WARNING_MS}).
  --codex <exec>          Codex CLI executable (default "codex" on PATH).
  --receipts-file <path>  Durable dedup file (REQUIRED when warnings are enabled).

The warning never calls a model, never edits the repo, never issues control RPC,
and NEVER kills or time-limits the work it warns about.
`;

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    process.stderr.write(`monitor: ${parsed.error}\n\n${HELP}`);
    return 2;
  }
  const options = parsed.options;

  let clientMod;
  try {
    clientMod = await loadPiClient(options.clientPath);
  } catch (error) {
    process.stderr.write(`monitor: cannot load PiClient: ${error && error.message ? error.message : error}\n`);
    return 3;
  }

  let client;
  try {
    client = await clientMod.PiClient.connect({ stateDir: options.stateDir, timeoutMs: 15_000 });
  } catch (error) {
    // Missing service must not crash: report and exit cleanly.
    process.stderr.write(`monitor: connect failed: ${redactText(error && error.message ? error.message : error)}\n`);
    return 4;
  }

  const call = makeReadOnlyCaller(client);
  let lastSnapshot = null;
  let warningLog = [];

  const warn = async (signal) => {
    if (!options.warningsEnabled || signal === null) return;
    const receiptsPath = options.receiptsFile;
    const receipts = loadReceipts(receiptsPath);
    const decision = shouldWarn({
      assignment: { id: signal.assignmentId },
      watermark: signal.watermark,
      receipts: receipts.warned,
      now: Date.now(),
      thresholdMs: options.idleWarningMs,
      terminal: signal.terminal,
    });
    if (!decision.warn) return;
    const message = buildWarningMessage({
      projectId: options.projectId,
      assignment: { id: signal.assignmentId, state: signal.state },
      ageMs: decision.ageMs,
      kind: signal.stalledWithoutChild ? "no running child task" : "task running but no recorded progress",
    });
    const result = await runCodexQueue({ executable: options.codexExec, thread: options.thread, message });
    const entry = {
      atIso: new Date().toISOString(),
      assignmentId: signal.assignmentId,
      watermark: signal.watermark,
      ageMs: decision.ageMs,
      ok: result.ok,
      receipt: result.receipt,
      error: result.error,
      permanent: result.permanent,
    };
    try {
      recordReceipt(receiptsPath, decision.key, entry);
    } catch (error) {
      entry.error = `${entry.error ? `${entry.error}; ` : ""}receipt write failed: ${redactText(error && error.message ? error.message : error)}`;
    }
    warningLog = [...warningLog, { atIso: entry.atIso, text: `queued=${result.ok} ${result.receipt ?? ""} ${result.error ?? ""}`.trim() }].slice(-20);
    process.stdout.write(`monitor: inactivity warning ${result.ok ? "queued" : "FAILED"} for ${signal.assignmentId}\n`);
  };

  const tick = async () => {
    const snapshot = await buildSnapshot({
      call,
      projectId: options.projectId,
      previous: lastSnapshot,
      warningThresholdMs: options.warningsEnabled ? options.idleWarningMs : null,
    });
    snapshot.intervalMs = options.intervalMs;
    snapshot.warnings.log = warningLog;
    try {
      await warn(snapshot._stallSignal);
    } catch (error) {
      snapshot.error = `${snapshot.error ? `${snapshot.error}; ` : ""}warn failed: ${redactText(error && error.message ? error.message : error)}`;
    }
    // Re-read receipts for display honesty.
    const receipts = loadReceipts(options.receiptsFile);
    snapshot.warnings.count = Object.keys(receipts.warned).length;
    lastSnapshot = snapshot;
    return snapshot;
  };

  if (options.once) {
    const snapshot = await tick();
    delete snapshot._stallSignal;
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    client.close();
    return 0;
  }

  const state = {
    port: options.port,
    title: "Pi Durable monitor",
    getSnapshot: () => {
      const s = lastSnapshot ?? { error: "warming up" };
      const copy = { ...s };
      delete copy._stallSignal;
      return copy;
    },
  };
  const server = createDashboardServer(state);

  const started = await new Promise((resolveStart) => {
    server.once("error", (error) => resolveStart({ error }));
    server.listen(options.port, options.host, () => resolveStart({ ok: true }));
  });
  if (started.error) {
    process.stderr.write(`monitor: cannot bind ${options.host}:${options.port}: ${started.error.message}\n`);
    client.close();
    return 5;
  }

  // Prime the snapshot, then refresh on the interval. Ticks are serialized:
  // if an RPC round-trip runs longer than the interval we skip the next beat
  // rather than stacking overlapping calls on the socket.
  await tick();
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch(() => undefined)
      .finally(() => {
        ticking = false;
      });
  }, options.intervalMs);
  timer.unref?.();

  process.stdout.write(
    `monitor: dashboard on http://${options.host}:${options.port}/  (project ${options.projectId}; read-only${
      options.warningsEnabled ? `; idle warning ${options.idleWarningMs}ms -> thread ${options.thread}` : "; warnings disabled"
    })\n`,
  );

  const shutdown = () => {
    clearInterval(timer);
    try {
      server.close();
    } catch {
      /* ignore */
    }
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return null; // keep running
}

// Start only when run directly (not when imported by tests).
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    if (typeof code === "number") process.exit(code);
  });
}
