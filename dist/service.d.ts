import { workerCompactionPolicy } from "./context-policy.js";
/**
 * Durable local Pi service.
 *
 * The service is the SOLE owner of both stores for its lifetime:
 *
 *   - our application metadata database ({@link MetadataStore}), and
 *   - Pi's own durable SQLite storage.
 *
 * It exposes a small JSON-RPC v1 protocol over a private Unix-domain socket.
 * Clients (the script client, later the CLI) talk to the stores ONLY through
 * this service; there is never a second writer.
 *
 * This slice implements the service skeleton, the socket protocol, the project,
 * session, and assignment methods, and explicit capability gating. Assignments
 * are executed by {@link AssignmentEngine} over the shared harness; sandboxed
 * project tools are registered per project in a shared registry.
 */
import { type Socket } from "node:net";
import type { Models } from "@earendil-works/pi-ai";
import { type PiDurableConfig } from "./config.js";
import { type ResolvedCredential } from "./credential.js";
import type { CreateProjectToolsOptions, ProjectTools } from "./tools.js";
/** Protocol version spoken over the socket. */
export declare const PROTOCOL_VERSION = 1;
/** Maximum size of a single request or response frame, in bytes. */
export declare const MAX_FRAME_BYTES: number;
/** How long a client may wait for one response by default, in milliseconds. */
export declare const DEFAULT_CALL_TIMEOUT_MS = 60000;
/**
 * Portable `AGENTS.md` seeded into every FRESH project repo (`projects.create`).
 *
 * Deliberately path-free and repo-agnostic: it states opt-in task routing and
 * the hard limits (one writer, no auto-commits, no secret reads) and points at
 * the INSTALLED Pi launcher, so it stays valid in any checkout and never leaks a
 * private path from the host that created it. Imports (`projects.import`) never
 * write this file — an existing `AGENTS.md` is left byte-for-byte unchanged.
 */
export declare const PORTABLE_AGENTS_MD: string;
/**
 * Raised for service setup/usage problems. The message is safe to surface to a
 * client: it never contains credentials or raw config objects.
 */
export declare class ServiceError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** JSON-serializable RPC value. */
export type RpcValue = null | boolean | number | string | RpcValue[] | {
    [key: string]: RpcValue;
};
/** A structured RPC error payload. */
export interface RpcErrorPayload {
    readonly code: string;
    readonly message: string;
}
/** A decoded request frame. */
export interface RpcRequest {
    readonly v: number;
    readonly id: string;
    readonly method: string;
    readonly params?: Record<string, unknown>;
}
/** A response frame. Exactly one of `result`/`error` is present on success/failure. */
export interface RpcResponse {
    readonly v: number;
    readonly id: string;
    readonly result?: RpcValue;
    readonly error?: RpcErrorPayload;
}
/** Injected dependencies for tests. Production callers omit everything. */
export interface ServiceHost {
    /** Build the pi-ai `Models` catalogue. Defaults to the real Modal provider. */
    readonly createModels?: (config: PiDurableConfig, credential: ResolvedCredential) => Models;
    /** Resolve the credential reference. Defaults to the process environment. */
    readonly resolveCredential?: (ref: PiDurableConfig["credential"]) => Promise<ResolvedCredential>;
    /** Provider id the agent model resolves against. Defaults to the Modal provider. */
    readonly providerId?: string;
    /** Override the runtime directory that holds state (lock/store/socket). */
    readonly runtimeDir?: string;
    /** Bypass config-file loading and supply a config directly (tests). */
    readonly config?: PiDurableConfig;
    /**
     * TEST ONLY: run project tools without the macOS sandbox. Production must
     * never set this; there is deliberately no CLI flag that enables it.
     */
    readonly unsandboxedForTesting?: boolean;
    /** TEST ONLY: inject a project tool factory (e.g. a faux provider harness). */
    readonly createTools?: (root: string, options: CreateProjectToolsOptions) => Promise<ProjectTools>;
    /** TEST ONLY: override the read-only host command runner (git evidence). */
    readonly runHostCommand?: (cwd: string, args: readonly string[]) => Promise<{
        stdout: string;
        code: number;
    }>;
    /** TEST ONLY: allow sandboxed tools to reach the network. */
    readonly allowNetwork?: boolean;
}
/** Options accepted by {@link PiDurableService.start}. */
export interface ServiceStartOptions {
    /** Path to the operator config file. Mutually exclusive with `host.config`. */
    readonly configFile?: string;
    /** Explicit socket path. Defaults to a resolved private runtime path. */
    readonly socketPath?: string;
    /**
     * Transport to bind. `"unix"` (default) binds the private Unix-domain socket;
     * `"none"` starts every other subsystem but binds no listener, so callers can
     * attach their own stream with {@link PiDurableService.attachSocket}.
     */
    readonly transport?: "unix" | "none";
    /** Host overrides (tests / embedding). */
    readonly host?: ServiceHost;
}
/** A JSON-safe report describing a started service. */
export interface ServiceStatusReport {
    readonly pid: number;
    /**
     * The installed package version this service binary reports (e.g.
     * `0.7.0-beta.1`). Callers MUST compare this against the version they expect:
     * a service built from different sources may share the same protocol/schema
     * but not be the build this client/config was written for.
     */
    readonly packageVersion: string;
    readonly protocolVersion: number;
    readonly schemaVersion: number;
    readonly socketPath: string;
    readonly stateDir: string;
    readonly configFile: string | null;
    readonly model: string;
    readonly providerId: string;
    readonly startedAt: number;
    readonly capabilities: ServiceCapabilities;
    readonly contextPolicy: ReturnType<typeof workerCompactionPolicy>;
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
}
/**
 * Machine-readable capability declaration.
 *
 * `methods` is the exact set of RPC method names the running service implements;
 * `unsupported` lists method names that are recognized but intentionally not
 * implemented (so a caller gets a truthful, stable answer instead of probing).
 */
