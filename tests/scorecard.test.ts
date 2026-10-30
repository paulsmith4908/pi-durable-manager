import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MetadataStore,type AssignmentRecord} from '../src/store.js';
import {scorecardOperation,checkMilestone,linkMilestone,recordWorkflowActivity} from '../src/scorecard.js';
import type {WorkflowRecord} from '../src/workflow.js';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'pdm-score-'));let s=await MetadataStore.open(join(dir,'m.sqlite'));
 const t:WorkflowRecord={id:'w',projectId:'p',threadId:'t',objective:'Test',roadmap:'M1',state:'active',assignments:[],submissions:[],createdAt:1,updatedAt:1};
 s.insertProject({id:'p',name:'p',path:dir,origin:'created',requestId:'p',createdAt:1,updatedAt:1});s.setWorkflowControl('workflow:w',t);
 let n=0;
 const call=(m:string,p:Record<string,any>={},requestId=String(++n))=>scorecardOperation(s,m,{id:'w',...p,requestId});
 const add=(id:string,state:AssignmentRecord['state']='accepted',parentId:string|null=null)=>{
  const a:AssignmentRecord={id,projectId:'p',sessionId:null,conversationId:null,requestId:id,state,acceptanceCriteria:'Tests',submissionId:null,payloadHash:'hash',parentId,task:'Test',attemptCount:1,deadlineAt:null,stopReason:null,leasePath:null,evidence:null,reviewNote:null,reviewedAt:null,error:null,createdAt:Date.now(),updatedAt:Date.now()};
  s.insertAssignment(a);t.assignments.push(id);s.setWorkflowControl('workflow:w',t);return a;
 };
 return {get s(){return s},t,call,add,restart:async()=>{s.close();s=await MetadataStore.open(join(dir,'m.sqlite'));},close:async()=>{s.close();await rm(dir,{recursive:true,force:true});}};
}
test('legacy history is factual, not a made-up percentage or zero Codex effort',async()=>{
 const f=await fixture();try{f.add('a');f.add('b','revision_requested');const r=f.call('scorecard.read');assert.equal(r.scope.piShare,null);assert.equal(r.codex.reportedSeconds,null);assert.equal(r.assignments.accepted,1);assert.equal(r.assignments.revisions,1);assert.equal(r.assignments.unmapped,2);assert.deepEqual(r.trends,[]);}finally{await f.close();}
});
test('prospective weights, lineage, corrections and partial time survive replay and restart',async()=>{
 const f=await fixture();try{
 const plan={milestoneId:'m1',title:'First deliverable',points:3};const p=f.call('scorecard.plan',plan,'plan');assert.deepEqual(f.call('scorecard.plan',plan,'plan'),p);assert.throws(()=>f.call('scorecard.plan',{...plan,points:7},'plan'),/payload|different|conflict/i);
 const first=f.add('a','revision_requested');linkMilestone(f.s,f.t,{milestoneId:'m1'},first);const child=f.add('b','accepted','a');
 recordWorkflowActivity(f.s,f.t,'review-a','revision_guidance','Fix count','a');recordWorkflowActivity(f.s,f.t,'review-a','revision_guidance','Fix count','a');
 recordWorkflowActivity(f.s,f.t,'answer-b','product_decision','Preserve order','b');
 const effort={category:'review',assignmentId:'b',note:'Independent tests',activeSeconds:60};f.call('scorecard.activity',effort,'effort');f.call('scorecard.activity',effort,'effort');
 f.call('scorecard.accept',{milestoneId:'m1',owner:'pi',assignmentId:child.id,note:'Reviewed',evidence:'Test log + source SHA'},'accept');
 await f.restart();const r=f.call('scorecard.read');assert.equal(r.scope.piShare,1);assert.equal(r.scope.piPoints,3);assert.equal(r.codex.total,3);assert.equal(r.codex.reportedSeconds,60);assert.equal(r.codex.timedEntries,1);assert.equal(r.firstReview.accepted,0);assert.equal(r.firstReview.total,1);assert.equal(r.trends[0].steering,1);assert.equal(r.trends[0].productDecisions,1);assert.equal(r.assignments.unmapped,0);
 assert.throws(()=>checkMilestone(f.s,f.t,{milestoneId:'m1'}),/unfinished/);
 assert.throws(()=>checkMilestone(f.s,f.t,{parentId:'b'}),/unfinished/);
 }finally{await f.close();}
});
test('acceptance fences unreviewed work and direct Codex repairs cannot count as Pi-only',async()=>{
 const f=await fixture();try{
 f.call('scorecard.plan',{milestoneId:'m',title:'Fix',points:2});const a=f.add('a','needs_review');linkMilestone(f.s,f.t,{milestoneId:'m'},a);
 const accept={milestoneId:'m',owner:'pi',assignmentId:'a',note:'Read evidence',evidence:'Tests'};
 assert.throws(()=>f.call('scorecard.accept',accept),/review/i);
 f.s.updateAssignment('a',{state:'accepted'});
 f.call('scorecard.activity',{category:'repair',assignmentId:'a',note:'Codex corrected bug'});
 assert.throws(()=>f.call('scorecard.accept',accept),/mixed/);
 f.call('scorecard.accept',{...accept,owner:'mixed'});assert.equal(f.call('scorecard.read').scope.mixedPoints,2);
 assert.throws(()=>f.call('scorecard.activity',{category:'repair',assignmentId:'other',note:'wrong task'}),/outside/);
 assert.throws(()=>f.call('scorecard.activity',{category:'review',note:'bad time',activeSeconds:-1}),/seconds/);
 }finally{await f.close();}
});
test('late repair disclosure adjusts attribution; extra requests cannot accept twice; full ledger pages are lossless',async()=>{
 const f=await fixture();try{
 f.call('scorecard.plan',{milestoneId:'m',title:'Done',points:1});const a=f.add('a');linkMilestone(f.s,f.t,{milestoneId:'m'},a);
 const accept={milestoneId:'m',owner:'pi',assignmentId:'a',note:'Reviewed',evidence:'Log'};f.call('scorecard.accept',accept,'accept');f.call('scorecard.accept',accept,'accept');assert.throws(()=>f.call('scorecard.accept',accept,'again'),/already/);
 f.call('scorecard.activity',{category:'repair',milestoneId:'m',note:'Late disclosure',retrospective:true});
 for(let i=0;i<80;i++)f.call('scorecard.activity',{category:'planning',note:'Planning '+i});
 const r=f.call('scorecard.read');assert.equal(r.scope.piShare,0);assert.equal(r.scope.mixedPoints,1);assert.equal(r.ledgerCount,81);assert.equal(r.ledger.length,30);
 let before: number|undefined,ids:string[]=[];do{const page=f.call('scorecard.ledger',{before,limit:25});ids.push(...page.entries.map((e:any)=>e.id));before=page.nextBefore??undefined;}while(before!==undefined);assert.equal(ids.length,81);assert.equal(new Set(ids).size,81);
 }finally{await f.close();}
});
test('milestone trend compares separate accepted scopes, cancels are not revisions, and task boundaries hold',async()=>{
 const f=await fixture();try{
 for(const [id,points] of [['m1',3],['m2',2]] as const)f.call('scorecard.plan',{milestoneId:id,title:id,points});
 const a=f.add('a','cancelled');linkMilestone(f.s,f.t,{milestoneId:'m1'},a);const b=f.add('b','accepted','a');
 f.call('scorecard.accept',{milestoneId:'m1',owner:'pi',assignmentId:b.id,note:'Accepted',evidence:'Log'});
 f.call('scorecard.activity',{milestoneId:'m2',category:'implementation',note:'Codex wrote second slice'});
 f.call('scorecard.accept',{milestoneId:'m2',owner:'codex',note:'Reviewed direct work',evidence:'Diff/tests'});
 const r=f.call('scorecard.read');assert.equal(r.scope.piShare,0.6);assert.equal(r.scope.completion,1);assert.equal(r.trends[0].revisions,0);assert.equal(r.trends[0].firstReview,true);assert.equal(r.trends[1].firstReview,null);
 assert.throws(()=>checkMilestone(f.s,f.t,{milestoneId:'missing'}),/planned/);
 f.s.setWorkflowControl('workflow:other',{...f.t,id:'other',assignments:[],submissions:[]});assert.equal(f.call('scorecard.read',{id:'other'}).assignments.total,0);
 }finally{await f.close();}
});

