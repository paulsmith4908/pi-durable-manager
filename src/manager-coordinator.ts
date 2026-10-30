import { workflowEventScope } from './workflow.js';
/**
 * Coordinates durable manager WAKE events and their delivery.
 *
 * The engine calls {@link ManagerWakeCoordinator.recordTransition} whenever it
 * writes an assignment state change. That call (a) classifies the transition,
 * (b) writes ONE deduplicated event into the outbox in the same store, and
 * (c) schedules a code-only dispatch pass. Nothing here calls an LLM and no
 * polling happens when nothing changed: a pass is only scheduled by a real
 * transition, a startup drain, or a bounded backoff timer for pending events.
 *
 * Delivery is AT-LEAST-ONCE (see manager-dispatcher.ts): the durable event id +
 * the manager's ack make re-delivery harmless — there is no exactly-once claim.
 *
 * Retry scheduling is CORRECT across the running/pass boundary: the coordinator
 * always remembers the EARLIEST absolute deadline it owes and re-arms a timer
 * for exactly the remaining delay after any pass, so a retry can never be lost
 * by a pass that is already running.
 */

import { randomUUID } from "node:crypto";
import type { MetadataStore, ManagerEventRecord, ManagerBindingRecord } from "./store.js";
import {
  buildWakeSummary,
  buildWakePrompt,
  isWakeState,
  wakeDedupKey,
  PROMPT_BATCH_MAX,
  type ManagerWakeKind,
} from "./manager-events.js";
import { ManagerDispatcher, retryBackoffMs } from "./manager-dispatcher.js";
import type { KnownSecrets } from "./redact.js";

/** Per-project dispatch state held in memory (never the source of truth). */
interface ProjectDispatchState {
  /** Pending backoff timer for retries; null when idle. */
  timer: NodeJS.Timeout | null;
  /** Absolute time (ms) the pending timer is due; null when idle. */
  timerDueAt: number | null;
  /** True while a dispatch pass is running; prevents overlap per project. */
  running: boolean;
  /**
   * EARLIEST absolute deadline a pass must not schedule before. Set when a
   * transition/retry arrives while a pass is running, so the delay is not lost.
   */
  dirtyAt: number | null;
}

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

export class ManagerWakeCoordinator {
  private readonly metadata: MetadataStore;
  private readonly dispatcher: ManagerDispatcher | null;
  private readonly coalesceMs: number;
  private readonly maxAttempts: number;
  private readonly enabled: boolean;
  private readonly schedule: NonNullable<ManagerWakeCoordinatorOptions["schedule"]>;
  private readonly cancel: NonNullable<ManagerWakeCoordinatorOptions["cancel"]>;
  private readonly now: () => number;
  private readonly states = new Map<string, ProjectDispatchState>();
  private stopped = false;
  private cleanupTail:Promise<unknown>=Promise.resolve();
  private cleanupTimer:NodeJS.Timeout|null=null;

  /** Persist every receipt, including reminders, rather than losing old queue
   * IDs when the latest delivery receipt replaces an event's display field. */
  private rememberReceipt(receipt:string,threadId:string,eventIds:string[]):void {
    const key=`workflow-queue:${receipt}`;
    const old=this.metadata.getControl<{eventIds:string[]}>(key);
    this.metadata.setWorkflowControl(key,{receipt,threadId,eventIds:[...new Set([...(old?.eventIds??[]),...eventIds])],state:'queued',attempts:0});
    const index=this.metadata.getControl<string[]>('workflow-queue-index')??[];
    if(!index.includes(receipt))this.metadata.setWorkflowControl('workflow-queue-index',[...index,receipt]);
  }

