import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { readTerminalOverview, roadmapMilestones, plainWork, plainWorkTone } from '../src/terminal-overview.js';
import { startTerminalBrowser } from '../src/native-terminal-browser.js';
import type { ObserverRpc } from '../src/native-terminal.js';

const id = 'pdm-a-11111111-1111-1111-1111-111111111111';
test('workflow terminal follows the live worker, then submission order, never an old review timestamp', async () => {
  const old = { id: 'old', state: 'accepted', updatedAt: 9999 };
  const current = { id: 'current', state: 'running', leaseHeld: true, updatedAt: 10 };
  const newest = { id: 'newest', state: 'cancelled', updatedAt: 20 };
  const rpc: ObserverRpc = { async call<T>(method: string): Promise<T> {
    assert.equal(method, 'workflow.status');
    return { workflow: { assignments: ['old', 'current', 'newest'] }, assignments: [old, current, newest] } as T;
  } };
  const app = await startTerminalBrowser({ rpc, stateDir: tmpdir(), assignmentId: 'old' });
  try {
    const read = async () => await (await fetch(app.url + '/assignments?workflowId=w')).json() as any;
    assert.equal((await read()).selected, 'current', 'a workflow must not inherit a standalone history pin');
    current.state = 'accepted'; current.leaseHeld = false;
    const settled = await read();
    assert.equal(settled.selected, 'newest');
    assert.deepEqual(settled.assignments.map((a: any) => a.id), ['newest', 'current', 'old']);
  } finally { await app.close(); }
});
function fixture() {
  const assignment: any = { id, projectId: 'p', state: 'running', task: 'Implement the agreed scope', updatedAt: 10 };
  const snapshot: any = {
    workflow: { id: 'w', projectId: 'p', state: 'active', objective: 'A small project', assignments: [id], roadmap: '- [x] Decide ordering\n- [~] Implement\n- [ ] Review', updatedAt: 5 },
    assignments: [{ id, latestActivity: { seq: 400, at: 20, kind: 'worker.tool_start' } }], events: [], manager: { enabled: true }, operatorPause: null,
  };
  const entries: any[] = [
    { seq: 399, at: 19, kind: 'worker.message', assignmentId: 'unrelated', data: { text: 'OTHER TASK' } },
    { seq: 400, at: 20, kind: 'worker.tool_start', assignmentId: id, data: { tool: 'bash', arguments: { command: 'python3 -m unittest' } } },
    { seq: 401, at: 21, kind: 'supervision.check', assignmentId: id, data: { text: 'observer read' } },
  ];
  const calls: any[] = [];
  const rpc: ObserverRpc = { async call<T>(method: string, params: any = {}): Promise<T> {
    calls.push({ method, params });
    if (method === 'workflow.status') { assert.equal(params.id, 'w'); return snapshot; }
    if (method === 'workflow.assignments') return {workflowId:'w',roadmap:snapshot.workflow.roadmap,total:1,before:1,nextBefore:null,selected:id,assignments:[{...assignment,number:1}]} as T;
    if (method === 'assignments.show') throw Error('Viewer must not fetch unbounded evidence');
    if (method === 'projects.show') return { name: 'Example', path: '/example' } as T;
    if (method === 'activity.list') return { entries, nextCursor: 401 } as T;
    if (method === 'assignments.list') return { assignments: [assignment] } as T;
    throw Error('Unexpected read ' + method);
  } };
  return { assignment, snapshot, entries, rpc, calls };
}

test('overview derives current work from facts and isolates this workflow’s recent activity', async () => {
  const f = fixture(), overview = await readTerminalOverview(f.rpc, 'w');
  assert.equal(overview.status, 'Working');
  assert.equal(overview.latest.at, 20);
  assert.match(overview.latest.summary, /Started bash: python3 -m unittest/);
  assert.equal(overview.history.length, 1);
  assert.ok(!JSON.stringify(overview).includes('OTHER TASK'));
  assert.equal(f.calls.find(c => c.method === 'activity.list').params.after, 200);
  assert.deepEqual(overview.milestones.map((m: any) => m.status), ['Complete', 'In progress', 'Planned']);
  assert.notEqual(overview.observedAt, overview.latest.at);
});

