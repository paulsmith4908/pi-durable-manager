import type { MetadataStore, ProcessReceipt } from "./store.js";
export interface QuarantineDecision {
    readonly assignmentId: string;
    /** Receipts from the dirty boot that triggered the quarantine. */
    readonly receipts: readonly ProcessReceipt[];
    /** Recorded pgids still observed alive at inspection time (never signalled). */
    readonly livePgids: readonly number[];
}
/** True when single process `pid` exists (signal 0 probe). Never fatal. */
export declare function isAlive(pid: number): boolean;
/**
 * True when ANY process in process GROUP `pgid` is still alive.
 *
 * Probes the whole group via `kill(-pgid, 0)`: a DEAD group leader can leave
 * same-PGID children running, so a leader-only probe would wrongly report the
 * group as gone and let us free a lease behind a live external command. EPERM
 * means the group exists but is not ours to signal — still alive.
 *
 * NOTE: this is a GROUP-ownership probe. For a single-process liveness check
 * (e.g. "is this exact pid still present") use {@link isAlive} instead.
 */
export declare function isGroupAlive(pgid: number): boolean;
/**
 * Compute which assignments must be quarantined because they have a receipt
 * recorded by a prior boot that did not shut down cleanly.
 *
 * `currentBootId` is excluded (its own receipts are this boot's business).
 */
export declare function planQuarantine(store: MetadataStore, currentBootId: string): QuarantineDecision[];
/**
 * Wait, bounded, for every recorded pgid in `decisions` to disappear. The
 * previous boot's death should have SIGKILLed its watcher group quickly; if a
 * pgid is still alive after the window we DO NOT signal it (it may have been
 * reused) and report it as unresolved so the caller keeps the row quarantined.
 */
export declare function waitForGroupsGone(decisions: readonly QuarantineDecision[], timeoutMs?: number, intervalMs?: number): Promise<{
    resolved: boolean;
    remaining: number[];
}>;
/**
 * Guard: may an operator abort a quarantined row right now? Refuse while ANY
 * recorded group from the quarantine is still alive and unverified, so we never
 * free the lease behind a live external command.
 */
export declare function canReleaseQuarantine(decisions: readonly QuarantineDecision[]): {
    ok: boolean;
    alive: number[];
};
//# sourceMappingURL=process-quarantine.d.ts.map