import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { PiDurableService } from '../src/service.js';
import { MetadataStore } from '../src/store.js';
import { WorkflowService, workflowEventScope } from '../src/workflow.js';

const threadId='11111111-2222-4333-8444-555555555555';
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'pdm-flow-'));await mkdir(join(dir,'projects'));
  const faux=fauxProvider({provider:'faux',models:[{id:'fixture'}]});const models=createModels();models.setProvider(faux.provider);
  const start=()=>PiDurableService.start({transport:'none',host:{runtimeDir:join(dir,'state'),config:{configVersion:1,endpoint:'https://example.invalid/v1',model:'fixture',limits:{contextWindow:65536,maxTokens:8192,maxSteps:null,timeoutMs:null},paths:{stateDir:join(dir,'state'),projectHome:join(dir,'projects'),allowedRoots:[join(dir,'projects')]},credential:{env:'UNUSED_FIXTURE'},manager:{enabled:false}},providerId:'faux',createModels:()=>models,resolveCredential:async()=>({apiKey:'fixture-key-unused',source:'test'}),unsandboxedForTesting:true}});
  let service=await start();
  const call=async(method:string,p:Record<string,any>={},requestId:string=randomUUID())=>{const r=await service.handle({v:1,id:requestId,method,params:{...p,requestId}} as any);if(r.error)throw Object.assign(new Error(r.error.message),{code:r.error.code});return r.result as any;};
  const project=(await call('projects.create',{path:join(dir,'projects','sample'),name:'sample'},'project')).project;
  const open={projectId:project.id,threadId,objective:'Implement the fixture',roadmap:'M1: ask then implement; independently verify.'};
  const task=(await call('workflow.open',open,'open')).workflow;
  return {dir,faux,call,project,open,task,get service(){return service},restart:async()=>{await service.stop();service=await start();},close:async()=>{await service.stop();await rm(dir,{recursive:true,force:true});}};
}

test('workflow reconnect is idempotent and creates no worker; another chat cannot take ownership',async()=>{
 const f=await fixture();try{
  assert.equal((await f.call('workflow.open',f.open,'open')).workflow.id,f.task.id);
  assert.equal((await f.call('workflow.open',f.open,'another-connect')).workflow.id,f.task.id);
  assert.equal((await f.call('assignments.list')).assignments.length,0);
  await assert.rejects(f.call('workflow.open',{...f.open,threadId:randomUUID()},'takeover'),/Another chat|owner/);
  const long='roadmap '.repeat(2500);await f.call('workflow.update',{id:f.task.id,roadmap:long},'roadmap');
  assert.equal((await f.call('workflow.status',{id:f.task.id})).workflow.roadmap,long);
  const targets=JSON.parse(await readFile(join(f.dir,'state','workflow-managers.json'),'utf8'));assert.equal(targets.targets[0].id,f.task.id);
 }finally{await f.close();}
});

