/** Read-only projections of durable facts. Roadmap checkboxes are owned by Codex. */
import { terminalText, readAssignmentSummary, readActivityPage, type ObserverRpc } from './native-terminal.js';
import { assignmentLabels, assignmentStateLabel } from './assignment-labels.js';
import type { ActivityEntry } from './activity.js';

type Row = Record<string, any>;
export function roadmapMilestones(roadmap: string): { title: string; status: string }[] {
  const milestones: { title: string; status: string }[] = [];
  for (const line of roadmap.split('\n')) {
    const check = line.match(/^\s*[-*]\s+\[([ xX~])\]\s+(.+)/);
    const named = line.match(/^\s*(?:#{1,6}\s*)?Milestone\s+\d+\s*[:.—-]\s*(.+)/i);
    if (check) milestones.push({ title: terminalText(check[2]), status: check[1]?.toLowerCase() === 'x' ? 'Complete' : check[1] === '~' ? 'In progress' : 'Planned' });
    else if (named) milestones.push({ title: terminalText(named[1]), status: 'Status not recorded' });
  }
  return milestones.slice(0, 60);
}

export function activitySummary(entry: ActivityEntry): string | null {
  const d = (entry.data ?? {}) as Row;
  const clean = (value: unknown) => terminalText(value).slice(0, 500);
  if (entry.kind === 'worker.provider_request') return 'Pi requested its next model response';
  if (entry.kind === 'worker.tool_start') {
    const args = d.arguments ?? {};
    return `Started ${clean(d.tool)}${args.command || args.path ? ': ' + clean(args.command ?? args.path) : ''}`;
  }
  if (entry.kind === 'worker.tool_result') return `Finished ${clean(d.tool)}${d.result?.isError || typeof d.result?.details?.exitCode === 'number' && d.result.details.exitCode !== 0 ? ' · reported an error' : ''}`;
  if (entry.kind === 'command.completed') return `Command finished · exit ${d.exitCode ?? 'unknown'}${d.timedOut ? ' · timed out' : ''}: ${clean(d.command)}`;
  if (entry.kind === 'worker.message' && d.text) return `Pi: ${clean(d.text)}`;
  if (entry.kind === 'assignment.state') return `Assignment: ${clean(d.state)}`;
  if (entry.kind === 'manager.decision') return `Codex recorded ${clean(d.action)}${d.note ? ': ' + clean(d.note) : ''}`;
  if (entry.kind === 'manager.answer') return `Codex answered: ${clean(d.answer)}`;
  return null;
}

/** Deterministic wording of recorded events; no model-generated progress claims. */
export function plainWork(entry: ActivityEntry): string | null {
  const d=(entry.data??{}) as Row, clean=(v:unknown)=>terminalText(v).slice(0,700);
  if(entry.kind==='worker.message'&&d.text)return 'Pi: '+clean(d.text);
  if(entry.kind==='worker.tool_start'){
    const a=d.arguments??{},path=a.path?' '+clean(a.path):'';
    if(d.tool==='read')return 'Pi is reading'+(path||' a file')+'.';
    if(['edit','write'].includes(d.tool))return 'Pi is updating'+(path||' a file')+'.';
    if(d.tool==='bash'){
      const cmd=String(a.command??'');
      if(/(?:--test|\bpytest\b|\bunittest\b|npm (?:run )?test|vitest|playwright test)/.test(cmd))return 'Pi is running tests.';
      if(/(?:npm run (?:build|typecheck)|\btsc\b)/.test(cmd))return 'Pi is checking the build.';
      return 'Pi is running a command.';
    }
    return null;
  }
  if(entry.kind==='worker.tool_result'&&(d.result?.isError||typeof d.result?.details?.exitCode==='number'&&d.result.details.exitCode!==0))return 'A Pi tool reported an error.';
  if(entry.kind==='validation.started')return 'Pi requested a browser check.';
  if(entry.kind==='validation.completed')return 'Browser check '+clean(d.profileName??d.profile??'')+' '+(d.state==='passed'?'passed.':d.state==='failed'?'failed.':'finished with status '+clean(d.state)+'.');
  if(entry.kind==='working_brief.updated')return 'Pi saved its working notes for the next step.';
  if(entry.kind==='manager.answer')return 'Codex answered: '+clean(d.answer);
  if(entry.kind==='manager.decision'){
    if(d.action==='accept')return 'Codex reviewed and accepted the work.';
    if(d.action==='revise')return 'Codex requested changes: '+clean(d.note);
    return null;
  }
  if(entry.kind==='codex.activity'&&d.source==='reported'&&!d.retrospective)return 'Codex: '+clean(d.note);
  if(entry.kind==='assignment.state')return ({running:'Pi started this step.',queued:'The next step is queued.',needs_review:'Pi finished this attempt and is waiting for Codex to review it.',blocked:'Pi paused for attention.',failed:'Pi stopped after an error.',unanswered:'Pi stopped before finishing; Codex needs to inspect it.'} as Row)[d.state]??null;
  if(entry.kind==='command.completed'&&(d.timedOut||typeof d.exitCode==='number'&&d.exitCode!==0))return 'A command '+(d.timedOut?'timed out.':'finished with exit code '+clean(d.exitCode)+'.');
  return null;
}

/** Color describes the recorded event, never an inferred claim in worker prose. */
export function plainWorkTone(entry: ActivityEntry): string {
  const d = (entry.data ?? {}) as Row;
  if (entry.kind === 'worker.tool_result' && (d.result?.isError || typeof d.result?.details?.exitCode === 'number' && d.result.details.exitCode !== 0)) return 'error';
  if (entry.kind === 'command.completed' && (d.timedOut || typeof d.exitCode === 'number' && d.exitCode !== 0)) return 'error';
  if (entry.kind === 'validation.completed') return d.state === 'passed' ? 'success' : d.state === 'failed' ? 'error' : 'attention';
  if (entry.kind === 'manager.decision') return d.action === 'accept' ? 'success' : 'attention';
  if (entry.kind === 'assignment.state') {
    if (['failed', 'unanswered'].includes(d.state)) return 'error';
    if (['needs_review', 'blocked'].includes(d.state)) return 'attention';
  }
  if (entry.kind === 'validation.started') return 'check';
  if (entry.kind === 'worker.tool_start') {
    if (d.tool === 'read') return 'note';
    const cmd = String(d.arguments?.command ?? '');
    if (d.tool === 'bash' && /(?:--test|\bpytest\b|\bunittest\b|npm (?:run )?(?:test|build|typecheck)|vitest|playwright test|\btsc\b)/.test(cmd)) return 'check';
  }
  if (entry.kind === 'working_brief.updated') return 'note';
  return 'work';
}

function statusFor(task: Row | null, assignment: Row | null, pause: Row | null, waiting: Row[]): { label: string; next: string } {
  if (task?.state === 'complete') return { label: 'Complete', next: 'Work reviewed and accepted by Codex. No next action.' };
  if (task?.state === 'stopped') return { label: 'Stopped', next: 'This task has been retired.' };
  if (task?.state === 'stopping') return { label: 'Stopping', next: 'Pi Durable is settling the task and releasing its worker.' };
  if (pause?.status === 'pausing') return { label: 'Pausing', next: 'Waiting for the current tool to finish safely.' };
  if (pause?.status === 'error') return { label: 'Needs attention', next: 'Codex needs to inspect the pause error.' };
  if (pause?.status === 'paused') return { label: 'Paused', next: 'Codex can review the checkpoint and explicitly resume.' };
  if (waiting.some(e => e.kind === 'manager_request')) return { label: 'Waiting for Codex', next: 'Codex needs to answer the worker’s question.' };
  if (assignment?.state === 'needs_review') return { label: 'Ready for review', next: 'Codex needs to inspect the evidence and accept or request a revision.' };
  if (['failed', 'budget', 'timeout', 'unanswered', 'blocked'].includes(assignment?.state)) return { label: 'Needs attention', next: 'Codex needs to inspect the recorded issue before continuing.' };
  if (['running', 'queued', 'cancelling'].includes(assignment?.state)) return { label: assignment?.state === 'running' ? 'Working' : assignment?.state === 'queued' ? 'Queued' : 'Cancelling', next: 'Pi Durable will record the next activity or request for attention.' };
  if (assignment?.state === 'accepted') return { label: 'Assignment accepted', next: 'Codex can submit the next milestone or finish the task.' };
  if (assignment?.state === 'revision_requested') return { label: 'Revision requested', next: 'Codex can submit a scoped correction.' };
  if (assignment?.state === 'cancelled') return { label: 'Assignment cancelled', next: 'Codex can decide the next step.' };
  return { label: assignment ? 'Status unavailable' : 'Awaiting assignment', next: 'Codex can submit the next planned scope.' };
}

export async function readTerminalOverview(rpc: ObserverRpc, workflowId?: string | null, assignmentId?: string | null): Promise<Row> {
  const snapshot = workflowId ? await rpc.call<Row>('workflow.status', { id: workflowId }) : null;
  const task = snapshot?.workflow ?? null;
  let assignment: Row | null = null;
  if (snapshot) {
    // Workflow order is creation order; reviewing an old assignment must not make it current.
    const id = [...snapshot.assignments].reverse().find((a:Row)=>a.leaseHeld||['running','queued','cancelling'].includes(a.state))?.id??snapshot.assignments.at(-1)?.id;
    if (id) assignment = await readAssignmentSummary(rpc, id, task?.projectId);
  } else if (assignmentId) assignment = await readAssignmentSummary(rpc, assignmentId);
  else {
    const list = await rpc.call<Row>('assignments.list');
    const latest = list.assignments.sort((a: Row, b: Row) => b.createdAt - a.createdAt)[0];
    if (latest) assignment = latest;
  }
  const projectId = task?.projectId ?? assignment?.projectId;
  const projectReply = projectId ? await rpc.call<Row>('projects.show', { id: projectId }) : null;
  const project = projectReply?.project ?? projectReply;
  const owned = new Set<string>(task?.assignments ?? (assignment ? [assignment.id] : []));
  const waiting = (snapshot?.events ?? []).filter((e: Row) => e.actionable && owned.has(e.assignmentId));
  const latestSeq = Math.max(0, ...(snapshot?.assignments ?? []).map((a: Row) => a.latestActivity?.seq ?? 0));
  let cursor = Math.max(0, latestSeq - 200);
  const history: Row[] = [];
  const work: Row[] = [];
  // Workflow snapshots give us a recent cursor. For legacy assignment-only URLs,
  // don't label the first page of a potentially large journal as recent activity.
  if (projectId && snapshot) for (let i = 0; i < 6; i++) {
    const page = await readActivityPage(rpc, projectId, cursor);
    for (const e of page.entries) {
      if (e.seq <= cursor) continue;
      if (!e.assignmentId || !owned.has(e.assignmentId)) continue;
      const plain=plainWork(e);if(plain)work.push({seq:e.seq,at:e.at,text:plain,tone:plainWorkTone(e)});
      const summary = activitySummary(e);
      if (summary) history.push({ seq: e.seq, at: e.at, summary });
    }
    if (!page.entries.length || page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }
  const recent = history.sort((a, b) => b.seq - a.seq).slice(0, 16);
  const latestRecorded = snapshot?.assignments.at(-1)?.latestActivity;
  const latest = recent[0] ?? (latestRecorded ? { at: latestRecorded.at, summary: `Recorded ${terminalText(latestRecorded.kind)}` } : assignment ? { at: assignment.updatedAt, summary: `Recorded assignment status: ${terminalText(assignment.state)}` } : null);
  const status = statusFor(task, assignment, snapshot?.operatorPause ?? null, waiting);
  const labels=assignmentLabels(task?.roadmap??'');
  const checklist=roadmapMilestones(task?.roadmap??'');
  const steps=checklist.length?checklist:[...labels].map(([id,title])=>({title,status:assignmentStateLabel(snapshot?.assignments.find((a:Row)=>a.id===id)?.state??'Status not recorded')}));
  const stepTitle=labels.get(assignment?.id)??checklist.find(m=>m.status==='In progress')?.title??null;
  const currentStep=['complete','stopped'].includes(task?.state)?status.next:stepTitle??(assignment?.task?terminalText(assignment.task).split('\n')[0]?.slice(0,240):status.next);
  const plainHistory=work.sort((a,b)=>b.seq-a.seq).filter((e,i,a)=>i===0||e.text!==a[i-1]?.text).slice(0,30);
  let scorecard: Row|null=null, scorecardError='';
  if(task?.id)try { scorecard=await rpc.call<Row>('scorecard.read',{id:task.id}); } catch { scorecardError='Scorecard unavailable from this service. Worker status is independent.'; }
  return {
    project: project ? { name: terminalText(project.name), path: terminalText(project.path) } : null,
    workflowId: task?.id ?? null, objective: terminalText(task?.objective ?? assignment?.task ?? 'No task has been submitted.'),
    assignment: assignment ? { id: assignment.id, state: assignment.state, task: terminalText(assignment.task), updatedAt: assignment.updatedAt } : null,
    steps, currentStep, plainHistory, scorecard, scorecardError, status: status.label, next: status.next, latest, history: recent,
    waiting: waiting.map((e: Row) => ({ eventId: e.eventId, kind: e.kind, summary: terminalText(e.summary), deliveryState: e.deliveryState })),
    issue: ['failed', 'blocked', 'budget', 'timeout', 'unanswered'].includes(assignment?.state) ? terminalText(assignment?.error) : '',
    milestones: roadmapMilestones(task?.roadmap ?? ''), roadmap: terminalText(task?.roadmap ?? ''),
    roadmapUpdatedAt: task?.updatedAt ?? null, observedAt: Date.now(),
    // A successful read is not worker progress. Show both timestamps separately.
    manager: snapshot?.manager ? { enabled: snapshot.manager.enabled, pending: snapshot.manager.pending, unacked: snapshot.manager.unacked, parked: snapshot.manager.parked } : null,
  };
}
