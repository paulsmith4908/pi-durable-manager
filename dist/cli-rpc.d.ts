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
/**
 * Map a command path (e.g. `["projects","create"]`) to a protocol method name.
 * Throws {@link CliUsageError} for unknown namespaces or actions.
 */
export declare function mapCommandToMethod(command: readonly string[]): string;
/** True when a command path is one of the aliased namespaces. */
export declare function isNamespaceCommand(command: readonly string[]): boolean;
/** Maximum size for `--task-file`, `--criteria-file`, and `--content-file`. */
export declare const MAX_TEXT_FILE_BYTES: number;
/**
 * Map CLI flags to their protocol param keys for `runRpc`.
 * `--task-file`/`--criteria-file`/`--content-file` carry file paths (read here);
 * the rest are scalar values copied verbatim.
 */
export declare const PARAM_FLAGS: ReadonlyMap<string, string>;
/** Flags that carry no param value and are handled by the dispatcher. */
export declare const NON_PARAM_FLAGS: Set<string>;
/** Read a UTF-8 text file with a hard byte cap. */
export declare function readTextFileBounded(path: string, maxBytes?: number): Promise<string>;
/**
 * Build the `params` object for a call from parsed flags and positionals.
 *
 * `--params-file` supplies a generic base object (its keys win over flag keys
 * only when not overridden). Scalar `PARAM_FLAGS` are copied through; file flags
 * are read as bounded UTF-8 text; `--timeout-ms` is handled by the caller.
 * Unknown flags are rejected as a usage error rather than silently ignored.
 */
export declare function collectParams(flags: ReadonlyMap<string, string>, positionals: readonly string[], base: Record<string, unknown>, booleans?: ReadonlySet<string>, booleanValues?: ReadonlyMap<string, boolean>): Promise<Record<string, unknown>>;
/** Parse and bound `--timeout-ms` (client-side wait), capped at 60s by default. */
export declare function parseTimeoutMs(flags: ReadonlyMap<string, string>, maxMs?: number): number | undefined;
/**
 * Read and parse a `--params-file`. `"-"` reads stdin; the content must be a
 * JSON object. Never executed, only parsed as data.
 */
export declare function readParamsFile(path: string, stdin?: () => Promise<string>): Promise<Record<string, unknown>>;
//# sourceMappingURL=cli-rpc.d.ts.map