test('questions, review, acceptance, pause, and task completion remain distinct', async () => {
  const f = fixture();
  f.assignment.state = 'blocked';
  f.snapshot.events = [{ eventId: 'question', kind: 'manager_request', assignmentId: id, actionable: true, summary: 'Preserve order or sort?' }, { kind: 'manager_request', assignmentId: 'unrelated', actionable: true, summary: 'Unrelated' }];
  let overview = await readTerminalOverview(f.rpc, 'w');
  assert.equal(overview.status, 'Waiting for Codex');
  assert.equal(overview.waiting.length, 1);
  assert.equal(overview.waiting[0].summary, 'Preserve order or sort?');
  f.snapshot.events[0].actionable = false;
  f.assignment.state = 'needs_review';
  assert.equal((await readTerminalOverview(f.rpc, 'w')).status, 'Ready for review');
  f.assignment.state = 'accepted';
  assert.equal((await readTerminalOverview(f.rpc, 'w')).status, 'Assignment accepted');
  f.snapshot.operatorPause = { status: 'pausing' };
  assert.equal((await readTerminalOverview(f.rpc, 'w')).status, 'Pausing');
  f.snapshot.operatorPause.status = 'paused';
  assert.equal((await readTerminalOverview(f.rpc, 'w')).status, 'Paused');
  f.snapshot.workflow.state = 'complete';
  overview = await readTerminalOverview(f.rpc, 'w');
  assert.equal(overview.status, 'Complete');
  assert.equal(overview.waiting.length, 0);
  assert.equal(overview.milestones[2].status, 'Planned', 'Never invent milestone completion from runtime state');
});

test('failures and empty workflows display honestly; legacy milestone text is not guessed', async () => {
  const f = fixture(); f.assignment.state = 'failed'; f.assignment.error = 'Command was interrupted';
  assert.equal((await readTerminalOverview(f.rpc, 'w')).issue, 'Command was interrupted');
  f.snapshot.assignments = []; f.snapshot.workflow.assignments = []; f.entries.length = 0;
  const overview = await readTerminalOverview(f.rpc, 'w');
  assert.equal(overview.status, 'Awaiting assignment');
  assert.equal(overview.assignment, null); assert.equal(overview.latest, null);
  assert.deepEqual(roadmapMilestones('Milestone 1: Implement\nMilestone 2: Review'), [{ title: 'Implement', status: 'Status not recorded' }, { title: 'Review', status: 'Status not recorded' }]);
  assert.deepEqual(roadmapMilestones('A prose-only roadmap'), []);
});

test('overview endpoint remains read-only, does not allocate a terminal, and rejects cross-origin reads', async () => {
  const f = fixture(), app = await startTerminalBrowser({ rpc: f.rpc, stateDir: tmpdir() });
  try {
    const overview = await (await fetch(app.url + '/overview?workflowId=w')).json() as any;
    assert.equal(overview.status, 'Working');
    const status = await (await fetch(app.url + '/status')).json() as any;
    assert.equal(status.views.length, 0);
    assert.equal((await fetch(app.url + '/overview?workflowId=w', { method: 'POST' })).status, 405);
    assert.equal((await fetch(app.url + '/overview?workflowId=w', { headers: { Origin: 'https://other.example' } })).status, 403);
    assert.ok(f.calls.every(c => ['workflow.status', 'assignments.list', 'projects.show', 'activity.list', 'scorecard.read'].includes(c.method)));
  } finally { await app.close(); }
});

test('overview read failure returns unavailable rather than a fabricated healthy status', async () => {
  const app = await startTerminalBrowser({ rpc: { async call() { throw Error('offline'); } }, stateDir: tmpdir() });
  try { assert.equal((await fetch(app.url + '/overview?workflowId=w')).status, 503); }
  finally { await app.close(); }
});

test('overview reports response-size failures accurately instead of claiming the daemon is offline', async () => {
  const app = await startTerminalBrowser({ rpc: { async call() { throw Object.assign(Error('sensitive internal detail'), { code: 'frame_too_large' }); } }, stateDir: tmpdir() });
  try {
    const response = await fetch(app.url + '/overview?workflowId=w');
    assert.equal(response.status, 503);
    const body = await response.json() as any;
    assert.equal(body.code, 'frame_too_large');
    assert.match(body.error, /Display response exceeds/);
    assert.ok(!JSON.stringify(body).includes('sensitive internal detail'));
  } finally { await app.close(); }
});

test('assignment picker uses explicit bounded roadmap names and stable fallback numbers', async () => {
  const rpc: ObserverRpc = { async call<T>(method: string): Promise<T> {
    assert.equal(method, 'workflow.status');
    return { workflow: { assignments: ['a', 'b', 'c'], roadmap: '- [assignment:a] M1 · Engine foundation\n- [assignment:c] M2 · Browser UI — revision 1' },
      assignments: [{id:'a',state:'accepted'}, {id:'b',state:'cancelled'}, {id:'c',state:'running',leaseHeld:true}] } as T;
  } };
  const app = await startTerminalBrowser({rpc,stateDir:tmpdir()});
  try {
    const r:any=await(await fetch(app.url+'/assignments?workflowId=w')).json();
    assert.equal(r.selected,'c');
    assert.deepEqual(r.assignments.map((a:any)=>a.label), ['M2 · Browser UI — revision 1 · Working','Assignment 2 · Ended','M1 · Engine foundation · Accepted']);
    assert.equal(r.assignments[0].id,'c');
  } finally {await app.close();}
});


