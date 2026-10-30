/**
 * Rebuild the `serve` argv that {@link serveMain} expects from parsed flags.
 * `parseArgs` consumes `--config/--socket` into the flag map, so the foreground
 * service would otherwise start with no config and exit immediately.
 */
export declare function buildServeArgs(flags: ReadonlyMap<string, string>): string[];
/** The help payload shared by text and `--json` output. */
export declare function helpEnvelope(): {
    ok: true;
    result: {
        help: string;
    };
};
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
export declare function resolveWaitTimeouts(method: string, params: Record<string, unknown>, requestedMs: number | undefined): {
    clientTimeoutMs: number | undefined;
};
/** Top-level dispatch. Returns a process exit code. */
export declare function runCli(argv: readonly string[]): Promise<number>;
//# sourceMappingURL=cli.d.ts.map