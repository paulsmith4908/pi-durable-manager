/**
 * Scriptable client for the durable local service.
 *
 * The client never opens the metadata store or Pi's storage; it only speaks the
 * JSON-RPC v1 protocol over the service's Unix-domain socket. It performs a
 * version handshake on construction and enforces a bounded wait per call that
 * is independent of the work the service is doing: a caller timeout does not
 * cancel the service's work, it only stops THIS caller from waiting.
 */
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { PROTOCOL_VERSION, resolveRuntimeDir, resolveSocketPath } from "./service.js";
export { resolveRuntimeDir, resolveSocketPath, PROTOCOL_VERSION as CLIENT_PROTOCOL_VERSION } from "./service.js";
/** Default per-call wait, in milliseconds. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 60_000;
/** Maximum response frame the client will buffer, in bytes. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Maximum request frame the client will send, in bytes. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
/** The parameter name used to carry the application-level idempotency key. */
export const REQUEST_ID_PARAM = "requestId";
/** A structured error returned by the service or raised locally by the client. */
export class PiClientError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "PiClientError";
        this.code = code;
    }
}
/**
 * Compute the deterministic socket path a service for `stateDir` would use.
 *
 * Exposed so scripts can construct a client without hardcoding a path; it
 * matches the server's resolution exactly.
 */
export function configSocketPath(stateDir, override) {
    return resolveSocketPath(stateDir, override);
}
/**
 * A connected client for one service instance.
 *
 * Create with {@link PiClient.connect}; the static factory performs the version
 * handshake so a protocol mismatch fails fast rather than mid-call.
 */