test('scorecard projection failure does not mark a healthy worker offline',async()=>{
 const f=fixture();const view=await readTerminalOverview(f.rpc,'w');
 assert.equal(view.status,'Working');assert.equal(view.scorecard,null);assert.match(view.scorecardError,/unavailable/);
});


test('plain work reports evidence without provider chatter or guessed test passes',()=>{
 const event=(kind:string,data:any)=>({kind,data} as any);
 assert.equal(plainWork(event('worker.provider_request',{})),null);
 assert.equal(plainWork(event('worker.tool_start',{tool:'bash',arguments:{command:'npm test'}})),'Pi is running tests.');
 assert.equal(plainWork(event('worker.tool_result',{tool:'bash',result:{details:{exitCode:0}}})),null);
 assert.equal(plainWork(event('worker.tool_result',{result:{isError:true}})),'A Pi tool reported an error.');
 assert.equal(plainWork(event('validation.completed',{profileName:'counter',state:'failed'})),'Browser check counter failed.');
 assert.equal(plainWork(event('worker.message',{text:'I found the bug.'})),'Pi: I found the bug.');
 assert.equal(plainWork(event('codex.activity',{source:'reported',retrospective:true,note:'Historical review'})),null);
});

test('progress uses the recorded current step and shows newest work first',async()=>{
 const f=fixture();f.snapshot.workflow.roadmap='- [assignment:'+id+'] Counter: apply the title';
 f.entries.push({seq:402,at:22,kind:'worker.message',assignmentId:id,data:{text:'The title is updated.'}});
 const view=await readTerminalOverview(f.rpc,'w');assert.equal(view.currentStep,'Counter: apply the title');
 assert.equal(view.steps[0].title,'Counter: apply the title');assert.deepEqual(view.plainHistory.map((e:any)=>e.seq),[402,400]);
 assert.equal(view.plainHistory[0].text,'Pi: The title is updated.');
 assert.equal(view.plainHistory[1].tone,'check');
 f.snapshot.workflow.state='complete';assert.match((await readTerminalOverview(f.rpc,'w')).currentStep,/reviewed and accepted/);
});

test('recent work retains the latest duplicate and latest thirty entries',async()=>{
 const f=fixture();
 for(let i=0;i<35;i++)f.entries.push({seq:402+i,at:22+i,kind:'worker.message',assignmentId:id,data:{text:'Update '+i}});
 f.entries.push({seq:437,at:57,kind:'worker.message',assignmentId:id,data:{text:'Update 34'}});
 const view=await readTerminalOverview(f.rpc,'w');
 assert.equal(view.plainHistory.length,30);
 assert.equal(view.plainHistory[0].seq,437);
 assert.equal(view.plainHistory.at(-1).seq,407);
 assert.ok(view.plainHistory.every((e:any,i:number,a:any[])=>!i||a[i-1].seq>e.seq));
});

test('work colors reflect recorded checks and decisions, not optimistic worker prose',()=>{
 const event=(kind:string,data:any)=>({kind,data} as any);
 assert.equal(plainWorkTone(event('worker.message',{text:'Everything passed, complete!'})),'work');
 assert.equal(plainWorkTone(event('worker.tool_start',{tool:'bash',arguments:{command:'npm test'}})),'check');
 assert.equal(plainWorkTone(event('validation.completed',{state:'passed'})),'success');
 assert.equal(plainWorkTone(event('validation.completed',{state:'failed'})),'error');
 assert.equal(plainWorkTone(event('worker.tool_result',{result:{details:{exitCode:1}}})),'error');
 assert.equal(plainWorkTone(event('command.completed',{timedOut:true})),'error');
 assert.equal(plainWorkTone(event('manager.decision',{action:'revise'})),'attention');
 assert.equal(plainWorkTone(event('assignment.state',{state:'needs_review'})),'attention');
 assert.equal(plainWorkTone(event('manager.decision',{action:'accept'})),'success');
 assert.equal(plainWorkTone(event('worker.tool_start',{tool:'read',arguments:{path:'src/main.js'}})),'note');
});


