import { PERMISSION_OPERATIONS, permissionOperation, effectivePermissions } from "./permissions.js";
import { CODEX_REPO_GUIDANCE } from "./codex-repo-guidance.js";
import { withWorkerPolicy } from "./worker-instructions.js";
import { ModelSettings, MODEL_OPERATIONS } from './model-settings.js';
import { parseProfile, profileKey, recentValidation } from "./host-validation.js";
import { briefView } from "./working-brief.js";
import { workerCompactionPolicy } from "./context-policy.js";
import { writeFileSync, renameSync } from 'node:fs';
import { SCORECARD_OPERATIONS, scorecardOperation, activityCategory, recordWorkflowActivity } from './scorecard.js';
import { WorkflowService, WORKFLOW_OPERATIONS, projectWorkflow, workflowOwns } from './workflow.js';
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
import { connect, createServer } from "node:net";
import { chmod, mkdir, open as openFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, UsageDoc, } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { allowNetwork, loadConfig } from "./config.js";
import { resolveCredential } from "./credential.js";
import { createModalModels, MODAL_PROVIDER_ID, configuredProviderId } from "./provider.js";
import { redactError, redactString } from "./redact.js";
import { AssignmentEngine, AssignmentError, } from "./assignments.js";
import { MetadataStore, StoreError, } from "./store.js";
import { planQuarantine, waitForGroupsGone } from "./process-quarantine.js";
import { ManagerDispatcher, retryBackoffMs } from "./manager-dispatcher.js";
import { ManagerWakeCoordinator } from "./manager-coordinator.js";
import { managerExecutable, managerEnabled } from "./config.js";
import { packageVersion } from "./version.js";
import { AdaptiveSupervisor } from "./supervision.js";
/** Protocol version spoken over the socket. */
export const PROTOCOL_VERSION = 1;
/** Maximum size of a single request or response frame, in bytes. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** How long a client may wait for one response by default, in milliseconds. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** File name of the ownership lock inside the state directory. */
const LOCK_FILE_NAME = "service.lock";
/** File name of our application metadata database inside the state directory. */
const METADATA_FILE_NAME = "metadata.sqlite";
/** File name of Pi's durable store inside the state directory. */
const PI_STORE_FILE_NAME = "pi.sqlite";
/** Codex guidance only; imports never replace existing repository instructions. */
export const PORTABLE_AGENTS_MD = CODEX_REPO_GUIDANCE;
/** Prefix used for auto-generated project/session ids. */
const ID_PREFIX = "pdm";
/** Default Unix socket path length ceiling (Linux `sun_path` is 108 incl. NUL). */
const MAX_SOCKET_PATH_BYTES = 100;
/** File name of the Unix socket inside a resolved runtime directory. */
const SOCKET_FILE_NAME = "s";
/** Methods that are recognized but not implemented in this slice. */
const NOT_YET_IMPLEMENTED = new Set([]);
/**
 * Raised for service setup/usage problems. The message is safe to surface to a
 * client: it never contains credentials or raw config objects.
 */
export class ServiceError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ServiceError";
        this.code = code;
    }
}
/**
 * Every RPC method the service implements. This is the single source of truth
 * for the capability report and for the client's method discovery; adding a
 * `case` to {@link PiDurableService.dispatch} means adding its name here.
 */
export const IMPLEMENTED_METHODS = [
    ...Object.keys(WORKFLOW_OPERATIONS),
    ...Object.keys(SCORECARD_OPERATIONS),
    ...Object.keys(MODEL_OPERATIONS),
    ...Object.keys(PERMISSION_OPERATIONS),
    "validation.configure", "validation.profiles", "validation.results", "brief.inspect",
    "service.ping",
    "service.status",
    "service.version",
    "service.capabilities",
    "service.shutdown",
    "projects.create",
    "projects.import",
    "projects.list",
    "projects.show",
    "sessions.create",
    "sessions.list",
    "sessions.inspect",
    "sessions.model",
    "sessions.transcript",
    "sessions.entry",
    "sessions.tasks",
    "sessions.usage",
    "sessions.usageGlobal",
    "sessions.fork",
    "sessions.compact",
    "sessions.configure",
    "sessions.reset",
    "sessions.steer",
    "sessions.followup",
    "assignments.create",
    "assignments.submit",
    "assignments.show",
    "assignments.inspect",
    "assignments.list",
    "assignments.wait",
    "assignments.abort",
    "assignments.cancel",
    "assignments.pause",
    "assignments.review",
    "assignments.recover",
    "assignments.evidence",
    "assignments.artifact",
    "assignments.checkpoint",
    "assignments.restore",
    "manager.bind",
    "manager.unbind",
    "manager.list",
    "manager.status",
    "manager.events",
    "manager.ack",
    "manager.decision",
    "activity.list",
    "activity.note",
    "supervision.configure",
    "supervision.status",
];
/**
 * Descriptive metadata for the operator-facing methods whose params are most
 * likely to change or be misused: durable fork, live steering/follow-up, the
 * byte-bounded transcript/entry reads, per-session vs global usage, and task
 * listing. Reported verbatim by `service.capabilities` so an operator (or the
 * CLI) can discover the exact params and idempotency keys in this build.
 */
export const OPERATION_DESCRIPTORS = {
    ...WORKFLOW_OPERATIONS,
    ...SCORECARD_OPERATIONS,
    ...MODEL_OPERATIONS,
    ...PERMISSION_OPERATIONS,
    'assignments.pause': { params: ['id', 'note', 'requestId'], requestId: 'requestId', summary: 'Durable admission fence: allow admitted tools to finish, then safely pause while retaining the lease. Read workflow.status for confirmation.' },
    "sessions.model": { params: ["id"], summary: "Compact pinned session provider/profile/model attribution, without transcript or credentials." },
    "activity.list": { params: ["after", "limit", "projectId"], pagination: ["after"], summary: "Read the durable redacted activity journal by monotonic cursor; <=500KiB/page." },
    "activity.note": { params: ["message", "tag", "requestId"], requestId: "requestId", summary: "Record a redacted manager/runtime-guard note with an idempotent receipt." },
    "supervision.configure": { params: ["assignmentId", "policy", "requestId"], requestId: "requestId", summary: "Persist adaptive check/review policy; no execution deadline and no model polling." },
    "supervision.status": { params: ["projectId"], summary: "Last/next checks and observed progress, including settled snapshots." },
    "validation.configure": { params: ["projectId", "profile", "requestId"], requestId: "requestId", summary: "Manager configures a declarative host browser profile while the project has no active writer. No host shell or project scripts." },
    "validation.profiles": { params: ["projectId"], summary: "Read manager-defined validation profiles." },
    "validation.results": { params: ["assignmentId"], summary: "Read observed, snapshot-bound browser outcomes." },
    "brief.inspect": { params: ["assignmentId"], summary: "Read current/inherited worker notes with live hash freshness checks." },
    "manager.decision": { params: ["eventId", "action", "note", "requestId"], requestId: "requestId", summary: "Record an idempotent manager decision before handling and acknowledging a wake." },
    "sessions.fork": {
        params: ["id", "at", "requestId"],
        requestId: "requestId",
        summary: "Fork a session's conversation at a validated entry id.",
    },
    "sessions.steer": {
        params: ["assignmentId", "content", "activityCategory", "requestId"],
        requestId: "requestId",
        summary: "Tracked operator steering input for a leased, non-closing assignment.",
    },
    "sessions.followup": {
        params: ["assignmentId", "content", "activityCategory", "requestId"],
        requestId: "requestId",
        summary: "Tracked operator follow-up input for a leased, non-closing assignment.",
    },
    "sessions.transcript": {
        params: ["id", "order", "limit", "cursor"],
        pagination: ["order", "cursor"],
        summary: "Byte-bounded (<=256KiB) raw transcript page; never skips entries.",
    },
    "sessions.inspect": {
        params: ["id", "order", "cursor"],
        pagination: ["order", "cursor"],
        summary: "Conversation metadata plus a bounded transcript page.",
    },
    "sessions.entry": {
        params: ["id", "entryId", "offset", "maxChars"],
        summary: "Stream one entry's redacted JSON in <=64KiB chunks for reconstruction.",
    },
    "sessions.tasks": {
        params: ["id"],
        summary: "Compact task/submission records scoped to the session (no transcript).",
    },
    "sessions.usage": {
        params: ["id"],
        summary: "Per-session usage ledger (scope: 'session').",
    },
    "sessions.usageGlobal": {
        params: [],
        summary: "Service-wide usage aggregate (scope: 'global').",
    },
    "assignments.recover": {
        params: ["id", "requestId", "sessionId"],
        requestId: "requestId",
        summary: "Reconcile/reattach a running assignment's tracked inputs after restart, or start a fresh assignment for a blocked row. A retired session is never inherited; pass a fresh sessionId.",
    },
    "assignments.evidence": {
        params: ["id", "section", "offset", "limit", "allowLegacy"],
        pagination: ["offset", "limit"],
        summary: "One <=64KiB page of a stored evidence bundle (section-scoped, sha256 + nextOffset). Legacy rows require allowLegacy:true.",
    },
    "assignments.artifact": {
        params: ["id", "artifactId", "offset", "maxChars"],
        pagination: ["offset", "maxChars"],
        summary: "Read a <=64KiB redacted slice of a recorded command-output artifact (owned ids only).",
    },
    "assignments.checkpoint": {
        params: ["id"],
        summary: "Show the pre-admission checkpoint manifest ref, counts, and verified state.",
    },
    "assignments.restore": {
        params: ["id", "paths", "overwrite", "expectedHash", "requestId"],
        requestId: "requestId",
        summary: "Restore a recorded pre-image checkpoint (missing-only by default); idempotent, writer-leased.",
    },
    "manager.bind": {
        params: ["projectId", "threadId", "requestId"],
        requestId: "requestId",
        summary: "Bind a project to an EXPLICIT Codex manager thread UUID (the existing GUI chat). Binds from NOW; no historical replay. threadId defaults to CODEX_THREAD_ID when omitted. The worker can never choose the target.",
    },
    "manager.unbind": {
        params: ["projectId"],
        summary: "Remove a project's manager binding. Pending events remain durably recorded and undelivered.",
    },
    "manager.list": {
        params: [],
        summary: "List every project → manager-thread binding (one row per project).",
    },
    "manager.status": {
        params: ["projectId"],
        summary: "Delivery health: enabled flag, bound projects, pending/failed counts, and next retry times.",
    },
    "manager.events": {
        params: ["projectId", "unacked", "limit"],
        pagination: ["limit"],
        summary: "List durable manager events (ids + summaries, never raw transcripts); filter by project and ack state.",
    },
    "manager.ack": {
        params: ["eventId", "requestId"],
        requestId: "requestId",
        summary: "Acknowledge an event idempotently so it is never re-delivered to the manager.",
    },
};
/** Methods that are recognized but deliberately unsupported in this build. */
export const UNSUPPORTED_METHODS = [
    // Bare conversation writes would bypass the assignment lease/budget, so they
    // are refused; steering/follow-up must route through the guarded session
    // lifecycle (sessions.steer / sessions.followup) or a new assignment.
    "conversation.submit",
    "sessions.delete",
    "projects.delete",
];
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
export function resolveRuntimeDir(stateDir, env = process.env) {
    const key = createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 16);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const override = env.PI_DURABLE_RUNTIME_DIR;
    const base = override !== undefined && override.length > 0 ? resolve(override) : "/tmp";
    return join(base, `pi-durable-${uid}`, key);
}
/**
 * Resolve the socket path for a state directory, honoring `override`.
 *
 * Throws when the result would exceed the platform limit so the failure is
 * explicit rather than a truncated-path bind error.
 */
