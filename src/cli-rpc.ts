/**
 * Generic RPC dispatch and command→method mapping for the CLI.
 *
 * The service is the sole writer; the CLI is a thin, composable client. Any
 * supported operation can be called generically as:
 *
 *   pi-durable call <method> --params-file FILE [--request-id ID]
 *
 * Named helpers (`projects create`, `sessions list`, ...) are thin sugar that
 * map to protocol method names and assemble `params`.
 */

import { readFile } from "node:fs/promises";
import { CliUsageError } from "./cli-args.js";

/** Alias (singular|plural) → canonical namespace prefix in the protocol. */
const NAMESPACE_ALIASES: Record<string, string> = {
  workflow: "workflow",
  project: "projects",
  projects: "projects",
  session: "sessions",
  sessions: "sessions",
  assignment: "assignments",
  assignments: "assignments",
  manager: "manager",
  managers: "manager",
};

/** Actions that are valid in every namespace, mapped to their protocol verb. */
const COMMON_ACTIONS: Record<string, string> = {
  list: "list",
  show: "show",
  inspect: "inspect",
  create: "create",
};

/** Namespace-specific action → protocol verb overrides. */
const NAMESPACE_ACTIONS: Record<string, Record<string, string>> = {
  projects: { import: "import" },
  sessions: {
    transcript: "transcript",
    transcripts: "transcript",
    tasks: "tasks",
    usage: "usage",
    fork: "fork",
    compact: "compact",
    reset: "reset",
    configure: "configure",
    steer: "steer",
    followup: "followup",
    "follow-up": "followup",
  },
  assignments: {
    submit: "submit",
    wait: "wait",
    abort: "abort",
    cancel: "cancel",
    review: "review",
    evidence: "evidence",
    artifact: "artifact",
    checkpoint: "checkpoint",
    restore: "restore",
  },
  manager: {
    bind: "bind",
    unbind: "unbind",
    status: "status",
    events: "events",
    ack: "ack",
    decision: "decision",
  },
};

/**
 * Map a command path (e.g. `["projects","create"]`) to a protocol method name.
 * Throws {@link CliUsageError} for unknown namespaces or actions.
 */
export function mapCommandToMethod(command: readonly string[]): string {
  const [namespace, action] = command;
  if (namespace === undefined) {
    throw new CliUsageError("no_command", "Missing command.");
  }
  const ns = NAMESPACE_ALIASES[namespace];
  if (ns === undefined) {
    throw new CliUsageError("unknown_namespace", `Unknown command: ${namespace}`, 2);
  }
  if (action === undefined) {
    throw new CliUsageError("no_action", `Missing action for ${namespace}.`, 2);
  }
  const verb = NAMESPACE_ACTIONS[ns]?.[action] ?? COMMON_ACTIONS[action] ?? action;
  return `${ns}.${verb}`;
}

/** True when a command path is one of the aliased namespaces. */
export function isNamespaceCommand(command: readonly string[]): boolean {
  return command[0] !== undefined && NAMESPACE_ALIASES[command[0]] !== undefined;
}

/** Maximum size for `--task-file`, `--criteria-file`, and `--content-file`. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

/**
 * Map CLI flags to their protocol param keys for `runRpc`.
 * `--task-file`/`--criteria-file`/`--content-file` carry file paths (read here);
 * the rest are scalar values copied verbatim.
 */
export const PARAM_FLAGS: ReadonlyMap<string, string> = new Map([
  ["project-id", "projectId"],
  ["session-id", "sessionId"],
  ["parent-id", "parentId"],
  ["id", "id"],
  ["name", "name"],
  ["path", "path"],
  ["decision", "decision"],
  ["note", "note"],
  ["limit", "limit"],
  ["cursor", "cursor"],
  ["order", "order"],
  ["assignment-id", "assignmentId"],
  ["section", "section"],
  ["offset", "offset"],
  ["artifact-id", "artifactId"],
  ["max-chars", "maxChars"],
  ["allow-legacy", "allowLegacy"],
  ["overwrite", "overwrite"],
  ["thread-id", "threadId"],
  ["event-id", "eventId"],
  ["unacked", "unacked"],
]);

/** Param flags whose value must be coerced to a finite number. */
const NUMERIC_PARAM_FLAGS = new Set<string>(["offset", "maxChars", "limit"]);

/** Param flags whose value must be coerced to a boolean. */
const BOOLEAN_PARAM_FLAGS = new Set<string>(["allowLegacy", "overwrite", "unacked"]);

