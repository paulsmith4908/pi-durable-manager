/**
 * CLI argument parsing and config-path resolution.
 *
 * Pure, side-effect-free helpers shared by the CLI entry point. Nothing here
 * reads credentials or performs I/O beyond reading an explicit `--params-file`
 * (done by the caller). Errors are structured so the CLI can emit a stable
 * `{ ok:false, error:{ code, message } }` envelope without raw traces.
 */
/** A structured, redaction-safe CLI failure. */
export declare class CliUsageError extends Error {
    readonly code: string;
    readonly exitCode: number;
    constructor(code: string, message: string, exitCode?: number);
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
/**
 * Interpret a boolean flag's textual value. Accepts the common spellings
 * (`true`/`false`, `1`/`0`, `yes`/`no`, and an empty value meaning `true`).
 * Returns `undefined` for anything else so the caller can reject it.
 */
export declare function parseBooleanValue(raw: string): boolean | undefined;
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
export declare function parseArgs(argv: readonly string[], options?: ParseOptions): ParsedArgs;
/** True when a boolean flag was present (bare or `=true`). `--flag=false` is false. */
export declare function flagEnabled(parsed: Pick<ParsedArgs, "booleans" | "booleanValues">, name: string): boolean;
/**
 * Resolve the config file path from flags/environment/defaults.
 *
 * Precedence: `--config` flag, then `PI_DURABLE_CONFIG`, then the default
 * private path. The result is absolute. No file is read here.
 */
export declare function resolveConfigPath(flags: ReadonlyMap<string, string>, env?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=cli-args.d.ts.map