test('real harness question -> durable answer -> fresh session; duplicate answer cannot duplicate writer',async()=>{
 const f=await fixture();try{
  f.faux.appendResponses([fauxAssistantMessage(fauxToolCall('request_manager',{question:'Reject fractional inputs?',context:'Reserved manager choice.'}),{stopReason:'toolUse'})]);
  const first=await f.call('workflow.submit',{id:f.task.id,task:'Ask the manager before work.',criteria:'Question answered then completed.'},'first');
  await f.call('assignments.wait',{id:first.assignment.id,timeoutMs:10000});
  const s=await f.call('workflow.status',{id:f.task.id});const event=s.events.find((e:any)=>e.kind==='manager_request');assert.ok(event);
  assert.equal(s.assignments[0].state,'blocked');assert.equal(s.assignments[0].leaseHeld,true);
  await assert.rejects(f.call('workflow.submit',{id:f.task.id,task:'duplicate',criteria:'no'},'duplicate'),/Review|answer/);
  f.faux.appendResponses([fauxAssistantMessage('Finished after the explicit answer.')]);
  const p={id:f.task.id,eventId:event.eventId,answer:'Yes. Reject fractional inputs with TypeError.'};
  const [answered,repeated]=await Promise.all([f.call('workflow.answer',p,'answer'),f.call('workflow.answer',p,'answer')]);
  assert.equal(answered.assignment.id,repeated.assignment.id);assert.notEqual(answered.assignment.sessionId,first.assignment.sessionId);
  const again=await f.call('workflow.answer',p,'different-request-same-event');assert.equal(again.assignment.id,answered.assignment.id);
  assert.equal((await f.call('assignments.list')).assignments.length,2);
  await assert.rejects(f.call('workflow.answer',{...p,answer:'No.'},'conflict'),/different answer/);
  const handled=await f.call('workflow.event',{eventId:event.eventId});assert.equal(handled.actionable,false);assert.equal(handled.decision.action,'answer');
  await f.call('assignments.wait',{id:answered.assignment.id,timeoutMs:10000});
  await assert.rejects(f.call('workflow.finish',{id:f.task.id,note:'too soon'},'finish-early'),/Review/);
  await f.call('assignments.review',{id:answered.assignment.id,decision:'accept',note:'Fixture output verified'});
  await f.call('workflow.finish',{id:f.task.id,note:'Reviewed fixture'},'finish');
  assert.equal((await f.call('manager.status')).boundProjects,0);
  assert.equal(JSON.parse(await readFile(join(f.dir,'state','workflow-managers.json'),'utf8')).targets.length,0);
  assert.equal((await f.call('workflow.status',{id:f.task.id})).workflow.state,'complete');
  assert.equal((await f.call('workflow.open',f.open,'open')).workflow.state,'complete');
 }finally{await f.close();}
});

test('stop joins only owned work, retires old questions, and reopening a new task cannot replay them',async()=>{
 const f=await fixture();try{
  f.faux.appendResponses([fauxAssistantMessage(fauxToolCall('request_manager',{question:'Pause here?',context:null}),{stopReason:'toolUse'})]);
  const a=await f.call('workflow.submit',{id:f.task.id,task:'Ask a question.',criteria:'Pause'},'stop-submit');
  await f.call('assignments.wait',{id:a.assignment.id,timeoutMs:10000});
  const event=(await f.call('workflow.status',{id:f.task.id})).events[0];
  await f.call('workflow.stop',{id:f.task.id,note:'User took over'},'stop');
  const e=await f.call('workflow.event',{eventId:event.eventId});assert.equal(e.actionable,false);assert.equal(e.event.acked,true);assert.equal(e.decision.action,'abort');
  assert.equal((await f.call('assignments.show',{id:a.assignment.id})).state,'cancelled');
  const t2=(await f.call('workflow.open',{...f.open,objective:'Next task'},'next')).workflow;assert.notEqual(t2.id,f.task.id);
  assert.equal((await f.call('workflow.event',{eventId:event.eventId})).actionable,false);
  await assert.rejects(f.call('workflow.submit',{id:f.task.id,task:'stale',criteria:'stale'},'stale'),/retired/);
  await f.call('workflow.stop',{id:t2.id,note:'Fixture cleanup'},'stop-next');
 }finally{await f.close();}
});

test('workflow state remains lossless beyond 32 assignments and survives store reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pdm-flow-store-'));const path=join(dir,'m.sqlite');let store=await MetadataStore.open(path);
 try {const data={id:'many',assignments:Array.from({length:80},(_,i)=>'a'+i),roadmap:'x'.repeat(20000)};store.setWorkflowControl('workflow:many',data);store.close();store=await MetadataStore.open(path);assert.deepEqual(store.getControl('workflow:many'),data);}finally{store.close();await rm(dir,{recursive:true,force:true});}
});


