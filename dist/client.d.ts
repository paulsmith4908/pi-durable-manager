/**
 * Scriptable client for the durable local service.
 *
 * The client never opens the metadata store or Pi's storage; it only speaks the
 * JSON-RPC v1 protocol over the service's Unix-domain socket. It performs a
 * version handshake on construction and enforces a bounded wait per call that
 * is independent of the work the service is doing: a caller timeout does not
 * cancel the service's work, it only stops THIS caller from waiting.
 */
import { type Socket } from "node:net";
export { resolveRuntimeDir, resolveSocketPath, PROTOCOL_VERSION as CLIENT_PROTOCOL_VERSION } from "./service.js";
/** Default per-call wait, in milliseconds. */
export declare const DEFAULT_CLIENT_TIMEOUT_MS = 60000;
/** Maximum response frame the client will buffer, in bytes. */
export declare const MAX_RESPONSE_BYTES: number;
/** Maximum request frame the client will send, in bytes. */
export declare const MAX_REQUEST_BYTES: number;
/** The parameter name used to carry the application-level idempotency key. */
export declare const REQUEST_ID_PARAM = "requestId";
/** A structured error returned by the service or raised locally by the client. */
export declare class PiClientError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Options accepted by {@link PiClient}. */
export interface PiClientOptions {
    /** Exact socket path to connect to. Mutually exclusive with `stateDir`. */
    readonly socketPath?: string;
    /** State directory whose runtime socket should be used. */
    readonly stateDir?: string;
    /** Per-call wait bound, in milliseconds. Defaults to 60s. */
    readonly timeoutMs?: number;
}
/** The stable success envelope returned by {@link PiClient.call}. */
export interface PiClientEnvelope<T> {
    readonly ok: true;
    readonly result: T;
}
/** The stable failure envelope; `call` throws by default instead. */
export interface PiClientFailure {
    readonly ok: false;
    readonly error: {
        readonly code: string;
        readonly message: string;
    };
}
/**
 * Compute the deterministic socket path a service for `stateDir` would use.
 *
 * Exposed so scripts can construct a client without hardcoding a path; it
 * matches the server's resolution exactly.
 */
export declare function configSocketPath(stateDir: string, override?: string): string;
/**
 * A connected client for one service instance.
 *
 * Create with {@link PiClient.connect}; the static factory performs the version
 * handshake so a protocol mismatch fails fast rather than mid-call.
 */
export declare class PiClient {
    private readonly socket;
    private readonly timeoutMs;
    private buffer;
    private readonly pending;
    private closed;
    private constructor();
    /**
     * Connect to a service and complete the protocol version handshake.
     *
     * @throws PiClientError when the socket is missing, unreachable, or speaks a
     * different protocol version.
     */
    static connect(options: PiClientOptions): Promise<PiClient>;
    /** Convenience factory: connect to the service for `stateDir`. */
    static connectToStateDir(stateDir: string, timeoutMs?: number): Promise<PiClient>;
    /**
     * Wrap an ALREADY-CONNECTED duplex socket and complete the handshake.
     *
     * Used for embedding and tests where the caller owns the transport (for
     * example a loopback socket); production code uses {@link PiClient.connect}.
     */
    static fromSocket(socket: Socket, timeoutMs?: number): Promise<PiClient>;
    /**
     * Invoke `method` and resolve with its result, or throw {@link PiClientError}.
     *
     * The optional `requestId` makes the call idempotent at the service: retrying
     * with the same id and payload replays the original result.
     *
     * The correlation id on the wire doubles as the application idempotency key
     * for mutating methods: if `params.requestId` is not already set, it is filled
     * from the correlation id so the two can never drift. If it IS set and differs,
     * the call is rejected — a mismatched key is a caller bug, not a silent rewrite.
     *
     * Concurrent calls that share a `requestId` are rejected: the pending map is
     * keyed by id, so two in-flight calls would otherwise clobber each other.
     */
    call<T = unknown>(method: string, params?: Record<string, unknown>, requestId?: string): Promise<T>;
    /** Close the connection. Idempotent. */
    close(): void;
    private onData;
    private deliver;
    private failAll;
}
/** Methods whose service handler treats `params.requestId` as an idempotency key. */
export declare const IDEMPOTENT_METHODS: Set<string>;
/**
 * Ensure the application idempotency key in `params.requestId` matches the
 * correlation id for mutating methods.
 *
 * For an idempotent (mutating) method, the correlation id is injected as
 * `params.requestId` when the caller omitted it, so the wire id and the
 * application idempotency key can never drift. If the caller supplied a
 * different value, the call is rejected rather than silently rewritten. Reads
 * and unknown methods are passed through untouched.
 */
export declare function applyRequestId(method: string, params: Record<string, unknown>, requestId: string): Record<string, unknown>;
//# sourceMappingURL=client.d.ts.map