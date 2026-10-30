import test from 'node:test';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TuiAltScreen, visibleWidth } from '@earendil-works/pi-tui';
import { loadPiUi, PiWorkerDisplay, observeWorker, readOnlyRpc, readAssignmentSummary, readActivityPage, recentActivityCursor, observerError, terminalText, packageRoot, type ObserverRpc } from '../src/native-terminal.js';
import { BrowserTerminal, startTerminalBrowser } from '../src/native-terminal-browser.js';
import type { ActivityEntry } from '../src/activity.js';
import { TERMINAL_HTML } from '../src/terminal-page.js';

test('Latest leaves history and follows continuations, including an in-flight refresh and reconnect', async () => {
  const script = TERMINAL_HTML.match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  const makeNode = (): any => ({ textContent: '', hidden: false, dataset: {}, children: [], value: '',
    replaceChildren() { this.children = []; }, append(...items: any[]) { this.children.push(...items); },
    addEventListener() {}, setAttribute() {}, focus() {} });
  const nodes: any = new Proxy({}, { get(target: any, key: string) { return target[key] ??= makeNode(); } });
  const handlers: any = {}, requests: string[] = [];
  let current = 'a', poll: any, pending: (() => void) | null = null, gate: Promise<void> | null = null, scrolls = 0;
  const doc: any = { visibilityState: 'visible', getElementById: (id: string) => nodes[id], createElement: makeNode,
    addEventListener: (type: string, fn: any) => handlers[type] = fn };
  class Source {
    static instances: Source[] = []; closed = false; listeners: any = {};
    constructor(public url: string) { Source.instances.push(this); }
    close() { this.closed = true; }
    addEventListener(t: string, f: any) { this.listeners[t] = f; }
    emit(t: string, data: any) { this.listeners[t]?.({ data: JSON.stringify(data) }); }
  }
  class Term { cols = 80; rows = 30; loadAddon() {} open() {} reset() {} write() {} scrollToBottom() { scrolls++; } }
  const context = { Terminal: Term, FitAddon: { FitAddon: class { fit() {} } }, ResizeObserver: class { observe() {} },
    EventSource: Source, document: doc, window: { addEventListener: (t: string, fn: any) => handlers[t] = fn },
    location: { search: '?workflowId=w', hash: '#terminal' }, URLSearchParams,
    fetch: async (url: string) => {
      requests.push(url);
      if (url.startsWith('/assignments') && gate) await gate;
      return { ok: true, json: async () => url.startsWith('/overview')
        ? { status: 'Working', waiting: [], milestones: [], history: [], observedAt: 1 }
        : { assignments: ['a', 'b', 'c'].map(id => ({ id, state: id === current ? 'running' : 'accepted' })), selected: current } };
    }, setTimeout: () => 0, clearTimeout() {}, setInterval: (f: any) => { poll = f; return 0; }, console };
  runInNewContext(script, context);
  await new Promise(r => setImmediate(r));
  const last = () => Source.instances.at(-1)!;
  assert.match(last().url, /assignmentId=a/);
  current = 'b'; await poll();
  assert.match(last().url, /assignmentId=b/);
  assert.ok(Source.instances[0]!.closed, 'prior worker stream closes on continuation');
  nodes.assignment.value = 'a'; nodes.assignment.onchange();
  assert.match(nodes['follow-state'].textContent, /Viewing history/);
  current = 'c'; await poll();
  assert.match(last().url, /assignmentId=a/, 'history remains intentionally inspectable');

  // Latest arrives while a status request is outstanding. It must join that
  // refresh, not race an old reply or require another polling interval.
  gate = new Promise<void>(resolve => { pending = resolve; });
  const inFlight = poll();
  const latest = nodes.end.onclick();
  pending!(); gate = null;
  await Promise.all([inFlight, latest]);
  assert.match(last().url, /assignmentId=c/);
  assert.match(nodes['follow-state'].textContent, /Following current worker/);
  last().emit('attached', { id: 'live-view' });
  await nodes.end.onclick();
  assert.ok(requests.includes('/view?id=live-view&action=end'));
  assert.ok(scrolls > 0);
  const count = Source.instances.length;
  await poll();
  assert.equal(Source.instances.length, count, 'unchanged current worker must not reattach every poll');

  doc.visibilityState = 'hidden'; handlers.visibilitychange();
  assert.ok(last().closed);
  current = 'b'; doc.visibilityState = 'visible'; handlers.visibilitychange();
  await new Promise(r => setImmediate(r));
  assert.match(last().url, /assignmentId=b/, 'returning to the pane retains live-follow mode');
  handlers.beforeunload();
  assert.ok(Source.instances.every(s => s.closed));
  assert.ok(requests.every(url => /^\/(assignments|overview|view)/.test(url)), 'display controls never submit or stop work');
});