test('lost continuation response reconciles after coordinator recreation without another session or writer',async()=>{
 const f=await fixture();try{
  f.faux.appendResponses([fauxAssistantMessage(fauxToolCall('request_manager',{question:'Choose A?',context:null}),{stopReason:'toolUse'})]);
  const a=await f.call('workflow.submit',{id:f.task.id,task:'Ask.',criteria:'Complete after answer'},'crash-submit');
  await f.call('assignments.wait',{id:a.assignment.id,timeoutMs:10000});
  const e=(await f.call('workflow.status',{id:f.task.id})).events[0];
  f.faux.appendResponses([fauxAssistantMessage('Done')]);
  const service:any=f.service, original=service.workflow.call;
  service.workflow.call=async(method:string,p:any)=>{const result=await original(method,p);if(method==='assignments.submit')throw new Error('simulated lost response after durable admission');return result;};
  const params={id:f.task.id,eventId:e.eventId,answer:'Choose A'};
  await assert.rejects(f.call('workflow.answer',params,'crash-answer'),/lost response/);
  const before=(await f.call('assignments.list')).assignments;assert.equal(before.length,2);
  service.workflow=new WorkflowService(service.metadata,original);
  const recovered=await f.call('workflow.answer',params,'crash-answer');
  assert.equal((await f.call('assignments.list')).assignments.length,2);
  assert.equal((await f.call('sessions.list')).sessions.length,2);
  assert.equal((await f.call('workflow.event',{eventId:e.eventId})).event.acked,true);
  assert.equal(recovered.assignment.parentId,a.assignment.id);
  await f.call('workflow.stop',{id:f.task.id,note:'fixture cleanup'},'crash-stop');
 }finally{await f.close();}
});

test('failed cancellation leaves task stopping and wakes retired until explicit retry succeeds',async()=>{
 const f=await fixture();try{
  f.faux.appendResponses([fauxAssistantMessage(fauxToolCall('request_manager',{question:'Wait?',context:null}),{stopReason:'toolUse'})]);
  const a=await f.call('workflow.submit',{id:f.task.id,task:'Ask.',criteria:'Pause'},'failstop-submit');
  await f.call('assignments.wait',{id:a.assignment.id,timeoutMs:10000});
  const e=(await f.call('workflow.status',{id:f.task.id})).events[0];
  const service:any=f.service,original=service.workflow.call;
  service.workflow.call=async(method:string,p:any)=>{if(method==='assignments.cancel')throw new Error('fixture live process hold');return original(method,p);};
  const params={id:f.task.id,note:'User requested stop'};
  await assert.rejects(f.call('workflow.stop',params,'failstop'),/live process/);
  assert.equal((await f.call('workflow.status',{id:f.task.id})).workflow.state,'stopping');
  assert.equal((await f.call('manager.status')).boundProjects,0);
  assert.equal((await f.call('workflow.event',{eventId:e.eventId})).actionable,false);
  service.workflow.call=original;
  await f.call('workflow.stop',params,'failstop');
  assert.equal((await f.call('workflow.status',{id:f.task.id})).workflow.state,'stopped');
 }finally{await f.close();}
});


test('finish resumes after a lost unbind response instead of stranding the task in stopping',async()=>{
 const f=await fixture();try{
  const service:any=f.service,original=service.workflow.call;
  let fail=true;
  service.workflow.call=async(method:string,p:any)=>{const result=await original(method,p);if(method==='manager.unbind'&&fail){fail=false;throw new Error('lost unbind response');}return result;};
  const params={id:f.task.id,note:'No work needed; finish the empty fixture'};
  await assert.rejects(f.call('workflow.finish',params,'finish-loss'),/lost unbind/);
  assert.equal((await f.call('workflow.status',{id:f.task.id})).workflow.state,'stopping');
  const r=await f.call('workflow.finish',params,'finish-loss');assert.equal(r.workflow.state,'complete');
  assert.equal((await f.call('manager.status')).boundProjects,0);
 }finally{await f.close();}
});