export interface ServiceCapabilities {
    readonly protocolVersion: number;
    readonly schemaVersion: number;
    readonly projects: boolean;
    readonly sessions: boolean;
    readonly assignments: boolean;
    readonly toolExecution: boolean;
    readonly methods: readonly string[];
    readonly unsupported: readonly string[];
    /**
     * Per-method parameter metadata: the params each method accepts and, where
     * applicable, the idempotency key the managed client injects automatically.
     * This is descriptive (names + intent), not a full JSON schema.
     */
    readonly operations: Readonly<Record<string, OperationDescriptor>>;
}
/** Descriptive metadata for a single protocol method. */
export interface OperationDescriptor {
    /** Parameter names the method reads from `params`. */
    readonly params: readonly string[];
    /** Parameter that acts as the durable idempotency key, when applicable. */
    readonly requestId?: string;
    /** Parameters that control pagination, when applicable. */
    readonly pagination?: readonly string[];
    /** One-line summary of the method's scope/effect. */
    readonly summary: string;
}
/**
 * Every RPC method the service implements. This is the single source of truth
 * for the capability report and for the client's method discovery; adding a
 * `case` to {@link PiDurableService.dispatch} means adding its name here.
 */
export declare const IMPLEMENTED_METHODS: readonly string[];
/**
 * Descriptive metadata for the operator-facing methods whose params are most
 * likely to change or be misused: durable fork, live steering/follow-up, the
 * byte-bounded transcript/entry reads, per-session vs global usage, and task
 * listing. Reported verbatim by `service.capabilities` so an operator (or the
 * CLI) can discover the exact params and idempotency keys in this build.
 */
export declare const OPERATION_DESCRIPTORS: Readonly<Record<string, OperationDescriptor>>;
/** Methods that are recognized but deliberately unsupported in this build. */
export declare const UNSUPPORTED_METHODS: readonly string[];
/**
 * Compute the default private runtime directory for a state directory.
 *
 * The socket lives in a short, private, per-user runtime path that is
 * INDEPENDENT of the (possibly very long) source path: a Unix socket path is
 * limited to ~104 bytes, and state directories often exceed that. The path is
 * keyed by a short hash of the state directory so distinct states never share a
 * socket, while the total length stays well under the platform limit.
 *
 * The path is deterministic and independent of `$TMPDIR`: by default
 * `/tmp/pi-durable-<uid>/<statehash>/s`. A stable, short, world-readable-parent
 * location keeps the total length well under the platform limit and lets a
 * client configured with the same state directory derive the identical socket
 * path. The parent itself is created and verified as a private owned directory
 * by {@link bindSocket}, which never weakens a pre-existing shared `/tmp`.
 *
 * `PI_DURABLE_RUNTIME_DIR` may override the base directory (default `/tmp`).
 * This exists for isolated tests and sandboxed environments whose `/tmp` is not
 * writable; the resulting path is still validated against the socket-length
 * limit by {@link resolveSocketPath}. The default is unchanged for real hosts.
 */