const id = 'pdm-a-11111111-1111-1111-1111-111111111111', other = 'pdm-a-22222222-2222-2222-2222-222222222222';
const assignment = { id, projectId: 'project-1', sessionId: 'existing-session', task: 'Existing task only', state: 'accepted', createdAt: 1 };
const event = (seq: number, kind: string, data: unknown, dedupKey: string | null = null, assignmentId = id): ActivityEntry => ({ seq, kind, data, dedupKey, assignmentId, at: 1, projectId: 'project-1', requestId: null });
function fixture() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rpc: ObserverRpc = { async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    calls.push({ method, params }); let value: unknown;
    if (method === 'service.capabilities') value = { methods: ['activity.list'] };
    else if (method === 'service.status') value = { pid: 123, model: 'configured-model' };
    else if (method === 'assignments.list') value = { assignments: [assignment] };
    else if (method === 'assignments.show') throw Error('Unbounded assignment detail must never be used by a viewer');
    else if (method === 'projects.show') value = { id: 'project-1', name: 'Existing project', path: '/existing/project' };
    else if (method === 'activity.list') value = Number(params.after) === 0 ? { entries: [event(1, 'worker.message', { text: 'Actual recorded worker text' })], nextCursor: 1 } : { entries: [], nextCursor: 1 };
    else if (method === 'supervision.status') value = { snapshots: [] };
    else if (method === 'manager.status') value = { pending: 0, unacked: 0 };
    else throw Error('Unexpected RPC ' + method);
    return value as T;
  } };
  return { rpc, calls };
}

test('observer refuses agent creation, steering, cancellation and wake mutations before transport', async () => {
  const f = fixture(), rpc = readOnlyRpc(f.rpc);
  for (const method of ['sessions.create', 'assignments.submit', 'assignments.cancel', 'sessions.steer', 'manager.bind', 'manager.ack', 'activity.note', 'service.shutdown']) await assert.rejects(() => rpc.call(method), /refuses/);
  assert.equal(f.calls.length, 0);
});

test('large assignment evidence is never fetched by the display; oversized journal pages retry without gaps', async () => {
  const detail = { ...assignment, evidence: 'x'.repeat(2 * 1024 * 1024) };
  const calls: { method: string; after?: number; limit?: number }[] = [];
  const rpc: ObserverRpc = { async call<T>(method: string, params: any = {}): Promise<T> {
    calls.push({ method, after: params.after, limit: params.limit });
    const value = method === 'assignments.show' ? detail : method === 'assignments.list' ? { assignments: [assignment] }
      : { entries: Array.from({ length: params.limit }, (_, n) => event(params.after + n + 1, 'worker.message', { text: 'recorded' })), nextCursor: params.after + params.limit };
    if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024 || method === 'activity.list' && params.limit > 12) {
      throw Object.assign(new Error('Response frame exceeded the client limit.'), { code: 'frame_too_large' });
    }
    return value as T;
  } };
  assert.equal((await readAssignmentSummary(rpc, id)).id, id);
  const page = await readActivityPage(rpc, 'project-1', 100);
  assert.deepEqual(page.entries.map(e => e.seq), Array.from({ length: 12 }, (_, n) => 101 + n));
  assert.equal(page.nextCursor, 112);
  assert.deepEqual(calls.filter(c => c.method === 'activity.list').map(c => [c.after, c.limit]), [[100, 50], [100, 25], [100, 12]]);
  assert.ok(!calls.some(c => c.method === 'assignments.show'));
  await assert.rejects(() => readOnlyRpc(rpc).call('assignments.show', { id }), /refuses/);
});

