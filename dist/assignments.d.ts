import { type PermissionSnapshot } from "./permissions.js";
import type { Harness, Registry } from "@earendil-works/pi-durable";
import { type KnownSecrets } from "./redact.js";
import { type QuarantineDecision } from "./process-quarantine.js";
import { type EvidenceBundle } from "./assignment-evidence.js";
import { MetadataStore, type AssignmentState, type ProjectRecord } from "./store.js";
/**
 * Upper bound (ms) the manager-request finalizer waits for this project's
 * owned bash process groups to drain after SIGKILL before it records the
 * durable pause. If they do not drain, the pause + wake are still written but
 * truthfully flagged as cleanup-unconfirmed (fail closed).
 */
export declare const MANAGER_PAUSE_DRAIN_MS = 5000;
import { type CreateProjectToolsOptions, type ProjectTools } from "./tools.js";
/** Upper bound (ms) an operator may ask `assignments.wait` to block for. */
export declare const MAX_WAIT_MS = 60000;
/**
 * Upper bound (ms) the generation hook waits for the invocation cancel signal
 * after aborting a task at a limit. The signal is already aborted whenever this
 * is reached, so the wait is defensive: it never delays a legitimate run.
 */
export declare const HOOK_ABORT_WAIT_MS = 2000;
/**
 * Canonical identity of an assignment payload. Two submits that share a
 * `requestId` are the SAME request only if this hash matches; anything else
 * (different project, task, criteria, session, or parent) is a conflict. We
 * include `sessionId` and `parentId` so a reused request id cannot silently
 * steer a different transcript or revision lineage.
 */
export declare function assignmentPayloadHash(params: {
    projectId: string;
    task: string;
    criteria?: string | null;
    sessionId?: string | null;
    parentId?: string | null;
}): string;
/** Pi submission statuses we understand (see pi-durable types). */
type PiSubmissionStatus = "queued" | "placed" | "done" | "unanswered";
/** Options that construct an {@link AssignmentEngine}. */
export interface AssignmentEngineOptions {
    readonly harness: Harness;
    /**
     * The shared tool registry. Every project's tool extension is installed here
     * (under a UNIQUE name) so conversations can enable exactly their own bundle.
     */
    readonly registry?: Registry;
    readonly metadata: MetadataStore;
    readonly config: {
        readonly model: string;
        readonly limits: {
            /** Max provider requests per assignment; `null` = unlimited. */
            readonly maxSteps: number | null;
            /** Wall-clock deadline (ms); `null` = unlimited (no deadline armed). */
            readonly timeoutMs: number | null;
        };
        /** Optional per-command bash timeout cap (ms); `null`/omitted = unlimited. */
        readonly tools?: {
            readonly commandTimeoutMs?: number | null;
        };
    };
    readonly providerId: string;
    readonly modelForSession?: (projectId: string, sessionId?: string) => {
        provider: string;
        modelId: string;
    };
    /** Service state directory; must be in every project's protected paths. */
    readonly stateDir: string;
    /** Config file path (protected), or null when config was injected. */
    readonly configFile: string | null;
    /** Additional protected paths (credential file, socket, etc.). */
    readonly protectedPaths?: readonly string[];
    /** Known secret values to scrub from evidence and errors. */
    readonly knownSecrets?: KnownSecrets;
    /** Builds project tools; overridable so tests can inject an unsandboxed seam. */
    readonly createTools?: (root: string, options: CreateProjectToolsOptions) => Promise<ProjectTools>;
    /** Run a read-only host command (git) to enumerate changed files. */
    readonly runHostCommand?: (cwd: string, args: readonly string[]) => Promise<{
        stdout: string;
        code: number;
    }>;
    /** Test seam: disable sandboxing in spawned tools. Never set in production. */
    readonly unsandboxedForTesting?: boolean;
    /** Assignments may reach the network when true. */
    readonly allowNetwork?: boolean;
    /** Service boot id; receipts are stamped with it to detect crash-runs. */
    readonly bootId?: string;
    /**
     * Optional sink notified on every assignment STATE transition. It is called
     * AFTER the store write, with the prior state, so event-driven manager wakes
     * are emitted at the single transition chokepoint. Absent in tests that do
     * not exercise manager wakes.
     */
    readonly onTransition?: (transition: import("./manager-coordinator.js").WakeTransition) => string | null | void;
}
/** The minimal shape the service needs to answer `assignments.*` calls. */
export interface AssignmentSummary {
    readonly id: string;
    readonly projectId: string;
    readonly sessionId: string | null;
    readonly conversationId: string | null;
    readonly state: AssignmentState;
    readonly submissionId: string | null;
    readonly parentId: string | null;
    /** Model-generation attempts consumed so far (every attempt/restart counts). */
    readonly attemptCount: number;
    /** Absolute epoch-ms deadline for the whole assignment, or null when unbounded. */
    readonly deadlineAt: number | null;
    /** Final assistant stop reason observed, or null before a terminal message. */
    readonly stopReason: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly error: string | null;
}
/** The detailed payload returned by `assignments.show`. */
export interface AssignmentDetail extends AssignmentSummary {
    /** Redacted, bounded task text as originally submitted. */
    readonly task: string | null;
    readonly acceptanceCriteria: string | null;
    readonly evidence: unknown;
    readonly reviewNote: string | null;
    readonly reviewedAt: number | null;
}
/** Result of one `create`/`submit` call. */
export interface SubmitResult {
    readonly assignment: AssignmentDetail;
    readonly replayed: boolean;
}
/** Result of admitting one operator steer/follow-up input. */
export interface SteerResult {
    readonly assignment: AssignmentDetail;
    /** The durable input requestId (its idempotency key). */
    readonly inputId: string;
    /** The Pi submission id once admitted, or null while still preparing. */
    readonly submissionId: string | null;
    readonly mode: "steer" | "followup";
    readonly replayed: boolean;
}
/** Raised for assignment-engine misuse. Never contains raw payload data. */
export declare class AssignmentError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Raised when `accept` is refused because the reviewed evidence no longer
 * matches the current checkout, or because no verifiable evidence exists. The
 * structured `detail` is surfaced verbatim to the CLI/service.
 */
