import type { MetadataStore } from "./store.js";
import type { ManagerWakeCoordinator } from "./manager-coordinator.js";
export interface SupervisionPolicy {
    enabled: boolean;
    startIntervalMs: number;
    activeIntervalMs: number;
    commandIntervalMs: number;
    idleWarningMs: number;
    ackReminderMs: number;
    maxAckReminders: number;
    expectedQuietUntil: number | null;
    nextReviewAt: number | null;
    reason: string;
}
export declare const DEFAULT_SUPERVISION: SupervisionPolicy;
export interface SupervisionSnapshot {
    assignmentId: string;
    projectId: string;
    state: string;
    phase: string;
    lastProgressAt: number;
    activitySeq: number | null;
    commandCount: number;
    lastCheckAt: number;
    nextCheckAt: number | null;
    intervalMs: number | null;
    reason: string;
    readsSinceEdit?: number;
    lastEditAt?: number | null;
    readLoop?: boolean;
}
export declare function supervisionPolicy(input: Record<string, unknown>, previous?: SupervisionPolicy): SupervisionPolicy;
/** The daemon owns this scheduler. It never invokes a model, edits code, or stops an assignment. */
export declare class AdaptiveSupervisor {
    private readonly store;
    private readonly manager;
    private readonly now;
    private timer;
    private stopped;
    constructor(store: MetadataStore, manager: ManagerWakeCoordinator, now?: () => number);
    configure(id: string, patch: Record<string, unknown>): SupervisionPolicy;
    policy(id: string): SupervisionPolicy;
    snapshot(id: string): SupervisionSnapshot | null;
    snapshots(projectId?: string): SupervisionSnapshot[];
    start(): void;
    stop(): void;
    refresh(): void;
    private nextAt;
    private nextDelay;
    /** Public for deterministic clock-driven recovery tests; production calls it through refresh. */
    tick(): void;
    private attention;
    private log;
}
//# sourceMappingURL=supervision.d.ts.map