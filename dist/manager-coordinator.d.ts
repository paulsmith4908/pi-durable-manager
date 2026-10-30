import type { MetadataStore } from "./store.js";
import { type ManagerWakeKind } from "./manager-events.js";
import { ManagerDispatcher } from "./manager-dispatcher.js";
import type { KnownSecrets } from "./redact.js";
export interface ManagerWakeCoordinatorOptions {
    readonly metadata: MetadataStore;
    readonly dispatcher: ManagerDispatcher | null;
    /** Coalescing window (ms): multiple events collapse into one wake. */
    readonly coalesceMs?: number;
    readonly maxAttempts?: number;
    readonly enabled?: boolean;
    readonly knownSecrets?: KnownSecrets;
    /** Test seam: schedule timers (defaults to setTimeout). */
    readonly schedule?: (fn: () => void, ms: number) => NodeJS.Timeout;
    /** Test seam: cancel a scheduled timer (defaults to clearTimeout). */
    readonly cancel?: (timer: NodeJS.Timeout) => void;
    /** Test seam: current time. */
    readonly now?: () => number;
}
/** Inputs to {@link ManagerWakeCoordinator.recordTransition}. */
export interface WakeTransition {
    /** Attention incidents use activity/review-specific keys, without changing worker state. */
    readonly dedupKey?: string;
    readonly assignmentId: string;
    readonly projectId: string;
    readonly conversationId: string | null;
    readonly state: string;
    readonly prevState: string | null;
    readonly detail?: string | null;
    /** Override the kind (e.g. `manager_request`); else derived from state. */
    readonly kind?: ManagerWakeKind;
    /** Bounded JSON payload (evidence refs); never a raw transcript. */
    readonly payload?: unknown;
    /** Current manager thread for the project, if bound; else looked up. */
    readonly threadId?: string | null;
}
export declare class ManagerWakeCoordinator {
    private readonly metadata;
    private readonly dispatcher;
    private readonly coalesceMs;
    private readonly maxAttempts;
    private readonly enabled;
    private readonly schedule;
    private readonly cancel;
    private readonly now;
    private readonly states;
    private stopped;
    private cleanupTail;
    private cleanupTimer;
    /** Persist every receipt, including reminders, rather than losing old queue
     * IDs when the latest delivery receipt replaces an event's display field. */
    private rememberReceipt;
    /** Remove ONLY Pi-owned receipts whose whole batch is now stale. Also used
     * after ack/unbind and on restart; no LLM polling or arbitrary queue purge. */
    reconcileQueued(): Promise<void>;
    private cleanupQueued;
    constructor(options: ManagerWakeCoordinatorOptions);
    /**
     * Record a state transition. Writes a durable, deduplicated event ONLY for a
     * meaningful wake transition; routine/unchanged/operator-cancel transitions
     * write nothing and schedule nothing. Returns the event id when written.
     */
    recordTransition(input: WakeTransition): string | null;
    private recordInTransaction;
    /** Drain pending events from a previous run. Call once at startup. */
    drain(): void;
    /**
     * Stop scheduling, cancel timers, and ABORT + JOIN any in-flight CLI child so
     * the caller can safely close the store afterwards. Idempotent.
     */
    stop(): Promise<void>;
    /**
     * Ensure a pass for `projectId` is scheduled no later than `delay` from now.
     * If a pass is RUNNING, record the deadline on `dirtyAt` (do not lose it); the
     * running pass re-arms after it finishes. If a timer already exists, keep the
     * EARLIER of the two deadlines and re-arm only when the new one is sooner.
     */
    private scheduleProject;
    /** Dispatch every due event for one project in a single coalesced wake. */
    private runPass;
    /**
     * PARK a project that has no manager binding: drop any pending dirty deadline
     * and CANCEL the idle query timer. No LM call is ever made here, and no new
     * timer is scheduled, so an unbound project with stale pending events cannot
     * spin. Events stay pending in the outbox until a future bind delivers them.
     */
    private park;
    /** Schedule the soonest pending deadline for `projectId`, if any. */
    private rearm;
    private deliver;
    private stateFor;
}
//# sourceMappingURL=manager-coordinator.d.ts.map