async function until<T>(read:()=>Promise<T>,accept:(x:T)=>boolean):Promise<T>{
 const until=Date.now()+8000;for(;;){const x=await read();if(accept(x))return x;if(Date.now()>until)throw Error('Fixture condition timed out');await new Promise(r=>setTimeout(r,10));}
}
for(const failAt of ['manager.decision','assignments.review','manager.ack'])test(`workflow.review recovers lost ${failAt} response with one verdict and acknowledgment`,async()=>{
 const f=await fixture();try{
  f.faux.appendResponses([fauxAssistantMessage('Completed')]);const job=await f.call('workflow.submit',{id:f.task.id,task:'Finish',criteria:'Review actual evidence'},'review-submit');await f.call('assignments.wait',{id:job.assignment.id,timeoutMs:8000});
  const event=(await f.call('workflow.status',{id:f.task.id})).events[0],evidence=await f.call('assignments.evidence',{id:job.assignment.id});
  const p={id:f.task.id,eventId:event.eventId,decision:'accept',note:'Fixture evidence independently checked',evidenceHash:evidence.sha256};
  const s:any=f.service,original=s.workflow.call;let fail=true;
  s.workflow.call=async(m:string,p:any)=>{const r=await original(m,p);if(m===failAt&&fail){fail=false;throw Error('lost response')}return r;};
  await assert.rejects(f.call('workflow.review',p,'review-loss'),/lost response/);
  s.workflow=new WorkflowService(s.metadata,original);
  const accepted=await f.call('workflow.review',p,'review-loss');const repeated=await f.call('workflow.review',p,'review-loss');
  assert.equal(accepted.assignment.state,'accepted');assert.equal(accepted.assignment.reviewedAt,repeated.assignment.reviewedAt);
  assert.equal((await f.call('workflow.event',{eventId:event.eventId})).event.acked,true);
  assert.equal((await f.call('assignments.list')).assignments.length,1);
 }finally{await f.close();}
});
test('workflow review refuses stale checkout and never acknowledges failed acceptance',async()=>{
 const f=await fixture();try{
  f.faux.appendResponses([fauxAssistantMessage('Done')]);const a=await f.call('workflow.submit',{id:f.task.id,task:'Finish',criteria:'Review'},'stale-submit');await f.call('assignments.wait',{id:a.assignment.id,timeoutMs:8000});
  const e=(await f.call('workflow.status',{id:f.task.id})).events[0],v=await f.call('assignments.evidence',{id:a.assignment.id});
  const p={id:f.task.id,eventId:e.eventId,decision:'accept',note:'Reviewed',evidenceHash:v.sha256};
  await assert.rejects(f.call('workflow.review',{...p,evidenceHash:'0'.repeat(64)},'wrong-hash'),/differs/);
  assert.equal((await f.call('workflow.event',{eventId:e.eventId})).decision,null);
  await writeFile(join(f.project.path,'unexpected.txt'),'changed');
  await assert.rejects(f.call('workflow.review',p,'stale-review'),/changed|stale|match/i);
  assert.equal((await f.call('workflow.event',{eventId:e.eventId})).event.acked,false);
  assert.equal((await f.call('assignments.show',{id:a.assignment.id})).state,'needs_review');
 }finally{await f.close();}
});
test('operator pause drains current command without killing it, fences subsequent tools and resumes once',async()=>{
 const f=await fixture();try{
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'sleep 0.4; printf done > completed.txt'}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxToolCall('write',{path:'forbidden.txt',content:'not admitted'}),{stopReason:'toolUse'})]);
  const a=await f.call('workflow.submit',{id:f.task.id,task:'Work with a command',criteria:'Preserve completed work'},'pause-submit');
  await until(async()=>((f.service as any).metadata.listProcessReceipts(a.assignment.id)),x=>x.some((r:any)=>r.state==='started'));
  const pause=await f.call('workflow.pause',{id:f.task.id,note:'Pause after current tool'},'pause');assert.equal(pause.pause.status,'pausing');
  await assert.rejects(f.call('workflow.resume',{id:f.task.id,summary:'Too soon'},'early-resume'),/confirmed safe pause/);
  const s=await until(()=>f.call('workflow.status',{id:f.task.id}),x=>x.operatorPause?.status==='paused');
  assert.equal(s.assignments[0].state,'blocked');assert.equal(s.assignments[0].leaseHeld,true);
  assert.equal(await readFile(join(f.project.path,'completed.txt'),'utf8'),'done');await assert.rejects(readFile(join(f.project.path,'forbidden.txt')));
  const evidence=await f.call('assignments.evidence',{id:a.assignment.id});assert.equal(evidence.bundle.commands[0].exitCode,0);
  await assert.rejects(f.call('workflow.submit',{id:f.task.id,task:'duplicate',criteria:'no'},'paused-submit'),/operator pause/);
  f.faux.setResponses([fauxAssistantMessage('Finished remaining work')]);
  const p={id:f.task.id,summary:'completed.txt already exists; do not rerun the completed command.'};
  const [r1,r2]=await Promise.all([f.call('workflow.resume',p,'resume'),f.call('workflow.resume',p,'resume')]);
  assert.equal(r1.assignment.id,r2.assignment.id);assert.notEqual(r1.assignment.sessionId,a.assignment.sessionId);assert.equal(r1.continuationPacket.recentCommands[0].exitCode,0);
  assert.equal((await f.call('assignments.list')).assignments.length,2);await f.call('assignments.wait',{id:r1.assignment.id,timeoutMs:8000});
  await f.call('workflow.stop',{id:f.task.id,note:'Fixture done'},'pause-stop');
 }finally{await f.close();}
});
for(const failAt of ['manager.unbind','manager.bind','manager.ack'])test(`handoff recovers lost ${failAt}, retires old chat wakes and reissues once`,async()=>{
 const f=await fixture();try{
  f.faux.appendResponses([fauxAssistantMessage(fauxToolCall('request_manager',{question:'Decision?',context:null}),{stopReason:'toolUse'})]);
  const a=await f.call('workflow.submit',{id:f.task.id,task:'Ask',criteria:'Pause'},'handoff-submit');await f.call('assignments.wait',{id:a.assignment.id,timeoutMs:8000});
  const old=(await f.call('workflow.status',{id:f.task.id})).events[0];const target=randomUUID();
  const s:any=f.service,original=s.workflow.call;let fail=true;
  s.workflow.call=async(m:string,p:any)=>{const r=await original(m,p);if(m===failAt&&fail){fail=false;throw Error('lost response')}return r;};
  const p={id:f.task.id,expectedThreadId:threadId,threadId:target,note:'Explicit test handoff'};
  await assert.rejects(f.call('workflow.handoff',p,'handoff'),/lost response/);
  await assert.rejects(f.call('workflow.update',{id:f.task.id,roadmap:'Interfering mutation'},'interfere'),/Retry workflow.handoff/);
  s.workflow=new WorkflowService(s.metadata,original);
  await assert.rejects(f.call('workflow.open',f.open,'open'),/Retry workflow.handoff/);
  const result=await f.call('workflow.handoff',p,'handoff');assert.equal(result.workflow.threadId,target);assert.equal(result.reissuedEventIds.length,1);
  assert.equal((await f.call('workflow.event',{eventId:old.eventId})).actionable,false);
  const next=await f.call('workflow.event',{eventId:result.reissuedEventIds[0]});assert.equal(next.event.threadId,target);assert.equal(next.actionable,true);
  await assert.rejects(f.call('workflow.open',f.open,'open'),/ownership changed/);
  assert.equal((await f.call('workflow.open',{...f.open,threadId:target},'new-owner-connect')).workflow.threadId,target);
  const again=await f.call('workflow.handoff',p,'handoff');assert.deepEqual(again.reissuedEventIds,result.reissuedEventIds);
  await assert.rejects(f.call('workflow.handoff',{...p,threadId:randomUUID()},'stale-owner'),/Expected manager/);
  await f.call('workflow.stop',{id:f.task.id,note:'Cleanup'},'handoff-stop');
 }finally{await f.close();}
});

