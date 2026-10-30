import type { MetadataStore, AssignmentRecord } from "./store.js";
import type { ManagerWakeCoordinator } from "./manager-coordinator.js";
import type { WorkMemory } from "./work-memory.js";

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
export const DEFAULT_SUPERVISION: SupervisionPolicy = {
  enabled: true, startIntervalMs: 10000, activeIntervalMs: 60000,
  commandIntervalMs: 120000, idleWarningMs: 900000,
  ackReminderMs: 300000, maxAckReminders: 3,
  expectedQuietUntil: null, nextReviewAt: null, reason: "Adaptive checks; inactivity is an alert, never an execution deadline.",
};
export interface SupervisionSnapshot {
  assignmentId: string; projectId: string; state: string; phase: string;
  lastProgressAt: number; activitySeq: number | null; commandCount: number;
  lastCheckAt: number; nextCheckAt: number | null; intervalMs: number | null; reason: string;
  readsSinceEdit?: number; lastEditAt?: number | null; readLoop?: boolean;
}

export function supervisionPolicy(input: Record<string, unknown>, previous = DEFAULT_SUPERVISION): SupervisionPolicy {
  for (const key of Object.keys(input)) if (!(key in DEFAULT_SUPERVISION)) throw new Error(`Unknown supervision field: ${key}`);
  const result = { ...previous, ...input } as SupervisionPolicy;
  if (typeof result.enabled !== "boolean" || typeof result.reason !== "string" || result.reason.length > 2000) throw new Error("Invalid supervision policy.");
  for (const name of ["startIntervalMs", "activeIntervalMs", "commandIntervalMs", "idleWarningMs", "ackReminderMs"] as const) {
    if (!Number.isSafeInteger(result[name]) || result[name] < 1000 || result[name] > 86400000) throw new Error(`${name} must be between 1000 and 86400000 ms.`);
  }
  if (!Number.isSafeInteger(result.maxAckReminders) || result.maxAckReminders < 0 || result.maxAckReminders > 8) throw new Error("Invalid reminder bound.");
  for (const name of ["expectedQuietUntil", "nextReviewAt"] as const) {
    if (result[name] !== null && (!Number.isSafeInteger(result[name]) || result[name]! < 0)) throw new Error(`Invalid ${name}.`);
  }
  return result;
}

