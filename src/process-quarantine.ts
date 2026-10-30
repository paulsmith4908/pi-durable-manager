// Startup inspection for durable process receipts + unclean-command quarantine.
//
// On engine start we MUST assume the previous boot crashed mid-command unless
// it recorded a fully drained shutdown. Any assignment that has a process
// receipt from a DIRTY boot (even one whose command already "ended") may have
// executed an external command before its Pi result was committed, so it is
// untrustworthy to auto-rerun. We:
//
//   * never signal a possibly-reused OLD pgid ourselves — we only OBSERVE
//     whether it is still alive and wait, bounded, for it to go away;
//   * mark such assignments blocked/in_doubt_command and RETAIN their lease;
//   * keep them quarantined until an explicit CTO review aborts/re-recovers.
//
// This module is pure observation + classification. It performs no kill and
// writes nothing; the caller owns the durable transitions.

import type { MetadataStore, ProcessReceipt } from "./store.js";

export interface QuarantineDecision {
  readonly assignmentId: string;
  /** Receipts from the dirty boot that triggered the quarantine. */
  readonly receipts: readonly ProcessReceipt[];
  /** Recorded pgids still observed alive at inspection time (never signalled). */
  readonly livePgids: readonly number[];
}

/** True when single process `pid` exists (signal 0 probe). Never fatal. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we cannot signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
export function isGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such group. EPERM: group exists, not signalable — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Compute which assignments must be quarantined because they have a receipt
 * recorded by a prior boot that did not shut down cleanly.
 *
 * `currentBootId` is excluded (its own receipts are this boot's business).
 */
export function planQuarantine(
  store: MetadataStore,
  currentBootId: string,
): QuarantineDecision[] {
  const dirtyBoots = store
    .listUncleanServiceRuns()
    .map((r) => r.bootId)
    .filter((id) => id !== currentBootId);
  if (dirtyBoots.length === 0) return [];

  const receipts = store.listReceiptsForBoots(dirtyBoots);
  const byAssignment = new Map<string, ProcessReceipt[]>();
  for (const r of receipts) {
    const list = byAssignment.get(r.assignmentId) ?? [];
    list.push(r);
    byAssignment.set(r.assignmentId, list);
  }

  const decisions: QuarantineDecision[] = [];
  for (const [assignmentId, list] of byAssignment) {
    const livePgids = list
      .map((r) => r.pgid)
      .filter((pgid): pgid is number => pgid !== null)
      .filter((pgid) => isGroupAlive(pgid));
    decisions.push({ assignmentId, receipts: list, livePgids });
  }
  return decisions;
}

/**
 * Wait, bounded, for every recorded pgid in `decisions` to disappear. The
 * previous boot's death should have SIGKILLed its watcher group quickly; if a
 * pgid is still alive after the window we DO NOT signal it (it may have been
 * reused) and report it as unresolved so the caller keeps the row quarantined.
 */
export async function waitForGroupsGone(
  decisions: readonly QuarantineDecision[],
  timeoutMs = 3000,
  intervalMs = 100,
): Promise<{ resolved: boolean; remaining: number[] }> {
  const pgids = new Set<number>();
  for (const d of decisions) for (const pgid of d.livePgids) pgids.add(pgid);
  if (pgids.size === 0) return { resolved: true, remaining: [] };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = [...pgids].filter((pgid) => isGroupAlive(pgid));
    if (remaining.length === 0) return { resolved: true, remaining: [] };
    if (Date.now() >= deadline) return { resolved: false, remaining };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Guard: may an operator abort a quarantined row right now? Refuse while ANY
 * recorded group from the quarantine is still alive and unverified, so we never
 * free the lease behind a live external command.
 */
export function canReleaseQuarantine(
  decisions: readonly QuarantineDecision[],
): { ok: boolean; alive: number[] } {
  const alive: number[] = [];
  for (const d of decisions) for (const pgid of d.livePgids) if (isGroupAlive(pgid)) alive.push(pgid);
  return { ok: alive.length === 0, alive };
}