for(const failAt of ['assignments.cancel','assignments.submit','manager.ack'])test(`paused continuation survives restart and lost ${failAt} without duplicate execution`,async()=>{
 const f=await fixture();try{
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'sleep 0.3; printf once >> once.txt'}),{stopReason:'toolUse'}),fauxAssistantMessage('Done')]);
  const a=await f.call('workflow.submit',{id:f.task.id,task:'Append once, then finish',criteria:'One append'},'resume-loss-submit');
  await until(async()=>((f.service as any).metadata.listProcessReceipts(a.assignment.id)),x=>x.some((r:any)=>r.state==='started'));
  await f.call('workflow.pause',{id:f.task.id,note:'Pause for restart'},'resume-loss-pause');
  await until(()=>f.call('workflow.status',{id:f.task.id}),x=>x.operatorPause?.status==='paused');
  await f.restart();
  assert.equal((await f.call('workflow.status',{id:f.task.id})).operatorPause.status,'paused');
  assert.equal(await readFile(join(f.project.path,'once.txt'),'utf8'),'once');
  f.faux.setResponses([fauxAssistantMessage('Finished without repeating completed commands')]);
  const s:any=f.service,original=s.workflow.call;let fail=true;
  s.workflow.call=async(m:string,p:any)=>{const r=await original(m,p);if(m===failAt&&fail){fail=false;throw Error('lost response')}return r;};
  const p={id:f.task.id,summary:'once.txt contains once. Do not repeat the append.'};
  await assert.rejects(f.call('workflow.resume',p,'resume-loss'),/lost response/);
  s.workflow=new WorkflowService(s.metadata,original);
  const result=await f.call('workflow.resume',p,'resume-loss');
  assert.equal((await f.call('assignments.list')).assignments.length,2);
  assert.equal((await f.call('sessions.list')).sessions.length,2);
  await f.call('assignments.wait',{id:result.assignment.id,timeoutMs:8000});
  assert.equal(await readFile(join(f.project.path,'once.txt'),'utf8'),'once');
  await f.call('workflow.stop',{id:f.task.id,note:'Cleanup'},'resume-loss-stop');
 }finally{await f.close();}
});

