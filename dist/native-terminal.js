/** A display client only. These imports contain no AgentSession or model runtime. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Container, Text, ScrollView, VStack, TuiAltScreen, ProcessTerminal, matchesKey, truncateToWidth, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
import { PiClient } from './client.js';
export const OBSERVER_METHODS = new Set(['service.capabilities', 'service.status', 'projects.show', 'assignments.list', 'activity.list', 'supervision.status', 'manager.status', 'workflow.status', 'workflow.assignments', 'sessions.model', 'sessions.transcript', 'sessions.entry', 'scorecard.read']);
export function readOnlyRpc(rpc) {
    return { async call(method, params = {}) {
            if (!OBSERVER_METHODS.has(method))
                throw new Error(`Observer refuses mutating/unsupported method: ${method}`);
            return rpc.call(method, params);
        } };
}
/** Never fetch assignment detail: it embeds the entire growing evidence bundle. */
export async function readAssignmentSummary(rpc, id, projectId) {
    const list = await rpc.call('assignments.list', projectId ? { projectId } : {});
    const assignment = list.assignments.find(a => a.id === id);
    if (!assignment)
        throw Object.assign(new Error('Assignment no longer available'), { code: 'not_found' });
    return assignment;
}
/** A large journal page is retried at the SAME cursor; never skip recorded output. */
export async function readActivityPage(rpc, projectId, after) {
    let limit = 50;
    for (;;) {
        try {
            return await rpc.call('activity.list', { projectId, after, limit });
        }
        catch (error) {
            if (error?.code !== 'frame_too_large' || limit === 1)
                throw error;
            limit = Math.max(1, Math.floor(limit / 2));
        }
    }
}
export function recentActivityCursor(checks, assignmentId) {
    const seq = checks.snapshots?.find((s) => s.assignmentId === assignmentId)?.activitySeq;
    return Number.isSafeInteger(seq) && seq > 400 ? seq - 400 : 0;
}
/** Only fixed messages/codes reach the UI; raw transport errors may contain private paths. */
export function observerError(error) {
    const code = error?.code;
    if (code === 'frame_too_large')
        return { code, message: 'Display response exceeds its size limit. Worker status is unknown to this view; existing work is unaffected.' };
    if (code === 'not_found')
        return { code, message: 'This assignment is no longer available to the display.' };
    if (code === 'timeout')
        return { code, message: 'Display read timed out. Existing work is unaffected; retrying reads.' };
    return { code: 'display_read_failed', message: 'Display could not read Pi status. This does not establish that the worker stopped; retrying reads.' };
}
export function packageRoot() {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++, dir = dirname(dir))
        if (existsSync(join(dir, 'vendor/pi-ui/components.mjs')))
            return dir;
    throw new Error('Packaged upstream Pi UI components are missing.');
}
let uiPromise;
export function loadPiUi() {
    return uiPromise ??= (async () => {
        const root = packageRoot();
        const ui = await import(pathToFileURL(join(root, 'vendor/pi-ui/components.mjs')).href);
        setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, 'app.tools.expand': { defaultKeys: 'ctrl+o', description: 'Expand tool output' } }));
        ui.setThemeInstance(ui.loadThemeFromPath(join(root, 'vendor/pi-ui/dark.json'), 'truecolor'));
        return ui;
    })();
}
/** Worker output is text, never a terminal control channel (including clipboard OSC). */
export function terminalText(value) {
    return String(value ?? '').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[ -/]*[@-~]/g, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 12000);
}
function safeValue(value, depth = 0) {
    if (depth > 8)
        return '[bounded]';
    if (typeof value === 'string')
        return terminalText(value);
    if (Array.isArray(value))
        return value.slice(0, 32).map(v => safeValue(v, depth + 1));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).slice(0, 32).map(([k, v]) => [terminalText(k), safeValue(v, depth + 1)]));
    return value;
}
const data = (e) => e.data && typeof e.data === 'object' ? e.data : {};
function recordedRenderers(ui, name) {
    const renderers = name === 'bash' ? ui.createShellRenderers('$') : name === 'read' ? ui.readRenderers : name === 'write' ? ui.writeRenderers : undefined;
    if (!renderers)
        return undefined;
    // Upstream's live clock would start at replay time and retain interval handles.
    // Supply a display-only context: only recorded command duration is meaningful here.
    return Object.fromEntries(Object.entries(renderers).map(([key, fn]) => [key, (...args) => {
            const i = args.length - 1;
            args[i] = { ...args[i], executionStarted: false };
            return fn(...args);
        }]));
}
class StatusLines {
    value = '';
    setText(text) { this.value = text; }
    render(width) { return this.value.split('\n').map(line => truncateToWidth(line, width, '…')); }
    invalidate() { }
}
/** Reuses Pi Coding Agent's actual published message/tool components, unmodified. */
export class PiWorkerDisplay {
    ui;
    tui;
    assignment;
    project;
    body = new Container();
    header = new Text('', 1, 0);
    footer = new StatusLines();
    scroll;
    tools = new Map();
    latestTools = new Map();
    completedCommands = new WeakSet();
    pendingBash = new Map();
    expanded = false;
    shown = 0;
    seen = new Set();
    lastSeq = 0;
    state = '';
    constructor(ui, tui, assignment, project) {
        this.ui = ui;
        this.tui = tui;
        this.assignment = assignment;
        this.project = project;
        this.header.setText(ui.theme.bold('pi') + '  durable observer · actual Pi UI 1.4.0 · read-only');
        this.body.addChild(new Text(terminalText(project.name) + '\n' + terminalText(assignment.id) + '\n' + terminalText(assignment.sessionId ?? 'No session ID'), 1, 1));
        this.body.addChild(new ui.UserMessageComponent(terminalText(assignment.task ?? 'Attached to this existing worker. Recent recorded activity follows; full history remains in the durable journal.')));
        this.scroll = new ScrollView(this.body, { follow: 'end', primary: true, scrollbar: 'auto' });
        this.tui.setLayoutRoot(new VStack([{ component: this.header, shrink: 0 }, { component: this.scroll, basis: 0, grow: 1, minSize: 1 }, { component: this.footer, shrink: 0 }]));
    }
    ingest(entries) {
        for (const e of entries) {
            if (e.assignmentId !== this.assignment.id || this.seen.has(e.seq))
                continue;
            this.seen.add(e.seq);
            this.lastSeq = Math.max(this.lastSeq, e.seq);
            const d = data(e);
            let component;
            if (e.kind === 'worker.message' && d.text?.trim())
                component = new this.ui.AssistantMessageComponent({ content: [{ type: 'text', text: terminalText(d.text) }], stopReason: 'stop' }, true);
            else if (e.kind === 'worker.tool_start') {
                const name = terminalText(d.tool), args = safeValue(d.arguments);
                const key = e.dedupKey?.replace('tool-start:', '') ?? String(e.seq);
                const tool = new this.ui.ToolExecutionComponent(name, key, args, { showImages: false }, recordedRenderers(this.ui, name), this.tui, terminalText(this.project.path));
                tool.markExecutionStarted();
                tool.setArgsComplete();
                tool.setExpanded(this.expanded);
                this.tools.set(key, tool);
                this.latestTools.set(name, tool);
                if (name === 'bash') {
                    const command = String(args?.command ?? '');
                    const queue = this.pendingBash.get(command) ?? [];
                    queue.push(tool);
                    this.pendingBash.set(command, queue);
                }
                component = tool;
            }
            else if (e.kind === 'worker.tool_result') {
                const key = e.dedupKey?.replace('tool-result:', '') ?? '';
                const tool = this.tools.get(key);
                const r = d.result ?? {};
                if (tool && !this.completedCommands.has(tool)) {
                    const output = r.output ?? r.content ?? [];
                    tool.updateResult({ content: (Array.isArray(output) ? output : []).filter((p) => p.type === 'text').map((p) => ({ type: 'text', text: terminalText(p.text) })), isError: r.isError === true || typeof r.details?.exitCode === 'number' && r.details.exitCode !== 0 });
                }
            }
            else if (e.kind === 'command.completed') {
                const queue = this.pendingBash.get(String(d.command ?? ''));
                const tool = queue?.shift();
                if (tool && typeof d.exitCode === 'number') {
                    tool.updateResult({ content: [{ type: 'text', text: terminalText([d.stdoutTail, d.stderrTail, `exit ${d.exitCode} · ${d.durationMs ?? '?'} ms${d.timedOut ? ' · timed out' : ''}`].filter(Boolean).join('\n')) }], isError: d.exitCode !== 0 || d.timedOut === true, durationMs: d.durationMs });
                    this.completedCommands.add(tool);
                }
            }
            else if (e.kind === 'manager.answer') {
                component = new this.ui.UserMessageComponent(terminalText(d.answer));
            }
            else if (e.kind === 'manager.request' && ['sessions.steer', 'sessions.followup', 'workflow.answer'].includes(d.method)) {
                component = new this.ui.UserMessageComponent(terminalText(d.params?.content ?? d.params?.answer ?? 'Manager input'));
            }
            else if (e.kind === 'assignment.state' || e.kind === 'wake.recorded' || e.kind === 'manager.decision') {
                const summary = e.kind === 'assignment.state' ? `state → ${d.state ?? 'unknown'}` : e.kind === 'manager.decision' ? `manager: ${d.action ?? 'decision recorded'}` : 'manager notification recorded';
                component = new Text(this.ui.theme.fg('dim', `#${e.seq} ${new Date(e.at).toLocaleTimeString()} · ${terminalText(summary)}`), 1, 0);
            }
            if (component) {
                this.body.addChild(component);
                this.shown++;
            }
        }
        // The durable journal is not trimmed. This is only a bounded display window.
        if (this.body.children.length > 180) {
            const removed = this.body.children.splice(2, this.body.children.length - 180);
            for (const [key, tool] of this.tools)
                if (removed.includes(tool))
                    this.tools.delete(key);
            for (const [name, tool] of this.latestTools)
                if (removed.includes(tool))
                    this.latestTools.delete(name);
            for (const [command, queue] of this.pendingBash) {
                const kept = queue.filter(t => !removed.includes(t));
                if (kept.length)
                    this.pendingBash.set(command, kept);
                else
                    this.pendingBash.delete(command);
            }
        }
        if (this.seen.size > 2000)
            this.seen = new Set([...this.seen].slice(-1000));
    }
    updateStatus(service, assignment, checks, manager, guard, sessionModel = null) {
        this.state = terminalText(assignment.state ?? 'unknown');
        const check = checks.snapshots?.find((s) => s.assignmentId === this.assignment.id);
        const phase = check?.nextCheckAt ? terminalText(check.phase) : this.state;
        const guardPhase = guard && typeof guard.nextCheckAt === 'number' && Date.now() > guard.nextCheckAt + 15000 ? 'stale' : guard?.phase ?? 'unavailable';
        const next = check?.nextCheckAt ? new Date(check.nextCheckAt).toLocaleTimeString() : 'none';
        this.footer.setText(this.ui.theme.fg('dim', [
            terminalText(this.project.path),
            sessionModel?.model?.modelId ? terminalText([sessionModel.providerName, sessionModel.profileName, sessionModel.model.modelId].filter(Boolean).join(' · ')) : 'Session model unavailable',
            `guard ${guardPhase} · ${phase} · daemon ${service.pid}`,
            `next check ${next} · wakes ${manager.pending ?? '?'} pending / ${manager.unacked ?? '?'} unacked · journal #${this.lastSeq}`,
            'Read-only · PgUp/PgDn scroll · Ctrl+O tool output · prompts go through Codex',
        ].join('\n')));
        this.tui.requestRender();
    }
    error(message) { this.footer.setText(this.ui.theme.fg('error', terminalText(message) + '\nDisconnected; reconnecting. Existing workers are unaffected.')); this.tui.requestRender(); }
    action(action) {
        if (action === 'up')
            this.tui.scrollBy(-Math.max(3, this.tui.terminal.rows - 7));
        if (action === 'down')
            this.tui.scrollBy(Math.max(3, this.tui.terminal.rows - 7));
        if (action === 'home')
            this.tui.scrollToTop();
        if (action === 'end')
            this.tui.scrollToBottom();
        if (action === 'tools') {
            this.expanded = !this.expanded;
            for (const tool of this.tools.values())
                tool.setExpanded(this.expanded);
        }
        this.tui.requestRender();
    }
    describe() { return { assignmentId: this.assignment.id, sessionId: this.assignment.sessionId, projectId: this.assignment.projectId, state: this.state, lastSeq: this.lastSeq, renderedBlocks: this.shown, renderer: '@earendil-works/pi-tui@1.4.0', components: '@earendil-works/pi-coding-agent@1.4.0', readOnly: true }; }
}
export async function connectObserver(stateDir, socketPath) {
    let client;
    const rpc = readOnlyRpc({ async call(method, params = {}) {
            try {
                client ??= await PiClient.connect({ stateDir, socketPath, timeoutMs: 5000 });
                return await client.call(method, params);
            }
            catch (e) {
                client?.close();
                client = undefined;
                throw e;
            }
        } });
    return { rpc, close: () => { client?.close(); client = undefined; } };
}
export async function observeWorker(options) {
    const rpc = readOnlyRpc(options.rpc), ui = await loadPiUi();
    const caps = await rpc.call('service.capabilities');
    if (!caps.methods.includes('activity.list'))
        throw new Error('Service lacks the durable activity journal.');
    const assignment = await readAssignmentSummary(rpc, options.assignmentId);
    const project = await rpc.call('projects.show', { id: assignment.projectId });
    const actualProject = project.project ?? project;
    const tui = new TuiAltScreen(options.terminal, false, undefined, { mouse: false, copyOnSelect: false });
    const display = new PiWorkerDisplay(ui, tui, assignment, actualProject);
    options.onDisplay?.(display);
    tui.addInputListener(input => {
        if (matchesKey(input, 'ctrl+c') || input === 'q') {
            options.onQuit?.();
            return { consume: true };
        }
        if (matchesKey(input, 'ctrl+o')) {
            display.action('tools');
            return { consume: true };
        }
        return undefined;
    });
    // Start near this assignment's latest recorded activity, not at the start of
    // a multi-day project's journal. The full journal is retained by the service.
    let sessionModel = null;
    if (caps.methods.includes('sessions.model'))
        try {
            sessionModel = await rpc.call('sessions.model', { id: assignment.sessionId });
        }
        catch { /* Do not guess from daemon defaults. */ }
    const initialChecks = await rpc.call('supervision.status', { projectId: assignment.projectId });
    let cursor = recentActivityCursor(initialChecks, assignment.id);
    try {
        tui.start();
        while (!options.signal.aborted) {
            try {
                for (let i = 0; i < 12; i++) {
                    const page = await readActivityPage(rpc, assignment.projectId, cursor);
                    display.ingest(page.entries);
                    const previous = cursor;
                    cursor = page.nextCursor;
                    if (!page.entries.length || cursor <= previous || options.signal.aborted)
                        break;
                }
                const [service, list, checks, manager] = await Promise.all([
                    rpc.call('service.status'), rpc.call('assignments.list', { projectId: assignment.projectId }),
                    rpc.call('supervision.status', { projectId: assignment.projectId }), rpc.call('manager.status', { projectId: assignment.projectId }),
                ]);
                let guard = null;
                try {
                    guard = JSON.parse(await readFile(join(options.stateDir, 'runtime-guard-status.json'), 'utf8'));
                }
                catch { /* An absent guard is displayed honestly. */ }
                display.updateStatus(service, list.assignments.find((a) => a.id === assignment.id) ?? { state: 'unknown' }, checks, manager, guard, sessionModel);
            }
            catch (error) {
                display.error(observerError(error).message);
            }
            await new Promise(resolve => { const done = () => { clearTimeout(timer); options.signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, 2000); options.signal.addEventListener('abort', done, { once: true }); if (options.signal.aborted)
                done(); });
        }
    }
    finally {
        tui.stop({ preserveScreen: true });
    }
}
export async function runNativeObserver(stateDir, assignmentId, signal, socketPath) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error('Native observer needs a terminal. Use --browser for the Codex side panel.');
    const connection = await connectObserver(stateDir, socketPath);
    const local = new AbortController(), abort = () => local.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted)
        local.abort();
    try {
        await observeWorker({ rpc: connection.rpc, terminal: new ProcessTerminal(), stateDir, assignmentId, signal: local.signal, onQuit: abort });
    }
    finally {
        signal.removeEventListener('abort', abort);
        connection.close();
    }
}
//# sourceMappingURL=native-terminal.js.map