export class PiClient {
    socket;
    timeoutMs;
    buffer = "";
    pending = new Map();
    closed = false;
    constructor(socket, timeoutMs) {
        this.socket = socket;
        this.timeoutMs = timeoutMs;
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (error) => this.failAll(new PiClientError("socket", error.message)));
        socket.on("close", () => this.failAll(new PiClientError("closed", "Service connection closed.")));
    }
    /**
     * Connect to a service and complete the protocol version handshake.
     *
     * @throws PiClientError when the socket is missing, unreachable, or speaks a
     * different protocol version.
     */
    static async connect(options) {
        const socketPath = options.socketPath ??
            (options.stateDir !== undefined ? configSocketPath(options.stateDir) : undefined);
        if (socketPath === undefined) {
            throw new PiClientError("args", "Provide socketPath or stateDir.");
        }
        if (!existsSync(socketPath)) {
            throw new PiClientError("unavailable", `No service socket at ${socketPath}.`);
        }
        const timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
        const socket = await new Promise((resolveConnect, rejectConnect) => {
            const s = connect(socketPath);
            // A connect/handshake deadline: never leave a half-open socket behind.
            const timer = setTimeout(() => {
                s.destroy();
                rejectConnect(new PiClientError("timeout", `Connect to ${socketPath} timed out after ${timeoutMs}ms.`));
            }, timeoutMs);
            s.once("connect", () => {
                clearTimeout(timer);
                resolveConnect(s);
            });
            s.once("error", (error) => {
                clearTimeout(timer);
                s.destroy();
                rejectConnect(new PiClientError("unavailable", error.message));
            });
        });
        const client = new PiClient(socket, timeoutMs);
        try {
            const status = await client.call("service.status", {}, "handshake");
            if (status.protocolVersion !== PROTOCOL_VERSION) {
                throw new PiClientError("version_mismatch", `Service protocol ${status.protocolVersion} does not match client ${PROTOCOL_VERSION}.`);
            }
            return client;
        }
        catch (error) {
            // Handshake (or timeout) failed: close the socket so no handle leaks.
            client.close();
            throw error;
        }
    }
    /** Convenience factory: connect to the service for `stateDir`. */
    static async connectToStateDir(stateDir, timeoutMs) {
        return PiClient.connect({ stateDir, timeoutMs });
    }
    /**
     * Wrap an ALREADY-CONNECTED duplex socket and complete the handshake.
     *
     * Used for embedding and tests where the caller owns the transport (for
     * example a loopback socket); production code uses {@link PiClient.connect}.
     */
    static async fromSocket(socket, timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS) {
        const client = new PiClient(socket, timeoutMs);
        try {
            const status = await client.call("service.status", {}, "handshake");
            if (status.protocolVersion !== PROTOCOL_VERSION) {
                throw new PiClientError("version_mismatch", `Service protocol ${status.protocolVersion} does not match client ${PROTOCOL_VERSION}.`);
            }
            return client;
        }
        catch (error) {
            client.close();
            throw error;
        }
    }
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
    async call(method, params = {}, requestId = randomRequestId()) {
        if (this.closed)
            throw new PiClientError("closed", "Client is closed.");
        if (this.pending.has(requestId)) {
            throw new PiClientError("duplicate_request", `A call with requestId ${requestId} is already in flight.`);
        }
        const withKey = applyRequestId(method, params, requestId);
        const frame = { v: PROTOCOL_VERSION, id: requestId, method, params: withKey };
        const encoded = `${JSON.stringify(frame)}\n`;
        if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) {
            throw new PiClientError("frame_too_large", `Request frame for ${method} exceeded the client limit.`);
        }
        const response = await new Promise((resolveResponse, rejectResponse) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                rejectResponse(new PiClientError("timeout", `Call ${method} timed out after ${this.timeoutMs}ms.`));
            }, this.timeoutMs);
            this.pending.set(requestId, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolveResponse(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    rejectResponse(error);
                },
            });
            this.socket.write(encoded, (error) => {
                if (error !== undefined && error !== null) {
                    if (this.pending.delete(requestId))
                        clearTimeout(timer);
                    rejectResponse(new PiClientError("socket", error.message));
                }
            });
        });
        if (response.error !== undefined) {
            throw new PiClientError(response.error.code, response.error.message);
        }
        return response.result;
    }
    /** Close the connection. Idempotent. */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.socket.destroy();
    }
    onData(chunk) {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > MAX_RESPONSE_BYTES) {
            this.failAll(new PiClientError("frame_too_large", "Response frame exceeded the client limit."));
            this.close();
            return;
        }
        let newline = this.buffer.indexOf("\n");
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (line.trim() !== "")
                this.deliver(line);
            newline = this.buffer.indexOf("\n");
        }
    }
    deliver(line) {
        let frame;
        try {
            frame = JSON.parse(line);
        }
        catch {
            return;
        }
        const entry = this.pending.get(frame.id);
        if (entry === undefined)
            return;
        this.pending.delete(frame.id);
        entry.resolve(frame);
    }
    failAll(error) {
        for (const [, entry] of this.pending)
            entry.reject(error);
        this.pending.clear();
    }
}
/** Generate a unique request id. */
function randomRequestId() {
    return `pdm-req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
/** Methods whose service handler treats `params.requestId` as an idempotency key. */
export const IDEMPOTENT_METHODS = new Set([
    "workflow.open", "workflow.update", "workflow.submit", "workflow.answer", "workflow.finish", "workflow.stop",
    "workflow.review", "workflow.pause", "workflow.resume", "workflow.handoff", "assignments.pause",
    "manager.decision",
    "supervision.configure",
    "activity.note",
    "projects.create",
    "projects.import",
    "sessions.create",
    "sessions.fork",
    "sessions.steer",
    "sessions.followup",
    "assignments.create",
    "assignments.submit",
    "assignments.recover",
    "assignments.restore",
]);
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
export function applyRequestId(method, params, requestId) {
    const provided = params[REQUEST_ID_PARAM];
    if (provided !== undefined && provided !== requestId) {
        throw new PiClientError("request_id_mismatch", `params.requestId (${String(provided)}) must match the call id (${requestId}).`);
    }
    if (provided !== undefined)
        return params;
    if (!IDEMPOTENT_METHODS.has(method))
        return params;
    return { ...params, [REQUEST_ID_PARAM]: requestId };
}
//# sourceMappingURL=client.js.map