test('working brief survives actual question/answer continuation and profiles are manager-controlled',async()=>{
 const f=await fixture();try{
  const profile={name:'smoke',serveDirectory:'dist',steps:[{action:'text',selector:'h1',value:'Ready'}]};
  await f.call('validation.configure',{projectId:f.project.id,profile},'profile');
  assert.equal((await f.call('validation.profiles',{projectId:f.project.id})).profiles[0].name,'smoke');
  await writeFile(join(f.project.path,'source.txt'),'original');
  f.faux.appendResponses([
   fauxAssistantMessage(fauxToolCall('working_brief',{objective:'Build fixture',decisions:['Reuse source.txt'],completed:['Located file'],issues:['Need ordering decision'],nextStep:'Use manager answer',paths:['source.txt']}),{stopReason:'toolUse'}),
   fauxAssistantMessage(fauxToolCall('request_manager',{question:'Which order?',context:'Reserved choice'}),{stopReason:'toolUse'})
  ]);
  const a=(await f.call('workflow.submit',{id:f.task.id,task:'Record brief and ask.',criteria:'Persist notes'},'brief-submit')).assignment;
  await f.call('assignments.wait',{id:a.id,timeoutMs:10000});const brief=await f.call('brief.inspect',{assignmentId:a.id});assert.equal(brief.notes.nextStep,'Use manager answer');assert.equal(brief.files[0].freshness,'unchanged');
  await assert.rejects(f.call('validation.configure',{projectId:f.project.id,profile:{...profile,steps:[{action:'text',selector:'h1',value:'Changed'}]}},'profile-live'),/writer|checkout/);
  const event=(await f.call('workflow.status',{id:f.task.id})).events.find((e:any)=>e.kind==='manager_request');
  f.faux.appendResponses([fauxAssistantMessage('Continued using inherited brief.')]);
  const child=(await f.call('workflow.answer',{id:f.task.id,eventId:event.eventId,answer:'Preserve order.'},'brief-answer')).assignment;
  await f.call('assignments.wait',{id:child.id,timeoutMs:10000});const inherited=await f.call('brief.inspect',{assignmentId:child.id});assert.equal(inherited.inherited,true);assert.equal(inherited.assignmentId,a.id);
 }finally{await f.close();}
});