test('one oversized journal entry fails boundedly with an honest display error; private error text never leaks', async () => {
  const limits: number[] = [];
  const rpc: ObserverRpc = { async call<T>(_method: string, params: any): Promise<T> {
    limits.push(params.limit); throw Object.assign(Error('private transport detail'), { code: 'frame_too_large' });
  } };
  await assert.rejects(() => readActivityPage(rpc, 'p', 10), { code: 'frame_too_large' });
  assert.deepEqual(limits, [50, 25, 12, 6, 3, 1]);
  assert.match(observerError({ code: 'frame_too_large' }).message, /Display response exceeds/);
  assert.ok(!JSON.stringify(observerError(Error('private transport detail'))).includes('private transport detail'));
});

test('long-project attachment starts near the selected assignment, not unrelated history', () => {
  const checks = { snapshots: [{ assignmentId: other, activitySeq: 90000 }, { assignmentId: id, activitySeq: 14600 }] };
  assert.equal(recentActivityCursor(checks, id), 14200);
  assert.equal(recentActivityCursor(checks, 'missing'), 0);
  assert.equal(recentActivityCursor({ snapshots: [{ assignmentId: id, activitySeq: 12 }] }, id), 0);
});

test('terminal text cannot issue screen, OSC clipboard, C1 or bidi controls', () => {
  const text = terminalText('hello\x1b[2J\x1b]52;c;c2VjcmV0\x07world\u009d\u009b\u202e\r\n<script>literal</script>');
  assert.equal(text, 'helloworld\n<script>literal</script>');
  assert.equal(terminalText('x'.repeat(13000)).length, 12000);
});