export function resolveSocketPath(stateDir, override) {
    const path = override !== undefined ? resolve(override) : join(resolveRuntimeDir(stateDir), SOCKET_FILE_NAME);
    const bytes = Buffer.byteLength(path);
    if (bytes > MAX_SOCKET_PATH_BYTES) {
        throw new ServiceError("socket_path_too_long", `Socket path is ${bytes} bytes, exceeding the ${MAX_SOCKET_PATH_BYTES}-byte limit: ${path}`);
    }
    return path;
}
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
export class OwnerLock {
    path;
    token;
    released = false;
    constructor(path, token) {
        this.path = path;
        this.token = token;
    }
    /** Acquire the lock, reclaiming a provably dead owner; throws otherwise. */
    static async acquire(stateDir) {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await chmod(stateDir, 0o700).catch(() => undefined);
        const path = join(resolve(stateDir), LOCK_FILE_NAME);
        const token = randomUUID();
        const write = async () => {
            const handle = await openFile(path, "w", 0o600);
            try {
                await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
            }
            finally {
                await handle.close();
            }
        };
        if (existsSync(path)) {
            const owner = await readLock(path);
            if (owner === undefined || !canReclaim(owner.pid)) {
                throw new ServiceError("locked", `State directory is already in use by another service: ${stateDir}`);
            }
            // The prior owner is provably gone; clear and re-create.
            await rm(path, { force: true });
            await write();
            return new OwnerLock(path, token);
        }
        try {
            await write();
        }
        catch (error) {
            if (error.code === "EEXIST") {
                throw new ServiceError("locked", `State directory is already in use by another service: ${stateDir}`);
            }
            throw error;
        }
        return new OwnerLock(path, token);
    }
    /** Remove the lock only while this process still owns it. Idempotent. */
    async release() {
        if (this.released)
            return;
        this.released = true;
        const owner = await readLock(this.path);
        // Never delete a lock recorded by a different pid or a different token.
        if (owner !== undefined && (owner.pid !== process.pid || owner.token !== this.token))
            return;
        await rm(this.path, { force: true }).catch(() => undefined);
    }
}
async function readLock(path) {
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0)
            return undefined;
        return { pid: parsed.pid, token: typeof parsed.token === "string" ? parsed.token : "" };
    }
    catch {
        return undefined;
    }
}
/**
 * Whether a lock owned by `pid` may be reclaimed.
 *
 * A lock naming our own pid is NEVER reclaimable: it means another service is
 * running in this process (or a crashed one left a record we must not stomp).
 */
function canReclaim(pid) {
    if (pid === process.pid)
        return false;
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (error) {
        return error.code === "ESRCH";
    }
}
/**
 * The durable local service.
 *
 * Construct with {@link PiDurableService.start}; call {@link stop} to release
 * the socket, the stores, and the lock.
 */