export declare function resolveRuntimeDir(stateDir: string, env?: NodeJS.ProcessEnv): string;
/**
 * Resolve the socket path for a state directory, honoring `override`.
 *
 * Throws when the result would exceed the platform limit so the failure is
 * explicit rather than a truncated-path bind error.
 */
export declare function resolveSocketPath(stateDir: string, override?: string): string;
/**
 * Exclusive ownership lock for a state directory.
 *
 * Correctness requirements:
 *  - Two services must never own the same state directory.
 *  - A lock naming the CURRENT pid is refused (it is another service in this
 *    process, or a stale record from a crashed run in this same pid namespace).
 *  - A lock naming a DEAD pid is reclaimed.
 *  - Release only removes a lock still owned by this process (token check), so
 *    a late release never deletes a different process's lock.
 */
export declare class OwnerLock {
    readonly path: string;
    private readonly token;
    private released;
    private constructor();
    /** Acquire the lock, reclaiming a provably dead owner; throws otherwise. */
    static acquire(stateDir: string): Promise<OwnerLock>;
    /** Remove the lock only while this process still owns it. Idempotent. */
    release(): Promise<void>;
}
/**
 * The durable local service.
 *
 * Construct with {@link PiDurableService.start}; call {@link stop} to release
 * the socket, the stores, and the lock.
 */