test('upstream UI bundle has recorded pinned provenance and excludes agent/auth/provider code', async () => {
  const root = packageRoot(), p = JSON.parse(await readFile(join(root, 'vendor/pi-ui/provenance.json'), 'utf8'));
  assert.equal(p.version, '1.4.0');
  assert.equal(createHash('sha256').update(await readFile(join(root, 'vendor/pi-ui/components.mjs'))).digest('hex'), p.componentsSha256);
  assert.ok(!p.inputs.some((s: string) => /auth-storage|agent-session|\/pi-mcp\/|providers\//.test(s)));
  const ui = await loadPiUi(); assert.ok(new ui.UserMessageComponent('hello').render(40).join('\n').includes('hello'));
});

test('real Pi tool components correlate one result with one tool, preserve failed exit and deduplicate replay', async () => {
  const ui = await loadPiUi(), tui = new TuiAltScreen(new BrowserTerminal(80, 30, () => {}));
  const display = new PiWorkerDisplay(ui, tui, assignment, { name: 'fixture', path: '/existing/project' });
  const entries = [event(1, 'worker.tool_start', { tool: 'bash', arguments: { command: 'check' } }, `tool-start:${id}:10`), event(2, 'command.completed', { command: 'check', exitCode: 7, durationMs: 12, stdoutTail: 'FAILED' }), event(3, 'worker.tool_result', { tool: 'bash', result: { output: [{ type: 'text', text: 'FAILED' }] } }, `tool-result:${id}:10`), event(4, 'worker.message', { text: 'not our worker' }, null, other)];
  display.ingest(entries); display.ingest(entries);
  const components = display.body.children;
  assert.equal(components.filter(c => c instanceof ui.ToolExecutionComponent).length, 1);
  const rendered = components.map(c => c.render(80).join('\n')).join('\n');
  assert.ok(rendered.includes('exit 7')); assert.ok(rendered.includes('FAILED')); assert.ok(!rendered.includes('not our worker'));
  assert.ok(terminalText(rendered).includes('$ check'));
  assert.equal(display.describe().assignmentId, id); assert.equal(display.describe().sessionId, 'existing-session');
});

test('missing tool result remains pending; successful tool output is not invented', async () => {
  const ui = await loadPiUi(), tui = new TuiAltScreen(new BrowserTerminal(60, 24, () => {}));
  const display = new PiWorkerDisplay(ui, tui, assignment, { name: 'fixture', path: '/existing/project' });
  display.ingest([event(1, 'worker.tool_start', { tool: 'bash', arguments: { command: 'long command' } }, `tool-start:${id}:10`)]);
  const text = display.body.render(60).join('\n'); assert.ok(text.includes('long command')); assert.ok(!text.includes('exit 0')); assert.ok(!text.includes('Elapsed'));
  const uiHint = new ui.ToolExecutionComponent('read', 'hint', { path: 'AGENTS.md' }, { showImages: false }, ui.readRenderers, tui, '/existing/project');
  uiHint.setArgsComplete(); assert.ok(terminalText(uiHint.render(60).join('\n')).includes('ctrl+o'));
});

test('real Pi viewport reserves a visible status footer at narrow and wide terminal sizes', async () => {
  const ui = await loadPiUi();
  for (const [cols, rows] of [[35, 20], [60, 30], [100, 40]]) {
    const terminal = new BrowserTerminal(cols!, rows!, () => {}), tui = new TuiAltScreen(terminal, false);
    const display = new PiWorkerDisplay(ui, tui, assignment, { name: 'fixture', path: '/existing/project/with/a/long/path/to/wrap' });
    display.ingest([event(1, 'worker.message', { text: 'long transcript line\n'.repeat(100) })]);
    tui.start();
    try {
      display.updateStatus({ model: 'long-configured-model-name', pid: 123 }, assignment, { snapshots: [] }, { pending: 0, unacked: 0 }, { phase: 'healthy', nextCheckAt: Date.now() + 10000 });
      tui.renderNow(true);
      const lines = tui.getScreenLines();
      assert.equal(lines.length, rows); assert.ok(lines.every(line => visibleWidth(line) <= cols!));
      assert.ok(lines.slice(-5).join('\n').includes('guard healthy'));
      assert.ok(lines.at(-1)?.includes('Read-only'));
    } finally { tui.stop({ preserveScreen: true }); }
  }
});

test('observer follows existing IDs and reconnects reads without starting work', async () => {
  const f = fixture(), controller = new AbortController(), state = await mkdtemp(join(tmpdir(), 'pi-observe-'));
  let output = '', display: PiWorkerDisplay | undefined;
  const terminal = new BrowserTerminal(70, 28, s => { output += s; });
  let failedOnce = false;
  const flaky: ObserverRpc = { async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'activity.list' && Number(params.after) > 0 && !failedOnce) { failedOnce = true; throw Error('fixture read disconnected'); }
    return f.rpc.call<T>(method, params);
  } };
  const task = observeWorker({ rpc: flaky, terminal, stateDir: state, assignmentId: id, signal: controller.signal, onDisplay: d => { display = d; } });
  try {
    for (let i = 0; i < 700 && f.calls.filter(c => c.method === 'manager.status').length < 2; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(display?.describe().assignmentId, id); assert.ok(f.calls.some(c => c.method === 'activity.list'));
    assert.ok(failedOnce); assert.ok(f.calls.filter(c => c.method === 'manager.status').length >= 2);
    assert.ok(output.includes('Actual recorded worker text')); assert.equal(display?.describe().state, 'accepted');
    assert.ok(f.calls.every(c => ['service.capabilities', 'service.status', 'projects.show', 'assignments.show', 'assignments.list', 'activity.list', 'supervision.status', 'manager.status'].includes(c.method)));
  } finally { controller.abort(); await task; await rm(state, { recursive: true, force: true }); }
});

test('browser terminal serves genuine VT output; display controls and closing cannot submit work', async () => {
  const f = fixture(), state = await mkdtemp(join(tmpdir(), 'pi-terminal-http-'));
  const app = await startTerminalBrowser({ stateDir: state, rpc: f.rpc, assignmentId: id });
  const abort = new AbortController();
  try {
    const html = await (await fetch(app.url)).text(); assert.ok(html.includes('/xterm.js')); assert.ok(!html.includes('innerHTML'));
    assert.equal((await fetch(app.url + '/view', { method: 'POST' })).status, 405);
    assert.equal((await fetch(app.url + '/status', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(app.url + '/events?assignmentId=invalid')).status, 400);
    assert.equal((await fetch(app.url + '/events?assignmentId=' + id + '&cols=0')).status, 400);
    const stream = await fetch(app.url + '/events?assignmentId=' + id + '&cols=65&rows=25', { signal: abort.signal });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body!.getReader(); let bytes = ''; const decoder = new TextDecoder();
    for (let i = 0; i < 20 && !bytes.includes('Actual recorded worker text'); i++) { const chunk = await reader.read(); bytes += decoder.decode(chunk.value); }
    assert.ok(bytes.includes('event: output')); assert.ok(bytes.includes('Actual recorded worker text'));
    const attachment = JSON.parse(bytes.match(/event: attached\ndata: ([^\n]+)/)![1]!);
    assert.equal(attachment.assignmentId, id);
    assert.equal((await fetch(app.url + '/view?id=' + attachment.id + '&action=assignments.submit')).status, 400);
    assert.equal((await fetch(app.url + '/view?id=' + attachment.id + '&action=tools')).status, 200);
    assert.equal((await fetch(app.url + '/view?id=' + attachment.id + '&cols=35&rows=20')).status, 200);
    const status = await (await fetch(app.url + '/status')).json() as { views: { assignmentId: string; sessionId: string }[] };
    assert.equal(status.views[0]?.sessionId, 'existing-session');
    await reader.cancel(); abort.abort();
  } finally { abort.abort(); await app.close(); await rm(state, { recursive: true, force: true }); }
  assert.ok(!f.calls.some(c => /submit|steer|cancel|create|bind|ack/.test(c.method)));
});

test('more than four panes replay history; capacity is bounded across concurrent attach and slots recover',async()=>{
 const f=fixture(),app=await startTerminalBrowser({stateDir:tmpdir(),rpc:f.rpc});const readers:ReadableStreamDefaultReader<Uint8Array>[]=[];
 try{
  const responses=await Promise.all(Array.from({length:9},()=>fetch(app.url+'/events?assignmentId='+id)));
  let attached=0,limited=0;
  for(const response of responses){const reader=response.body!.getReader();readers.push(reader);let bytes='';
   while(!bytes.includes('Actual recorded worker text')&&!bytes.includes('event: failure')){const chunk=await reader.read();if(chunk.done)break;bytes+=new TextDecoder().decode(chunk.value);}
   if(bytes.includes('event: failure')){limited++;assert.match(bytes,/Display capacity reached/);}else{attached++;assert.match(bytes,/Actual recorded worker text/);}
  }
  assert.equal(attached,8);assert.equal(limited,1);
  await readers[0]!.cancel();
  for(let n=0;n<100;n++){const s:any=await(await fetch(app.url+'/status')).json();if(s.views.length===7)break;await new Promise(r=>setTimeout(r,10));}
  const response=await fetch(app.url+'/events?assignmentId='+id);const reader=response.body!.getReader();readers.push(reader);const chunk=await reader.read();assert.match(new TextDecoder().decode(chunk.value),/event: attached/);
 }finally{await Promise.all(readers.map(r=>r.cancel().catch(()=>{})));await app.close();}
 assert.ok(!f.calls.some(c=>/submit|steer|cancel|create|bind|ack/.test(c.method)));
});

test('browser releases hidden streams, preserves output on error and explicitly reconnects terminal failures',async()=>{
 const f=fixture(),app=await startTerminalBrowser({stateDir:tmpdir(),rpc:f.rpc});
 try{
  const html=await(await fetch(app.url)).text(),script=html.match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  const makeNode=():any=>({textContent:'',hidden:false,dataset:{},children:[],replaceChildren(){this.children=[]},append(...items:any[]){this.children.push(...items)},addEventListener(){},setAttribute(){},focus(){}});
  const nodes:any=new Proxy({}, {get(target:any,key:string){return target[key]??=makeNode()}});
  const handlers:any={},timers=new Map<number,()=>void>();let timerId=0,resets=0,offline=false;let poll:any;const output:string[]=[];
  const doc:any={visibilityState:'visible',getElementById:(id:string)=>nodes[id],createElement:makeNode,addEventListener:(type:string,fn:any)=>handlers[type]=fn};
  class Source{static instances:Source[]=[];closed=false;listeners:any={};onerror:any;constructor(public url:string){Source.instances.push(this)}close(){this.closed=true}addEventListener(t:string,f:any){this.listeners[t]=f}emit(t:string,data:any){this.listeners[t]?.({data:JSON.stringify(data)})}}
  class Term{cols=80;rows=30;loadAddon(){}open(){}reset(){resets++}write(t:string){output.push(t)}}
  const context:any={Terminal:Term,FitAddon:{FitAddon:class{fit(){}}},ResizeObserver:class{observe(){}},EventSource:Source,document:doc,window:{addEventListener:(t:string,f:any)=>handlers[t]=f},location:{search:'',hash:''},URLSearchParams,fetch:async(url:string)=>{if(offline)throw Error('fixture disconnected');return {ok:true,json:async()=>url.startsWith('/overview')?{status:'Assignment accepted',objective:'<script>literal task text</script>',waiting:[],milestones:[],history:[],observedAt:1}:{assignments:[assignment],selected:id}}},setTimeout:(f:()=>void)=>{timers.set(++timerId,f);return timerId},clearTimeout:(n:number)=>timers.delete(n),setInterval:(f:any)=>{poll=f;return 0},console};
  runInNewContext(script,context);await new Promise(r=>setImmediate(r));
  assert.equal(Source.instances.length,0,'Overview opens without allocating a terminal stream');assert.equal(nodes['overview-panel'].hidden,false);assert.equal(nodes['terminal-panel'].hidden,true);assert.equal(nodes.objective.textContent,'<script>literal task text</script>');
  offline=true;await poll();assert.equal(nodes.offline.hidden,false);assert.match(nodes.offline.textContent,/last recorded snapshot/);assert.equal(nodes.status.textContent,'Assignment accepted');offline=false;await poll();assert.equal(nodes.offline.hidden,true);
  nodes['terminal-tab'].onclick();assert.equal(nodes['terminal-panel'].hidden,false);
  const first=Source.instances[0]!;first.emit('attached',{id:'view-1'});first.emit('output','recorded transcript');assert.equal(resets,1);first.onerror();assert.equal(first.closed,true);assert.equal(resets,1);assert.deepEqual(output,['recorded transcript']);assert.equal(timers.size,1);
  const retry=[...timers.values()][0]!;timers.clear();retry();const second=Source.instances[1]!;second.emit('failure','Display capacity reached. Close unused Pi panes.');assert.match(nodes.state.textContent,/capacity reached.*Retrying/);assert.equal(second.closed,true);
  doc.visibilityState='hidden';handlers.visibilitychange();assert.equal(timers.size,0);assert.match(nodes.state.textContent,/workers continue/);
  doc.visibilityState='visible';handlers.visibilitychange();await new Promise(r=>setImmediate(r));const third=Source.instances[2]!;assert.ok(third);third.emit('attached',{id:'view-3'});third.emit('output','replayed transcript');assert.equal(resets,2);
  nodes['overview-tab'].onclick();assert.equal(third.closed,true);nodes['terminal-tab'].onclick();const fourth=Source.instances[3]!;assert.ok(fourth);
  handlers.pagehide();assert.equal(third.closed,true);
  handlers.pageshow();await new Promise(r=>setImmediate(r));assert.equal(Source.instances.length,5);handlers.beforeunload();
 }finally{await app.close();}
});