test('scorecard tracks real question/answer/revision continuation exactly once with prospective scope',async()=>{
 const f=await fixture();try{
  await f.call('scorecard.plan',{id:f.task.id,milestoneId:'m1',title:'Implement fixture',points:3},'score-plan');
  f.faux.appendResponses([fauxAssistantMessage(fauxToolCall('request_manager',{question:'Preserve order?',context:'Reserved choice'}),{stopReason:'toolUse'})]);
  const first=await f.call('workflow.submit',{id:f.task.id,milestoneId:'m1',task:'Ask then implement',criteria:'Reviewed result'},'score-first');
  await f.call('assignments.wait',{id:first.assignment.id,timeoutMs:10000});
  const question=(await f.call('workflow.status',{id:f.task.id})).events.find((e:any)=>e.kind==='manager_request');
  f.faux.appendResponses([fauxAssistantMessage('Initial result')]);
  const params={id:f.task.id,eventId:question.eventId,answer:'Preserve order',activityCategory:'product_decision'};
  const next=await f.call('workflow.answer',params,'score-answer');await f.call('workflow.answer',params,'score-answer-again');
  await f.call('assignments.wait',{id:next.assignment.id,timeoutMs:10000});
  const review=async(id:string,decision:string,requestId:string)=>{
    const event=(await f.call('workflow.status',{id:f.task.id})).events.find((e:any)=>e.assignmentId===id&&e.kind==='needs_review');
    const evidence=await f.call('assignments.evidence',{id,section:'summary'});
    const p={id:f.task.id,eventId:event.eventId,decision,note:'Fixture evidence inspected',evidenceHash:evidence.sha256};
    await f.call('workflow.review',p,requestId);await f.call('workflow.review',p,requestId);
  };
  await review(next.assignment.id,'revise','score-revise');
  f.faux.appendResponses([fauxAssistantMessage('Corrected result')]);
  const fixed=await f.call('workflow.submit',{id:f.task.id,parentId:next.assignment.id,task:'Correct scoped issue',criteria:'Pass review'},'score-fix');
  await f.call('assignments.wait',{id:fixed.assignment.id,timeoutMs:10000});await review(fixed.assignment.id,'accept','score-review');
  await f.call('scorecard.accept',{id:f.task.id,milestoneId:'m1',owner:'pi',assignmentId:fixed.assignment.id,note:'Independent review complete',evidence:'Fixture evidence + review event'},'score-accept');
  await f.restart();const score=await f.call('scorecard.read',{id:f.task.id});
  assert.equal(score.codex.counts.product_decision,1);assert.equal(score.codex.counts.revision_guidance,1);assert.equal(score.codex.counts.review,1);assert.equal(score.codex.total,3);assert.equal(score.trends[0].assignments,3);assert.equal(score.trends[0].firstReview,false);assert.equal(score.scope.piPoints,3);assert.equal(score.assignments.unmapped,0);
  await f.call('workflow.finish',{id:f.task.id,note:'Fixture accepted'},'score-finish');
 }finally{await f.close();}
});
