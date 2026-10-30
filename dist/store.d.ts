import { type ActivityEntry, type ActivityInput } from "./activity.js";
import { type KnownSecrets } from "./redact.js";
/**
 * Application metadata store.
 *
 * This is OUR store: project registry, session mapping, assignment request
 * records, and the idempotent creation journal. It is a SEPARATE node:sqlite
 * database from Pi's own durable storage, owned by the same service process.
 * The two are reconciled through this journal (by Pi IDs and request IDs), not
 * through one shared transaction.
 *
 * One writer: the service opens the database exclusively for its lifetime and
 * only through {@link MetadataStore.open}. Clients never touch this file.
 */
/** Current application schema version. Bump and add a migration to change it. */
export declare const SCHEMA_VERSION = 8;
/** Default journal entry statuses. */
export type JournalStatus = "preparing" | "ready" | "error";
/** A journal entry: one idempotent operation keyed by `(kind, requestId)`. */
export interface JournalRecord {
    readonly id: number;
    readonly kind: string;
    readonly requestId: string;
    readonly payloadHash: string;
    readonly status: JournalStatus;
    readonly resultId: string | null;
    readonly error: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
}
/** Stored project record. */
export interface ProjectRecord {
    readonly id: string;
    readonly name: string;
    /** Canonical absolute path of the project checkout. */
    readonly path: string;
    /** `created` for a fresh git init, `imported` for an existing directory. */
    readonly origin: "created" | "imported";
    readonly requestId: string;
    readonly createdAt: number;
    readonly updatedAt: number;
}
/** Stored session record mapping a Pi conversation to a project. */
export interface SessionRecord {
    readonly id: string;
    readonly projectId: string;
    /** Pi conversation id, stored as a string because Pi brands it as a number. */
    readonly conversationId: string;
    readonly requestId: string;
    readonly createdAt: number;
}
/**
 * Lifecycle state of an assignment, as persisted by our metadata store.
 *
 * This is OUR coarse state, distinct from Pi's per-submission status. It moves
 * `queued` -> `running` -> `needs_review` on the happy path, and to one of the
 * incomplete terminal states (`failed`/`unanswered`/`budget`/`timeout`/
 * `blocked`) otherwise. Only operator review may promote an assignment beyond
 * `needs_review`; the engine never records `accepted` by itself.
 */
export type AssignmentState = "queued" | "running" | "needs_review" | "accepted" | "revision_requested" | "failed" | "unanswered" | "budget" | "timeout" | "cancelling" | "cancelled" | "blocked";
/** Terminal assignment states (no further progress without a new assignment). */
export declare const TERMINAL_ASSIGNMENT_STATES: readonly AssignmentState[];
/** A stored assignment request and its durable execution state. */
export interface AssignmentRecord {
    readonly id: string;
    readonly projectId: string;
    readonly sessionId: string | null;
    /** Pi conversation the assignment drives, stored as a string. */
    readonly conversationId: string | null;
    readonly requestId: string;
    readonly state: AssignmentState;
    /** JSON-encoded acceptance criteria supplied by the operator. */
    readonly acceptanceCriteria: string | null;
    /** Pi submission id once admitted; required for reattach after restart. */
    readonly submissionId: string | null;
    /** Stable payload hash used to detect requestId reuse with a new payload. */
    readonly payloadHash: string;
    /** Parent assignment id when this is a revision of an earlier assignment. */
    readonly parentId: string | null;
    /**
     * Redacted task text as submitted by the operator. Persisted so an operator
     * can review WHAT was asked even after a crash/restart, and surfaced via the
     * assignment detail. Bounded and redacted before storage.
     */
    readonly task: string | null;
    /** Model-generation attempts consumed so far (every attempt/restart counts). */
    readonly attemptCount: number;
    /** Absolute epoch-ms deadline for the whole assignment, or null when unbounded. */
    readonly deadlineAt: number | null;
    /**
     * The final assistant message's stop reason (e.g. `stop`, `length`, `error`,
     * `aborted`) once observed, used to classify an incomplete stop. Null until a
     * terminal provider message has been seen.
     */
    readonly stopReason: string | null;
    /** Writer-lease owner (canonical checkout) held while the assignment runs. */
    readonly leasePath: string | null;
    /** JSON-encoded evidence summary (changed files, command results). */
    readonly evidence: string | null;
    /** Operator review note recorded by `assignments.review`, if any. */
    readonly reviewNote: string | null;
    /** When the operator last reviewed this assignment, if ever. */
    readonly reviewedAt: number | null;
    /** Last redacted error message, if any. */
    readonly error: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
}
/**
 * Lifecycle of one tracked operator input (a steer/follow-up on a running
 * assignment).
 *
 * `preparing`  — intent persisted durably; the Pi submission has NOT yet been
 *                admitted (a crash here replays idempotently by requestId).
 * `admitted`   — admitted to Pi and the submission id is stored.
 * `done`       — the submission settled (terminal, either answered or not).
 * `error`      — admission failed; the input is terminal and never replayed.
 */