/** File-path flags whose contents are read and mapped to a param key. */
const FILE_PARAM_FLAGS: ReadonlyMap<string, string> = new Map([
  ["task-file", "task"],
  ["criteria-file", "criteria"],
  ["content-file", "content"],
]);

/** Flags that carry no param value and are handled by the dispatcher. */
export const NON_PARAM_FLAGS = new Set<string>([
  "config",
  "socket",
  "json",
  "help",
  "params-file",
  "request-id",
  "timeout-ms",
]);

/** Read a UTF-8 text file with a hard byte cap. */
export async function readTextFileBounded(path: string, maxBytes = MAX_TEXT_FILE_BYTES): Promise<string> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    throw new CliUsageError("file_read", `Unable to read file: ${path}`, 2);
  }
  if (buf.byteLength > maxBytes) {
    throw new CliUsageError("file_too_large", `File exceeds ${maxBytes} bytes: ${path}`, 2);
  }
  return buf.toString("utf8");
}

/**
 * Build the `params` object for a call from parsed flags and positionals.
 *
 * `--params-file` supplies a generic base object (its keys win over flag keys
 * only when not overridden). Scalar `PARAM_FLAGS` are copied through; file flags
 * are read as bounded UTF-8 text; `--timeout-ms` is handled by the caller.
 * Unknown flags are rejected as a usage error rather than silently ignored.
 */
export async function collectParams(
  flags: ReadonlyMap<string, string>,
  positionals: readonly string[],
  base: Record<string, unknown>,
  booleans: ReadonlySet<string> = new Set<string>(),
  booleanValues?: ReadonlyMap<string, boolean>,
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { ...base };
  // Bare boolean param flags (e.g. `--overwrite`, `--allow-legacy`) carry no
  // value; `parseArgs` collects them separately, so fold them in. An explicit
  // `--flag=false` is honoured via `booleanValues`.
  for (const name of booleans) {
    const key = PARAM_FLAGS.get(name);
    if (key !== undefined && BOOLEAN_PARAM_FLAGS.has(key)) {
      params[key] = booleanValues?.get(name) ?? true;
    }
  }
  for (const [flag, value] of flags) {
    if (NON_PARAM_FLAGS.has(flag)) continue;
    const key = PARAM_FLAGS.get(flag);
    if (key !== undefined) {
      if (NUMERIC_PARAM_FLAGS.has(key)) {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new CliUsageError("bad_number", `Invalid numeric flag: --${flag}`, 2);
        params[key] = n;
      } else if (BOOLEAN_PARAM_FLAGS.has(key)) {
        if (value === "true" || value === "") params[key] = true;
        else if (value === "false") params[key] = false;
        else throw new CliUsageError("bad_boolean", `Invalid boolean flag: --${flag} (use true/false)`, 2);
      } else {
        params[key] = value;
      }
      continue;
    }
    const fileKey = FILE_PARAM_FLAGS.get(flag);
    if (fileKey !== undefined) {
      params[fileKey] = await readTextFileBounded(value);
      continue;
    }
    throw new CliUsageError("unknown_flag", `Unknown flag: --${flag}`, 2);
  }
  if (positionals.length > 0 && params.id === undefined) params.id = positionals[0];
  return params;
}

/** Parse and bound `--timeout-ms` (client-side wait), capped at 60s by default. */
export function parseTimeoutMs(flags: ReadonlyMap<string, string>, maxMs = 60_000): number | undefined {
  const raw = flags.get("timeout-ms");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliUsageError("bad_timeout", `Invalid --timeout-ms: ${raw}`, 2);
  }
  return Math.min(Math.floor(value), maxMs);
}

/**
 * Read and parse a `--params-file`. `"-"` reads stdin; the content must be a
 * JSON object. Never executed, only parsed as data.
 */
export async function readParamsFile(path: string, stdin?: () => Promise<string>): Promise<Record<string, unknown>> {
  let raw: string;
  if (path === "-") {
    if (stdin === undefined) throw new CliUsageError("no_stdin", "params-file '-' requires stdin.");
    raw = await stdin();
  } else {
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new CliUsageError("params_read", `Unable to read params file: ${path}`, 2);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError("params_parse", "Params file is not valid JSON.", 2);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliUsageError("params_shape", "Params file must contain a JSON object.", 2);
  }
  return parsed as Record<string, unknown>;
}