test('Mac Chrome shows a plain progress log by default and keeps measurements optional',{skip:process.env.PDM_HOST_BROWSER_TEST!=='1'},async()=>{
 const {chromium}=await import('playwright-core');const f=fixture();f.snapshot.assignments[0].state='running';
 f.entries.push({seq:402,at:22,kind:'worker.message',assignmentId:id,data:{text:'The count now increments once. I am checking reload behavior.'}});
 const app=await startTerminalBrowser({rpc:f.rpc,stateDir:tmpdir()});let browser:any;
 try{
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:500,height:900}}),errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.goto(app.url+'/?workflowId=w');await page.waitForFunction(()=>(globalThis as any).document.getElementById('progress-now')?.textContent === 'Implement');
  assert.equal(await page.locator('#progress-now').innerText(),'Implement');
  assert.equal(await page.getByRole('tab',{name:'Progress',exact:true}).isVisible(),true);
  assert.equal(await page.locator('#progress-roadmap li').count(),3);assert.equal(await page.locator('#progress-roadmap li[data-current=true]').innerText(),'→\nImplement\nIn progress');
  assert.match(await page.locator('#work-log').innerText(),/Pi is running tests/);assert.match(await page.locator('#work-log').innerText(),/The count now increments once/);
  assert.equal(await page.locator('#scorecard').isVisible(),false);assert.equal(await page.locator('#waiting-card').isVisible(),false);
  await page.getByText('Details and measurements',{exact:true}).click();assert.equal(await page.locator('#scorecard').isVisible(),true);
  await page.getByText('Details and measurements',{exact:true}).click();
  f.assignment.state='blocked';f.snapshot.events=[{eventId:'q',kind:'manager_request',assignmentId:id,actionable:true,summary:'Should reload retain the count?'}];
  await page.locator('#waiting-list').getByText('Should reload retain the count?',{exact:true}).waitFor();assert.equal(await page.locator('#waiting-card').isVisible(),true);
  await page.setViewportSize({width:390,height:850});assert.equal(await page.evaluate(()=>(globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth),true);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await app.close();}
});

test('assignment history HTTP route uses bounded cursor reads and retains the live selection',async()=>{
 const calls:any[]=[];
 const rpc:ObserverRpc={async call<T>(method:string,p:any):Promise<T>{
  calls.push({method,p});assert.equal(method,'workflow.assignments');
  return {workflowId:'w',roadmap:'',total:120,before:p.before??120,nextBefore:80,selected:'live',assignments:[{id:'older',number:100,state:'accepted'}]} as T;
 }};
 const app=await startTerminalBrowser({rpc,stateDir:tmpdir()});try{
  const r=await fetch(app.url+'/assignments?workflowId=w&history=1&before=100'),p=await r.json() as any;
  assert.equal(r.status,200);assert.equal(p.selected,'live');assert.equal(p.nextBefore,80);assert.equal(p.assignments[0].title,'Assignment 100');
  assert.deepEqual(calls,[{method:'workflow.assignments',p:{id:'w',before:100,limit:20}}]);
 }finally{await app.close();}
});

test('recorded output pages and oversized entry chunks stay read-only and escape worker text',async()=>{
 const calls:any[]=[];
 const rpc:ObserverRpc={async call<T>(method:string,p:any={}):Promise<T>{
  calls.push({method,p});
  if(method==='assignments.list')return {assignments:[{id,projectId:'p',sessionId:'s',state:'accepted'}]} as T;
  if(method==='sessions.transcript')return {entries:p.cursor?[{id:'3',kind:'message',data:'last'}]:[{id:'1',kind:'message',data:'<script>evil()</script>'},{id:'2',kind:'message',entryId:'2',truncated:true}],nextCursor:p.cursor?null:'cursor+/?=',truncated:false} as T;
  if(method==='sessions.entry')return {offset:p.offset,chunk:'large </pre><script>bad()</script>',totalChars:90000,nextOffset:16384} as T;
  throw Error('Unexpected method '+method);
 }};
 const app=await startTerminalBrowser({rpc,stateDir:tmpdir()});try{
  const path=app.url+'/history?assignmentId='+id;
  let r=await fetch(path),html=await r.text();assert.equal(r.status,200);assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('Read the full entry in chunks'));assert.ok(html.includes('Next page'));
  r=await fetch(path+'&cursor='+encodeURIComponent('cursor+/?='));html=await r.text();assert.ok(html.includes('last'));assert.ok(!html.includes('Next page'));
  r=await fetch(path+'&entryId=2&offset=0');html=await r.text();assert.ok(html.includes('Next chunk'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('offset=16384'));
  assert.ok(calls.filter(c=>c.method==='sessions.transcript').every(c=>c.p.limit===20));assert.ok(calls.filter(c=>c.method==='sessions.entry').every(c=>c.p.maxChars===16384&&c.p.id==='s'));
  assert.equal((await fetch(path,{method:'POST'})).status,405);assert.equal((await fetch(path,{headers:{Origin:'https://other.invalid'}})).status,403);assert.equal((await fetch(path+'&entryId=-1')).status,400);
  assert.ok(calls.every(c=>['assignments.list','sessions.transcript','sessions.entry'].includes(c.method)));
 }finally{await app.close();}
});