export type AssignmentInputState = "preparing" | "admitted" | "done" | "error";
/**
 * One tracked operator input on an assignment.
 *
 * The `(requestId)` primary key makes every operator input idempotent: a repeat
 * with the same content hash replays; a repeat with different content is a
 * conflict. The row is written BEFORE the input reaches Pi, so a restart can
 * reattach (or safely replay) every input instead of silently dropping it.
 */
export interface AssignmentInputRecord {
    /** Caller-supplied idempotency key; unique across ALL inputs. */
    readonly requestId: string;
    readonly assignmentId: string;
    /** `steer` interrupts the current turn; `followup` queues a new turn. */
    readonly mode: "steer" | "followup";
    /** Stable hash of the (already validated) content; detects id reuse. */
    readonly contentHash: string;
    /** Redacted, bounded content, kept so a restart can replay it verbatim. */
    readonly redactedContent: string;
    /** Pi submission id once admitted; null while `preparing`. */
    readonly submissionId: string | null;
    readonly state: AssignmentInputState;
    readonly createdAt: number;
}
export declare class StoreError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Deterministic canonical JSON: object keys sorted, no insignificant whitespace. */
export declare function canonicalJson(value: unknown): string;
/** SHA-256 hex digest of the canonical JSON form of `value`. */
export declare function payloadHash(value: unknown): string;
/**
 * Open application metadata storage at `path`.
 *
 * Creates the parent directory with private (0700) permissions, the file
 * itself with 0600, and applies the schema (idempotently). Refuses a database
 * written by a newer schema version rather than guessing at its shape.
 */