export class PiDurableService {
    config;
    configFile;
    stateDir;
    socketPath;
    lock;
    metadata;
    storage;
    harness;
    registry;
    engine;
    server;
    modelSettings;
    providerId;
    knownSecrets;
    bootId;
    startedAt = Date.now();
    manager;
    /**
     * Whether manager wake DISPATCH is actually active for this run: config opted
     * in (`manager.enabled !== false`) AND a dispatcher was constructed. This is
     * the truthful value reported by `manager.status.enabled`; the coordinator is
     * always constructed (so durable events still record when configured
     * disabled), but its dispatch capability is exactly this flag.
     */
    managerDispatchEnabled;
    sockets = new Set();
    stopping = false;
    stopped = false;
    shutdownScheduled = false;
    stopPromise;
    supervisor;
    workflow;
    constructor(init) {
        this.config = init.config;
        this.configFile = init.configFile;
        this.stateDir = init.stateDir;
        this.socketPath = init.socketPath;
        this.lock = init.lock;
        this.metadata = init.metadata;
        this.storage = init.storage;
        this.harness = init.harness;
        this.registry = init.registry;
        this.engine = init.engine;
        this.server = init.server;
        this.providerId = init.providerId;
        this.modelSettings = init.modelSettings;
        this.knownSecrets = init.knownSecrets;
        this.bootId = init.bootId;
        this.manager = init.manager;
        this.managerDispatchEnabled = init.managerDispatchEnabled;
        this.supervisor = new AdaptiveSupervisor(init.metadata, init.manager);
        this.workflow = new WorkflowService(init.metadata, (method, params) => this.dispatch(method, params), () => {
            const targets = (this.metadata.getControl('workflow-index') ?? []).map(id => this.metadata.getControl(`workflow:${id}`)).filter(t => t?.state === 'active').map(t => ({ id: t.id, threadId: t.threadId }));
            const path = join(this.stateDir, 'workflow-managers.json');
            writeFileSync(path + '.next', JSON.stringify({ targets }), { mode: 0o600 });
            renameSync(path + '.next', path);
            this.manager?.drain();
        });
    }
    /**
     * Start the service: acquire the lock, open both stores, bind the socket, and
     * begin accepting requests. Resolves once the socket is listening.
     */
    static async start(options) {
        const host = options.host ?? {};
        if (options.configFile === undefined && host.config === undefined) {
            throw new ServiceError("args", "A config file or an injected config is required.");
        }
        const config = host.config ?? (await loadConfig(options.configFile));
        const configFile = options.configFile !== undefined ? resolve(options.configFile) : null;
        const stateDir = resolve(host.runtimeDir ?? config.paths.stateDir);
        const socketPath = resolveSocketPath(stateDir, options.socketPath);
        // Unique id for THIS service boot. Receipts are stamped with it so a later
        // boot can detect commands that may have run before a crash.
        const bootId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await chmod(stateDir, 0o700).catch(() => undefined);
        const lock = await OwnerLock.acquire(stateDir);
        let metadata;
        let storage;
        let harness;
        let boundServer;
        try {
            metadata = await MetadataStore.open(join(stateDir, METADATA_FILE_NAME));
            storage = await openNodeSqliteStorage(join(stateDir, PI_STORE_FILE_NAME));
            const resolveCred = host.resolveCredential ?? ((ref) => resolveCredential(ref));
            const credential = await resolveCred(config.credential);
            const knownSecrets = [credential.apiKey];
            const modelSettings = new ModelSettings(metadata, config, () => (host.createModels ?? createModalModels)(config, credential), host.providerId ?? configuredProviderId(config), knownSecrets);
            await modelSettings.initialize();
            const models = () => modelSettings.models();
            metadata.setActivitySecrets(knownSecrets);
            // The tool registry is shared across the service lifetime. The engine
            // installs one uniquely-named extension per project, so a conversation
            // can enable exactly its own bundle and never another project's tools.
            const registry = createRegistry();
            harness = await Harness.open(storage, { models, registry, settings: { compaction: { ...workerCompactionPolicy(config.limits.contextWindow, config.limits.maxTokens), modelOverrides: modelSettings.compaction } } }, BACKGROUND_CONTEXT);
            // The credential file must never be readable or writable by sandboxed
            // tools, even when it lives outside the home directory (for example under
            // a project checkout). Protect its directory explicitly.
            const credentialPaths = config.credential.apiKeyFile !== undefined ? [config.credential.apiKeyFile] : [];
            // Event-driven manager wake-up. The dispatcher runs OUTSIDE any LLM
            // request, spawning `codex queue` (ARGV array, no shell) with a trusted
            // env allowlist. It is constructed only when config enables it; a missing
            // Codex CLI degrades gracefully (events stay pending, delivery health is
            // surfaced) rather than crashing the service.
            const dispatchEnabled = managerEnabled(config);
            const dispatcher = dispatchEnabled
                ? new ManagerDispatcher({
                    executable: managerExecutable(config),
                    baseArgs: config.manager?.cliBaseArgs,
                    timeoutMs: config.manager?.cliTimeoutMs,
                    knownSecrets,
                })
                : null;
            const manager = new ManagerWakeCoordinator({
                metadata,
                dispatcher,
                // Thread the SAME config-derived flag into the coordinator so its
                // scheduling gate and `manager.status.enabled` can never disagree: a
                // configured-disabled manager still RECORDS durable events, but never
                // dispatches, and reports truthfully disabled.
                enabled: dispatchEnabled,
                maxAttempts: config.manager?.maxAttempts,
            });
            let refreshSupervision = () => { };
            const engine = new AssignmentEngine({
                harness,
                registry,
                metadata,
                config,
                providerId: host.providerId ?? configuredProviderId(config),
                modelForSession: (projectId, sessionId) => modelSettings.sessionRef(projectId, sessionId),
                stateDir,
                configFile,
                // The credential file and the socket must never be writable by tools.
                protectedPaths: [socketPath, ...credentialPaths],
                knownSecrets,
                createTools: host.createTools,
                unsandboxedForTesting: host.unsandboxedForTesting,
                runHostCommand: host.runHostCommand,
                // A host override wins; otherwise the config's explicit opt-in applies.
                allowNetwork: host.allowNetwork ?? allowNetwork(config),
                bootId,
                // Every persisted state change flows here; the coordinator decides
                // (code-only, deduplicated) whether it warrants a manager wake.
                onTransition: (transition) => {
                    const eventId = manager.recordTransition(transition);
                    queueMicrotask(() => refreshSupervision());
                    return eventId;
                },
            });
            // Mark THIS boot DIRTY BEFORE any tool can run, then inspect every prior
            // boot that did not shut down cleanly. A prior dirty boot that recorded a
            // command process group quarantines its assignment: an external command
            // may have executed before its Pi result was committed, so we must NOT
            // auto-rerun or free its lease. We wait, bounded, for the recorded groups
            // to die on their own and NEVER signal a possibly-reused old pgid.
            metadata.beginServiceRun(bootId, process.pid, Date.now());
            const quarantine = planQuarantine(metadata, bootId);
            if (quarantine.length > 0) {
                await waitForGroupsGone(quarantine, 3000);
            }
            // Block in-doubt rows BEFORE any durable conversation is resumed, so a
            // quarantined command is never blindly re-driven by the harness.
            await engine.applyQuarantine(quarantine);
            // Re-install every known project's extension BEFORE resuming so durable
            // conversations never resume referencing a registry entry that is absent.
            await engine.preloadProjects();
            harness.resume();
            // Reattach to any NORMAL assignments left running by a previous process
            // BEFORE the RPC socket is bound, so a caller can never observe a service
            // that has not yet reconciled durable state.
            await engine.reconcile(quarantine);
            const server = options.transport === "none" ? undefined : await bindSocket(socketPath);
            boundServer = server;
            const instance = new PiDurableService({
                config,
                configFile,
                stateDir,
                socketPath,
                lock,
                metadata,
                storage,
                harness,
                registry,
                engine,
                server,
                providerId: host.providerId ?? configuredProviderId(config),
                modelSettings,
                knownSecrets,
                bootId,
                manager,
                // Truthful: dispatch is active only when config enables it AND a
                // dispatcher was constructed. The coordinator is always present so
                // events still record, but the manager is NOT `enabled` for delivery.
                managerDispatchEnabled: dispatchEnabled && dispatcher !== null,
            });
            // Drain any durable events left pending by a prior boot. This is
            // code-only: the coordinator re-schedules delivery of already-recorded
            // events (idempotent by dedup key) and never re-observes history.
            manager.drain();
            refreshSupervision = () => instance.supervisor.refresh();
            metadata.appendActivity({ kind: "service.started", projectId: null, assignmentId: null, requestId: null,
                dedupKey: `boot:${bootId}`, data: { bootId, pid: process.pid, version: packageVersion() } });
            instance.supervisor.start();
            instance.listen();
            return instance;
        }
        catch (error) {
            if (harness !== undefined)
                await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
            if (storage !== undefined)
                await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
            metadata?.close();
            await lock.release();
            if (boundServer !== undefined) {
                await new Promise((resolveClose) => boundServer.close(() => resolveClose())).catch(() => undefined);
                await rm(socketPath, { force: true }).catch(() => undefined);
            }
            throw error;
        }
    }
    /** JSON-safe status report, including the resolved socket path. */
    status() {
        return {
            pid: process.pid,
            packageVersion: packageVersion(),
            protocolVersion: PROTOCOL_VERSION,
            schemaVersion: this.metadata.schemaVersion,
            socketPath: this.socketPath,
            stateDir: this.stateDir,
            configFile: this.configFile,
            model: this.config.model,
            providerId: this.providerId,
            startedAt: this.startedAt,
            capabilities: this.capabilities(),
            contextPolicy: workerCompactionPolicy(this.config.limits.contextWindow, this.config.limits.maxTokens),
            contextWindow: this.config.limits.contextWindow,
            maxOutputTokens: this.config.limits.maxTokens,
        };
    }
    capabilities() {
        return {
            protocolVersion: PROTOCOL_VERSION,
            schemaVersion: this.metadata.schemaVersion,
            projects: true,
            sessions: true,
            assignments: true,
            toolExecution: true,
            methods: [...IMPLEMENTED_METHODS],
            unsupported: [...UNSUPPORTED_METHODS],
            operations: OPERATION_DESCRIPTORS,
        };
    }
    /** Resolved socket path clients should connect to. */
    get path() {
        return this.socketPath;
    }
    /** Wait until the service has stopped (used by signal handlers). */
    waitUntilStopped() {
        if (this.stopPromise !== undefined)
            return this.stopPromise;
        if (this.server === undefined) {
            return this.stop();
        }
        return new Promise((resolveStopped) => {
            if (this.stopped) {
                resolveStopped();
                return;
            }
            this.server.once("close", () => resolveStopped());
        });
    }
    /** Stop accepting requests, close both stores, and release the lock. Idempotent. */
    stop() {
        if (this.stopPromise === undefined)
            this.stopPromise = this.doStop();
        return this.stopPromise;
    }
    /**
     * Orderly shutdown requested over the wire (see `service.shutdown`).
     *
     * The response frame for the triggering request is written by {@link respond}
     * AFTER {@link handle} returns, so we must not tear the socket down in the
     * same turn: we defer the stop to the next macrotask. The returned promise
     * settles once teardown completes; callers normally do not await it.
     */
    scheduleShutdown() {
        if (this.shutdownScheduled)
            return;
        this.shutdownScheduled = true;
        setImmediate(() => {
            void this.stop().catch(() => undefined);
        });
    }
    async doStop() {
        if (this.stopping)
            return;
        this.stopping = true;
        this.stopped = true;
        this.supervisor.stop();
        this.metadata.appendActivity({ kind: "service.stopping", projectId: null, assignmentId: null, requestId: null,
            dedupKey: `stop:${this.bootId}`, data: { bootId: this.bootId, pid: process.pid } });
        if (this.server !== undefined) {
            const server = this.server;
            // Stop accepting new connections, then DESTROY the active ones. Node's
            // `server.close()` callback only fires once every connection has ended, so
            // awaiting it before destroying sockets would deadlock when a client keeps
            // an idle connection open. Destroy first, then await the close.
            const closed = new Promise((resolveClose) => {
                if (server.listening === false) {
                    resolveClose();
                    return;
                }
                server.once("close", () => resolveClose());
            });
            server.close();
            for (const socket of this.sockets)
                socket.destroy();
            this.sockets.clear();
            await closed;
        }
        // Fully drain: stop every tool group, await background settlement, THEN
        // close Pi storage. The boot is recorded CLEAN only if EVERY step succeeds.
        // Any failure leaves the boot DIRTY so the next start quarantines in-doubt
        // commands rather than trusting this run.
        let clean = true;
        try {
            // Cancel any pending manager-delivery timers AND abort+join any in-flight
            // `codex queue` child FIRST, so no dispatch can touch the store after it
            // is closed. Await the join before stopping the engine/storage.
            await this.manager?.stop();
            await this.engine.stopAll();
            await this.harness.close(BACKGROUND_CONTEXT);
            await this.storage.close(BACKGROUND_CONTEXT);
        }
        catch (error) {
            clean = false;
            this.logStopFailure(error);
        }
        if (clean) {
            this.metadata.markServiceRunClean(this.bootId, Date.now());
        }
        this.metadata.close();
        await rm(this.socketPath, { force: true }).catch(() => undefined);
        await this.lock.release();
    }
    /** Surface (never swallow) a shutdown-drain failure to stderr. */
    logStopFailure(error) {
        process.stderr.write(`[pi-durable-manager] unclean shutdown; boot ${this.bootId} left DIRTY: ` +
            `${error instanceof Error ? error.message : String(error)}\n`);
    }
    /** Dispatch one decoded request to its handler. */
    async handle(request) {
        const id = typeof request.id === "string" ? request.id : "";
        if (request.v !== PROTOCOL_VERSION) {
            return errorResponse(id, "version_mismatch", `Unsupported protocol version: ${String(request.v)}.`);
        }
        const params = (request.params ?? {});
        const mutating = request.method.startsWith("scorecard.") && !["scorecard.read", "scorecard.ledger"].includes(request.method) || request.method.startsWith("workflow.") && !["workflow.list", "workflow.status", "workflow.event", "workflow.assignments"].includes(request.method) || /^(service\.shutdown|projects\.(create|import)|sessions\.(create|steer|followup|configure|compact|reset|fork)|assignments\.(create|submit|abort|cancel|pause|review|restore|recover)|manager\.(bind|unbind|ack|decision)|supervision\.configure)$/.test(request.method);
        const assignment = typeof params.assignmentId === "string" ? this.metadata.getAssignment(params.assignmentId)
            : typeof params.id === "string" && request.method.startsWith("assignments.") ? this.metadata.getAssignment(params.id) : undefined;
        const context = { projectId: assignment?.projectId ?? (typeof params.projectId === "string" ? params.projectId : null),
            assignmentId: assignment?.id ?? null, requestId: typeof params.requestId === "string" ? params.requestId : id, dedupKey: null };
        try {
            if (mutating)
                this.metadata.appendActivity({ ...context, kind: "manager.request", data: { method: request.method, params } });
            const result = await this.dispatch(request.method, params);
            if (mutating) {
                this.metadata.appendActivity({ ...context, kind: "manager.result", data: { method: request.method, result } });
                this.supervisor.refresh();
            }
            return { v: PROTOCOL_VERSION, id, result };
        }
        catch (error) {
            if (mutating)
                this.metadata.appendActivity({ ...context, kind: "manager.error", data: { method: request.method, error: this.redact(error) } });
            return this.toErrorResponse(id, error);
        }
    }
    async dispatch(method, params) {
        if (NOT_YET_IMPLEMENTED.has(method)) {
            throw new ServiceError("not_yet_implemented", `Method ${method} is recognized but not implemented in this service slice.`);
        }
        if (method.startsWith("permissions."))
            return permissionOperation(this.metadata, allowNetwork(this.config), method, params);
        if (method.startsWith("models."))
            return await this.modelSettings.run(method, params);
        if (method.startsWith("scorecard."))
            return scorecardOperation(this.metadata, method, params);
        if (method.startsWith("workflow."))
            return await this.workflow.run(method, params);
        switch (method) {
            case "brief.inspect": {
                const row = this.metadata.getAssignment(requireString(params, "assignmentId"));
                if (!row)
                    throw new ServiceError("not_found", "Assignment missing");
                const project = this.metadata.getProject(row.projectId);
                return await briefView(this.metadata, row, project.path, [this.config.paths.stateDir]);
            }
            case "validation.results": return { results: recentValidation(this.metadata, requireString(params, "assignmentId")) };
            case "validation.profiles": {
                const projectId = requireString(params, "projectId"), names = this.metadata.getControl(`validation-profiles:${projectId}`) ?? [];
                return { profiles: names.map(n => this.metadata.getControl(profileKey(projectId, n))) };
            }
            case "validation.configure": {
                const projectId = requireString(params, "projectId"), requestId = requireString(params, "requestId"), project = this.metadata.getProject(projectId);
                if (!project)
                    throw new ServiceError("not_found", "Project missing");
                const profile = parseProfile(params.profile), prior = this.metadata.beginJournal("validation.configure", requestId, { projectId, profile });
                if (prior.replayed && prior.record.status === "ready")
                    return { profile, replayed: true };
                if (this.metadata.getActiveLease(project.path))
                    throw new ServiceError("writer_active", "Configure validation before submitting work, while no writer holds this checkout");
                const names = this.metadata.getControl(`validation-profiles:${projectId}`) ?? [];
                if (!names.includes(profile.name))
                    names.push(profile.name);
                if (names.length > 8)
                    throw new ServiceError("invalid_params", "At most 8 profiles per project");
                this.metadata.setControl(profileKey(projectId, profile.name), profile);
                this.metadata.setControl(`validation-profiles:${projectId}`, names);
                this.metadata.completeJournal("validation.configure", requestId, profile.name);
                return { profile, replayed: false };
            }
            case "activity.note": {
                const requestId = requireString(params, "requestId");
                const message = requireString(params, "message");
                const tag = optionalString(params, "tag") ?? "manager.note";
                if (!/^[a-z][a-z0-9_.-]{0,50}$/.test(tag) || message.length > 12000)
                    throw new ServiceError("invalid_params", "Invalid journal note.");
                const prior = this.metadata.beginJournal("activity.note", requestId, { tag, message });
                const entry = this.metadata.appendActivity({ kind: tag, projectId: null, assignmentId: null, requestId,
                    dedupKey: `note:${requestId}`, data: { message } });
                this.metadata.completeJournal("activity.note", requestId, String(entry.seq));
                return { seq: entry.seq, replayed: prior.replayed };
            }
            case "activity.list": {
                const after = optionalNumber(params, "after") ?? 0;
                const limit = optionalNumber(params, "limit") ?? 50;
                if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
                    throw new ServiceError("invalid_params", "Invalid activity cursor/limit.");
                const entries = this.metadata.listActivity(after, limit, optionalString(params, "projectId"));
                return { entries, nextCursor: entries.at(-1)?.seq ?? after };
            }
            case "supervision.status":
                return { snapshots: this.supervisor.snapshots(optionalString(params, "projectId")) };
            case "supervision.configure": {
                const id = requireString(params, "assignmentId");
                const requestId = requireString(params, "requestId");
                if (!params.policy || typeof params.policy !== "object" || Array.isArray(params.policy))
                    throw new ServiceError("invalid_params", "policy must be an object.");
                const admission = this.metadata.beginJournal("supervision.configure", requestId, { id, policy: params.policy });
                const policy = admission.replayed && admission.record.status === "ready" ? this.supervisor.policy(id) : this.supervisor.configure(id, params.policy);
                this.metadata.completeJournal("supervision.configure", requestId, id);
                return { assignmentId: id, policy, replayed: admission.replayed };
            }
            case "manager.decision":
                return this.managerDecision(params);
            case "service.ping":
                return { pong: true, pid: process.pid, at: Date.now() };
            case "service.status":
                return this.status();
            case "service.version":
                return {
                    name: "pi-durable-manager",
                    packageVersion: packageVersion(),
                    protocolVersion: PROTOCOL_VERSION,
                    schemaVersion: this.metadata.schemaVersion,
                    methods: [...IMPLEMENTED_METHODS],
                    unsupported: [...UNSUPPORTED_METHODS],
                };
            case "service.capabilities":
                return this.capabilities();
            case "service.shutdown":
                // Respond-then-stop: the caller must receive an acknowledgement BEFORE
                // the listener closes, otherwise a clean shutdown looks like a dropped
                // connection. We schedule the stop on a later macrotask so `respond`
                // finishes writing this frame first. Idempotent: a second request while
                // already stopping just acknowledges.
                // An external guard respects an explicit operator stop. A crash/transport
                // loss does not create this marker and is handled differently.
                await writeFile(join(this.stateDir, "guard-pause.json"), JSON.stringify({ at: Date.now(), reason: "Explicit service.shutdown" }), { mode: 0o600 });
                this.scheduleShutdown();
                return {
                    ok: true,
                    shuttingDown: true,
                    pid: process.pid,
                    socketPath: this.socketPath,
                };
            case "projects.create":
                return (await this.projectsCreate(params));
            case "projects.import":
                return (await this.projectsImport(params));
            case "projects.list":
                return { projects: this.metadata.listProjects() };
            case "projects.show":
                return (await this.projectsShow(params));
            case "sessions.create":
                return (await this.sessionsCreate(params));
            case "sessions.list":
                return { sessions: this.sessionsList(params) };
            case "sessions.model": {
                const session = this.requireSession(params);
                const profileId = this.metadata.getControl(`workflow-model-session:${session.id}`) ?? "existing";
                const profile = this.modelSettings.profile(profileId), connection = this.modelSettings.connection(profile.connectionId);
                return { sessionId: session.id, projectId: session.projectId, profileId, profileName: profile.name, providerName: connection.name, model: this.modelSettings.historicalRef(session.id), available: !connection.disabled };
            }
            case "sessions.inspect":
                return (await this.sessionsInspect(params));
            case "sessions.transcript":
                return (await this.sessionsTranscript(params));
            case "sessions.entry":
                return (await this.sessionsEntry(params));
            case "sessions.tasks":
                return (await this.sessionsTasks(params));
            case "sessions.usage":
                return (await this.sessionsUsage(params));
            case "sessions.usageGlobal":
                return (await this.sessionsUsageGlobal(params));
            case "sessions.fork":
                return (await this.sessionsFork(params));
            case "sessions.compact":
                return (await this.sessionsCompact(params));
            case "sessions.configure":
                return (await this.sessionsConfigure(params));
            case "sessions.reset":
                return (await this.sessionsReset(params));
            case "sessions.steer":
                return (await this.sessionsSteer(params, "steer"));
            case "sessions.followup":
                return (await this.sessionsSteer(params, "followup"));
            case "assignments.create":
            case "assignments.submit":
                return (await this.assignmentsSubmit(params));
            case "assignments.show":
            case "assignments.inspect":
                return this.assignmentsShow(params);
            case "assignments.list":
                return {
                    assignments: this.engine.list(typeof params.projectId === "string" ? { projectId: params.projectId } : {}),
                };
            case "assignments.wait":
                return (await this.engine.wait({
                    id: requireString(params, "id"),
                    timeoutMs: optionalNumber(params, "timeoutMs"),
                }));
            case "assignments.abort":
            case "assignments.cancel":
                return (await this.engine.abort({ id: requireString(params, "id") }));
            case "assignments.pause":
                return this.engine.pause({ id: requireString(params, 'id'), note: requireString(params, 'note'), requestId: requireString(params, 'requestId') });
            case "assignments.review":
                return (await this.assignmentsReview(params));
            case "assignments.evidence":
                return (await this.assignmentsEvidence(params));
            case "assignments.artifact":
                return (await this.assignmentsArtifact(params));
            case "assignments.checkpoint":
                return (await this.assignmentsCheckpoint(params));
            case "assignments.restore":
                return (await this.assignmentsRestore(params));
            case "assignments.recover":
                return (await this.engine.recover({
                    id: requireString(params, "id"),
                    requestId: optionalString(params, "requestId"),
                    sessionId: optionalString(params, "sessionId"),
                }));
            case "manager.bind":
                return (await this.managerBind(params));
            case "manager.unbind":
                return await this.managerUnbind(params);
            case "manager.list":
                return { bindings: this.metadata.listManagerBindings() };
            case "manager.status":
                return this.managerStatus(params);
            case "manager.events":
                return this.managerEvents(params);
            case "manager.ack":
                return await this.managerAck(params);
            default:
                throw new ServiceError("method_not_found", `Unknown method: ${method}`);
        }
    }
    /** Create a new project directory and git repository, idempotently. */
    async projectsCreate(params) {
        const name = requireString(params, "name");
        const requestId = requireString(params, "requestId");
        const rawPath = requireString(params, "path");
        const payload = { name, path: resolve(rawPath) };
        const begun = this.metadata.beginJournal("project.create", requestId, payload);
        if (begun.replayed && begun.record.status === "ready") {
            const existing = this.metadata.getProject(begun.record.resultId);
            if (existing !== undefined)
                return { project: existing, replayed: true };
        }
        const requested = await this.assertWithinRoots(payload.path);
        // Canonicalize the EXISTING parent, then re-check the boundary. This blocks
        // a symlinked parent that resolves outside the allowed roots: textual
        // prefix checks alone would let `<root>/link` escape to any directory.
        const parent = dirname(requested);
        let canonicalParent;
        try {
            canonicalParent = await realPath(parent);
        }
        catch {
            throw new ServiceError("not_found", `Parent directory does not exist: ${parent}`);
        }
        await this.assertWithinRoots(canonicalParent);
        const target = join(canonicalParent, basename(requested));
        try {
            if (existsSync(target)) {
                throw new ServiceError("exists", `Refusing to overwrite existing path: ${target}`);
            }
            await mkdir(target, { recursive: false, mode: 0o700 });
            await git(target, ["init", "--quiet"]);
            // Repository guidance is user-owned. Creating a project grants no authority
            // to install Codex instructions into its checkout.
        }
        catch (error) {
            this.metadata.failJournal("project.create", requestId, this.redact(error));
            throw error;
        }
        const now = Date.now();
        const project = {
            id: `${ID_PREFIX}-p-${randomUUID()}`,
            name,
            path: target,
            origin: "created",
            requestId,
            createdAt: now,
            updatedAt: now,
        };
        this.metadata.withTransaction(() => { this.metadata.insertProject(project); this.modelSettings.pin(project.id); });
        this.metadata.completeJournal("project.create", requestId, project.id);
        return { project, replayed: false };
    }
    /** Import an existing directory as a project, idempotently and non-destructively. */
    async projectsImport(params) {
        const name = typeof params.name === "string" ? params.name : undefined;
        const requestId = requireString(params, "requestId");
        const rawPath = requireString(params, "path");
        const payload = { name: name ?? null, path: resolve(rawPath) };
        const begun = this.metadata.beginJournal("project.import", requestId, payload);
        if (begun.replayed && begun.record.status === "ready") {
            const existing = this.metadata.getProject(begun.record.resultId);
            if (existing !== undefined)
                return { project: existing, replayed: true };
        }
        const requested = await this.assertWithinRoots(payload.path);
        let info;
        try {
            info = await stat(requested);
        }
        catch {
            this.metadata.failJournal("project.import", requestId, "Path does not exist.");
            throw new ServiceError("not_found", `Import path does not exist: ${requested}`);
        }
        if (!info.isDirectory()) {
            this.metadata.failJournal("project.import", requestId, "Path is not a directory.");
            throw new ServiceError("not_directory", `Import path is not a directory: ${requested}`);
        }
        // Reject escapes: the real (symlink-resolved) path must stay within roots.
        const realTarget = await realPath(requested);
        await this.assertWithinRoots(realTarget);
        // Import REQUIRES an existing Git root. We must never silently `git init` a
        // user's existing directory; that would mutate a checkout the operator did
        // not ask us to touch. A non-repo directory is rejected by default.
        if (!existsSync(join(realTarget, ".git"))) {
            this.metadata.failJournal("project.import", requestId, "Not a Git repository.");
            throw new ServiceError("not_a_repo", `Import path is not a Git repository (no .git): ${realTarget}`);
        }
        // Canonical-path dedup across DIFFERENT request ids: one checkout maps to
        // exactly one project, no matter how many import requests name it.
        const already = this.metadata.getProjectByPath(realTarget);
        if (already !== undefined) {
            this.metadata.completeJournal("project.import", requestId, already.id);
            return { project: already, replayed: true };
        }
        const now = Date.now();
        const project = {
            id: `${ID_PREFIX}-p-${randomUUID()}`,
            name: name ?? basename(realTarget),
            path: realTarget,
            origin: "imported",
            requestId,
            createdAt: now,
            updatedAt: now,
        };
        this.metadata.withTransaction(() => { this.metadata.insertProject(project); this.modelSettings.pin(project.id); });
        this.metadata.completeJournal("project.import", requestId, project.id);
        return { project, replayed: false };
    }
    async projectsShow(params) {
        const id = requireString(params, "id");
        const project = this.metadata.getProject(id);
        // Never reflect the caller-supplied id verbatim: it may embed secret
        // material the redactor cannot classify. The id has already been redacted
        // of known secrets; a fixed message keeps arbitrary input out of errors.
        if (project === undefined)
            throw new ServiceError("not_found", "No project with the requested id.");
        const sessions = this.metadata.listSessions(project.id);
        return { project, sessions };
    }
    /** Create a real Pi conversation tied to a project, idempotently. */
    async sessionsCreate(params) {
        const projectId = requireString(params, "projectId");
        const requestId = requireString(params, "requestId");
        const payload = { projectId, ...(params.profileId !== undefined ? { profileId: requireString(params, "profileId") } : {}) };
        // Validate the idempotency key FIRST, before any replay shortcut, so a
        // requestId reused with a DIFFERENT project is a conflict rather than a
        // silent replay of the first project's session. `beginJournal` throws
        // `conflict` when `(kind, requestId)` exists with a different payload.
        const begun = this.metadata.beginJournal("session.create", requestId, payload);
        const existing = this.metadata.getSessionByRequest(requestId);
        if (existing !== undefined) {
            return { session: existing, replayed: true };
        }
        if (begun.replayed && begun.record.status === "ready" && begun.record.resultId !== null) {
            const replay = this.metadata.getSession(begun.record.resultId);
            if (replay !== undefined)
                return { session: replay, replayed: true };
        }
        const project = this.metadata.getProject(projectId);
        if (project === undefined)
            throw new ServiceError("not_found", "No project with the requested id.");
        // Reject service state roots as session scope: they hold secrets/DBs.
        if (isWithin(this.stateDir, project.path) || resolve(project.path) === this.stateDir) {
            throw new ServiceError("unsafe_root", "Cannot create a session scoped to service state.");
        }
        if (params.profileId !== undefined && this.modelSettings.projectChoice(projectId) !== params.profileId)
            await this.modelSettings.run("models.project", { projectId, profileId: params.profileId, requestId: `${requestId}:model` });
        const profileId = this.modelSettings.pin(projectId);
        let conversationId;
        try {
            // Each session gets its OWN conversation scoped to its project directory.
            // `harness.root()` would return the SAME reserved root conversation for
            // every call, sharing one transcript across all projects; `createConversation`
            // allocates a fresh conversation with a project-scoped agent cwd.
            const conversation = await this.harness.createConversation({
                ownership: { kind: "ownerless" },
                agent: {
                    model: this.modelSettings.ref(profileId),
                    cwd: project.path,
                    instructions: `Project session for ${project.name}. No tools are available in this slice.`,
                },
            }, BACKGROUND_CONTEXT);
            conversationId = String(conversation.id);
        }
        catch (error) {
            this.metadata.failJournal("session.create", requestId, this.redact(error));
            throw error;
        }
        const session = {
            id: `${ID_PREFIX}-s-${randomUUID()}`,
            projectId,
            conversationId,
            requestId,
            createdAt: Date.now(),
        };
        this.metadata.withTransaction(() => { this.metadata.insertSession(session); this.modelSettings.bindSession(session.id, profileId); });
        this.metadata.completeJournal("session.create", requestId, session.id);
        return { session, replayed: false };
    }
    sessionsList(params) {
        const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
        return this.metadata.listSessions(projectId);
    }
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
    async readBoundedTranscript(conversation, options) {
        const conversationId = String(conversation.id);
        // Decode + validate the opaque cursor. It is bound to this session and this
        // scan order; a malformed or foreign cursor is a structured invalid-args
        // error rather than a crash or a silent full restart.
        let piCursor;
        if (options.cursor !== undefined && options.cursor !== "") {
            const decoded = this.decodeCursor(options.cursor, conversationId, options.order);
            piCursor = decoded.piCursor;
        }
        const entries = [];
        let cursor = piCursor;
        let entryBytes = 0;
        let truncated = false;
        const encode = (next) => next === undefined ? null : this.encodeCursor(next, conversationId, options.order);
        // Include array separators, stubs, cursor and envelope in the page budget.
        // In particular, an oversized-entry stub must NEVER reset prior byte usage.
        const pageBytes = (bytes, count, next, cut) => Buffer.byteLength(JSON.stringify({ entries: [], nextCursor: encode(next), truncated: cut }), "utf8") +
            bytes + Math.max(0, count - 1);
        for (let i = 0; i < options.maxEntries; i += 1) {
            const page = await conversation.entries({ order: options.order }, 1, cursor, BACKGROUND_CONTEXT);
            const entry = page.items[0];
            if (entry === undefined)
                return { entries, nextCursor: null, truncated };
            const next = (page.next ?? undefined);
            let framed = this.frameEntry(entry);
            let framedBytes = Buffer.byteLength(JSON.stringify(framed), "utf8");
            const oversized = pageBytes(framedBytes, 1, next, truncated || next !== undefined) > options.maxBytes;
            if (oversized) {
                framed = { id: String(entry.id), entryId: String(entry.id), kind: entry.kind,
                    truncated: true, note: "entry exceeds page budget; fetch via sessions.entry" };
                framedBytes = Buffer.byteLength(JSON.stringify(framed), "utf8");
            }
            if (pageBytes(entryBytes + framedBytes, entries.length + 1, next, truncated || oversized || next !== undefined) > options.maxBytes) {
                if (!entries.length)
                    throw new ServiceError("frame_budget", "Transcript entry metadata exceeds the page budget.");
                // Do not advance: this entry (or its stub) starts the next page.
                return { entries, nextCursor: encode(cursor), truncated: true };
            }
            entries.push(framed);
            entryBytes += framedBytes;
            truncated ||= oversized;
            cursor = next;
            if (next === undefined)
                break;
        }
        return { entries, nextCursor: encode(cursor), truncated: truncated || cursor !== undefined };
    }
    /**
     * Encode Pi's object cursor as a versioned, opaque, self-describing string.
     *
     * The wire cursor is a base64url JSON envelope binding the continuation to the
     * session and the scan order. Encoding as a string (never an object) keeps the
     * JSON-RPC surface stable and validates cleanly on the next request — Pi's raw
     * object cursor cannot be passed straight back through an optional-string
     * param.
     */
    encodeCursor(piCursor, conversationId, order) {
        const envelope = JSON.stringify({ v: 1, session: conversationId, order, c: piCursor });
        return Buffer.from(envelope, "utf8").toString("base64url");
    }
    /** Decode + validate an opaque wire cursor; throws structured invalid_args. */
    decodeCursor(raw, conversationId, order) {
        if (raw.length > 8192) {
            throw new ServiceError("invalid_params", "cursor is too large to be a valid continuation token.");
        }
        let parsed;
        try {
            parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
        }
        catch {
            throw new ServiceError("invalid_params", "cursor is not a valid continuation token.");
        }
        if (parsed === null ||
            typeof parsed !== "object" ||
            parsed.v !== 1 ||
            typeof parsed.session !== "string" ||
            parsed.order !== order ||
            parsed.c === null ||
            typeof parsed.c !== "object") {
            throw new ServiceError("invalid_params", "cursor is malformed or belongs to a different session/order; restart pagination from the first page.");
        }
        if (parsed.session !== conversationId) {
            throw new ServiceError("invalid_params", "cursor belongs to a different session.");
        }
        return { piCursor: parsed.c };
    }
    /** Serialize one entry for the wire, redacting known secrets in `data`. */
    frameEntry(entry) {
        const data = this.redactValue((entry.data ?? null));
        return {
            id: String(entry.id),
            kind: entry.kind,
            model: this.redactValue((entry.model ?? null)),
            data,
        };
    }
    /** Recursively redact known secret substrings from a JSON-ish value. */
    redactValue(value) {
        if (typeof value === "string")
            return this.redactString(value);
        if (Array.isArray(value))
            return value.map((item) => this.redactValue(item));
        if (value !== null && typeof value === "object") {
            const out = {};
            for (const [key, item] of Object.entries(value))
                out[key] = this.redactValue(item);
            return out;
        }
        return value;
    }
    /** Read the real Pi conversation transcript and usage for a session. */
    async sessionsInspect(params) {
        const id = requireString(params, "id");
        const session = this.metadata.getSession(id);
        if (session === undefined)
            throw new ServiceError("not_found", "No session with the requested id.");
        const order = this.readOrder(params);
        const conversation = await this.requireConversation(session.conversationId);
        const bounded = await this.readBoundedTranscript(conversation, {
            maxBytes: TRANSCRIPT_MAX_BYTES,
            maxEntries: TRANSCRIPT_MAX_ENTRIES,
            order,
            cursor: optionalString(params, "cursor"),
        });
        return {
            session,
            model: this.modelSettings.historicalRef(session.id),
            profileId: this.metadata.getControl(`workflow-model-session:${session.id}`) ?? "existing",
            entries: bounded.entries,
            nextCursor: bounded.nextCursor,
            truncated: bounded.truncated,
            usage: (await this.sessionUsageValue(session.conversationId)),
        };
    }
    /**
     * Paginated raw transcript for a session.
     *
     * `cursor` is an opaque continuation token (the Pi entry cursor); pages are
     * byte-bounded (never more than ~256 KiB of serialized entries) so a large
     * history can never blow the RPC frame. Entries are returned oldest-first and
     * a truncated page's `nextCursor` resumes exactly at the first entry not yet
     * returned (no gaps, no duplicates). Read-only; runs no task code.
     */
    async sessionsTranscript(params) {
        const session = this.requireSession(params);
        const conversation = await this.requireConversation(session.conversationId);
        const maxEntries = clampInt(optionalNumber(params, "limit") ?? TRANSCRIPT_MAX_ENTRIES, 1, 1000);
        const order = this.readOrder(params);
        const bounded = await this.readBoundedTranscript(conversation, {
            maxBytes: TRANSCRIPT_MAX_BYTES,
            maxEntries,
            order,
            cursor: optionalString(params, "cursor"),
        });
        return {
            sessionId: session.id,
            order,
            entries: bounded.entries,
            nextCursor: bounded.nextCursor,
            truncated: bounded.truncated,
        };
    }
    /**
     * Fetch one entry's serialized JSON chunk for full reconstruction.
     *
     * `offset` walks the entry's serialized JSON in `maxChars`-sized chunks
     * (default/cap 64 KiB of source chars) so a very large entry can be streamed
     * without a giant frame. Ownership is scoped to the session's own
     * conversation: an entry of another conversation is `not_found`.
     */
    async sessionsEntry(params) {
        const session = this.requireSession(params);
        const entryId = positiveSafeInteger(params.entryId ?? params.at, "entryId");
        const offset = clampInt(optionalNumber(params, "offset") ?? 0, 0, Number.MAX_SAFE_INTEGER);
        const maxChars = clampInt(optionalNumber(params, "maxChars") ?? ENTRY_CHUNK_CHARS, 1, ENTRY_CHUNK_CHARS);
        const conversation = await this.requireConversation(session.conversationId);
        const page = await conversation.entries({ minEntryId: entryId, maxEntryId: entryId, order: "ascending" }, 1, undefined, BACKGROUND_CONTEXT);
        const entry = page.items[0];
        if (entry === undefined || Number(entry.id) !== entryId) {
            throw new ServiceError("not_found", `Unknown entry for this session: ${entryId}`);
        }
        const serialized = JSON.stringify(this.frameEntry(entry));
        const chunk = serialized.slice(offset, offset + maxChars);
        const nextOffset = offset + chunk.length;
        return {
            sessionId: session.id,
            id: String(entry.id),
            entryId: String(entry.id),
            offset,
            maxChars,
            totalChars: serialized.length,
            chunk: this.redactString(chunk),
            nextOffset: nextOffset < serialized.length ? nextOffset : null,
            done: nextOffset >= serialized.length,
        };
    }
    /** This conversation's own usage document, or an empty ledger. */
    async sessionUsageValue(conversationId) {
        const usage = await this.harness.snapshot(UsageDoc, Number(conversationId), BACKGROUND_CONTEXT);
        return (usage ?? { models: {}, tools: {} });
    }
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
    async sessionsTasks(params) {
        const session = this.requireSession(params);
        const conversationId = Number(session.conversationId);
        const inspection = await this.harness.inspect(BACKGROUND_CONTEXT);
        const tasks = inspection.tasks
            .filter((task) => Number(task.record.conversationId) === conversationId)
            .map((task) => ({
            id: String(task.record.id),
            kind: task.record.kind,
            state: task.state.kind,
            status: task.record.state.status,
            ownership: task.record.owner === undefined
                ? Number(task.record.conversationId) === conversationId
                    ? "conversation"
                    : "other"
                : "task",
            background: task.record.background,
            abortRequested: task.record.abortRequested,
        }));
        const submissions = inspection.submissions
            .filter((submission) => Number(submission.conversationId) === conversationId)
            .map((submission) => ({
            id: String(submission.id),
            type: submission.type,
            status: submission.status,
            requestId: submission.requestId ?? null,
        }));
        return {
            sessionId: session.id,
            scheduling: inspection.scheduling,
            tasks,
            submissions,
        };
    }
    /**
     * Per-session usage: this session's OWN conversation ledger only.
     *
     * `Harness.usage()` sums every conversation in the session — wrong for a
     * per-session view. Instead we read the conversation-scoped `pi.usage`
     * document via the public `snapshot(UsageDoc, conversationId, ctx)`. The
     * numbers are token/counter metadata (`cost` is provider-reported or zero,
     * NOT a GPU or Modal bill). `scope: "session"` makes the boundary explicit.
     */
    async sessionsUsage(params) {
        const session = this.requireSession(params);
        const conversationId = Number(session.conversationId);
        const usage = await this.harness.snapshot(UsageDoc, conversationId, BACKGROUND_CONTEXT);
        return {
            sessionId: session.id,
            scope: "session",
            usage: (usage ?? { models: {}, tools: {} }),
        };
    }
    /**
     * Global usage summed across EVERY conversation in the harness (all sessions
     * in this daemon). Kept clearly scoped so it is never confused with the
     * per-session `sessions.usage`.
     */
    async sessionsUsageGlobal(_params) {
        const usage = await this.harness.usage(BACKGROUND_CONTEXT);
        return { scope: "global", usage: usage };
    }
    /**
     * Fork a NEW session from a visible entry of an existing session.
     *
     * The fork starts a fresh conversation with the same project scope and copies
     * the same Modal model/budget agent, so it is safe to diverge without
     * touching the source transcript. No tools or model calls happen here.
     */
    async sessionsFork(params) {
        const session = this.requireSession(params);
        const at = requireString(params, "at");
        const project = this.metadata.getProject(session.projectId);
        if (project === undefined)
            throw new ServiceError("not_found", "Session project is missing.");
        const requestId = requireString(params, "requestId");
        // Validate the fork point BEFORE journaling. `at` is the string form of an
        // entry id; require a positive safe integer so a malformed value can never
        // reach `Storage.entry()` (which throws on a non-entry id).
        const entryId = positiveSafeInteger(at, "at");
        const source = await this.requireConversation(session.conversationId);
        // Ownership-scoped, public read of a single committed entry. A fork point
        // must be a VISIBLE entry of THIS conversation; an entry that is unknown or
        // lives in another conversation resolves to no page and is rejected before
        // any journal write.
        const page = await source.entries({ minEntryId: entryId, maxEntryId: entryId, order: "ascending" }, 1, undefined, BACKGROUND_CONTEXT);
        const located = page.items[0];
        if (located === undefined || Number(located.id) !== entryId) {
            throw new ServiceError("invalid_params", `Unknown entry for this session: ${at}`);
        }
        const payload = { sessionId: session.id, at: String(entryId) };
        const begun = this.metadata.beginJournal("session.fork", requestId, payload);
        if (begun.replayed) {
            if (begun.record.status === "ready" && begun.record.resultId !== null) {
                const replay = this.metadata.getSession(begun.record.resultId);
                if (replay !== undefined)
                    return { session: replay, replayed: true };
            }
            // A prior fork with this requestId never completed. Fail closed rather
            // than silently starting a second, divergent fork: the caller must use a
            // new requestId to retry.
            throw new ServiceError("conflict", `Fork request ${requestId} did not complete. Retry with a new requestId.`);
        }
        const forked = await source.fork(entryId, {
            ownership: { kind: "ownerless" },
            agent: {
                model: this.modelSettings.sessionRef(project.id, session.id),
                cwd: project.path,
            },
        }, BACKGROUND_CONTEXT);
        const forkedSession = {
            id: `${ID_PREFIX}-s-${randomUUID()}`,
            projectId: session.projectId,
            conversationId: String(forked.id),
            requestId,
            createdAt: Date.now(),
        };
        this.metadata.withTransaction(() => { this.metadata.insertSession(forkedSession); this.modelSettings.bindSession(forkedSession.id, this.metadata.getControl(`workflow-model-session:${session.id}`) ?? "existing"); });
        this.metadata.completeJournal("session.fork", requestId, forkedSession.id);
        return { session: forkedSession, replayed: false };
    }
    /**
     * Admit a manual compaction task for a session's conversation.
     *
     * Compaction folds older context into a summary; it runs while the
     * conversation keeps working and places its summary at the next boundary.
     */
    async sessionsCompact(params) {
        const session = this.requireSession(params);
        const conversation = await this.requireConversation(session.conversationId);
        const instructions = optionalString(params, "instructions");
        const taskId = await conversation.compact(instructions === undefined ? undefined : this.redactString(instructions), BACKGROUND_CONTEXT);
        return { sessionId: session.id, taskId: String(taskId) };
    }
    /**
     * Reconfigure a session's agent, restricted to the SAME Modal model and
     * budgets. Only `thinkingLevel` and `instructions` may change; the model is
     * pinned to this service's provider/model so a session can never be pointed
     * at a different provider (which would defeat the credential boundary).
     */
    async sessionsConfigure(params) {
        const session = this.requireSession(params);
        const conversation = await this.requireConversation(session.conversationId);
        const change = {};
        if (params.thinkingLevel !== undefined) {
            const level = requireString(params, "thinkingLevel");
            if (!THINKING_LEVELS.has(level)) {
                throw new ServiceError("invalid_params", `thinkingLevel must be one of: ${[...THINKING_LEVELS].join(", ")}.`);
            }
            change.thinkingLevel = level;
        }
        if (params.instructions !== undefined) {
            change.instructions = withWorkerPolicy(this.redactString(requireString(params, "instructions")), effectivePermissions(this.metadata, allowNetwork(this.config), session.projectId));
        }
        if (params.model !== undefined) {
            // Allow only the pinned model, and only by exact match, to make an
            // accidental provider switch impossible.
            const requested = requireString(params, "model");
            if (requested !== this.modelSettings.sessionRef(session.projectId, session.id).modelId) {
                throw new ServiceError("model_pinned", `Sessions are pinned to model ${this.config.model}; a different model is not permitted.`);
            }
        }
        if (Object.keys(change).length === 0) {
            throw new ServiceError("invalid_params", "configure requires thinkingLevel and/or instructions.");
        }
        await conversation.configure(change, BACKGROUND_CONTEXT);
        return { sessionId: session.id, configured: Object.keys(change) };
    }
    /**
     * Reset a session's context to a fresh one, optionally with a handoff note.
     *
     * Refused unless the conversation is idle: resetting mid-run would discard
     * in-flight work. Callers who want to stop in-flight work should abort the
     * assignment first.
     */
    async sessionsReset(params) {
        const session = this.requireSession(params);
        const conversation = await this.requireConversation(session.conversationId);
        const idle = await this.isIdle(conversation);
        if (!idle) {
            throw new ServiceError("busy", "Session is not idle; abort or wait for the running assignment before resetting.");
        }
        const handoff = optionalString(params, "handoff");
        await conversation.reset(handoff === undefined ? undefined : this.redactString(handoff), BACKGROUND_CONTEXT);
        return { sessionId: session.id, reset: true };
    }
    /**
     * Route steering/follow-up through the guarded assignment engine.
     *
     * We require an assignment id so the writer lease and budget remain enforced;
     * a bare session cannot be steered without one, because that would create
     * unmanaged input.
     */
    async sessionsSteer(params, mode) {
        const id = requireString(params, "assignmentId");
        const content = requireString(params, "content");
        const requestId = requireString(params, "requestId");
        const category = activityCategory(params, 'steering_unclassified');
        const result = await this.engine.steer({ id, content, mode, requestId });
        const a = this.metadata.getAssignment(id), t = a && projectWorkflow(this.metadata, a.projectId);
        if (t && workflowOwns(this.metadata, t, id))
            recordWorkflowActivity(this.metadata, t, `input:${mode}:${requestId}`, category, content, id);
        return result;
    }
    /** Resolve a session by `id`, or throw a redacted `not_found`. */
    requireSession(params) {
        const id = requireString(params, "id");
        const session = this.metadata.getSession(id);
        if (session === undefined)
            throw new ServiceError("not_found", "No session with the requested id.");
        return session;
    }
    /** Resolve a session's live Pi conversation by conversation id. */
    async requireConversation(conversationId) {
        const conversation = await this.harness.conversation(Number(conversationId), BACKGROUND_CONTEXT);
        if (conversation === undefined) {
            throw new ServiceError("not_found", `Pi conversation ${conversationId} is missing.`);
        }
        return conversation;
    }
    /**
     * Parse the optional `order` scan direction.
     *
     * `descending` returns newest-first (used for CTO checkpoints); default is
     * `ascending` (oldest-first). Anything else is a structured invalid-args
     * error rather than a silent fallback.
     */
    readOrder(params) {
        const raw = optionalString(params, "order");
        if (raw === undefined || raw === "ascending")
            return "ascending";
        if (raw === "descending")
            return "descending";
        throw new ServiceError("invalid_params", `order must be "ascending" or "descending", got "${raw}".`);
    }
    /** Whether the conversation's ordinary ownership scope has no live work. */
    async isIdle(conversation) {
        let settled = false;
        const wait = conversation.waitForIdle(BACKGROUND_CONTEXT).then(() => {
            settled = true;
        });
        // Race the idle wait against a short grace period so a busy conversation is
        // reported as busy promptly rather than blocking the RPC indefinitely.
        await Promise.race([wait.catch(() => undefined), delay(250)]);
        return settled;
    }
    /**
     * Admit a coding assignment for a project, idempotently.
     *
     * The `requestId` doubles as the correlation id (filled by the client) and
     * the engine's idempotency key. It is REQUIRED: a retry of the same
     * `(requestId, payload)` replays the stored assignment; a different payload
     * under the same id is a `conflict`. Submit returns as soon as the input is
     * admitted; settlement happens in the background.
     */
    async assignmentsSubmit(params) {
        const projectId = requireString(params, "projectId");
        const task = requireString(params, "task");
        const requestId = requireString(params, "requestId");
        const criteria = optionalString(params, "criteria");
        const sessionId = optionalString(params, "sessionId");
        const parentId = optionalString(params, "parentId");
        return (await this.engine.submit({
            projectId,
            task,
            requestId,
            ...(criteria !== undefined ? { criteria } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(parentId !== undefined ? { parentId } : {}),
        }));
    }
    /** Read one assignment's durable detail by `id` or `requestId`. */
    assignmentsShow(params) {
        const id = optionalString(params, "id");
        const requestId = optionalString(params, "requestId");
        if (id === undefined && requestId === undefined) {
            throw new ServiceError("invalid_params", "assignments.show requires id or requestId.");
        }
        return this.engine.show({
            ...(id !== undefined ? { id } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
        });
    }
    /** Record an operator verdict (`accept` / `revise`) for a settled assignment. */
    async assignmentsReview(params) {
        const id = requireString(params, "id");
        const decision = requireString(params, "decision");
        if (decision !== "accept" && decision !== "revise") {
            throw new ServiceError("invalid_params", "decision must be 'accept' or 'revise'.");
        }
        const note = optionalString(params, "note");
        return (await this.engine.review({
            id,
            decision,
            ...(note !== undefined ? { note } : {}),
        }));
    }
    /** Return one bounded page of an assignment's recorded evidence bundle. */
    async assignmentsEvidence(params) {
        const id = requireString(params, "id");
        return (await this.engine.evidenceSection({
            id,
            section: optionalString(params, "section"),
            offset: optionalNumber(params, "offset"),
            limit: optionalNumber(params, "limit"),
            ...(optionalBoolean(params, "allowLegacy") !== undefined ? { allowLegacy: optionalBoolean(params, "allowLegacy") } : {}),
        }));
    }
    /** Read a bounded slice of a recorded artifact (owned ids only). */
    async assignmentsArtifact(params) {
        const id = requireString(params, "id");
        const artifactId = requireString(params, "artifactId");
        return (await this.engine.artifactChunk({
            id,
            artifactId,
            offset: optionalNumber(params, "offset"),
            maxChars: optionalNumber(params, "maxChars"),
        }));
    }
    /** Show the recorded checkpoint manifest ref, counts, and verified state. */
    async assignmentsCheckpoint(params) {
        const id = requireString(params, "id");
        return (await this.engine.checkpointInfo({ id }));
    }
    /** Restore an assignment's recorded pre-image checkpoint (explicit, idempotent). */
    async assignmentsRestore(params) {
        const id = requireString(params, "id");
        const requestId = optionalString(params, "requestId");
        const paths = optionalStringArray(params, "paths");
        const overwrite = optionalBoolean(params, "overwrite");
        const expectedHash = optionalStringRecord(params, "expectedHash");
        return (await this.engine.restore({
            id,
            ...(requestId !== undefined ? { requestId } : { requestId: `restore-${id}-${Date.now()}` }),
            ...(paths !== undefined ? { paths } : {}),
            ...(overwrite !== undefined ? { overwrite } : {}),
            ...(expectedHash !== undefined ? { expectedHash } : {}),
        }));
    }
    /**
     * Bind a project to an EXPLICIT manager thread UUID. The manager caller
     * supplies the existing GUI session UUID; the CLI may default it to
     * `CODEX_THREAD_ID` from the environment. Binding is FROM NOW: no historical
     * job is replayed. The worker never calls this and can never choose a target.
     */
    async managerBind(params) {
        const projectId = requireString(params, "projectId");
        // The caller (manager GUI session) MUST supply an EXPLICIT thread UUID. The
        // server NEVER falls back to `process.env.CODEX_THREAD_ID`: the service is
        // started by the root/daemon, whose thread is NOT the future caller's chat.
        // The CLI is responsible for injecting the caller's current thread env into
        // the params; a direct SDK caller must pass `threadId` explicitly. This
        // keeps the binding target the caller's choice and never the worker's.
        const rawThread = optionalString(params, "threadId");
        if (rawThread === undefined || rawThread.length === 0) {
            throw new ServiceError("invalid_params", "manager.bind requires an explicit threadId (the manager's current Codex session UUID).");
        }
        const threadId = rawThread.trim();
        const project = this.metadata.getProject(projectId);
        if (project === undefined) {
            throw new ServiceError("not_found", `Unknown project: ${projectId}`);
        }
        if (!isThreadUuid(threadId)) {
            throw new ServiceError("invalid_params", `manager.bind threadId is not a valid UUID: ${threadId}`);
        }
        const requestId = optionalString(params, "requestId") ?? `manager-bind-${projectId}`;
        // Idempotent: replaying the same requestId returns the same binding.
        const begun = this.metadata.beginJournal("manager.bind", requestId, { projectId, threadId });
        const before = this.metadata.getManagerBinding(projectId);
        if (begun.replayed && begun.record.status === "ready") {
            if (before !== undefined)
                return { binding: before, replayed: true };
        }
        const now = Date.now();
        // Bind FROM NOW: supersede any still-pending event recorded before this
        // watermark so a new/retargeted thread never receives a historical replay,
        // and events recorded for an OLD thread are never routed to the new one.
        // Same-thread idempotent rebinds keep an existing watermark (never newer
        // than the first effective bind) so they do not silently drop fresh events.
        const sameThread = before !== undefined && before.threadId === threadId;
        const boundAt = sameThread ? before.boundAt ?? now : now;
        this.metadata.withTransaction(() => {
            this.metadata.upsertManagerBinding({
                projectId,
                threadId,
                requestId,
                boundAt,
                createdAt: before?.createdAt ?? now,
                updatedAt: now,
            });
            if (!sameThread)
                this.metadata.supersedePendingManagerEvents(projectId, boundAt);
        });
        this.metadata.completeJournal("manager.bind", requestId, projectId);
        const binding = this.metadata.getManagerBinding(projectId);
        return { binding: binding ?? null };
    }
    /** Remove a project's manager binding. Pending events stay durably recorded. */
    async managerUnbind(params) {
        const projectId = requireString(params, "projectId");
        const removed = this.metadata.deleteManagerBinding(projectId);
        await this.manager?.reconcileQueued();
        return { projectId, removed };
    }
    /**
     * Delivery health. Truthfully reports whether the dispatcher is enabled, how
     * many events are pending vs parked-failed, and the next scheduled retry — so
     * an operator can see a missing/offline Codex CLI instead of a silent gap.
     */
    managerStatus(params) {
        const projectId = optionalString(params, "projectId");
        const pending = this.metadata.countPendingManagerEvents(projectId);
        const parked = this.metadata.countParkedManagerEvents(projectId);
        const events = this.metadata.listManagerEvents(projectId, false);
        const unacked = events.filter((row) => !row.acked).length;
        const nextAttempt = events
            .map((row) => row.nextAttemptAt)
            .filter((value) => typeof value === "number")
            .sort((a, b) => a - b)[0] ?? null;
        return {
            // Truthful: the coordinator is ALWAYS constructed so durable events keep
            // recording, but delivery is only active when config enabled it AND a
            // dispatcher exists. Reporting `this.manager !== null` would wrongly say
            // `enabled:true` for a `manager.enabled=false` config.
            enabled: this.managerDispatchEnabled,
            boundProjects: this.metadata.listManagerBindings().length,
            pending,
            parked,
            unacked,
            nextAttemptAt: nextAttempt,
            queueCleanup: this.metadata.getControl('manager-queue-cleanup'),
        };
    }
    /** List durable manager events: ids + bounded summaries, never raw transcripts. */
    managerEvents(params) {
        const projectId = optionalString(params, "projectId");
        const unackedOnly = optionalBoolean(params, "unacked") ?? false;
        const limit = optionalNumber(params, "limit") ?? 100;
        const rows = this.metadata.listManagerEvents(projectId, unackedOnly).slice(0, Math.max(1, limit));
        return {
            events: rows.map((row) => ({
                eventId: row.eventId,
                projectId: row.projectId,
                assignmentId: row.assignmentId,
                kind: row.kind,
                state: row.state,
                threadId: row.threadId,
                summary: row.summary,
                deliveryState: row.deliveryState,
                attempts: row.attempts,
                acked: row.acked,
                createdAt: row.createdAt,
            })),
        };
    }
    /** Acknowledge an event idempotently so it is never re-delivered. */
    async managerAck(params) {
        const eventId = requireString(params, "eventId");
        const event = this.metadata.getManagerEvent(eventId);
        if (event === undefined) {
            throw new ServiceError("not_found", `Unknown manager event: ${eventId}`);
        }
        if (event.acked) {
            await this.manager?.reconcileQueued();
            return { eventId, acked: true, replayed: true };
        }
        const assignment = this.metadata.getAssignment(event.assignmentId);
        if (!this.metadata.getControl(`manager-decision:${eventId}`) && !assignment?.reviewedAt && assignment?.state !== "cancelled") {
            throw new ServiceError("action_required", "Record manager.decision or complete a review/cancel action before acknowledging this event.");
        }
        this.metadata.ackManagerEvent(eventId, Date.now());
        await this.manager?.reconcileQueued();
        return { eventId, acked: true };
    }
    managerDecision(params) {
        const eventId = requireString(params, "eventId");
        const action = requireString(params, "action");
        const note = requireString(params, "note");
        const requestId = requireString(params, "requestId");
        if (!["accept", "revise", "answer", "abort", "observe"].includes(action) || note.length > 12000)
            throw new ServiceError("invalid_params", "Invalid manager decision.");
        const event = this.metadata.getManagerEvent(eventId);
        if (!event)
            throw new ServiceError("not_found", "Unknown manager event.");
        const key = `manager-decision:${eventId}`;
        const old = this.metadata.getControl(key);
        if (old) {
            if (old.action !== action || old.note !== note)
                throw new ServiceError("conflict", "A different decision was already recorded for this event.");
            return { eventId, decision: old, replayed: true };
        }
        this.metadata.withTransaction(() => {
            this.metadata.beginJournal("manager.decision", requestId, { eventId, action, note });
            this.metadata.setControl(key, { action, note, requestId, at: Date.now() });
            this.metadata.appendActivity({ kind: "manager.decision", projectId: event.projectId, assignmentId: event.assignmentId,
                requestId, dedupKey: key, data: { eventId, action, note } });
            this.metadata.completeJournal("manager.decision", requestId, eventId);
        });
        return { eventId, decision: this.metadata.getControl(key), replayed: false };
    }
    /**
     * Canonicalize and enforce the configured project boundary.
     *
     * Both the requested path AND the configured allowed roots are canonicalized
     * through the same routine so path aliases (`/var` vs `/private/var`, other
     * symlinked prefixes) compare equal. Canonicalization only follows symlinks
     * that already exist on disk, so this never widens the boundary; the
     * symlink-escape rejection downstream is unchanged.
     */
    async assertWithinRoots(path) {
        const resolved = await canonicalizeNearest(path);
        const roots = await Promise.all(this.config.paths.allowedRoots.map((r) => canonicalizeNearest(r)));
        if (!roots.some((root) => isWithin(root, resolved))) {
            throw new ServiceError("outside_roots", `Path is outside the configured allowed roots: ${resolved}`);
        }
        // Reject the service's own state directory and the config file's directory.
        const stateDir = await canonicalizeNearest(this.stateDir);
        if (isWithin(stateDir, resolved) || resolved === stateDir) {
            throw new ServiceError("unsafe_root", "Path is inside service state.");
        }
        return resolved;
    }
    toErrorResponse(id, error) {
        if (error instanceof ServiceError) {
            return errorResponse(id, error.code, this.redact(error));
        }
        if (error instanceof StoreError) {
            return errorResponse(id, error.code, this.redact(error));
        }
        if (error instanceof AssignmentError) {
            return errorResponse(id, error.code, this.redact(error));
        }
        return errorResponse(id, "internal", this.redact(error));
    }
    redact(error) {
        return redactString(redactError(error, this.knownSecrets).message, this.knownSecrets);
    }
    /** Redact known secrets out of caller-supplied text before it is stored. */
    redactString(value) {
        return redactString(value, this.knownSecrets);
    }
    listen() {
        this.server?.on("connection", (socket) => this.attachSocket(socket));
    }
    /**
     * Attach the newline-delimited JSON-RPC framing loop to a connected stream.
     *
     * Production reaches this through the Unix-domain socket server; tests can
     * drive the exact same protocol over an in-memory or loopback socket, which
     * keeps the transport out of the protocol's logic.
     */
    attachSocket(socket) {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
                socket.end(JSON.stringify(errorResponse("", "frame_too_large", "Request frame too large.")) + "\n");
                buffer = "";
                return;
            }
            let newline = buffer.indexOf("\n");
            while (newline !== -1) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (line.trim() !== "")
                    void this.respond(socket, line);
                newline = buffer.indexOf("\n");
            }
        });
        socket.on("error", () => socket.destroy());
    }
    async respond(socket, line) {
        let response;
        try {
            const parsed = JSON.parse(line);
            if (parsed === null || typeof parsed !== "object" || typeof parsed.method !== "string") {
                response = errorResponse("", "bad_frame", "Malformed request frame.");
            }
            else {
                response = await this.handle(parsed);
            }
        }
        catch {
            response = errorResponse("", "bad_frame", "Malformed request frame.");
        }
        if (!socket.destroyed)
            socket.write(`${JSON.stringify(response)}\n`);
    }
}
/**
 * Build and bind a Unix-domain socket server at `socketPath`.
 *
 * Safety rules (the socket parent is a SHARED, possibly world-writable place
 * like `/tmp`, so we must never weaken it):
 *  - The parent directory must be an owned PRIVATE directory. We only `chmod`
 *    the parent when WE created it; we never chmod a pre-existing shared parent
 *    (chmodding `/tmp` to 0700 would break the whole machine).
 *  - We never `unlink` a regular file: only a socket-file leftover at exactly
 *    our path is a candidate for removal.
 *  - We refuse to bind over a socket that a live process is still listening on,
 *    even when a *different* state directory happens to resolve here. A dead
 *    leftover socket (connection refused) is removed.
 *  - If `listen` fails, we remove only the path we just tried to bind and never
 *    touch any other instance's files.
 */