  /** Remove ONLY Pi-owned receipts whose whole batch is now stale. Also used
   * after ack/unbind and on restart; no LLM polling or arbitrary queue purge. */
  reconcileQueued():Promise<void> {
    const op=this.cleanupTail.then(()=>this.cleanupQueued());
    this.cleanupTail=op.catch(()=>{});return op;
  }
  private async cleanupQueued():Promise<void> {
    if(this.stopped||!this.dispatcher?.retract)return;
    // Upgrade/restart recovery for receipts written by older service builds.
    const groups=new Map<string,{threadId:string,ids:string[]}>();
    for(const e of this.metadata.listManagerEvents(undefined,false))if(e.receipt&&e.threadId){
      const g=groups.get(e.receipt)??{threadId:e.threadId,ids:[]};g.ids.push(e.eventId);groups.set(e.receipt,g);
    }
    for(const [receipt,g] of groups)if(!this.metadata.getControl(`workflow-queue:${receipt}`))this.rememberReceipt(receipt,g.threadId,g.ids);
    let retryAt:number|null=null,removed=0,failed=0,pending=0;
    for(const receipt of this.metadata.getControl<string[]>('workflow-queue-index')??[]){
      const key=`workflow-queue:${receipt}`;
      const row=this.metadata.getControl<{receipt:string,threadId:string,eventIds:string[],state:string,attempts:number,nextAt?:number}>(key);
      if(!row||row.state==='removed'||row.state==='absent')continue;
      const stale=row.eventIds.length>0&&row.eventIds.every(id=>{
        const e=this.metadata.getManagerEvent(id);if(!e)return false;
        const binding=this.metadata.getManagerBinding(e.projectId);
        return e.acked||!workflowEventScope(this.metadata,e).actionable||!binding||binding.threadId!==row.threadId;
      });
      if(!stale)continue;
      if(row.attempts>=this.maxAttempts){failed++;continue;}
      if(row.nextAt&&row.nextAt>this.now()){pending++;retryAt=Math.min(retryAt??Infinity,row.nextAt);continue;}
      const result=await this.dispatcher.retract(row.threadId,receipt);
      if(this.stopped)return;
      const attempts=row.attempts+1;
      const nextAt=result.ok||attempts>=this.maxAttempts?null:this.now()+retryBackoffMs(attempts);
      this.metadata.setWorkflowControl(key,{...row,state:result.ok?(result.deleted?'removed':'absent'):'error',attempts,nextAt,error:result.error,checkedAt:this.now()});
      const first=this.metadata.getManagerEvent(row.eventIds[0]!);
      this.metadata.appendActivity({kind:'wake.queue_cleanup',projectId:first?.projectId??null,assignmentId:first?.assignmentId??null,requestId:null,dedupKey:`queue-cleanup:${receipt}:${attempts}`,data:{receipt,eventIds:row.eventIds,deleted:result.deleted,ok:result.ok,error:result.error}});
      if(result.ok){if(result.deleted)removed++;}else{failed++;if(nextAt!==null){pending++;retryAt=Math.min(retryAt??Infinity,nextAt);}}
    }
    this.metadata.setControl('manager-queue-cleanup',{checkedAt:this.now(),removedThisPass:removed,failed,pending,nextAt:retryAt});
    if(this.cleanupTimer!==null)this.cancel(this.cleanupTimer);
    this.cleanupTimer=retryAt===null?null:this.schedule(()=>{this.cleanupTimer=null;void this.reconcileQueued();},Math.max(0,retryAt-this.now()));
  }