export declare class MetadataStore {
    private readonly db;
    private readonly filePath;
    private closed;
    /** Nesting depth for {@link withTransaction}; 0 = no transaction open. */
    private txnDepth;
    private activitySecrets;
    private constructor();
    static open(filePath: string): Promise<MetadataStore>;
    /** Absolute path of the opened database file. */
    get path(): string;
    get schemaVersion(): number;
    setActivitySecrets(secrets: KnownSecrets): void;
    appendActivity(input: ActivityInput): ActivityEntry;
    listActivity(after?: number, limit?: number, projectId?: string): ActivityEntry[];
    latestWorkActivity(assignmentId: string): ActivityEntry | null;
    private activityRow;
    getControl<T>(key: string): T | null;
    setControl(key: string, value: unknown): void;
    /** Exact internal configuration, never an exported activity record or arbitrary worker text.
     * Callers validate the configuration schema. Secret bytes are prohibited; references are allowed.
     * Substring redaction here can corrupt endpoints, paths and authorization policies.
     */
    setPrivateConfiguration(key: string, value: unknown): void;
    /** Workflow text, unlike exact private configuration, is redacted for disclosure safety. */
    setWorkflowControl(key: string, value: unknown): void;
    /** Look up a journal entry by `(kind, requestId)`. */
    getJournal(kind: string, requestId: string): JournalRecord | undefined;
    /**
     * Begin a journal entry. Returns the existing entry when one is present.
     *
     * Idempotency contract: if an entry with the same `(kind, requestId)` exists
     * and its payload hash matches, the existing entry is returned untouched (the
     * caller may then replay the stored result). If the payload hash differs, the
     * request is a conflict and a {@link StoreError} with code `conflict` is
     * thrown. This never overwrites a prior result.
     */
    beginJournal(kind: string, requestId: string, payload: unknown): {
        record: JournalRecord;
        replayed: boolean;
    };
    /** Mark a journal entry `ready` with its result id. */
    completeJournal(kind: string, requestId: string, resultId: string): void;
    /** Mark a journal entry `error` with a redacted message. */
    failJournal(kind: string, requestId: string, message: string): void;
    /** Journal entries left `preparing` by a crash, for reconciliation. */
    pendingJournal(): JournalRecord[];
    insertProject(record: ProjectRecord): void;
    getProject(id: string): ProjectRecord | undefined;
    getProjectByPath(path: string): ProjectRecord | undefined;
    listProjects(): ProjectRecord[];
    /** Close the database. Idempotent. */
    insertSession(record: SessionRecord): void;
    getSession(id: string): SessionRecord | undefined;
    getSessionByConversation(conversationId: string): SessionRecord | undefined;
    getSessionByRequest(requestId: string): SessionRecord | undefined;
    listSessions(projectId?: string): SessionRecord[];
    /**
     * Begin tracking an operator input, keyed by its requestId.
     *
     * Idempotency: a prior row with the SAME content hash is returned untouched
     * (the caller replays); a prior row with a DIFFERENT hash is a `conflict`
     * (requestId reuse with new content). The row is written in state
     * `preparing` BEFORE the input reaches Pi, so a crash here is replayable.
     */
    beginInput(record: {
        requestId: string;
        assignmentId: string;
        mode: "steer" | "followup";
        contentHash: string;
        redactedContent: string;
    }): AssignmentInputRecord;
    /** Read one tracked input by requestId. */
    getInput(requestId: string): AssignmentInputRecord | undefined;
    /** List every tracked input for an assignment, oldest first. */
    listInputs(assignmentId: string): AssignmentInputRecord[];
    /** Move a tracked input to `admitted`, recording its Pi submission id. */
    markInputAdmitted(requestId: string, submissionId: string): void;
    /** Move a tracked input to a terminal `done`/`error` state. */
    setInputState(requestId: string, state: "done" | "error"): void;
    /**
     * Record a service boot as DIRTY. Called synchronously on engine start
     * BEFORE any tool can run. Idempotent per bootId.
     */
    beginServiceRun(bootId: string, pid: number, at: number): void;
    /** Mark a boot clean — ONLY after full drain + Pi storage close. */
    markServiceRunClean(bootId: string, at: number): void;
    /**
     * Persist a process receipt SYNCHRONOUSLY. Called BEFORE the START barrier is
     * released so no supervised command's side effects can precede durability.
     */
    insertProcessReceipt(record: ProcessReceipt): void;
    /** Transition a receipt to a terminal state after its group is gone. */
    setProcessReceiptState(receiptId: string, state: ProcessReceiptState, at: number): void;
    listProcessReceipts(assignmentId: string): ProcessReceipt[];
    /** Every prior boot that did NOT shut down cleanly. */
    listUncleanServiceRuns(): ServiceRunRecord[];
    /** Receipts belonging to any of the given boots that reached a run state. */
    listReceiptsForBoots(bootIds: readonly string[]): ProcessReceipt[];
    /** Insert a new assignment record. */
    insertAssignment(record: AssignmentRecord): void;
    getAssignment(id: string): AssignmentRecord | undefined;
    getAssignmentByRequest(requestId: string): AssignmentRecord | undefined;
    /** Assignments targeting a project, oldest first. */
    listAssignments(projectId?: string): AssignmentRecord[];
    /**
     * The assignment currently holding the writer lease for `leasePath`, if any.
     *
     * A lease is held whenever `lease_path` is non-null — REGARDLESS of state.
     * A `blocked` or terminal-but-not-yet-cleaned assignment still owns the
     * checkout (the lease is cleared only when cleanup completes), so it must be
     * detected here; otherwise a new submit could slip in and write concurrently.
     */
    getActiveLease(leasePath: string): AssignmentRecord | undefined;
    /**
     * Apply a partial update to an assignment, bumping `updated_at`.
     * Unknown fields are ignored; `undefined` values are not written.
     */
    updateAssignment(id: string, patch: Partial<Pick<AssignmentRecord, "state" | "submissionId" | "evidence" | "reviewNote" | "reviewedAt" | "error" | "leasePath" | "sessionId" | "conversationId" | "acceptanceCriteria" | "task" | "attemptCount" | "deadlineAt" | "stopReason">>): void;
    /** Close the database. Idempotent. */
    close(): void;
    /**
     * Run `fn` inside a single SQLite transaction (BEGIN IMMEDIATE/COMMIT, or
     * ROLLBACK on throw). This gives assignment-state + manager-outbox-event
     * ATOMICITY: the engine writes the state patch and the wake event in one
     * transaction, so a crash or an outbox write failure rolls back BOTH (or
     * commits BOTH) — an assignment can never end up in a reviewable state with
     * the matching wake event silently missing (or vice versa).
     *
     * Nested calls reuse the outermost transaction (a depth counter), so callers
     * can compose without spurious "cannot start a transaction within a
     * transaction" errors. Not re-entrant across await points: `fn` must run
     * synchronously (it does — better-sqlite3-style sync statements).
     */
    withTransaction<T>(fn: () => T): T;
    /** Insert or replace the SINGLE manager binding for a project. */
    upsertManagerBinding(record: ManagerBindingRecord): void;
    getManagerBinding(projectId: string): ManagerBindingRecord | undefined;
    listManagerBindings(): ManagerBindingRecord[];
    /** Remove a project's binding; returns true when a row existed. Idempotent. */
    deleteManagerBinding(projectId: string): boolean;
    /**
     * Persist a durable manager-request PAUSE INTENT. This is written BEFORE any
     * cleanup so that (a) the intent survives a crash/restart and can be finished
     * by startup reconciliation, and (b) a fresh tool call can never re-enter. It
     * is idempotent by `intent_id`.
     */
    insertManagerPauseIntent(record: ManagerPauseIntentRecord): void;
    getManagerPauseIntent(intentId: string): ManagerPauseIntentRecord | undefined;
    /** The most recent pause intent for an assignment, if any. */
    getManagerPauseIntentForAssignment(assignmentId: string): ManagerPauseIntentRecord | undefined;
    /** Pause intents not yet finished (status = 'pending'); reconciled on startup. */
    listPendingManagerPauseIntents(): ManagerPauseIntentRecord[];
    /** Mark a pause intent completed, recording the ACTUAL persisted event id. */
    completeManagerPauseIntent(intentId: string, eventId: string, at: number): void;
    /** Mark a pause intent failed (cleanup could not be confirmed); keep detail. */
    failManagerPauseIntent(intentId: string, error: string, at: number): void;
    /**
     * Mark every not-yet-delivered event for `projectId` created strictly before
     * `boundAt` as `superseded`, so a new/retargeted binding NEVER receives a
     * historical replay (and a rebind does not route events recorded for an old
     * thread to the new one). Delivered events are untouched. Returns the count.
     */
    supersedePendingManagerEvents(projectId: string, boundAt: number): number;
    /**
     * Record one manager wake event. IDEMPOTENT: the unique `dedup_key` means a
     * repeat of the same transition (same assignment+state+kind, e.g. a restart
     * re-observing a terminal) is a no-op and returns the existing row with
     * `inserted:false`. Returns the row and whether it was newly inserted.
     */
    insertManagerEvent(record: ManagerEventRecord): {
        record: ManagerEventRecord;
        inserted: boolean;
    };
    getManagerEvent(eventId: string): ManagerEventRecord | undefined;
    getManagerEventByDedup(dedupKey: string): ManagerEventRecord | undefined;
    /** Events for one project, oldest first, optionally only unacknowledged. */
    listManagerEvents(projectId?: string, unackedOnly?: boolean): ManagerEventRecord[];
    /**
     * Pending events whose backoff window has elapsed, for ONE project, oldest
     * first, bounded by `limit`. Project-scoped on purpose: a global LIMIT would
     * let one busy project starve the others. `parked` (retries exhausted) and
     * `superseded` events are NEVER due again, so a restart cannot redeliver a
     * parked event forever.
     */
    listDueManagerEvents(projectId: string, now: number, limit?: number): ManagerEventRecord[];
    /** Distinct project ids that currently have at least one due event. */
    listProjectsWithDueManagerEvents(now: number, limit?: number): string[];
    /**
     * True when a project has at least one event that is due right now (pending,
     * unacked, `next_attempt_at` null or already elapsed). Used to continue
     * draining a batch larger than the per-pass size without waiting for a new
     * transition: a follow-up pass is scheduled immediately (delay 0). This is a
     * bounded drain — each pass delivers up to the batch size — so it cannot spin.
     */
    hasDueManagerEvents(projectId: string, now: number): boolean;
    /**
     * Earliest `next_attempt_at` still scheduled among `pending` events for a
     * project, or null when none. Used to reschedule a retry timer for exactly
     * the delay that remains, instead of spinning.
     */
    earliestPendingManagerNextAttempt(projectId: string): number | null;
    updateManagerEventDelivery(eventId: string, patch: {
        deliveryState?: ManagerEventDelivery;
        attempts?: number;
        nextAttemptAt?: number | null;
        lastError?: string | null;
        receipt?: string | null;
        threadId?: string | null;
        acked?: boolean;
        ackedAt?: number | null;
    }): void;
    /** Acknowledge an event idempotently (no-op if already acked). */
    ackManagerEvent(eventId: string, at: number): void;
    /** Count undelivered (pending, unacked) events, optionally per project. */
    countPendingManagerEvents(projectId?: string): number;
    /** Count retries-exhausted (parked) events, optionally per project. */
    countParkedManagerEvents(projectId?: string): number;
    private assertOpen;
}
/** Terminal/active states for a durable process receipt. */
export type ProcessReceiptState = "started" | "stopped" | "in_doubt";
/** A durable record of a supervised command's process group. */
export interface ProcessReceipt {
    readonly receiptId: string;
    readonly assignmentId: string;
    readonly bootId: string;
    readonly pid: number | null;
    readonly pgid: number | null;
    /** Redacted command text — never the raw model-supplied command. */
    readonly commandRedacted: string;
    readonly state: ProcessReceiptState;
    readonly createdAt: number;
    readonly updatedAt: number;
}
/** A service boot record; `clean` is true only after a fully drained stop. */
export interface ServiceRunRecord {
    readonly bootId: string;
    readonly pid: number;
    readonly clean: boolean;
    readonly startedAt: number;
    readonly stoppedAt: number | null;
}
/**
 * Explicit project -> manager (Codex GUI) thread binding. One row per project;
 * binding takes effect from NOW, so no historical assignment is replayed.
 */