async function bindSocket(socketPath) {
    const parent = dirname(socketPath);
    // Create the private parent if absent; if it already exists, verify (do NOT
    // chmod) that it is a directory and owned by this user before using it.
    const parentExisted = existsSync(parent);
    if (!parentExisted) {
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await chmod(parent, 0o700).catch(() => undefined);
    }
    else {
        const parentInfo = await stat(parent);
        if (!parentInfo.isDirectory()) {
            throw new ServiceError("socket_parent", `Socket parent is not a directory: ${parent}`);
        }
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        if (uid !== undefined && parentInfo.uid !== uid) {
            throw new ServiceError("socket_parent", `Socket parent is not owned by this user: ${parent}`);
        }
    }
    // Inspect any existing path. Never remove a regular file; only a socket may be
    // a stale leftover, and only when no live process is listening on it.
    if (existsSync(socketPath)) {
        const info = await stat(socketPath);
        if (!info.isSocket()) {
            throw new ServiceError("socket_exists", `Refusing to remove a non-socket at ${socketPath}`);
        }
        const live = await isSocketLive(socketPath);
        if (live) {
            throw new ServiceError("locked", `Socket is already in use by another service: ${socketPath}`);
        }
        await rm(socketPath, { force: true }).catch(() => undefined);
    }
    const server = createServer();
    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.removeListener("error", reject);
            resolveListen();
        });
    }).catch((error) => {
        const code = error.code;
        if (code === "EADDRINUSE") {
            // Another process bound between our stale-check and listen. Do NOT remove
            // the path: it is now that live owner's socket, not ours.
            throw new ServiceError("locked", `Socket is already in use: ${socketPath}`);
        }
        // Our own bind failed for another reason (e.g. permissions): clean up only
        // the path we attempted.
        return rm(socketPath, { force: true }).catch(() => undefined).then(() => {
            throw error;
        });
    });
    await chmod(socketPath, 0o600).catch(() => undefined);
    return server;
}
/** Whether a live process is listening on the Unix socket at `socketPath`. */
function isSocketLive(socketPath) {
    return new Promise((resolveLive) => {
        const probe = connect(socketPath);
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            probe.destroy();
            resolveLive(value);
        };
        probe.once("connect", () => finish(true));
        probe.once("error", () => finish(false));
        setTimeout(() => finish(false), 200).unref();
    });
}
/** Deliver a structured error response. */
function errorResponse(id, code, message) {
    return { v: PROTOCOL_VERSION, id, error: { code, message } };
}
/** Read a required string field, or throw a structured error. */
function requireString(params, field) {
    const value = params[field];
    if (typeof value !== "string" || value.length === 0) {
        throw new ServiceError("invalid_params", `Missing or invalid string parameter: ${field}`);
    }
    return value;
}
/**
 * True for a canonical 8-4-4-4-12 hex UUID (any version, including v7).
 * Case-insensitive. Used to reject a garbage manager thread id at bind time.
 */
function isThreadUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
/** Read an optional non-empty string parameter, or `undefined` when absent. */
function optionalString(params, field) {
    const value = params[field];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "string") {
        throw new ServiceError("invalid_params", `Invalid string parameter: ${field}`);
    }
    return value.length === 0 ? undefined : value;
}
/** Read an optional finite number parameter, or `undefined` when absent. */
function optionalNumber(params, field) {
    const value = params[field];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ServiceError("invalid_params", `Invalid numeric parameter: ${field}`);
    }
    return value;
}
/** Read an optional array-of-strings parameter, or `undefined` when absent. */
function optionalStringArray(params, field) {
    const value = params[field];
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new ServiceError("invalid_params", `Invalid string[] parameter: ${field}`);
    }
    return value;
}
/** Read an optional boolean parameter, or `undefined` when absent. */
function optionalBoolean(params, field) {
    const value = params[field];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "boolean") {
        throw new ServiceError("invalid_params", `Invalid boolean parameter: ${field}`);
    }
    return value;
}
/** Read an optional `Record<string,string>` parameter, or `undefined` when absent. */
function optionalStringRecord(params, field) {
    const value = params[field];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new ServiceError("invalid_params", `Invalid object parameter: ${field}`);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (typeof v !== "string") {
            throw new ServiceError("invalid_params", `Invalid object parameter: ${field}`);
        }
        out[k] = v;
    }
    return out;
}
/** Parse a positive safe integer from a string/number, or throw `invalid_params`. */
function positiveSafeInteger(value, field) {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (!/^[0-9]+$/.test(text)) {
        throw new ServiceError("invalid_params", `Invalid positive integer parameter: ${field}`);
    }
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n <= 0) {
        throw new ServiceError("invalid_params", `Invalid positive integer parameter: ${field}`);
    }
    return n;
}
/** Clamp an integer into `[min, max]`. */
function clampInt(value, min, max) {
    const n = Math.trunc(value);
    if (!Number.isFinite(n))
        return min;
    return Math.min(max, Math.max(min, n));
}
/** Resolve after `ms` milliseconds. */
function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
/** The thinking levels Pi accepts; used to validate `sessions.configure`. */
const THINKING_LEVELS = new Set(["off", "low", "medium", "high"]);
/** Serialized-byte budget for one transcript page (well under the 1 MiB frame). */
const TRANSCRIPT_MAX_BYTES = 256 * 1024;
/** Default maximum entries per transcript page. */
const TRANSCRIPT_MAX_ENTRIES = 200;
/** Maximum source characters per `sessions.entry` reconstruction chunk. */
const ENTRY_CHUNK_CHARS = 64 * 1024;
/** Whether `child` is `parent` or nested inside it. */
function isWithin(parent, child) {
    const p = resolve(parent);
    const c = resolve(child);
    return c === p || c.startsWith(p + "/");
}
/**
 * Canonicalize a path by resolving symlinks on its deepest existing ancestor,
 * then re-appending the not-yet-existing tail verbatim.
 *
 * On macOS the configured allowed roots are frequently given through the
 * `/var` -> `/private/var` alias (or another symlinked prefix) while the
 * canonical path the OS actually hands back from `realpath` uses
 * `/private/var`. Comparing a canonical requested path against a
 * non-canonical configured root therefore produces a spurious `outside_roots`
 * rejection. Canonicalizing BOTH sides through the same routine fixes the
 * comparison without widening the boundary: we only ever follow symlinks that
 * already exist on disk, and we never invent a parent that escapes the
 * configured root.
 */
