/**
 * Pure, dependency-free status/doctor classification helpers for the CLI.
 *
 * These carry the release-critical verdicts — "is the service running?", "did
 * doctor pass?" — and are intentionally free of I/O, sockets, and config parsing
 * so they can be unit-tested in isolation (type-stripped under Node 22) without
 * a live daemon. `cli-daemon.ts` and `cli.ts` consume them; there is exactly one
 * source of truth for each verdict so the CLI value and the test value cannot
 * drift.
 */
/** The runner's status verdict: `running:true`, a clean "not running", or a failure. */
export type StatusVerdict = {
    ok: true;
    running: true;
    code: "running";
} | {
    ok: true;
    running: false;
    code: "no_socket";
} | {
    ok: false;
    running: false;
    code: "stale_socket" | "permission" | "protocol_error" | "unreachable";
};
/**
 * Classify a status-probe errno into a verdict.
 *
 * - `ENOENT`/`ENOTDIR`: the socket file genuinely does not exist → the service
 *   is not running, and that is a clean, `ok:true` result.
 * - `ECONNREFUSED`/`ECONNRESET`/`ENOTSOCK`/`EHOSTUNREACH`: a socket file is
 *   present but nothing healthy is listening → a STALE socket, `ok:false`.
 * - `EACCES`/`EPERM`: we lack permission to probe → `ok:false`.
 * - anything else (timeouts, protocol/RPC errors, unknown): we cannot prove the
 *   service stopped → `ok:false`, never a false success.
 *
 * A bare `existsSync` must never be used as the success signal here: a stale
 * socket file exists yet is not a running service.
 */
export declare function classifyStatusError(code: string | undefined): StatusVerdict;
/** The doctor `ok` verdict: every environmental precondition must hold. */
export declare function doctorOk(parts: {
    nodeOk: boolean;
    platformOk: boolean;
    sandboxExecAvailable: boolean;
    configPresent: boolean;
    configOk: boolean;
}): boolean;
/** The single versioned JSON envelope shape the CLI emits on stdout. */
export interface CliEnvelope {
    ok: boolean;
    result?: unknown;
    error?: {
        code: string;
        message: string;
    };
}
/** Build a success envelope `{ ok:true, result }`. */
export declare function okEnvelope(result: unknown): CliEnvelope;
/** Build an error envelope `{ ok:false, error:{ code, message } }`. */
export declare function errorEnvelope(code: string, message: string): CliEnvelope;
/**
 * Serialize an envelope to one line of JSON. Guarantees exactly one trailing
 * newline and no extra output, so a `--json` caller always parses one object.
 */
export declare function serializeEnvelope(envelope: CliEnvelope): string;
/** Parse a single JSON envelope line; returns null when it is not valid JSON. */
export declare function parseEnvelope(text: string): CliEnvelope | null;
//# sourceMappingURL=cli-status.d.ts.map