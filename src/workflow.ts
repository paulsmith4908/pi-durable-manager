/** Durable operator workflows. The service is the only writer; RPCs remain available. */
import { checkMilestone, linkMilestone, recordWorkflowActivity, activityCategory } from './scorecard.js';
import { randomUUID } from 'node:crypto';
import { StoreError, type MetadataStore, type AssignmentRecord, type ManagerEventRecord } from './store.js';

type Params = Record<string, any>;
export interface WorkflowRecord {
  id: string; projectId: string; threadId: string; objective: string; roadmap: string;
  state: 'active' | 'stopping' | 'stopped' | 'complete';
  assignments: string[]; submissions: string[]; createdAt: number; updatedAt: number;
  pause?: {assignmentId:string|null,requestId:string,note:string};
}
export const WORKFLOW_OPERATIONS = {
  'workflow.open': { params: ['projectId','threadId','objective','roadmap','requestId'], requestId: 'requestId', summary: 'Opt into one durable project task; reconnect the same owner without duplicating workers.' },
  'workflow.list': { params: ['projectId','threadId'], summary: 'Compact recoverable task index, newest first.' },
  'workflow.assignments': { params: ['id','before','limit'], summary: 'Bounded assignment history, newest first, with stable exclusive submission-index cursor. Read-only.' },
  'workflow.status': { params: ['id'], summary: 'Task roadmap, owned assignments, real latest activity, and wake health.' },
  'workflow.update': { params: ['id','roadmap','requestId'], requestId: 'requestId', summary: 'Persist the manager roadmap and milestone acceptance criteria.' },
  'workflow.submit': { params: ['id','task','criteria','parentId','milestoneId','profileId','requestId'], requestId: 'requestId', summary: 'Submit one task-owned assignment with a fresh session and unlimited default execution budget.' },
  'workflow.answer': { params: ['id','eventId','answer','activityCategory','requestId'], requestId: 'requestId', summary: 'Persist decision, inspect checkpoint, safely release paused worker, submit fresh continuation, then acknowledge.' },
  'workflow.event': { params: ['eventId'], summary: 'Read current event eligibility, decision and task generation before acting on a GUI wake.' },
  'workflow.finish': { params: ['id','note','requestId'], requestId: 'requestId', summary: 'Finish an independently reviewed task and retire its wake binding and events.' },
  'workflow.stop': { params: ['id','note','requestId'], requestId: 'requestId', summary: 'Durably stop only this task, join its workers, retire notifications. Safe to retry after disconnect.' },
  'workflow.review': { params: ['id','eventId','decision','note','evidenceHash','requestId'], requestId: 'requestId', summary: 'Record an explicit review against inspected evidence, verify acceptance freshness, apply verdict, then acknowledge. Does not review on behalf of the caller.' },
  'workflow.handoff': { params: ['id','expectedThreadId','threadId','note','requestId'], requestId: 'requestId', summary: 'Transfer a safely paused or settled task to an explicitly selected existing chat; retire old wakes and reissue unresolved attention.' },
  'workflow.pause': { params: ['id','note','requestId'], requestId: 'requestId', summary: 'Fence new work immediately, let admitted tools finish, retain the lease and report safe pause asynchronously. No execution deadline.' },
  'workflow.resume': { params: ['id','summary','requestId'], requestId: 'requestId', summary: 'Verify a confirmed operator pause, preserve a continuation packet, join old work and admit one fresh session. Never replays quarantined commands.' },
} as const;
const key = (id: string) => `workflow:${id}`;
export function projectWorkflow(store: MetadataStore, projectId: string): WorkflowRecord | null {
  const id = store.getControl<string>(`workflow-project:${projectId}`);
  return id ? store.getControl<WorkflowRecord>(key(id)) : null;
}
export function workflowOwns(store: MetadataStore, task: WorkflowRecord, assignmentId: string): boolean {
  return task.assignments.includes(assignmentId) || task.submissions.includes(store.getAssignment(assignmentId)?.requestId ?? '');
}
/** A retired generation must not wake, even if old queue messages arrive later. */
export function workflowEventScope(store: MetadataStore, event: Pick<ManagerEventRecord,'projectId'|'assignmentId'> & {threadId?:string|null}) {
  const task = projectWorkflow(store, event.projectId);
  return { workflowId: task?.id ?? null, actionable: !task || task.state === 'active' && workflowOwns(store, task, event.assignmentId) && (!event.threadId || event.threadId===task.threadId) };
}
function str(p: Params, name: string, max = 12000): string {
  const value = p[name];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new StoreError('invalid_params', `Expected nonempty bounded ${name}.`);
  return value;
}
export class WorkflowService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private store: MetadataStore, private call: (method: string, params: Params) => Promise<any>, private changed: () => void = () => {}) {}
  // Serialise multi-step workflows. Underlying engine still enforces checkout leases.
  run(method: string, p: Params): Promise<any> {
    const read = ['workflow.list','workflow.status','workflow.event','workflow.assignments'].includes(method);
    if (read) return this.execute(method, p);
    const result = this.tail.then(() => this.execute(method, p));
    this.tail = result.catch(() => {}); return result;
  }
  private task(id: string): WorkflowRecord {
    const t = this.store.getControl<WorkflowRecord>(key(id));
    if (!t) throw new StoreError('not_found', 'Unknown workflow.'); return t;
  }
  private save(t: WorkflowRecord): void { t.updatedAt = Date.now(); this.store.setWorkflowControl(key(t.id), t); this.changed(); }
  private active(t: WorkflowRecord,allowPaused=false): void {
    if (t.state !== 'active' || projectWorkflow(this.store,t.projectId)?.id !== t.id) throw new StoreError('retired_workflow','This task is retired; do not restart it.');
    const binding = this.store.getManagerBinding(t.projectId);
    if (binding?.threadId !== t.threadId) throw new StoreError('binding_changed','Task binding was removed or changed; explicitly reconnect before proceeding.');
    if(t.pause&&!allowPaused)throw new StoreError('operator_paused','Task has an operator pause; explicitly resume before submitting or answering.');
  }
  private rows(t: WorkflowRecord): AssignmentRecord[] { return this.store.listAssignments(t.projectId).filter(a => workflowOwns(this.store,t,a.id)); }
  private async execute(method: string, p: Params): Promise<any> {
    if (method === 'workflow.list') {
      const ids = this.store.getControl<string[]>('workflow-index') ?? [];
      return { workflows: ids.map(id=>this.task(id)).filter(t=>(!p.projectId || t.projectId===p.projectId)&&(!p.threadId || t.threadId===p.threadId)).reverse().slice(0,100).map(t=>({id:t.id,projectId:t.projectId,threadId:t.threadId,state:t.state,objective:t.objective,updatedAt:t.updatedAt})) };
    }
    if (method === 'workflow.event') {
      const event = this.store.getManagerEvent(str(p,'eventId'));
      if (!event) throw new StoreError('not_found','Unknown event.');
      const scope = workflowEventScope(this.store,event);
      return { event, ...scope, actionable: scope.actionable && !event.acked,
        decision: this.store.getControl(`manager-decision:${event.eventId}`), assignment: this.store.getAssignment(event.assignmentId) };
    }
    if (method === 'workflow.open') return this.open(p);
    const t = this.task(str(p,'id'));
    if (method === 'workflow.assignments') {
      // Submission indices are immutable even as new work is appended. Resolve
      // only the requested page, never every historical evidence-bearing row.
      const requests=t.submissions.length>0, slots=requests?t.submissions:t.assignments;
      const before=p.before??slots.length,limit=p.limit??20;
      if(!Number.isSafeInteger(before)||before<0||before>slots.length||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new StoreError('invalid_params','Invalid assignment history cursor/limit.');
      const start=Math.max(0,before-limit);
      const resolve=(slot:string)=>requests?this.store.getAssignmentByRequest(slot):this.store.getAssignment(slot);
      const rows=slots.slice(start,before).map((slot,index)=>({row:resolve(slot),number:start+index+1})).filter(v=>v.row&&v.row.projectId===t.projectId);
      const latest=resolve(slots.at(-1)??'')??this.store.getAssignment(t.assignments.at(-1)??'');
      const lease=this.store.getActiveLease(this.store.getProject(t.projectId)!.path);
      const selected=lease&&workflowOwns(this.store,t,lease.id)?lease:latest;
      return {workflowId:t.id,roadmap:t.roadmap,total:slots.length,before,nextBefore:start||null,selected:selected?.id??null,
        assignments:rows.reverse().map(({row:a,number})=>({id:a!.id,number,sessionId:a!.sessionId,projectId:a!.projectId,state:a!.state,leaseHeld:!!a!.leasePath,createdAt:a!.createdAt}))};
    }
    if (method === 'workflow.status') {
      return { workflow:t, operatorPause:t.pause?(t.pause.assignmentId?this.store.getControl(`operator-pause:${t.pause.assignmentId}`)??{status:'settled',assignmentId:t.pause.assignmentId}:{status:'paused',assignmentId:null}):null, assignmentCount:this.rows(t).length, assignments:this.rows(t).slice(-20).map(a=>({id:a.id,sessionId:a.sessionId,state:a.state,parentId:a.parentId,leaseHeld:!!a.leasePath,updatedAt:a.updatedAt,latestActivity:(()=>{const e=this.store.latestWorkActivity(a.id);return e?{seq:e.seq,at:e.at,kind:e.kind}:null;})()})),
        binding:this.store.getManagerBinding(t.projectId)??null, manager:await this.call('manager.status',{projectId:t.projectId}),
        supervision:await this.call('supervision.status',{projectId:t.projectId}),
        events:this.store.listManagerEvents(t.projectId,true).filter(e=>workflowOwns(this.store,t,e.assignmentId)).map(e=>({eventId:e.eventId,kind:e.kind,assignmentId:e.assignmentId,summary:e.summary,deliveryState:e.deliveryState,actionable:workflowEventScope(this.store,e).actionable})) };
    }
    const requestId = str(p,'requestId',200);
    const exclusive=this.store.getControl<{method:string,requestId:string}>(`workflow-exclusive:${t.id}`);
    if(exclusive&&(exclusive.method!==method||exclusive.requestId!==requestId))throw new StoreError('operation_in_progress',`Retry ${exclusive.method} with requestId ${exclusive.requestId} before another mutation.`);
    // Durable operation identity is recorded before any side effect. A retry may
    // reconcile a partially applied action; changed payloads always conflict.
    const prior = this.store.beginJournal(method,requestId,p);
    if (prior.replayed && prior.record.status==='ready') return this.store.getControl(`workflow-result:${method}:${requestId}`);
    let result: any;
    if (method === 'workflow.stop' || method === 'workflow.finish') {
      const note = str(p,'note');
      if (t.state==='complete' || t.state==='stopped') result={workflow:t,replayed:true};
      else {
        const closing=this.store.getControl<{method:string,requestId:string}>(`workflow-closing:${t.id}`);
        if(t.state==='stopping' && (!closing || closing.method!==method || closing.requestId!==requestId)) throw new StoreError('operation_in_progress','Retry the recorded close operation with its original request ID.');
        if (method==='workflow.finish' && (this.rows(t).some(a=>a.leasePath || !['accepted','cancelled','revision_requested'].includes(a.state)))) throw new StoreError('review_required','Review all assignments and release writers before finishing.');
        // Retire before awaiting cancellation. A crash cannot re-enable wakes.
        this.store.setWorkflowControl(`workflow-closing:${t.id}`,{method,requestId,note});
        t.state='stopping'; this.save(t);
        if (this.store.getManagerBinding(t.projectId)?.threadId===t.threadId) await this.call('manager.unbind',{projectId:t.projectId});
        for (const a of this.rows(t)) {
          if (a.leasePath || ['running','queued','cancelling','blocked'].includes(a.state)) await this.call('assignments.cancel',{id:a.id});
          if (this.store.getAssignment(a.id)?.leasePath) throw new StoreError('writer_active','Prior writer has not released its lease. Retry after process review.');
        }
        for (const e of this.store.listManagerEvents(t.projectId,true).filter(e=>workflowOwns(this.store,t,e.assignmentId))) {
          if (!this.store.getControl(`manager-decision:${e.eventId}`)) await this.call('manager.decision',{eventId:e.eventId,action:method==='workflow.stop'?'abort':'observe',note,requestId:`${requestId}:${e.eventId}`});
          await this.call('manager.ack',{eventId:e.eventId,requestId:`${requestId}:ack:${e.eventId}`});
        }
        t.state=method==='workflow.stop'?'stopped':'complete'; this.save(t); result={workflow:t};
      }
    } else if(method==='workflow.handoff') result=await this.handoff(t,p,requestId);
    else {
      this.active(t,['workflow.review','workflow.pause','workflow.resume'].includes(method));
      if (method==='workflow.update') { t.roadmap=str(p,'roadmap',24000); this.save(t); result={workflow:t}; }
      else if (method==='workflow.submit') result=await this.submit(t,p,requestId);
      else if (method==='workflow.answer') result=await this.answer(t,p,requestId);
      else if (method==='workflow.review') result=await this.review(t,p,requestId);
      else if (method==='workflow.pause') result=await this.pause(t,p,requestId);
      else if (method==='workflow.resume') result=await this.resume(t,p,requestId);
      else throw new StoreError('method_not_found','Unknown workflow operation.');
    }
    this.store.withTransaction(()=>{this.store.setWorkflowControl(`workflow-result:${method}:${requestId}`,result);this.store.completeJournal(method,requestId,t.id);this.store.setWorkflowControl(`workflow-exclusive:${t.id}`,null);});
    return result;
  }
  private async pause(t:WorkflowRecord,p:Params,requestId:string):Promise<any>{
    const note=str(p,'note',4000);
    if(t.pause&&t.pause.requestId!==requestId)throw new StoreError('already_paused','Resume or retry the original pause request.');
    if(!t.pause){
      const running=this.rows(t).filter(a=>a.leasePath||['queued','running','cancelling'].includes(a.state));
      if(running.some(a=>!['queued','running'].includes(a.state)))throw new StoreError('review_required','Resolve the blocked/question/cancellation state before an operator pause.');
      t.pause={assignmentId:running[0]?.id??null,requestId,note};this.save(t);
    }
    const a=t.pause.assignmentId?this.store.getAssignment(t.pause.assignmentId):null;
    if(a&&['queued','running','blocked'].includes(a.state))await this.call('assignments.pause',{id:a.id,note,requestId:`${requestId}:pause`});
    return {workflow:t,pause:t.pause.assignmentId?this.store.getControl(`operator-pause:${t.pause.assignmentId}`)??{status:'settled'}:{status:'paused'},workerCreated:false};
  }
  private async resume(t:WorkflowRecord,p:Params,requestId:string):Promise<any>{
    const summary=str(p,'summary');
    const k=`workflow-resume:${t.id}:${requestId}`;
    let intent=this.store.getControl<any>(k);
    if(!intent){
      if(!t.pause)throw new StoreError('not_paused','Task has no operator pause.');
      const a=t.pause.assignmentId?this.store.getAssignment(t.pause.assignmentId):null;
      if(a?.leasePath&&!(a.state==='blocked'&&a.stopReason==='operator_pause'&&this.store.getControl<any>(`operator-pause:${a.id}`)?.status==='paused'))throw new StoreError('pause_pending','Wait for a confirmed safe pause or inspect quarantine; no command will be replayed.');
      if(!a||a.state!=='blocked'){
        if(a&&['queued','running','cancelling'].includes(a.state))throw new StoreError('pause_pending','Current tool has not paused yet.');
        delete t.pause;this.save(t);return {workflow:t,workerCreated:false,next:'Review settled work or submit the next scope.'};
      }
      if(a.stopReason!=='operator_pause')throw new StoreError('manual_review','Only a confirmed operator pause can be resumed through this operation.');
      const checkpoint=await this.call('assignments.checkpoint',{id:a.id});
      if(!checkpoint.verified||checkpoint.corrupt?.length)throw new StoreError('checkpoint_review','Checkpoint integrity failed.');
      const evidence=await this.call('assignments.evidence',{id:a.id,section:'summary'}),b=evidence.bundle;
      const packet={version:1,parentAssignmentId:a.id,objective:t.objective,roadmap:t.roadmap,managerSummary:summary,evidenceSummaryHash:evidence.sha256,afterManifest:b?.after?.manifest??null,recentCommands:(b?.commands??[]).slice(-10).map((x:any)=>({command:String(x.command).slice(0,400),exitCode:x.exitCode,durationMs:x.durationMs,ok:x.ok})),recentChanges:(b?.changes??[]).slice(-50),historyMayBeTruncated:(b?.commands?.length??0)>10||(b?.changes?.length??0)>50,checkpointVerified:true};
      const task=`Resume the existing work after an explicit operator pause. Inspect the checkout first. Completed commands are evidence, NOT instructions to run them again. Continue only remaining work.\n\nOriginal assignment:\n${a.task??''}\n\nDurable continuation packet:\n${JSON.stringify(packet)}`;
      if(task.length>96000)throw new StoreError('context_too_large','Continuation exceeds the bounded prompt; explicitly rescope remaining work instead.');
      intent={parentId:a.id,packet,task,criteria:a.acceptanceCriteria??'Complete the agreed acceptance criteria.',pauseRequestId:t.pause.requestId};
      this.store.setWorkflowControl(k,intent);
    }
    this.store.setWorkflowControl(`workflow-exclusive:${t.id}`,{method:'workflow.resume',requestId});
    for(const e of this.store.listManagerEvents(t.projectId,true).filter(e=>e.assignmentId===intent.parentId)){
      if(!this.store.getControl(`manager-decision:${e.eventId}`))await this.call('manager.decision',{eventId:e.eventId,action:'observe',note:summary,requestId:`${requestId}:decision:${e.eventId}`});
    }
    await this.call('assignments.cancel',{id:intent.parentId});
    if(this.store.getAssignment(intent.parentId)?.leasePath)throw new StoreError('writer_active','Paused writer has not released its lease.');
    const result=await this.submit(t,{task:intent.task,criteria:intent.criteria,parentId:intent.parentId},`${intent.pauseRequestId}:resume`);
    for(const e of this.store.listManagerEvents(t.projectId,true).filter(e=>e.assignmentId===intent.parentId))await this.call('manager.ack',{eventId:e.eventId,requestId:`${requestId}:ack:${e.eventId}`});
    delete t.pause;this.save(t);return {...result,continuationPacket:intent.packet,workerCreated:true};
  }
  private async review(t:WorkflowRecord,p:Params,requestId:string):Promise<any> {
    const eventId=str(p,'eventId'),note=str(p,'note',4000),hash=str(p,'evidenceHash',64),decision=str(p,'decision');
    if(!['accept','revise'].includes(decision)||!/^[a-f0-9]{64}$/.test(hash))throw new StoreError('invalid_params','Review requires accept/revise and the SHA-256 of the inspected evidence summary.');
    const e=this.store.getManagerEvent(eventId),a=e&&this.store.getAssignment(e.assignmentId);
    if(!e||e.kind!=='needs_review'||!a||!workflowOwns(this.store,t,a.id)||e.threadId!==t.threadId)throw new StoreError('wrong_review','Review event does not belong to the current task owner.');
    const state=decision==='accept'?'accepted':'revision_requested';
    if(this.store.getActiveLease(this.store.getProject(t.projectId)!.path))throw new StoreError('writer_active','Wait for the checkout writer to settle before review.');
    if(!['needs_review',state].includes(a.state))throw new StoreError('review_conflict','Assignment already has a different state or verdict.');
    const evidence=await this.call('assignments.evidence',{id:a.id,section:'summary'});
    if(evidence.sha256!==hash)throw new StoreError('evidence_stale','The evidence summary differs from what the manager inspected.');
    const recorded=this.store.getControl<{action:string,note:string}>(`manager-decision:${eventId}`);
    if(recorded&&(recorded.action!==decision||recorded.note!==note))throw new StoreError('review_conflict','A different decision was already recorded for this event.');
    // beginJournal above persists the requested verdict as intent. Only record
    // a final manager decision AFTER assignments.review validates the current
    // checkout and applies it. Failed acceptance must remain revisable.
    // A lost applied-review response is reconciled from durable assignment state
    // without reapplying acceptance or replacing its timestamp.
    if(a.state!==state)await this.call('assignments.review',{id:a.id,decision,note});
    else if(a.reviewNote!==note)throw new StoreError('review_conflict','Existing review note differs; inspect the prior verdict.');
    await this.call('manager.decision',{eventId,action:decision,note,requestId:`${requestId}:decision`});
    recordWorkflowActivity(this.store,t,eventId,decision==='accept'?'review':'revision_guidance',note,a.id);
    await this.call('manager.ack',{eventId,requestId:`${requestId}:ack`});
    return {workflowId:t.id,assignment:this.store.getAssignment(a.id),eventId,decision,evidenceHash:hash};
  }
  private async handoff(t:WorkflowRecord,p:Params,requestId:string):Promise<any> {
    const expected=str(p,'expectedThreadId'),threadId=str(p,'threadId'),note=str(p,'note',4000);
    if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)||threadId===expected)throw new StoreError('invalid_params','Select a different existing chat UUID.');
    if(t.state!=='active')throw new StoreError('retired_workflow','Only a current task can be transferred.');
    const k=`workflow-handoff:${t.id}:${requestId}`;
    let intent=this.store.getControl<{expected:string,threadId:string,eventIds:string[]}>(k);
    if(!intent){
      if(t.threadId!==expected)throw new StoreError('owner_changed','Expected manager no longer owns this task.');
      const rows=this.rows(t);
      if(rows.some(a=>['running','queued','cancelling'].includes(a.state)||a.state==='blocked'&&!['operator_pause','manager_request'].includes(a.stopReason??'')))throw new StoreError('pause_required','Pause work safely or resolve quarantine before transferring ownership.');
      for(const a of rows.filter(a=>!!a.leasePath)){
        if(a.stopReason==='operator_pause'&&this.store.getControl<any>(`operator-pause:${a.id}`)?.status!=='paused')throw new StoreError('pause_required','The operator pause has not drained yet.');
        const cp=await this.call('assignments.checkpoint',{id:a.id});
        if(!cp.verified||cp.corrupt?.length)throw new StoreError('checkpoint_review','Inspect checkpoint integrity before handoff.');
      }
      const events=this.store.listManagerEvents(t.projectId,true).filter(e=>workflowOwns(this.store,t,e.assignmentId));
      if(events.some(e=>this.store.getControl(`manager-decision:${e.eventId}`)))throw new StoreError('operation_in_progress','Finish the recorded decision/ack before handoff.');
      intent={expected,threadId,eventIds:events.map(e=>e.eventId)};this.store.setWorkflowControl(k,intent);
    }
    this.store.setWorkflowControl(`workflow-exclusive:${t.id}`,{method:'workflow.handoff',requestId});
    if(![expected,threadId].includes(t.threadId))throw new StoreError('owner_changed','A different transfer owns this task.');
    const binding=this.store.getManagerBinding(t.projectId);
    if(binding&&! [expected,threadId].includes(binding.threadId))throw new StoreError('binding_changed','Another manager binding exists.');
    if(binding?.threadId===expected)await this.call('manager.unbind',{projectId:t.projectId});
    t.threadId=threadId;this.save(t);
    await this.call('manager.bind',{projectId:t.projectId,threadId,requestId:`${requestId}:bind`});
    const eventIds:string[]=[];
    for(const oldId of intent.eventIds){
      const old=this.store.getManagerEvent(oldId)!;
      if(!this.store.getControl(`manager-decision:${oldId}`))await this.call('manager.decision',{eventId:oldId,action:'observe',note:`Transferred to ${threadId}: ${note}`,requestId:`${requestId}:retire:${oldId}`});
      await this.call('manager.ack',{eventId:oldId,requestId:`${requestId}:ack:${oldId}`});
      const dedupKey=`${old.dedupKey}:handoff:${requestId}`,existing=this.store.getManagerEventByDedup(dedupKey);
      if(existing){eventIds.push(existing.eventId);continue;}
      const eventId=`mw-${randomUUID()}`,now=Date.now();
      const payload={...JSON.parse(old.payload),eventId,threadId,workflowId:t.id,transferredFromEventId:oldId,at:now};
      this.store.insertManagerEvent({...old,eventId,threadId,dedupKey,payload:JSON.stringify(payload),deliveryState:'pending',attempts:0,nextAttemptAt:null,lastError:null,receipt:null,acked:false,ackedAt:null,createdAt:now,updatedAt:now});eventIds.push(eventId);
    }
    this.save(t);return {workflow:t,previousThreadId:expected,reissuedEventIds:eventIds};
  }
  private async open(p: Params): Promise<any> {
    const projectId=str(p,'projectId'), threadId=str(p,'threadId'), objective=str(p,'objective'), roadmap=str(p,'roadmap',24000), requestId=str(p,'requestId',200);
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new StoreError('invalid_params','An existing Codex thread UUID is required.');
    if (!this.store.getProject(projectId)) throw new StoreError('not_found','Unknown project.');
    const current=projectWorkflow(this.store,projectId);
    const exclusive=current&&this.store.getControl<{method:string,requestId:string}>(`workflow-exclusive:${current.id}`);
    if(exclusive)throw new StoreError('operation_in_progress',`Retry ${exclusive.method} with requestId ${exclusive.requestId} before reconnecting.`);
    const prior=this.store.beginJournal('workflow.open',requestId,p);
    if (prior.record.resultId) {
      const saved=this.task(prior.record.resultId);
      if(saved.state==='active') {
        if(saved.threadId!==threadId)throw new StoreError('owner_changed','Task ownership changed; this old connect request cannot reclaim it.');
        const b=this.store.getManagerBinding(projectId);
        if(b && b.threadId!==threadId) throw new StoreError('binding_changed','Another chat owns the binding.');
        await this.call('manager.bind',{projectId,threadId,requestId:`${saved.id}:bind:${threadId}`});
      }
      return {workflow:saved,replayed:true};
    }
    const currentBinding=this.store.getManagerBinding(projectId);
    if(currentBinding && currentBinding.threadId!==threadId) throw new StoreError('binding_changed','Another chat owns this project.');
    let t=projectWorkflow(this.store,projectId);
    if (t && ['active','stopping'].includes(t.state)) {
      if(t.state==='stopping' || t.threadId!==threadId || t.objective!==objective) throw new StoreError('workflow_busy','This project already has a task owner. Resume it by ID or explicitly stop it.');
    } else {
      const lease=this.store.getActiveLease(this.store.getProject(projectId)!.path);
      if(lease) throw new StoreError('writer_active','An existing unowned worker must be reviewed before opening a new task.');
      t={id:`pdm-w-${randomUUID()}`,projectId,threadId,objective,roadmap,state:'active',assignments:[],submissions:[],createdAt:Date.now(),updatedAt:Date.now()};
      this.store.withTransaction(()=>{this.save(t!);this.store.setWorkflowControl(`workflow-project:${projectId}`,t!.id);this.store.setWorkflowControl('workflow-index',[...(this.store.getControl<string[]>('workflow-index')??[]),t!.id]);});
    }
    this.save(t);
    const binding=this.store.getManagerBinding(projectId);
    if(binding && binding.threadId!==threadId) throw new StoreError('binding_changed','Another chat owns the project binding.');
    await this.call('manager.bind',{projectId,threadId,requestId:`${t.id}:bind:${threadId}`});
    this.store.completeJournal('workflow.open',requestId,t.id);
    return {workflow:t,replayed:prior.replayed};
  }
  private async submit(t: WorkflowRecord,p: Params,requestId:string): Promise<any> {
    const task=str(p,'task',96000), criteria=str(p,'criteria',12000);
    if(p.parentId && !workflowOwns(this.store,t,p.parentId)) throw new StoreError('wrong_task','Parent is not owned by this task.');
    checkMilestone(this.store,t,p);
    const submitId=`${requestId}:submit`;
    const planned=this.store.getControl<{task:string,criteria:string,parentId:string|null}>(`workflow-submit:${submitId}`);
    const payload={task,criteria,parentId:p.parentId??null,...(p.profileId?{profileId:p.profileId}:{}),...(p.milestoneId?{milestoneId:p.milestoneId}:{})};
    if(planned && JSON.stringify(planned)!==JSON.stringify(payload)) throw new StoreError('conflict','Continuation payload changed.');
    if(!planned)this.store.setWorkflowControl(`workflow-submit:${submitId}`,payload);
    const existing=this.store.getAssignmentByRequest(submitId);
    if(existing) { if(!t.assignments.includes(existing.id)){t.assignments.push(existing.id);this.save(t);} linkMilestone(this.store,t,p,existing); return {workflowId:t.id,assignment:existing,replayed:true}; }
    if(this.rows(t).some(a=>a.leasePath || ['queued','running','cancelling','blocked','needs_review'].includes(a.state))) throw new StoreError('review_required','Review or answer the current assignment before starting another.');
    if(!t.submissions.includes(submitId)) {t.submissions.push(submitId);this.save(t);}
    const s=await this.call('sessions.create',{projectId:t.projectId,...(p.profileId?{profileId:p.profileId}:{}),requestId:`${requestId}:session`});
    const result=await this.call('assignments.submit',{projectId:t.projectId,sessionId:s.session.id,task,criteria,...(p.parentId?{parentId:p.parentId}:{}),requestId:submitId});
    t.assignments.push(result.assignment.id);this.save(t);linkMilestone(this.store,t,p,result.assignment);
    return {workflowId:t.id,...result};
  }
  private async answer(t:WorkflowRecord,p:Params,requestId:string):Promise<any> {
    const category=activityCategory(p,'question_unclassified');
    const eventId=str(p,'eventId'),answer=str(p,'answer');
    const e=this.store.getManagerEvent(eventId);
    if(!e || e.kind!=='manager_request' || !workflowOwns(this.store,t,e.assignmentId) || e.threadId!==t.threadId) throw new StoreError('wrong_question','Question does not belong to this task owner.');
    const a=this.store.getAssignment(e.assignmentId)!;
    const question=JSON.parse(e.payload).detail ?? e.summary;
    // Event identity, not caller request ID, owns the continuation across retries.
    const continuation=`${t.id}:answer:${eventId}`;
    const previous=this.store.getControl<{answer:string}>(`workflow-answer:${eventId}`);
    if(previous && previous.answer!==answer) throw new StoreError('conflict','Question already has a different answer.');
    if(!previous && (e.acked || a.state!=='blocked')) throw new StoreError('stale_question','Question is already handled or no longer paused.');
    await this.call('manager.decision',{eventId,action:'answer',note:answer,requestId:`${continuation}:decision`});
    this.store.setWorkflowControl(`workflow-answer:${eventId}`,{answer,continuation,at:Date.now()});
    this.store.appendActivity({kind:'manager.answer',projectId:t.projectId,assignmentId:a.id,requestId,dedupKey:`answer:${eventId}`,data:{answer,eventId}});
    const checkpoint=await this.call('assignments.checkpoint',{id:a.id});
    this.store.setWorkflowControl(`workflow-checkpoint:${eventId}`,checkpoint);
    if(!checkpoint.verified || checkpoint.corrupt?.length) throw new StoreError('checkpoint_review','Checkpoint integrity could not be verified; inspect before continuing.');
    // abort joins tracked processes and refuses any live quarantined group.
    await this.call('assignments.cancel',{id:a.id});
    if(this.store.getAssignment(a.id)?.leasePath) throw new StoreError('writer_active','Paused worker still owns its lease.');
    const result=await this.submit(t,{task:`Continue the existing assignment after the manager answered your question. Inspect the existing checkout; do not redo completed work.\n\nOriginal assignment:\n${a.task??''}\n\nQuestion:\n${question}\n\nManager answer:\n${answer}`,criteria:a.acceptanceCriteria??'Complete the original acceptance criteria.',parentId:a.id},continuation);
    recordWorkflowActivity(this.store,t,eventId,category,answer,a.id);
    await this.call('manager.ack',{eventId,requestId:`${continuation}:ack`});
    return {...result,answeredEventId:eventId,checkpointInspected:!!checkpoint};
  }
}