async function canonicalizeNearest(path) {
    const { realpath } = await import("node:fs/promises");
    let current = resolve(path);
    const suffix = [];
    // Walk up until we find an existing ancestor, collecting the missing tail.
    // The filesystem root always exists, so this terminates.
    for (;;) {
        try {
            const real = await realpath(current);
            return suffix.length === 0 ? real : join(real, ...suffix.reverse());
        }
        catch (error) {
            const code = error.code;
            if (code !== "ENOENT" && code !== "ENOTDIR")
                throw error;
            const parent = dirname(current);
            if (parent === current)
                return resolve(path);
            suffix.push(basename(current));
            current = parent;
        }
    }
}
/** Resolve the real path (following symlinks) of an existing path. */
async function realPath(path) {
    const { realpath } = await import("node:fs/promises");
    return realpath(path);
}
const execFileAsync = promisify(execFile);
/** Run a safe, fixed git argv in `cwd`. Never commits, never adds a remote. */
async function git(cwd, args) {
    await execFileAsync("git", args, { cwd });
}
/** Install SIGINT/SIGTERM handlers that stop the service cleanly. */
export function installSignalHandlers(service) {
    const shutdown = () => {
        void service.stop().finally(() => {
            process.exitCode = 0;
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
/** True when this module is the process entry point (foreground `serve`). */
export async function serveMain(argv) {
    let configFile;
    let socketPath;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--config") {
            configFile = argv[i + 1];
            i += 1;
        }
        else if (arg === "--socket") {
            socketPath = argv[i + 1];
            i += 1;
        }
        else {
            process.stderr.write(`Unknown argument: ${arg}\n`);
            return 2;
        }
    }
    if (configFile === undefined) {
        process.stderr.write("Usage: service --config PATH [--socket PATH]\n");
        return 2;
    }
    try {
        const service = await PiDurableService.start({ configFile, socketPath });
        installSignalHandlers(service);
        process.stdout.write(`${JSON.stringify({ ok: true, ...service.status() })}\n`);
        await service.waitUntilStopped();
        return 0;
    }
    catch (error) {
        const message = redactError(error).message;
        process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
        return 1;
    }
}
//# sourceMappingURL=service.js.map