export declare class EvidenceStaleError extends AssignmentError {
    readonly detail: Record<string, unknown>;
    constructor(message: string, detail: Record<string, unknown>);
}
/**
 * Raised from the generation `beforeRequest` hook when a hard limit is hit.
 * The `kind` distinguishes a step-budget stop from a wall-clock timeout.
 */
export declare class AssignmentLimitError extends Error {
    readonly kind: "budget" | "timeout";
    constructor(kind: "budget" | "timeout", message: string);
}
/**
 * Map a Pi terminal submission status onto our assignment state.
 *
 * A settled `done` means the agent stopped cleanly; it does NOT mean the work
 * is accepted. Anything else is an incomplete stop and is surfaced as such.
 */
export declare function mapSettledStatus(status: PiSubmissionStatus): AssignmentState;
/** Build the worker instruction block delivered to the agent. */
export declare function buildInstructions(project: ProjectRecord, task: string, criteria: string | undefined, permissions?: PermissionSnapshot): string;
/** The engine: durable orchestration of assignments over a shared harness. */
export declare class AssignmentEngine {
    private readonly harness;
    private readonly registry;
    private readonly metadata;
    private readonly config;
    private readonly providerId;
    private readonly modelForSession?;
    private readonly stateDir;
    private readonly extraProtected;
    private readonly knownSecrets;
    private readonly createTools;
    private readonly runHostCommand;
    private readonly unsandboxedForTesting;
    private readonly allowNetwork;
    /** Optional per-command bash timeout cap (ms); null = unlimited. */
    private readonly commandTimeoutMs;
    /**
     * The current service boot id. Receipts are stamped with it so a later boot
     * can detect commands that may have run to completion before a crash.
     */
    private readonly bootId;
    private readonly onTransition;
    /** Per-project tool bundles and their extension names, keyed by project id. */
    private readonly bundles;
    /** In-flight requestIds, so concurrent duplicate submits never double-admit. */
    private readonly inFlight;
    /** Background settlement promises, keyed by assignment id. */
    private readonly runs;
    private readonly activeToolIds;
    private readonly operatorPauseJobs;
    /** Operator pause is a durable admission fence, not a signal to kill a tool.
     * The current tool finishes normally; provider/tool admission remains closed
     * until a fresh continuation is explicitly submitted by the manager. */
    pause(params: {
        id: string;
        note: string;
        requestId: string;
    }): Record<string, unknown>;
    private kickOperatorPause;
    private finishOperatorPause;
    /** Live conversations, keyed by assignment id, so abort can reach them. */
    private readonly live;
    /** Quarantined assignments (dirty-boot command receipts), keyed by id. */
    private readonly quarantined;
    /**
     * Every assignment id admitted in this process, mapped to its project id.
     * Used by project-scoped abort so we kill ONLY the target project's bundles
     * and conversations, and to hold the writer lease until the scope is idle.
     */
    private readonly admitted;
    /**
     * Maps a Pi conversation id to the assignment currently driving it, so the
     * generation `beforeRequest` hook can attribute model attempts to the right
     * assignment (and enforce `limits.maxSteps`).
     */
    private readonly conversationToAssignment;
    /** In-memory model-attempt counters, keyed by assignment id. */
    private readonly attempts;
    /**
     * The live run scope per assignment (conversation + Pi submission id), so a
     * generation-hook limit trip can abort exactly the target run. Pi swallows
     * non-abort hook throws, so a cap MUST abort the submission to stop the run.
     */
    private readonly stoppable;
    /**
     * Tracked operator inputs per assignment, keyed by assignment id then
     * requestId. Each entry is the durable intent plus its live admission promise
     * (resolved once Pi has accepted the submission). Steering/follow-up inputs
     * share the parent assignment's lease/budget/deadline; the settlement loop
     * waits for EVERY tracked submission before collecting evidence.
     */
    private readonly inputs;
    /**
     * Assignments whose run has ENTERED SETTLEMENT (closing). No new operator
     * input may be admitted once an assignment is closing: the lease is about to
     * be freed, so admitting more work now would outlive it. The gate is checked
     * synchronously with no await gap between it and the input's state check.
     */
    private readonly closing;
    /**
     * Assignments that have tripped a hard limit ("budget"/"timeout"). Once set
     * it is NEVER cleared for that id: every subsequent model request is refused,
     * so a retry cannot bypass the cap. The terminal record state is written only
     * after the run scope is idle.
     */
    private readonly tripped;
    /**
     * Signaled at service shutdown. The fail-closed generation hook awaits this
     * (alongside the invocation's `context.abortSignal`) so a run whose cancel API
     * failed never returns to provider dispatch; shutdown releases the wait.
     */
    private readonly shutdown;
    /**
     * Per-assignment command record sequence, keyed by assignment id. Guarded by
     * no `await` between read and write so parallel commands (which resolve out
     * of order) never lose a record to a read-modify-write race.
     */
    private readonly commandSeq;
    /**
     * In-flight async artifact writes (full command output copies). Awaited
     * before the writer lease is freed so no immutable artifact is half-written
     * after the checkout is released.
     */
    private readonly pendingArtifacts;
    /**
     * In-flight async manager-request FINALIZERS. They run OUTSIDE the tool
     * invocation (bonus: no self-join deadlock) and are tracked so shutdown and
     * tests can await them before closing the store / asserting durable state.
     */
    private readonly pendingPauseFinalizers;
    /**
     * Per-project writer lease mutex for explicit `assignments.restore`. The
     * synchronous check+set (no await) mirrors the submit-time lease invariant.
     */
    private readonly restoreLeases;
    constructor(options: AssignmentEngineOptions);
    /**
     * Single transition chokepoint. Reads the current state, writes the patch via
     * the store, then notifies the manager-wake sink ONLY when the state actually
     * changed. All state-writing call sites go through here so wakes can never
     * drift from the persisted row. Non-state patches (evidence/submission/lease)
     * pass through unchanged and emit nothing.
     */
    private transition;
    /**
     * Create and immediately submit an assignment.
     *
     * Idempotency: the `(kind, requestId)` journal and the assignment row are
     * written BEFORE the input reaches Pi. A repeat call with the same
     * `requestId` and payload replays the stored assignment; a different payload
     * is a conflict. Concurrent duplicate calls are serialized so Pi admits the
     * input exactly once.
     */
    submit(params: {
        projectId: string;
        task: string;
        criteria?: string;
        sessionId?: string;
        requestId: string;
        parentId?: string;
    }): Promise<SubmitResult>;
    private submitOnce;
    /** Read one assignment, including bounded evidence and acceptance criteria. */
    show(params: {
        id?: string;
        requestId?: string;
    }): AssignmentDetail;
    /**
     * Return one bounded section of a stored evidence bundle, chunked with a
     * SHA-256 digest and next-offset cursor so large snapshots/command lists can
     * be paged without loading them whole. Scoped to the assignment's OWN
     * recorded evidence — never an arbitrary filesystem path.
     */
    evidenceSection(params: {
        id: string;
        section?: string;
        offset?: number;
        limit?: number;
        allowLegacy?: boolean;
    }): Promise<{
        id: string;
        section: string;
        legacy: boolean;
        note: string | null;
        totalChars: number;
        nextOffset: number | null;
        sha256: string;
        chunk: string;
        bundle: EvidenceBundle | null;
    }>;
    /** Serialize one evidence section to (redacted) text. */
    private serializeEvidenceSection;
    /** Chunk `text` into ≤64 KiB windows with a SHA-256 + next-offset cursor. */
    private chunk;
    /**
     * Read a bounded slice of a previously-recorded artifact, scoped strictly to
     * artifact ids this assignment recorded. Arbitrary filesystem paths are
     * rejected. `maxChars` is capped at 64 KiB per call.
     */
    artifactChunk(params: {
        id: string;
        artifactId: string;
        offset?: number;
        maxChars?: number;
    }): Promise<{
        id: string;
        artifactId: string;
        totalChars: number;
        nextOffset: number | null;
        sha256: string;
        chunk: string;
    }>;
    /** Show the pre-admission checkpoint manifest ref/counts/verified state. */
    checkpointInfo(params: {
        id: string;
    }): Promise<{
        id: string;
        manifestRef: string | null;
        counts: {
            files: number;
            symlinks: number;
            totalBytes: number;
        } | null;
        verified: boolean;
        corrupt: string[];
        complete: boolean;
        reasons: string[];
    }>;
    /**
     * Restore a recorded pre-image checkpoint of the checkout.
     *
     * This is an EXPLICIT operator command only, and it is IDEMPOTENT via the
     * durable `(kind, requestId)` journal (a replay returns the SAME result
     * artifact). The writer lease is acquired SYNCHRONOUSLY (check+set with no
     * await) before any async IO, so a busy project is rejected; the lease is
     * held (via the same lease invariant as submit) until all restore IO is done.
     * Default is MISSING-only: a human-edited file is never clobbered and added
     * files are never removed unless `overwrite:true`.
     */
    restore(params: {
        id: string;
        paths?: readonly string[];
        overwrite?: boolean;
        expectedHash?: Record<string, string>;
        requestId: string;
    }): Promise<{
        id: string;
        requestId: string;
        replayed: boolean;
        restored: string[];
        skipped: string[];
        conflicts: string[];
        errors: {
            path: string;
            reason: string;
        }[];
        ok: boolean;
    }>;
    list(params?: {
        projectId?: string;
    }): AssignmentSummary[];
    /**
     * Record an operator review verdict for an assignment.
     *
     * This is the ONLY path that may move an assignment beyond `needs_review`.
     * `accept` marks the assignment accepted as-is; `revise` records that another
     * pass is required (the operator then submits a revision with `parentId`).
     * Only a `needs_review` (or a previously reviewed) assignment may be reviewed;
     * reviewing a still-running assignment is rejected.
     */
    review(params: {
        id: string;
        decision: "accept" | "revise";
        note?: string;
    }): Promise<AssignmentDetail>;
    /**
     * Confirm the CURRENT checkout still matches the recorded after-manifest
     * EXACTLY — every file, hash, type, and set. A record with NO after-manifest
     * (legacy/pre-feature) is reported as `evidence_unavailable`, never silently
     * treated as verified. An added, removed, or modified file is `evidence_stale`;
     * an incomplete/tampered manifest or a bounded re-capture is `evidence_incomplete`
     * (fail closed). `changes`-only evidence is NEVER sufficient on its own.
     */
    private verifyAcceptFreshness;
    /**
     * Block until an assignment reaches a terminal state, returning its detail.
     *
     * `wait` reattaches to Pi's submission by id, so it works after a service
     * restart as long as the submission was admitted. `timeoutMs` bounds the
     * wait; on expiry the current (`running`) state is returned.
     */
    wait(params: {
        id: string;
        timeoutMs?: number;
    }): Promise<AssignmentDetail>;
    /**
     * True when a `blocked` row has finished its manager-request transition, i.e.
     * its pause intent is no longer `pending` (completed or failed) or there is no
     * pause intent at all (a plain blocked row). Used only by {@link wait} so it
     * returns promptly on a settled pause WITHOUT racing the durable outbox event.
     */
    private isSettledBlocked;
    /**
     * Begin an orderly engine shutdown.
     *
     * Aborts the internal shutdown signal so any fail-closed generation hook stops
     * suspending, and marks the engine as stopping: a run that rejects BECAUSE of
     * teardown must NOT rewrite durable state as `failed` (that would create a
     * spurious terminal row and defeat restart reconciliation). Surviving `running`
     * rows are what a fresh engine reattaches. Idempotent.
     */
    shutdownEngine(): void;
    /**
     * Abort a running assignment.
     *
     * Withdraws queued input, signals live tasks, marks the assignment
     * `cancelling` until the scope is idle, then `cancelled`. The writer lease is
     * released only once the process scope has stopped, so a half-killed process
     * never leaves the checkout free to a second writer.
     */
    abort(params: {
        id: string;
    }): Promise<AssignmentDetail>;
    /**
     * Explicitly recover a BLOCKED assignment under a NEW request id.
     *
     * A blocked row means the service restarted BEFORE the input reached Pi, so
     * the work was never admitted and must not be reported as a replay. Recovery
     * is deliberately explicit (never automatic) and fails closed when the old
     * row WAS submitted: replaying a submitted request could double-write the
     * checkout, so we require manual operator review instead.
     *
     * On success this creates a NEW child assignment (`parentId` = blocked id)
     * with the caller's new request id, inheriting the original task/criteria.
     */
    recover(params: {
        id: string;
        requestId?: string;
        sessionId?: string;
    }): Promise<SubmitResult>;
    /**
     * Admit operator steering or follow-up input into an EXISTING assignment.
     *
     * This is the ONLY supported way to add input to a running conversation. A
     * bare `conversation.submit` would bypass the writer lease and budgets, so it
     * is refused at the RPC layer and callers must come through here.
     *
     * Guards:
     *   - the assignment must exist and still own its checkout (a live lease);
     *   - a terminal assignment must be re-driven with a fresh assignment, not
     *     steered, so callers are told to cancel/reassign instead;
     *   - an input arriving after the run's closing/admissions gate is REJECTED
     *     with new-assignment guidance (the lease is about to be freed, so
     *     admitting more work now would outlive it).
     *
     * Durability: a NEW `requestId` is persisted in `assignment_inputs` (state
     * `preparing`) BEFORE the input reaches Pi, then moved to `admitted` with the
     * Pi submission id. Reusing a requestId with the SAME content replays (never
     * double-submits); reusing it with DIFFERENT content is a conflict. Every
     * tracked input shares the parent assignment's budget, deadline, and lease,
     * and the settlement loop waits for all of them.
     */
    steer(params: {
        id: string;
        content: string;
        mode: "steer" | "followup";
        requestId: string;
    }): Promise<SteerResult>;
    /**
     * Admit one tracked operator input to Pi and record its submission id.
     *
     * Kept small so the closing/admissions gate in `settle` and `abort` can race
     * against it without an await gap: callers hold the returned promise and
     * either await it (admission) or withdraw its submission id (abort).
     */
    private admitInput;
    /**
     * Await every tracked operator input for an assignment, then settle it.
     *
     * Loops until the tracking set is stable: an input may be admitted while an
     * earlier one is still settling, but each is waited for exactly once. Because
     * `settle` sets the closing gate before calling this, no NEW input can be
     * admitted after the loop empties, so the loop terminates.
     */
    private waitForInputs;
    /**
     * Block every assignment that recorded a command process group during a prior
     * UNCLEAN boot. MUST run BEFORE `harness.resume()` so a durable conversation
     * is never re-driven while an external command may still be running or may
     * have executed before its Pi result was committed. Idempotent.
     *
     * We never signal the recorded group here (a pgid may have been reused); we
     * only retain a quarantine record so the row stays blocked and lease-holding.
     *
     * Blocking the manager row is NOT sufficient by itself: the Pi harness stores
     * the submission durably and `harness.resume()` re-drives every unsettled
     * submission regardless of this row's state. So we ALSO withdraw the durable
     * submission (and any recorded operator inputs) via the public
     * `harness.abortSubmission` BEFORE the caller resumes, so a quarantined
     * command is never re-executed. Idempotent.
     */
    applyQuarantine(quarantine: readonly QuarantineDecision[]): Promise<number>;
    /**
     * Reconcile durable state after a restart.
     *
     * Any assignment left `queued`/`running`/`cancelling` with no live process is
     * re-examined: if Pi still knows the submission we reattach and let it
     * settle; otherwise we mark it `blocked` rather than silently freeing the
     * writer lease (an uncertain process may still be mutating the checkout).
     * Returns a summary count for logging.
     */
    reconcile(quarantine?: readonly QuarantineDecision[]): Promise<{
        reattached: number;
        blocked: number;
    }>;
    /**
     * Build and register tool bundles for every known project.
     *
     * Called once at service start (and before resuming harness state), so each
     * project's extension is installed under its unique name before any
     * conversation — including one rehydrated by `harness.resume` — tries to
     * enable it. Idempotent: re-running reuses the existing bundle.
     */
    preloadProjects(): Promise<number>;
    /** Abort every live assignment's process scope. Used during shutdown. */
    stopAll(): Promise<void>;
    /** Resolve the conversation for an assignment, creating one when needed. */
    private ensureConversation;
    /** The agent change (model/cwd/instructions) for a project. */
    private agentChange;
    /**
     * Generation hooks that enforce this assignment engine's hard limits.
     *
     * `beforeRequest` fires before every model call (each step of a turn). We
     * count attempts per conversation and, when `limits.maxSteps` is reached or
     * the assignment deadline has passed, throw so the generation stops. The
     * throw is our signal: it prevents an unbounded run and lets the settle path
     * record an honest terminal state. We never silently continue, and we never
     * relabel a terminal budget/timeout as `needs_review`.
     */
    private budgetHooks;
    /**
     * Trusted admission gate for EVERY project tool call, installed as a
     * `beforeTool` hook (and mirrored synchronously via `beforeExecute`).
     *
     * This is the AUTHORITATIVE defense (never rely on upstream abort semantics):
     * a durable tool call may be re-driven by `harness.resume()` regardless of the
     * manager row's state, so we refuse the call unless the conversation's
     * assignment is CURRENTLY admitted. Fail-closed: an unmanaged conversation, a
     * terminal/blocked row, or a quarantined row all refuse with a model-visible
     * block so Pi drains the call without any side effect.
     *
     * Ownership: the assignment is resolved from the live map AND the durable
     * `conversationId` column, so an OLD quarantined tool call cannot borrow a
     * fresh assignment's admission — the conversation id is fixed per assignment.
     */
    private toolGuards;
    /**
     * True when `conversationId` EVER carried an assignment whose command was left
     * in doubt (`stopReason === "in_doubt_command"`). Such a conversation is
     * RETIRED: its transcript may contain a tool call whose side effect was never
     * committed, so it must never be reused for new work — a fresh session is
     * required. This closes the session-reuse ownership edge (Pi reuses a
     * conversation across assignments when the operator passes the same session).
     */
    isRetiredConversation(conversationId: string): boolean;
    /**
     * True when `sessionId` is retired because it maps to a conversation that EVER
     * carried an in-doubt command.
     */
    isRetiredSession(sessionId: string): boolean;
    /**
     * Decide whether a tool call in `conversationId` is admitted. Returns a
     * refusal reason, or `undefined` when the call may proceed. Fail-closed.
     *
     * Order matters:
     *   1. A RETIRED conversation (any historical in-doubt command) is refused
     *      unconditionally — an old quarantined tool call must never borrow a
     *      fresh assignment's admission, even if the operator reuses the session.
     *   2. Otherwise, resolve the assignment that CURRENTLY owns the conversation:
     *      the live map, then (during `harness.resume()`, before `reconcile`) the
     *      current writer-lease holder, then the LATEST recorded row — never the
     *      first historical terminal row.
     *   3. Admit only `queued`/`running`/`cancelling` rows that still hold their
     *      checkout lease and are not quarantined in this process.
     */
    toolAdmissionReason(conversationId: string, toolName: string): string | undefined;
    /**
     * Enforce `limits.maxSteps` / `limits.timeoutMs` from the generation
     * `beforeRequest` hook.
     *
     * Pi's generation scheduler SWALLOWS ordinary hook throws (it reports an
     * `extension_error` and continues) unless the invocation controller signal is
     * aborted — so a bare throw cannot stop a run. The invocation context carries
     * that controller signal (`context.abortSignal`); we therefore (1) abort the
     * TARGET task with the supported `harness.abortTask(api.taskId, ...)` API,
     * which signals the controller on a reconcile pass, (2) wait — bounded — for
     * that signal to abort, then (3) throw. Once the signal is aborted, `hooks.each`
     * rethrows and the provider is never dispatched, so exactly `maxSteps` requests
     * run. We must NOT await `abortTask` completion here: it joins this very
     * invocation and would deadlock.
     */
    private enforceBudgetHook;
    /**
     * Record an explicit `blocked` state for an assignment whose limit stop could
     * not be delivered, RETAINING the writer lease. Unlike the crash-recovery
     * block path, this row keeps `leasePath` set so `getActiveLease` still
     * detects it and no new submit can claim the checkout while cleanup is pending.
     */
    private recordBlockedNoCancel;
    /**
     * Trusted handler for the worker `request_manager` tool. Binds ONLY the
     * current assignment (resolved from the calling conversation), records a
     * durable `manager_request` event, and PAUSES the run: the row is set to a
     * truthful `blocked`/`manager_request` state that RETAINS the writer lease
     * until the manager reviews/cancels/responds. We fire `harness.abortTask`
     * WITHOUT awaiting it (awaiting would join this very invocation and deadlock),
     * so no further tool side effects or provider requests occur after the pause.
     *
     * The model can never choose a different thread or project: the target is
     * whatever assignment currently owns the calling conversation.
     */
    private handleManagerRequest;
    /**
     * Async manager-request FINALIZER, run OUTSIDE the tool invocation:
     *   1. abort the TARGET scope/processes (never knowingly joining our own run),
     *   2. CONFIRM this project's owned bash groups drained (bounded), then
     *   3. in ONE transaction write the FINAL blocked/manager_request state PLUS
     *      exactly ONE durable manager_request outbox event, capturing the ACTUAL
     *      persisted event id.
     * On cleanup failure we FAIL CLOSED: the pause state + wake are still written
     * (the question is never lost) but the event truthfully reports that cleanup
     * could not be confirmed, and the intent is marked `failed`.
     */
    private runManagerPauseFinalizer;
    /**
     * Resolve once every in-flight manager-request finalizer has settled. Used at
     * shutdown (so no durable pause is written after the store closes) and by
     * tests that need deterministic observation of the final durable state.
     */
    whenManagerPauseIdle(): Promise<void>;
    /**
     * Reconcile durable pause intents left `pending` by a crash/restart: re-run
     * the finalizer so the pause state + wake are finished (or truthfully failed)
     * rather than silently lost. Idempotent via the outbox dedup key.
     */
    private reconcileManagerPauseIntents;
    /**
     * Compute whether this assignment has just exceeded a limit, WITHOUT mutating
     * any state. Returns the terminal kind, or null to allow the request.
     */
    private budgetTripKind;
    /**
     * Stop the target run for a tripped limit WITHOUT joining it.
     *
     * Marks the id tripped, kills ONLY the target project's tool processes, and
     * aborts the target submission via `harness.abortSubmission` /
     * `conversation.abort` (fire-and-forget — these resolve only once the run
     * settles, so awaiting them inside the run's own scope would deadlock). On the
     * generation-hook path, `enforceBudgetHook` additionally aborts the task via
     * `harness.abortTask` and waits on the invocation cancel signal so the extra
     * provider request is never dispatched. The deadline timer calls this directly
     * (no hook context), which still stops a tool/shell outliving the deadline.
     */
    private requestLimitStop;
    /**
     * Arm a wall-clock deadline for an assignment.
     *
     * On expiry (if the assignment is still running) it marks the id as tripped
     * (`timeout`) so any further model request is refused, kills ONLY the target
     * project's tool processes, and aborts the conversation's submission. This
     * covers a tool/shell that outlives the deadline, which `beforeRequest`
     * cannot see. Returns the timer handle (or undefined for a non-positive
     * window) so the caller can clear it on settle.
     */
    private armDeadline;
    /** Execute the deadline action once, scoped to the target project's scope. */
    private fireDeadline;
    /** Build (or reuse) the per-project tool bundle with a UNIQUE extension name. */
    private readonly bundlePermissions;
    private ensureBundle;
    /**
     * Handle a background run rejection.
     *
     * A budget/timeout stop is an honest TERMINAL state already recorded by the
     * hook; we must not overwrite it with `failed`. Any other rejection is a real
     * failure. Either way the lease is released and the live map cleaned up, so
     * no unmanaged write survives a freed lease.
     */
    private onRunFailure;
    /**
     * The protected paths handed to the sandbox/tools and the checkpoint walker.
     * Beyond the operator-configured list, the private state dir, any credential
     * file, and the runtime socket are always excluded, alongside the checkout's
     * `.git`/`.secrets`/`.runtime`/`.env` names enforced inside the evidence and
     * checkpoint modules.
     */
    private effectiveProtectedPaths;
    /**
     * Capture a hashed baseline snapshot AND a full file pre-image checkpoint
     * before admitting anything to Pi. Returns `{ ok: false }` (never throws)
     * when the checkpoint is incomplete or the capture failed, so the caller can
     * fail closed WITHOUT a provider request.
     */
    private capturePreAdmission;
    /**
     * Record one tool/shell command result for the CURRENT active assignment of
     * `project`. The summary is redacted + bounded; the FULL output is copied to
     * an immutable private artifact ONLY when it lives at a known canonical path
     * inside the assignment's scratch dir (regular file, NO follow). The durable
     * evidence JSON is updated with a no-await read-modify-write so parallel
     * commands never lose a record.
     */
    private recordCommand;
    /**
     * Persist a durable process receipt SYNCHRONOUSLY.
     *
     * This runs on BOTH `started` and `stopped`. The `started` receipt is written
     * before `runSandboxedCommand` releases the START barrier, so a crash can
     * never leave an external command whose existence is unrecorded. A `stopped`
     * receipt is written only after the command's group has gone away.
     *
     * The command text is redacted before it is stored: receipts must never leak
     * model-supplied secrets even though the command itself is model-visible.
     */
    private recordProcessReceipt;
    /** The single active/running assignment driving `project`, if any. */
    private activeAssignmentFor;
    private rowForConversation;
    private audit;
    /** Merge the command list into the durable evidence JSON (read-modify-write). */
    private persistEvidenceCommands;
    /**
     * Copy a command's full-output artifact into the assignment's private
     * artifact dir. The source MUST be the exact canonical path the sandbox
     * reported AND a strict descendant of the assignment's scratch dir; a
     * symlink/non-regular source is refused. Copy is capped with an explicit
     * truncation flag; when ineligible, the captured stdout/stderr tails are used.
     */
    private copyCommandArtifact;
    /** Await every in-flight async artifact write before the lease is freed. */
    private flushArtifacts;
    /**
     * Capture the after-hash snapshot and compare it to the pre-admission
     * baseline. Only real additions/modifications/deletions are reported; a
     * pre-existing untracked file that did not change is NEVER claimed changed.
     */
    private captureAfterAndCompare;
    /**
     * Persist the full after-manifest for `after` as a private immutable artifact
     * and return its bounded ref. The manifest is written even when `after` is
     * itself bounded/incomplete; the ref records `bounded:true` so a later accept
     * fails closed rather than silently trusting a truncated image.
     */
    private persistAfterManifest;
    /** Drive a submission to settlement and record the resulting state/evidence. */
    private settle;
    /**
     * Read the newest assistant message's stop reason and text.
     *
     * `order: "descending"` yields NEWEST first; the first assistant entry is the
     * terminal message. A read failure degrades to a null reason (never fails the
     * assignment), so classification is best-effort but never throws.
     */
    private readFinalStop;
    /**
     * Read the last assistant text from the conversation transcript, bounded.
     *
     * The final assistant message is the agent's report; we surface it (redacted
     * and length-capped) so the operator can review the outcome without opening
     * the raw transcript. A read failure never fails the assignment.
     */
    private readFinalReport;
    /** Collect bounded evidence for an assignment from the checkout. */
    private collectEvidence;
    private redactString;
    private redactBounded;
    /** Verify a replayed requestId carries the same payload as the stored row. */
    private assertSamePayload;
    private summary;
    private detail;
    private redact;
}
/** True for assignment states that need no further engine progress. */
export declare function isTerminal(state: AssignmentState): boolean;
/**
 * Select the agent's final report text from transcript entries.
 *
 * Callers pass entries in DESCENDING order (newest first). The final report is
 * the newest non-empty assistant text, so we return the FIRST match found and
 * stop. (Overwriting with each match instead would surface the OLDEST assistant
 * turn — e.g. an early "I'll create…" preamble — which is the bug this guards.)
 */
export declare function selectFinalReportText(items: readonly {
    model?: readonly {
        role: string;
        content: unknown;
    }[];
}[]): string | null;
/**
 * Select the terminal assistant message's stop reason from transcript entries.
 *
 * Callers pass entries in DESCENDING order (newest first), so the first
 * assistant message is the terminal one. The `stopReason` may live on the
 * message itself or on an entry-level `model` record; we accept either. A
 * missing/blank reason yields `null` (treated as a clean stop by callers that
 * only downgrade on an explicit non-`stop` reason).
 */
export declare function selectFinalStopReason(items: readonly {
    stopReason?: unknown;
    model?: readonly {
        role: string;
        content: unknown;
        stopReason?: unknown;
    }[];
}[]): string | null;
export {};
//# sourceMappingURL=assignments.d.ts.map