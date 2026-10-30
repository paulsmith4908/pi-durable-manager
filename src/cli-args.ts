/**
 * CLI argument parsing and config-path resolution.
 *
 * Pure, side-effect-free helpers shared by the CLI entry point. Nothing here
 * reads credentials or performs I/O beyond reading an explicit `--params-file`
 * (done by the caller). Errors are structured so the CLI can emit a stable
 * `{ ok:false, error:{ code, message } }` envelope without raw traces.
 */

import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

/** A structured, redaction-safe CLI failure. */
export class CliUsageError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode = 2) {
    super(message);
    this.name = "CliUsageError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** A parsed argv split into a command path, positional args, and flags. */
export interface ParsedArgs {
  /** Leading non-flag tokens, e.g. ["projects", "create"]. */
  readonly command: readonly string[];
  /** Remaining positional (non-flag) tokens after the command. */
  readonly positionals: readonly string[];
  /** Flag values, with `--flag value` and `--flag=value` both supported. */
  readonly flags: ReadonlyMap<string, string>;
  /**
   * Boolean flags that were present. A bare `--flag` is `true`; `--flag=false`
   * is `false`; `--flag=true`/`--flag=` is `true`. Only flags in
   * {@link BOOLEAN_FLAGS} (or an explicit `knownBooleanFlags` set) are collected
   * here — never a value-taking flag.
   */
  readonly booleans: ReadonlySet<string>;
  /** Effective boolean value for each collected boolean flag (`--flag=false` → false). */
  readonly booleanValues: ReadonlyMap<string, boolean>;
}

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set<string>([
  "json",
  "help",
  "version",
  "follow",
  "force",
  "quiet",
  "allow-legacy",
  "overwrite",
  "offline",
  "online",
  "dry-run",
  "install-skill",
  "replace-skill",
  "replace",
  "allow-network",
  "no-marketplace",
  "once",
]);

/** Short aliases that expand to their long boolean-flag form. */
const SHORT_ALIASES = new Map<string, string>([
  ["-h", "help"],
]);

/**
 * Interpret a boolean flag's textual value. Accepts the common spellings
 * (`true`/`false`, `1`/`0`, `yes`/`no`, and an empty value meaning `true`).
 * Returns `undefined` for anything else so the caller can reject it.
 */
export function parseBooleanValue(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return undefined;
}

/** Optional strictness controls for {@link parseArgs}. */
export interface ParseOptions {
  /**
   * Extra flags (beyond {@link BOOLEAN_FLAGS}) that never take a value. When
   * provided, unknown `--flag` tokens are rejected with a usage error.
   */
  readonly booleanFlags?: ReadonlySet<string>;
  /**
   * When true, any `--flag` not in the boolean set or {@link VALUE_FLAGS} is a
   * usage error, and more than `maxCommandTokens`/`maxPositionals` non-flag
   * tokens is a usage error. Off by default so existing callers are unaffected.
   */
  readonly strict?: boolean;
  /** Value-taking flags allowed under `strict` (in addition to {@link VALUE_FLAGS}). */
  readonly valueFlags?: ReadonlySet<string>;
  /** Max non-flag tokens that may form the command prefix (default 2). */
  readonly maxCommandTokens?: number;
  /** Max extra positional tokens allowed under `strict` (default unlimited). */
  readonly maxPositionals?: number;
}

/**
 * Parse argv into command tokens, positionals, and flags.
 *
 * Flags may appear anywhere (before, between, or after command tokens); flag
 * position never prevents command collection. The first up-to-two non-flag
 * tokens form the command; later non-flag tokens are positionals. A value-taking
 * flag must be followed by a value that is not itself another `--flag`
 * (otherwise it is a missing-value error). `--` stops flag parsing entirely.
 *
 * Boolean flags accept an optional `=value` (`--allow-network=false`), which is
 * recorded in {@link ParsedArgs.booleanValues}; an unrecognized boolean value is
 * a usage error. With `strict: true`, unknown flags and extra positionals are
 * rejected as usage errors so typos never silently succeed.
 */
export function parseArgs(argv: readonly string[], options: ParseOptions = {}): ParsedArgs {
  const command: string[] = [];
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const booleanValues = new Map<string, boolean>();
  const maxCommandTokens = options.maxCommandTokens ?? 2;
  const isBoolean = (name: string): boolean =>
    BOOLEAN_FLAGS.has(name) || options.booleanFlags?.has(name) === true;
  let flagsDone = false;

  const recordBoolean = (name: string, rawValue: string | undefined): void => {
    if (rawValue === undefined) {
      booleans.add(name);
      booleanValues.set(name, true);
      return;
    }
    const parsed = parseBooleanValue(rawValue);
    if (parsed === undefined) {
      throw new CliUsageError(
        "bad_boolean",
        `Flag --${name} expects a boolean value (true/false), got "${rawValue}".`,
      );
    }
    booleans.add(name);
    booleanValues.set(name, parsed);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (flagsDone) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      flagsDone = true;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const alias = SHORT_ALIASES.get(token);
      const long = alias !== undefined ? `--${alias}` : token;
      if (!long.startsWith("--")) {
        throw new CliUsageError("bad_flag", `Unknown flag: ${token}`);
      }
      const eq = long.indexOf("=");
      const name = eq === -1 ? long.slice(2) : long.slice(2, eq);
      if (name.length === 0) throw new CliUsageError("bad_flag", "Empty flag name.");
      if (
        options.strict === true &&
        !isBoolean(name) &&
        (options.valueFlags === undefined || !options.valueFlags.has(name))
      ) {
        // Reject unknown flags up front (a typo'd value-flag must not be
        // misreported as a missing value for the following token).
        throw new CliUsageError("unknown_flag", `Unknown flag: --${name}`);
      }
      if (isBoolean(name)) {
        recordBoolean(name, eq === -1 ? undefined : long.slice(eq + 1));
      } else if (eq !== -1) {
        flags.set(name, long.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("-") && next !== "-")) {
          throw new CliUsageError("missing_flag_value", `Flag --${name} requires a value.`);
        }
        flags.set(name, next);
        i += 1;
      }
      continue;
    }
    // Non-flag token: fills the command prefix, then positionals.
    if (command.length < maxCommandTokens) command.push(token);
    else positionals.push(token);
  }

  if (options.strict === true) {
    const knownValueFlags = options.valueFlags;
    for (const name of flags.keys()) {
      if (isBoolean(name)) continue;
      if (knownValueFlags !== undefined && !knownValueFlags.has(name)) {
        throw new CliUsageError("unknown_flag", `Unknown flag: --${name}`);
      }
    }
    if (
      options.maxPositionals !== undefined &&
      positionals.length > options.maxPositionals
    ) {
      throw new CliUsageError(
        "too_many_arguments",
        `Unexpected extra argument: ${positionals[options.maxPositionals]}`,
      );
    }
  }

  return { command, positionals, flags, booleans, booleanValues };
}

/** True when a boolean flag was present (bare or `=true`). `--flag=false` is false. */
export function flagEnabled(parsed: Pick<ParsedArgs, "booleans" | "booleanValues">, name: string): boolean {
  return parsed.booleanValues.get(name) === true
    || (parsed.booleanValues.get(name) === undefined && parsed.booleans.has(name));
}

/**
 * Resolve the config file path from flags/environment/defaults.
 *
 * Precedence: `--config` flag, then `PI_DURABLE_CONFIG`, then the default
 * private path. The result is absolute. No file is read here.
 */
export function resolveConfigPath(
  flags: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromFlag = flags.get("config");
  const fromEnv = env.PI_DURABLE_CONFIG;
  const chosen = fromFlag ?? (fromEnv && fromEnv.length > 0 ? fromEnv : undefined);
  if (chosen !== undefined) return isAbsolute(chosen) ? chosen : resolve(chosen);
  return resolve(homedir(), ".config", "pi-durable-manager", "config.json");
}