export declare class PiDurableService {
    private readonly config;
    private readonly configFile;
    private readonly stateDir;
    private readonly socketPath;
    private readonly lock;
    private readonly metadata;
    private readonly storage;
    private readonly harness;
    private readonly registry;
    private readonly engine;
    private readonly server;
    private readonly modelSettings;
    private readonly providerId;
    private readonly knownSecrets;
    private readonly bootId;
    private readonly startedAt;
    private readonly manager;
    /**
     * Whether manager wake DISPATCH is actually active for this run: config opted
     * in (`manager.enabled !== false`) AND a dispatcher was constructed. This is
     * the truthful value reported by `manager.status.enabled`; the coordinator is
     * always constructed (so durable events still record when configured
     * disabled), but its dispatch capability is exactly this flag.
     */
    private readonly managerDispatchEnabled;
    private readonly sockets;
    private stopping;
    private stopped;
    private shutdownScheduled;
    private stopPromise;
    private readonly supervisor;
    private readonly workflow;
    private constructor();
    /**
     * Start the service: acquire the lock, open both stores, bind the socket, and
     * begin accepting requests. Resolves once the socket is listening.
     */
    static start(options: ServiceStartOptions): Promise<PiDurableService>;
    /** JSON-safe status report, including the resolved socket path. */
    status(): ServiceStatusReport;
    capabilities(): ServiceCapabilities;
    /** Resolved socket path clients should connect to. */
    get path(): string;
    /** Wait until the service has stopped (used by signal handlers). */
    waitUntilStopped(): Promise<void>;
    /** Stop accepting requests, close both stores, and release the lock. Idempotent. */
    stop(): Promise<void>;
    /**
     * Orderly shutdown requested over the wire (see `service.shutdown`).
     *
     * The response frame for the triggering request is written by {@link respond}
     * AFTER {@link handle} returns, so we must not tear the socket down in the
     * same turn: we defer the stop to the next macrotask. The returned promise
     * settles once teardown completes; callers normally do not await it.
     */
    private scheduleShutdown;
    private doStop;
    /** Surface (never swallow) a shutdown-drain failure to stderr. */
    private logStopFailure;
    /** Dispatch one decoded request to its handler. */
    handle(request: RpcRequest): Promise<RpcResponse>;
    private dispatch;
    /** Create a new project directory and git repository, idempotently. */
    private projectsCreate;
    /** Import an existing directory as a project, idempotently and non-destructively. */
    private projectsImport;
    private projectsShow;
    /** Create a real Pi conversation tied to a project, idempotently. */
    private sessionsCreate;
    private sessionsList;
    /**
     * Read a byte-bounded, ascending slice of a conversation's transcript.
     *
     * Pi pages entries by count, but a single entry (e.g. a large tool result)
     * can itself exceed the RPC frame limit. We therefore walk entries ONE at a
     * time via `entries({order:"ascending", ...}, 1, cursor)`; after each page the
     * returned `next` cursor points immediately before the first entry we have
     * NOT yet returned, so a truncated page never skips (or double-counts) an
     * entry. We stop when the serialized bytes would exceed `maxBytes` or we hit
     * `maxEntries`. An entry too large to fit alone is emitted as a summary with a
     * `truncated` flag and its `entryId`, retrievable in full via
     * `sessions.entry`. Secret values are redacted before serializing.
     */
    private readBoundedTranscript;
    /**
     * Encode Pi's object cursor as a versioned, opaque, self-describing string.
     *
     * The wire cursor is a base64url JSON envelope binding the continuation to the
     * session and the scan order. Encoding as a string (never an object) keeps the
     * JSON-RPC surface stable and validates cleanly on the next request — Pi's raw
     * object cursor cannot be passed straight back through an optional-string
     * param.
     */
    private encodeCursor;
    /** Decode + validate an opaque wire cursor; throws structured invalid_args. */
    private decodeCursor;
    /** Serialize one entry for the wire, redacting known secrets in `data`. */
    private frameEntry;
    /** Recursively redact known secret substrings from a JSON-ish value. */
    private redactValue;
    /** Read the real Pi conversation transcript and usage for a session. */
    private sessionsInspect;
    /**
     * Paginated raw transcript for a session.
     *
     * `cursor` is an opaque continuation token (the Pi entry cursor); pages are
     * byte-bounded (never more than ~256 KiB of serialized entries) so a large
     * history can never blow the RPC frame. Entries are returned oldest-first and
     * a truncated page's `nextCursor` resumes exactly at the first entry not yet
     * returned (no gaps, no duplicates). Read-only; runs no task code.
     */
    private sessionsTranscript;
    /**
     * Fetch one entry's serialized JSON chunk for full reconstruction.
     *
     * `offset` walks the entry's serialized JSON in `maxChars`-sized chunks
     * (default/cap 64 KiB of source chars) so a very large entry can be streamed
     * without a giant frame. Ownership is scoped to the session's own
     * conversation: an entry of another conversation is `not_found`.
     */
    private sessionsEntry;
    /** This conversation's own usage document, or an empty ledger. */
    private sessionUsageValue;
    /**
     * Live tasks and unsettled submissions for a session's conversation.
     *
     * Uses the public `Harness.inspect()` (a point-in-time view of unfinished
     * work) rather than `viewState()` — the latter returns the whole structural
     * view (conversation + entries + docs), which bloats the RPC frame with the
     * full transcript. We keep only compact scheduling/ownership metadata:
     * task `id`/`kind`/`state`/`ownership`/`status`, submission id/status — never
     * entry transcript or content.
     */
    private sessionsTasks;
    /**
     * Per-session usage: this session's OWN conversation ledger only.
     *
     * `Harness.usage()` sums every conversation in the session — wrong for a
     * per-session view. Instead we read the conversation-scoped `pi.usage`
     * document via the public `snapshot(UsageDoc, conversationId, ctx)`. The
     * numbers are token/counter metadata (`cost` is provider-reported or zero,
     * NOT a GPU or Modal bill). `scope: "session"` makes the boundary explicit.
     */
    private sessionsUsage;
    /**
     * Global usage summed across EVERY conversation in the harness (all sessions
     * in this daemon). Kept clearly scoped so it is never confused with the
     * per-session `sessions.usage`.
     */
    private sessionsUsageGlobal;
    /**
     * Fork a NEW session from a visible entry of an existing session.
     *
     * The fork starts a fresh conversation with the same project scope and copies
     * the same Modal model/budget agent, so it is safe to diverge without
     * touching the source transcript. No tools or model calls happen here.
     */
    private sessionsFork;
    /**
     * Admit a manual compaction task for a session's conversation.
     *
     * Compaction folds older context into a summary; it runs while the
     * conversation keeps working and places its summary at the next boundary.
     */
    private sessionsCompact;
    /**
     * Reconfigure a session's agent, restricted to the SAME Modal model and
     * budgets. Only `thinkingLevel` and `instructions` may change; the model is
     * pinned to this service's provider/model so a session can never be pointed
     * at a different provider (which would defeat the credential boundary).
     */
    private sessionsConfigure;
    /**
     * Reset a session's context to a fresh one, optionally with a handoff note.
     *
     * Refused unless the conversation is idle: resetting mid-run would discard
     * in-flight work. Callers who want to stop in-flight work should abort the
     * assignment first.
     */
    private sessionsReset;
    /**
     * Route steering/follow-up through the guarded assignment engine.
     *
     * We require an assignment id so the writer lease and budget remain enforced;
     * a bare session cannot be steered without one, because that would create
     * unmanaged input.
     */
    private sessionsSteer;
    /** Resolve a session by `id`, or throw a redacted `not_found`. */
    private requireSession;
    /** Resolve a session's live Pi conversation by conversation id. */
    private requireConversation;
    /**
     * Parse the optional `order` scan direction.
     *
     * `descending` returns newest-first (used for CTO checkpoints); default is
     * `ascending` (oldest-first). Anything else is a structured invalid-args
     * error rather than a silent fallback.
     */
    private readOrder;
    /** Whether the conversation's ordinary ownership scope has no live work. */
    private isIdle;
    /**
     * Admit a coding assignment for a project, idempotently.
     *
     * The `requestId` doubles as the correlation id (filled by the client) and
     * the engine's idempotency key. It is REQUIRED: a retry of the same
     * `(requestId, payload)` replays the stored assignment; a different payload
     * under the same id is a `conflict`. Submit returns as soon as the input is
     * admitted; settlement happens in the background.
     */
    private assignmentsSubmit;
    /** Read one assignment's durable detail by `id` or `requestId`. */
    private assignmentsShow;
    /** Record an operator verdict (`accept` / `revise`) for a settled assignment. */
    private assignmentsReview;
    /** Return one bounded page of an assignment's recorded evidence bundle. */
    private assignmentsEvidence;
    /** Read a bounded slice of a recorded artifact (owned ids only). */
    private assignmentsArtifact;
    /** Show the recorded checkpoint manifest ref, counts, and verified state. */
    private assignmentsCheckpoint;
    /** Restore an assignment's recorded pre-image checkpoint (explicit, idempotent). */
    private assignmentsRestore;
    /**
     * Bind a project to an EXPLICIT manager thread UUID. The manager caller
     * supplies the existing GUI session UUID; the CLI may default it to
     * `CODEX_THREAD_ID` from the environment. Binding is FROM NOW: no historical
     * job is replayed. The worker never calls this and can never choose a target.
     */
    private managerBind;
    /** Remove a project's manager binding. Pending events stay durably recorded. */
    private managerUnbind;
    /**
     * Delivery health. Truthfully reports whether the dispatcher is enabled, how
     * many events are pending vs parked-failed, and the next scheduled retry — so
     * an operator can see a missing/offline Codex CLI instead of a silent gap.
     */
    private managerStatus;
    /** List durable manager events: ids + bounded summaries, never raw transcripts. */
    private managerEvents;
    /** Acknowledge an event idempotently so it is never re-delivered. */
    private managerAck;
    private managerDecision;
    /**
     * Canonicalize and enforce the configured project boundary.
     *
     * Both the requested path AND the configured allowed roots are canonicalized
     * through the same routine so path aliases (`/var` vs `/private/var`, other
     * symlinked prefixes) compare equal. Canonicalization only follows symlinks
     * that already exist on disk, so this never widens the boundary; the
     * symlink-escape rejection downstream is unchanged.
     */
    private assertWithinRoots;
    private toErrorResponse;
    private redact;
    /** Redact known secrets out of caller-supplied text before it is stored. */
    private redactString;
    private listen;
    /**
     * Attach the newline-delimited JSON-RPC framing loop to a connected stream.
     *
     * Production reaches this through the Unix-domain socket server; tests can
     * drive the exact same protocol over an in-memory or loopback socket, which
     * keeps the transport out of the protocol's logic.
     */
    attachSocket(socket: Socket): void;
    private respond;
}
/** Install SIGINT/SIGTERM handlers that stop the service cleanly. */
export declare function installSignalHandlers(service: PiDurableService): void;
/** True when this module is the process entry point (foreground `serve`). */
export declare function serveMain(argv: readonly string[]): Promise<number>;
//# sourceMappingURL=service.d.ts.map