/** The daemon owns this scheduler. It never invokes a model, edits code, or stops an assignment. */
export class AdaptiveSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  constructor(private readonly store: MetadataStore, private readonly manager: ManagerWakeCoordinator,
    private readonly now: () => number = Date.now) {}

  configure(id: string, patch: Record<string, unknown>): SupervisionPolicy {
    const row = this.store.getAssignment(id); if (!row) throw new Error("Unknown assignment.");
    const policy = supervisionPolicy(patch, this.policy(id));
    this.store.setControl(`supervision-policy:${id}`, policy);
    this.store.setControl(`supervision-snapshot:${id}`, null);
    this.log(row, "supervision.policy", policy);
    this.refresh(); return policy;
  }
  policy(id: string): SupervisionPolicy { return this.store.getControl<SupervisionPolicy>(`supervision-policy:${id}`) ?? { ...DEFAULT_SUPERVISION }; }
  snapshot(id: string): SupervisionSnapshot | null { return this.store.getControl<SupervisionSnapshot>(`supervision-snapshot:${id}`); }
  snapshots(projectId?: string): SupervisionSnapshot[] {
    return this.store.listAssignments(projectId).map(row => this.snapshot(row.id)).filter((row): row is SupervisionSnapshot => row !== null);
  }
  start(): void { this.refresh(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  refresh(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    try { this.tick(); }
    catch (error) { this.store.appendActivity({ kind: "supervision.error", projectId: null, assignmentId: null, requestId: null, dedupKey: null, data: { message: error instanceof Error ? error.message : "Supervision failed" } }); }
    this.timer = setTimeout(() => this.refresh(), this.nextDelay()); this.timer.unref();
  }
  private nextAt: number | null = null;
  private nextDelay(): number { return Math.max(1000, Math.min(60000, (this.nextAt ?? (this.now() + 60000)) - this.now())); }

  /** Public for deterministic clock-driven recovery tests; production calls it through refresh. */
  tick(): void {
    const now = this.now(); this.nextAt = null;
    const due = (at: number): void => { this.nextAt = this.nextAt === null ? at : Math.min(at, this.nextAt); };
    for (const row of this.store.listAssignments()) {
      const policy = this.policy(row.id);
      const active = ["running", "queued", "cancelling"].includes(row.state);
      const previous = this.snapshot(row.id);
      if (!active || !policy.enabled) {
        const phase = active ? "disabled" : ["blocked", "needs_review", "unanswered", "failed"].includes(row.state) ? "awaiting_manager" : "settled";
        if (previous && (previous.nextCheckAt !== null || previous.state !== row.state || previous.phase !== phase)) {
          const activity = this.store.latestWorkActivity(row.id);
          const snapshot = { ...previous, state: row.state, phase, lastCheckAt: now, lastProgressAt: activity?.at ?? previous.lastProgressAt,
            activitySeq: activity?.seq ?? previous.activitySeq, nextCheckAt: null, intervalMs: null };
          this.store.setControl(`supervision-snapshot:${row.id}`, snapshot);
          this.log(row, "supervision.settled", snapshot);
        }
        continue;
      }
      if (previous?.nextCheckAt && previous.nextCheckAt > now) { due(previous.nextCheckAt); continue; }
      const activity = this.store.latestWorkActivity(row.id);
      const commands = this.store.listProcessReceipts(row.id).filter(receipt => receipt.state === "started");
      const age = now - (activity?.at ?? row.createdAt);
      const memory = this.store.getControl<WorkMemory>(`work-memory:${row.id}`);
      const phase = commands.length ? "command" : memory?.loop ? "read_loop" : activity?.kind === "worker.provider_request" ? "provider" : activity ? "working" : "unknown";
      const intervalMs = commands.length ? policy.commandIntervalMs : now - row.createdAt < 30000 ? policy.startIntervalMs
        : age >= policy.activeIntervalMs * 2 || policy.expectedQuietUntil !== null && now < policy.expectedQuietUntil
          ? Math.max(policy.activeIntervalMs, policy.commandIntervalMs) : policy.activeIntervalMs;
      let next = now + intervalMs;
      if (policy.nextReviewAt !== null && policy.nextReviewAt > now) next = Math.min(next, policy.nextReviewAt);
      const snapshot: SupervisionSnapshot = { assignmentId: row.id, projectId: row.projectId, state: row.state, phase,
        lastProgressAt: activity?.at ?? row.createdAt, activitySeq: activity?.seq ?? null, commandCount: commands.length,
        lastCheckAt: now, nextCheckAt: next, intervalMs, reason: `${policy.reason} Observed ${phase}; next code check in ${intervalMs} ms.`,
        ...(memory ? { readsSinceEdit: memory.readsSinceEdit, lastEditAt: memory.lastEditAt, readLoop: memory.loop } : {}) };
      this.store.setControl(`supervision-snapshot:${row.id}`, snapshot); this.log(row, "supervision.check", snapshot); due(next);
      if (!commands.length && memory?.loop && memory.readsSinceEdit >= 60) {
        this.attention(row, "stale_progress", `read-loop:${row.id}:${memory.lastEditAt ?? "initial"}`,
          "Repeated reads persist despite the automatic context checkpoint. Activity is not evidence of implementation progress; inspect before intervening. Work has not been stopped.", snapshot);
      }
      if (policy.nextReviewAt !== null && policy.nextReviewAt <= now) {
        this.attention(row, "review_due", `review:${row.id}:${policy.nextReviewAt}`, "The manager's requested review time arrived; work has not been stopped.", snapshot);
        this.store.setControl(`supervision-policy:${row.id}`, { ...policy, nextReviewAt: null });
      }
      if (age >= policy.idleWarningMs && (policy.expectedQuietUntil === null || now >= policy.expectedQuietUntil)) {
        this.attention(row, "stale_progress", `stale:${row.id}:${activity?.seq ?? "initial"}`, "No recent recorded work progress. Inspect the command/provider state; this is not proof of a hang and no process has been killed.", snapshot);
      }
    }
    // Delivery receipt and manager handling are separate. Re-send the SAME event ID
    // with bounded, durable reminder accounting; never create another worker.
    for (const binding of this.store.listManagerBindings()) {
      for (const event of this.store.listManagerEvents(binding.projectId, true)) {
        if (event.deliveryState !== "delivered") continue;
        const policy = this.policy(event.assignmentId);
        if (!policy.enabled || policy.maxAckReminders === 0) continue;
        const key = `wake-reminder:${event.eventId}`;
        const receipt = this.store.getControl<{ count: number; lastAt: number }>(key) ?? { count: 0, lastAt: event.updatedAt };
        if (receipt.count >= policy.maxAckReminders) continue;
        const at = Math.max(receipt.lastAt, event.updatedAt) + policy.ackReminderMs * Math.pow(2, receipt.count);
        if (at > now) { due(at); continue; }
        this.store.withTransaction(() => {
          this.store.setControl(key, { count: receipt.count + 1, lastAt: now });
          this.store.updateManagerEventDelivery(event.eventId, { deliveryState: "pending", nextAttemptAt: now });
          this.store.appendActivity({ kind: "wake.reminder", projectId: event.projectId, assignmentId: event.assignmentId,
            requestId: null, dedupKey: `${key}:${receipt.count + 1}`, data: { eventId: event.eventId, reminder: receipt.count + 1 } });
        });
        this.manager.drain();
      }
    }
  }
  private attention(row: AssignmentRecord, kind: "stale_progress" | "review_due", dedupKey: string, detail: string, evidence: unknown): void {
    this.manager.recordTransition({ assignmentId: row.id, projectId: row.projectId, conversationId: row.conversationId,
      prevState: row.state, state: row.state, kind, dedupKey, detail, payload: evidence });
  }
  private log(row: AssignmentRecord, kind: string, data: unknown): void {
    this.store.appendActivity({ kind, projectId: row.projectId, assignmentId: row.id, requestId: null, dedupKey: null, data });
  }
}