export interface ManagerBindingRecord {
    readonly projectId: string;
    /** The existing Codex GUI session/thread UUID the manager is woken on. */
    readonly threadId: string;
    readonly requestId: string;
    /**
     * Watermark (ms) from which this binding is effective. Events created before
     * `boundAt` are NOT delivered to this thread (bind-from-NOW): a rebind
     * supersedes earlier unbound/pending events so a new thread never receives a
     * historical replay. A late-bound or re-bound project therefore only wakes on
     * transitions that occur after the binding took effect. Optional on input;
     * the store defaults a missing value to `createdAt` (or 0 when also absent).
     */
    readonly boundAt?: number;
    readonly createdAt: number;
    readonly updatedAt: number;
}
/**
 * Delivery lifecycle of one manager wake event in the durable outbox.
 * `superseded` marks an event that will never be delivered to the CURRENT
 * binding (it predates a bind/rebind) but whose history is preserved.
 */
export type ManagerEventDelivery = "pending" | "delivered" | "failed" | "parked" | "superseded";
/** One durable, deduplicated manager WAKE event. */
export interface ManagerEventRecord {
    readonly eventId: string;
    readonly projectId: string;
    readonly assignmentId: string;
    readonly conversationId: string | null;
    /** Transition that produced the wake (see ManagerEventKind). */
    readonly kind: string;
    readonly state: string;
    /** Stable dedup key; a second identical transition never yields a new event. */
    readonly dedupKey: string;
    readonly threadId: string | null;
    /** Bounded, redacted one-line summary (never a raw worker instruction). */
    readonly summary: string;
    /** JSON payload carrying the event id + bounded evidence, no transcript. */
    readonly payload: string;
    readonly deliveryState: ManagerEventDelivery;
    readonly attempts: number;
    readonly nextAttemptAt: number | null;
    readonly lastError: string | null;
    /** Trusted queue receipt (message id) on success, or null. */
    readonly receipt: string | null;
    readonly acked: boolean;
    readonly ackedAt: number | null;
    readonly createdAt: number;
    readonly updatedAt: number;
}
/**
 * Durable marker for a worker → manager PAUSE. Written the instant
 * `request_manager` is called (before any process cleanup) so the pause is
 * durable and survives a restart; the async finalizer later records the ONE
 * outbox event and marks this intent `completed` (or `failed` if cleanup could
 * not be confirmed, in which case the event carries a truthful cleanup warning).
 */
export interface ManagerPauseIntentRecord {
    /** Truthful intent id returned to the worker (never a fabricated event id). */
    readonly intentId: string;
    readonly projectId: string;
    readonly assignmentId: string;
    readonly conversationId: string | null;
    readonly taskId: string;
    readonly question: string;
    readonly context: string | null;
    readonly detail: string;
    /** 'pending' until the finalizer runs; then 'completed' or 'failed'. */
    readonly status: string;
    /** The ACTUAL persisted outbox event id, once finalized. */
    readonly eventId: string | null;
    readonly error: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
}
//# sourceMappingURL=store.d.ts.map