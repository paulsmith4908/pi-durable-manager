import { PiClient } from './client.js';
import { packageVersion } from './version.js';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Terminal } from '@earendil-works/pi-tui';
import { connectObserver, observeWorker, readAssignmentSummary, observerError, terminalText, type ObserverRpc, type PiWorkerDisplay } from './native-terminal.js';
import { readTerminalOverview } from './terminal-overview.js';
import { assignmentLabels, assignmentStateLabel } from './assignment-labels.js';
import { recordedHistory } from './recorded-history.js';
import { TERMINAL_HTML } from './terminal-page.js';

/** Bridges the real Pi TUI's VT output, not HTML message imitations, into xterm. */
export class BrowserTerminal implements Terminal {
  kittyProtocolActive = false;
  private resizeHandler: () => void = () => {};
  constructor(public columns: number, public rows: number, private readonly output: (data: string) => void) {}
  start(_input: (data: string) => void, resize: () => void): void { this.resizeHandler = resize; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output(data); }
  resize(columns: number, rows: number): void { this.columns = columns; this.rows = rows; this.resizeHandler(); }
  moveBy(lines: number): void { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? 'A' : 'B'}`); }
  hideCursor(): void { this.write('\x1b[?25l'); }
  showCursor(): void { this.write('\x1b[?25h'); }
  clearLine(): void { this.write('\x1b[2K'); }
  clearFromCursor(): void { this.write('\x1b[J'); }
  clearScreen(): void { this.write('\x1b[2J\x1b[H'); }
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(): void {}
}
function dimension(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? fallback : Number(raw); if (!Number.isInteger(n) || n < min || n > max) throw new RangeError('Invalid terminal dimensions'); return n;
}
interface View { terminal: BrowserTerminal; controller: AbortController; response: ServerResponse; display?: PiWorkerDisplay; }
export async function startTerminalBrowser(options: { stateDir: string; port?: number; assignmentId?: string; socketPath?: string; rpc?: ObserverRpc }): Promise<{ server: Server; url: string; operatorUrl: string; close(): Promise<void> }> {
  const ownConnection = options.rpc ? null : await connectObserver(options.stateDir, options.socketPath);
  // A test-supplied caller is still narrowed inside observeWorker and here.
  const { readOnlyRpc } = await import('./native-terminal.js');
  const rpc = readOnlyRpc(options.rpc ?? ownConnection!.rpc);
  const require = createRequire(import.meta.url);
  const xterm = require.resolve('@xterm/xterm'), fit = require.resolve('@xterm/addon-fit');
  const assets = new Map([
    ['/xterm.js', { type: 'text/javascript', bytes: await readFile(xterm) }],
    ['/fit.js', { type: 'text/javascript', bytes: await readFile(fit) }],
    ['/xterm.css', { type: 'text/css', bytes: await readFile(join(dirname(xterm), '../css/xterm.css')) }],
  ]);
  // A private manager/operator capability is never exposed by a public route.
  // Origin and CSRF checks protect browsers, not worker subprocesses with network access.
  const operatorToken = randomBytes(32).toString('hex');
  const settingsToken=randomUUID();
  const authorized = (value: string | undefined): boolean => {
    const actual = Buffer.from(value ?? ''), expected = Buffer.from('Bearer ' + operatorToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const settingsCall=async(method:string,params:Record<string,unknown>)=>{if(options.rpc)return options.rpc.call(method,params);const client=await PiClient.connect({stateDir:options.stateDir,socketPath:options.socketPath,timeoutMs:70000});try{return await client.call(method,params);}finally{client.close();}};
  const maxViews = 8; let attaching = 0;
  const views = new Map<string, View>(); const instance = randomUUID(); let origin = '';
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown): void => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Loopback terminal only' });
    const settingsUrl=new URL(req.url??'/',origin);
    if(settingsUrl.pathname==='/settings'){
      if (!authorized(req.headers.authorization)) return json(403, { error: 'Settings requires the private operator link from Codex. Reconnect Pi to reopen it.' });
      try {
        if(req.method==='GET'){
          const workflowId=settingsUrl.searchParams.get('workflowId');
          const projectId=workflowId?(await rpc.call<any>('workflow.status',{id:workflowId})).workflow.projectId:undefined;
          return json(200,{...await settingsCall('models.settings',{...(projectId?{projectId}:{})}) as any,permissions:await settingsCall('permissions.read',projectId?{projectId}:{}),csrf:settingsToken});
        }
        if(req.method!=='POST')return json(405,{error:'Use GET or POST'});
        if(req.headers.origin!==origin||req.headers['x-pi-settings']!==settingsToken||req.headers['content-type']!=='application/json')return json(403,{error:'Open Settings in this Pi panel'});
        let body='';for await(const chunk of req){body+=chunk.toString('utf8');if(Buffer.byteLength(body)>32768)return json(413,{error:'Settings request too large'});}
        const input=JSON.parse(body),allowed=['connection.add','connection.rotate','connection.disable','connection.rename','profile.add','default','project','discover','test','permissions.set'];
        if(!allowed.includes(input.action)||!input.params||typeof input.params!=='object'||Array.isArray(input.params))return json(400,{error:'Unknown settings action'});
        const result=await settingsCall(input.action==='permissions.set'?'permissions.set':'models.'+input.action,input.params);return json(200,result);
      }catch(e){return json(400,{error:e instanceof Error?e.message:'Settings request failed'});}
    }
    if (req.method !== 'GET'  && req.method !== 'HEAD') return json(405, { error: 'Read-only observer' });
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname === '/') { res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); res.end(TERMINAL_HTML); return; }
    const asset = assets.get(url.pathname); if (asset) { res.writeHead(200, { ...headers, 'Content-Type': asset.type }); res.end(asset.bytes); return; }
    try {
      if (url.pathname === '/history') {
        const html=await recordedHistory(rpc,url);
        res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8'});res.end(req.method==='HEAD'?undefined:html);return;
      }
      if (url.pathname === '/overview') return json(200, await readTerminalOverview(rpc, url.searchParams.get('workflowId'), url.searchParams.get('assignmentId') ?? options.assignmentId));
      if (url.pathname === '/assignments') {
        const workflowId=url.searchParams.get('workflowId');
        if(workflowId && url.searchParams.get('history')==='1') {
          const before=url.searchParams.get('before');
          const page=await rpc.call<any>('workflow.assignments',{id:workflowId,...(before!==null?{before:Number(before)}:{}),limit:20});
          const labels=assignmentLabels(page.roadmap??'');
          return json(200,{...page,roadmap:undefined,assignments:page.assignments.map((a:any)=>{
            const title=labels.get(a.id)||`Assignment ${a.number}`;
            return {...a,title,label:`${title} · ${assignmentStateLabel(a.state)}`};
          })});
        }
        const task=workflowId ? await rpc.call<any>('workflow.status',{id:workflowId}) : null;
        const list: { assignments: Record<string, any>[] } = task ? {assignments:task.assignments} : await rpc.call<{ assignments: Record<string, any>[] }>('assignments.list');
        // Workflow order is submission order. Reviewing an old assignment updates
        // its timestamp but must never make that history the current worker.
        const order: string[] = task?.workflow.assignments ?? [];
        const ordered = [...list.assignments].sort((a, b) => task
          ? order.indexOf(b.id) - order.indexOf(a.id)
          : (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt));
        const current = ordered.find(a => a.leaseHeld || ['running', 'queued'].includes(a.state)) ?? ordered[0];
        const labels = assignmentLabels(task?.workflow.roadmap ?? '');
        const rows = ordered.slice(0, 50).map((a, index) => {
          const number = task ? order.indexOf(a.id) + 1 : ordered.length - index;
          const title = labels.get(a.id) || `Assignment ${number}`;
          return { id: a.id, sessionId: a.sessionId, projectId: a.projectId, state: a.state,
            title, label: `${title} · ${assignmentStateLabel(a.state)}` };
        });
        return json(200, { assignments: rows, selected: (!task && options.assignmentId) || current?.id || null });
      }
      if (url.pathname === '/status') return json(200, { renderer: 'actual Pi TUI 1.4.0', pid:process.pid, stateDir:options.stateDir, instance, packageVersion:packageVersion(), readOnly: true, maxViews, attaching, views: [...views.values()].map(v => v.display?.describe() ?? { state: 'attaching' }) });
      if (url.pathname === '/view') {
        const view = views.get(url.searchParams.get('id') ?? ''); if (!view) return json(404, { error: 'Display detached' });
        const action = url.searchParams.get('action');
        if (action) {
          if (!['up', 'down', 'home', 'end', 'tools'].includes(action)) return json(400, { error: 'Unsupported display action' });
          view.display?.action(action);
        } else view.terminal.resize(dimension(url.searchParams.get('cols'), 80, 20, 240), dimension(url.searchParams.get('rows'), 30, 10, 100));
        return json(200, { readOnly: true });
      }
      if (url.pathname !== '/events') return json(404, { error: 'Unknown route' });
      if (req.method === 'HEAD') return json(200, { readOnly: true });
      const assignmentId = url.searchParams.get('assignmentId') ?? options.assignmentId;
      if (!assignmentId || !/^pdm-a-[a-f0-9-]{36}$/.test(assignmentId)) return json(400, { error: 'Choose an existing assignment' });
      const cols = dimension(url.searchParams.get('cols'), 80, 20, 240), rows = dimension(url.searchParams.get('rows'), 30, 10, 100);
      // Validate before streaming; this call never creates or resumes anything.
      // Reserve before awaiting RPC: concurrent attachments cannot exceed the bound.
      if (views.size + attaching >= maxViews) {
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
        res.end(`event: failure\ndata: ${JSON.stringify('Display capacity reached. Close unused Pi panes; this pane will retry. Workers are unaffected.')}\n\n`);
        return;
      }
      attaching++;
      try { await readAssignmentSummary(rpc, assignmentId); }
      finally { attaching--; }
      if (res.destroyed) return;
      const id = randomUUID(), controller = new AbortController();
      res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      const send = (type: string, value: unknown): void => {
        if (res.destroyed || controller.signal.aborted) return;
        // Disconnect a slow reader instead of retaining an unbounded output queue.
        if (res.writableLength > 1024 * 1024) { controller.abort(); res.destroy(); return; }
        res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      };
      const terminal = new BrowserTerminal(cols, rows, text => send('output', text));
      const view: View = { terminal, controller, response: res }; views.set(id, view); send('attached', { id, assignmentId, readOnly: true });
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': display alive\n\n'); }, 10000);
      res.on('close', () => { clearInterval(heartbeat); controller.abort(); views.delete(id); });
      void observeWorker({ rpc, terminal, stateDir: options.stateDir, assignmentId, signal: controller.signal, onDisplay: d => { view.display = d; } })
        .catch(error => send('failure', observerError(error).message))
        .finally(() => { clearInterval(heartbeat); views.delete(id); res.end(); });
    } catch (error) { const detail = observerError(error); json(error instanceof RangeError ? 400 : 503, { error: error instanceof RangeError ? 'Invalid display parameters' : detail.message, code: detail.code }); }
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); }); }
  catch (e) { ownConnection?.close(); throw e; }
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, url: origin, operatorUrl: origin + '/#operator=' + operatorToken, async close() { for (const v of views.values()) { v.controller.abort(); v.response.end(); } views.clear(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); ownConnection?.close(); } };
}