test('Mac Chrome renders evidence, trend and ledger safely at narrow widths',{skip:process.env.PDM_HOST_BROWSER_TEST!=='1'},async()=>{
 const {chromium}=await import('playwright-core');const {startTerminalBrowser}=await import('../src/native-terminal-browser.js');
 const f=await fixture();let browser:any,app:any;
 try{
  f.call('scorecard.plan',{milestoneId:'m',title:'Counter <script>window.bad=1</script>',points:3});const a=f.add('a');linkMilestone(f.s,f.t,{milestoneId:'m'},a);
  f.call('scorecard.activity',{category:'product_decision',assignmentId:'a',note:'Preserve order <img onerror="window.bad=1">'});
  f.call('scorecard.accept',{milestoneId:'m',owner:'pi',assignmentId:'a',note:'Tests passed',evidence:'Fixture source'});
  for(let i=0;i<80;i++)f.call('scorecard.activity',{category:'planning',note:'Historical note '+i});
  app=await startTerminalBrowser({stateDir:tmpdir(),rpc:{async call<T>(method:string,p:any={}):Promise<T>{
    if(method==='workflow.status')return {workflow:f.t,assignments:[{...a,latestActivity:null}],events:[],manager:{enabled:false}} as T;
    if(method==='workflow.assignments')return {assignments:[{...a,number:1}],selected:a.id,total:1,nextBefore:null,roadmap:''} as T;
    if(method==='projects.show')return {name:'Scorecard fixture',path:'/fixture'} as T;
    if(method==='assignments.list')return {assignments:[a]} as T;
    if(method==='activity.list')return {entries:[],nextCursor:0} as T;
    if(method==='scorecard.read')return f.call(method) as T;
    throw Error(method);
  }}});
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:650,height:1000}}),errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.goto(app.url+'/?workflowId=w');await page.getByText('Details and measurements',{exact:true}).click();await page.locator('#score-stats').getByText('100%',{exact:true}).waitFor();
  assert.match(await page.locator('#score-trend').innerText(),/Counter <script>/);
  await page.locator('#score-ledger-title').click();assert.equal(await page.locator('#score-ledger li').count(),30);assert.match(await page.locator('#score-ledger-title').innerText(),/81 recorded/);
  assert.equal(await page.evaluate('window.bad'),undefined);
  await page.setViewportSize({width:390,height:850});assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await app?.close();await f.close();}
});