  constructor(options: ManagerWakeCoordinatorOptions) {
    this.metadata = options.metadata;
    this.dispatcher = options.dispatcher;
    this.coalesceMs = options.coalesceMs ?? 250;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.enabled = options.enabled !== false;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Record a state transition. Writes a durable, deduplicated event ONLY for a
   * meaningful wake transition; routine/unchanged/operator-cancel transitions
   * write nothing and schedule nothing. Returns the event id when written.
   */
  recordTransition(input: WakeTransition): string | null {
    if (this.stopped) return null;
    const kind = input.kind ?? (isWakeState(input.state, input.prevState) ? (input.state as ManagerWakeKind) : null);
    if (kind === null) return null;
    // The engine already opened a transaction around (state-change + this call);
    // wrapping here nests onto it, so the event insert and the assignment update
    // commit (or roll back) together.
    const eventId = this.metadata.withTransaction(() => this.recordInTransaction(input, kind));
    // Schedule ONLY after the transaction committed: a rolled-back event must
    // never reach the dispatcher. `eventId` is null for a dedup no-op; skip it.
    if (eventId !== null && this.enabled && this.dispatcher !== null) {
      this.scheduleProject(input.projectId, 0);
    }
    return eventId;
  }

  private recordInTransaction(input: WakeTransition, kind: ManagerWakeKind): string | null {
    const scope = workflowEventScope(this.metadata, input);
    if (!scope.actionable) return null;
    const binding = this.metadata.getManagerBinding(input.projectId);
    const threadId = input.threadId ?? binding?.threadId ?? null;
    const project = this.metadata.getProject(input.projectId);
    const summary = buildWakeSummary({
      kind,
      assignmentId: input.assignmentId,
      projectName: project?.name ?? input.projectId,
      state: input.state,
      detail: input.detail ?? null,
    });
    const dedupKey = input.dedupKey ?? wakeDedupKey({
      projectId: input.projectId,
      assignmentId: input.assignmentId,
      kind,
      state: input.state,
    });
    const existing = this.metadata.getManagerEventByDedup(dedupKey);
    if (existing !== undefined) return existing.eventId; // idempotent; no re-schedule
    const now = this.now();
    const eventId = `mw-${randomUUID()}`;
    const payload = JSON.stringify({
      eventId,
      workflowId: scope.workflowId,
      projectId: input.projectId,
      assignmentId: input.assignmentId,
      conversationId: input.conversationId,
      kind,
      state: input.state,
      detail: input.detail ?? null,
      evidence: input.payload ?? null,
      at: now,
    });
    const { inserted } = this.metadata.insertManagerEvent({
      eventId,
      projectId: input.projectId,
      assignmentId: input.assignmentId,
      conversationId: input.conversationId,
      kind,
      state: input.state,
      dedupKey,
      threadId,
      summary,
      payload,
      deliveryState: "pending",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      receipt: null,
      acked: false,
      ackedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    if (!inserted) return null;
    return eventId;
  }

  /** Drain pending events from a previous run. Call once at startup. */
  drain(): void {
    if (this.stopped || !this.enabled || this.dispatcher === null) return;
    void this.reconcileQueued();
    const projects = this.metadata.listProjectsWithDueManagerEvents(this.now());
    for (const projectId of projects) this.scheduleProject(projectId, 0);
  }

  /**
   * Stop scheduling, cancel timers, and ABORT + JOIN any in-flight CLI child so
   * the caller can safely close the store afterwards. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if(this.cleanupTimer!==null)this.cancel(this.cleanupTimer);
    for (const state of this.states.values()) {
      if (state.timer !== null) this.cancel(state.timer);
      state.timer = null;
      state.timerDueAt = null;
    }
    if (this.dispatcher !== null) await this.dispatcher.stop();
    await this.cleanupTail;
  }

  /**
   * Ensure a pass for `projectId` is scheduled no later than `delay` from now.
   * If a pass is RUNNING, record the deadline on `dirtyAt` (do not lose it); the
   * running pass re-arms after it finishes. If a timer already exists, keep the
   * EARLIER of the two deadlines and re-arm only when the new one is sooner.
   */
  private scheduleProject(projectId: string, delay: number): void {
    if (this.stopped) return;
    // Unbound project: PARK with no idle query timer at all. A pending event is
    // preserved for a future bind; nothing is scheduled and no LM call is made.
    if (this.metadata.getManagerBinding(projectId) === undefined) {
      this.park(projectId);
      return;
    }
    const dueAt = this.now() + Math.max(0, delay);
    const state = this.stateFor(projectId);
    if (state.running) {
      state.dirtyAt = state.dirtyAt === null ? dueAt : Math.min(state.dirtyAt, dueAt);
      return;
    }
    const effective = Math.max(dueAt, this.now() + this.coalesceMs);
    if (state.timer !== null && state.timerDueAt !== null && state.timerDueAt <= effective) return;
    if (state.timer !== null) this.cancel(state.timer);
    state.timerDueAt = effective;
    state.timer = this.schedule(() => {
      state.timer = null;
      state.timerDueAt = null;
      void this.runPass(projectId);
    }, Math.max(0, effective - this.now()));
  }

  /** Dispatch every due event for one project in a single coalesced wake. */
  private async runPass(projectId: string): Promise<void> {
    const state = this.stateFor(projectId);
    if (state.running || this.stopped) return;
    // Resolve the binding BEFORE entering the pass. When the project has NO
    // manager binding there is nothing to deliver to: the pass must PARK, not
    // re-arm. A stale `next_attempt_at` on a pending event (e.g. a failed
    // attempt recorded before the binding was lost) must NEVER be turned into a
    // recurring idle timer — that was an unbounded hot loop that re-ran forever
    // without any LM call. We drop the dirty deadline and clear any timer so no
    // further pass is scheduled; the pending event is preserved and a future
    // bind supersedes old history (see service `bind`).
    const binding = this.metadata.getManagerBinding(projectId);
    if (binding === undefined) {
      this.park(projectId);
      return;
    }
    state.running = true;
    try {
      // BOUND the batch so every id + the essential instructions always fit in
      // one wake prompt (never truncated). Any remaining due events stay
      // pending (due now) and are handed over in a subsequent pass; each pass
      // re-arms because those events are still due.
      const candidates = this.metadata.listDueManagerEvents(projectId, this.now(), PROMPT_BATCH_MAX);
      const due = candidates.filter(e => workflowEventScope(this.metadata,e).actionable);
      for (const e of candidates.filter(e => !workflowEventScope(this.metadata,e).actionable)) this.metadata.updateManagerEventDelivery(e.eventId, { deliveryState: "parked", nextAttemptAt: null, lastError: "Retired task generation; inspect workflow.event." });
      if (due.length > 0) {
        await this.deliver(projectId, binding, due);
      }
      // No due events: nothing to do; the finally re-arm below is a no-op.
    } finally {
      state.running = false;
      // Re-arm for the EARLIEST deadline we still owe (a dirtied transition
      // during the pass, or the next pending retry's next_attempt_at).
      this.rearm(projectId, binding);
    }
  }

  /**
   * PARK a project that has no manager binding: drop any pending dirty deadline
   * and CANCEL the idle query timer. No LM call is ever made here, and no new
   * timer is scheduled, so an unbound project with stale pending events cannot
   * spin. Events stay pending in the outbox until a future bind delivers them.
   */
  private park(projectId: string): void {
    const state = this.stateFor(projectId);
    state.dirtyAt = null;
    if (state.timer !== null) {
      this.cancel(state.timer);
      state.timer = null;
      state.timerDueAt = null;
    }
  }

  /** Schedule the soonest pending deadline for `projectId`, if any. */
  private rearm(projectId: string, binding: ManagerBindingRecord): void {
    if (this.stopped) return;
    // Defensive: the binding could have been removed while the pass was running.
    // Re-check so a deleted binding can never resurrect the idle timer.
    if (this.metadata.getManagerBinding(projectId) === undefined) {
      this.park(projectId);
      return;
    }
    const state = this.stateFor(projectId);
    const dirtyAt = state.dirtyAt;
    state.dirtyAt = null;
    // Batch overflow: if MORE events are still due (a batch larger than one
    // prompt), schedule an IMMEDIATE follow-up pass. This is bounded: each pass
    // delivers up to the batch size, so the pending set strictly shrinks.
    if (this.metadata.hasDueManagerEvents(projectId, this.now())) {
      this.scheduleProject(projectId, 0);
      return;
    }
    const nextAttempt = this.metadata.earliestPendingManagerNextAttempt(projectId);
    let dueAt: number | null = dirtyAt;
    if (nextAttempt !== null) dueAt = dueAt === null ? nextAttempt : Math.min(dueAt, nextAttempt);
    if (dueAt === null) return;
    void binding; // binding is resolved above; kept for call-site symmetry
    this.scheduleProject(projectId, Math.max(0, dueAt - this.now()));
  }

  private async deliver(
    projectId: string,
    binding: ManagerBindingRecord,
    events: readonly ManagerEventRecord[],
  ): Promise<void> {
    const dispatcher = this.dispatcher;
    if (dispatcher === null) return;
    const project = this.metadata.getProject(projectId);
    const prompt = buildWakePrompt({
      eventIds: events.map((e) => e.eventId),
      projectId,
      projectName: project?.name ?? projectId,
      threadId: binding.threadId,
      events: events.map((e) => ({ kind: e.kind, assignmentId: e.assignmentId, state: e.state, summary: e.summary })),
    });
    const result = await dispatcher.dispatch(binding.threadId, prompt);
    if (this.stopped) return; // do not touch the store after stop()
    const now = this.now();
    if (result.ok) {
      if(result.receipt)this.rememberReceipt(result.receipt,binding.threadId,events.map(e=>e.eventId));
      for (const event of events) {
        this.metadata.updateManagerEventDelivery(event.eventId, {
          deliveryState: "delivered",
          attempts: event.attempts + 1,
          nextAttemptAt: null,
          lastError: null,
          receipt: result.receipt,
          threadId: binding.threadId,
        });
      }
      // Ack/stop can race the external CLI. Re-read the durable state after
      // delivery and retract the newly arrived receipt if it is already stale.
      await this.reconcileQueued();
      return;
    }
    // Failure: record the diagnostic, schedule a bounded backoff retry, and PARK
    // the event once attempts are exhausted (or the failure is permanent). A
    // parked event is never due again, so a restart cannot redeliver it forever.
    for (const event of events) {
      const attempts = event.attempts + 1;
      const park = attempts >= this.maxAttempts || result.permanent;
      this.metadata.updateManagerEventDelivery(event.eventId, {
        deliveryState: park ? "parked" : "pending",
        attempts,
        nextAttemptAt: park ? null : now + retryBackoffMs(attempts),
        lastError: result.error,
        threadId: binding.threadId,
      });
    }
  }

  private stateFor(projectId: string): ProjectDispatchState {
    let state = this.states.get(projectId);
    if (state === undefined) {
      state = { timer: null, timerDueAt: null, running: false, dirtyAt: null };
      this.states.set(projectId, state);
    }
    return state;
  }
}
