/** Plugin entry point: reconcile setup/runtime/task/display; never submits a worker. */
import { readFile, mkdir, open, rename, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { resolveSocketPath } from './service.js';
import { startDaemon, statusDaemon } from './cli-daemon.js';
import { PiClient } from './client.js';
import { CliUsageError, parseArgs, resolveConfigPath } from './cli-args.js';
import { readTextFileBounded } from './cli-rpc.js';
import { packageVersion } from './version.js';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function json(path) { try {
    return JSON.parse(await readFile(path, 'utf8'));
}
catch (e) {
    if (e.code === 'ENOENT')
        return null;
    throw e;
} }
function alive(pid) { try {
    process.kill(pid, 0);
    return true;
}
catch (e) {
    return e.code !== 'ESRCH';
} }
async function launch(bin, args, logPath) {
    const log = await open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
        const child = spawn(process.execPath, [bin, ...args], { detached: true, stdio: ['ignore', log.fd, log.fd] });
        await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no); });
        child.unref();
        return child;
    }
    finally {
        await log.close();
    }
}
export async function ensureTerminal(state, config) {
    const receipt = join(state, 'terminal-view.json');
    const probe = async () => {
        const r = await json(receipt);
        if (!r)
            return null;
        if (typeof r.pid !== 'number' || !alive(r.pid))
            return null;
        if (typeof r.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(r.url))
            throw new Error('Invalid terminal receipt.');
        try {
            const reply = await fetch(r.url + '/status', { signal: AbortSignal.timeout(1500) });
            const body = await reply.json();
            if (body.pid === r.pid && body.stateDir === state && body.instance === r.instance && body.packageVersion === packageVersion()) {
                const operator = new URL(r.operatorUrl ?? r.url);
                if (operator.origin !== r.url || !/^#operator=[a-f0-9]{64}$/.test(operator.hash))
                    throw new Error('Terminal operator authority is missing; restart the idle viewer to upgrade it.');
                return operator.href;
            }
        }
        catch { }
        throw new Error('An existing terminal owner is live but not compatible/reachable; review it before replacement.');
    };
    const existing = await probe();
    if (existing)
        return existing;
    const child = await launch(fileURLToPath(new URL('../bin/pi-durable-terminal.js', import.meta.url)), ['--config', config, '--browser', '--port', '0', '--managed'], join(state, 'terminal-view.log'));
    for (let i = 0; i < 50; i++) {
        await wait(100);
        const url = await probe();
        if (url)
            return url;
    }
    throw new Error('Terminal startup did not become ready; inspect terminal-view.log.');
}
export async function ensureGuard(state, config, threadId) {
    const lock = await json(join(state, 'runtime-guard.lock'));
    if (lock && (typeof lock.pid !== 'number' || alive(lock.pid))) {
        const report = await json(join(state, 'runtime-guard-status.json'));
        if (report?.guardPid !== lock.pid || !report.nextCheckAt || Date.now() > report.nextCheckAt + 15000)
            throw new Error('Guard owner is live but its receipt is stale; inspect before replacement.');
        return { pid: lock.pid, reused: true };
    }
    const bin = fileURLToPath(new URL('../bin/pi-durable.js', import.meta.url));
    const child = await launch(bin, ['guard', '--config', config, '--thread-id', threadId], join(state, 'runtime-guard.log'));
    for (let i = 0; i < 50; i++) {
        await wait(100);
        const r = await json(join(state, 'runtime-guard-status.json'));
        if (r?.guardPid === child.pid && r.nextCheckAt)
            return { pid: child.pid, reused: false };
        if (child.exitCode !== null)
            break;
    }
    throw new Error('Guard startup did not become ready; inspect runtime-guard.log.');
}
export async function connectWorkflow(argv) {
    const parsed = parseArgs(argv), f = parsed.flags;
    const allowed = new Set(['config', 'path', 'project-id', 'workflow-id', 'thread-id', 'objective-file', 'roadmap-file', 'request-id']);
    for (const k of f.keys())
        if (!allowed.has(k))
            throw new CliUsageError('unknown_flag', `Unknown connect flag: ${k}`);
    if (parsed.booleans.has('help'))
        return { help: 'connect --path PATH --objective-file FILE --roadmap-file FILE --request-id ID [--thread-id UUID] | connect --workflow-id ID. Returns terminalUrl; creates no worker. Missing configuration: use the plugin guided setup first.' };
    const configPath = resolveConfigPath(f);
    try {
        await access(configPath);
    }
    catch {
        throw new CliUsageError('setup_required', 'Configuration is missing. Use the plugin guided setup to supply the model endpoint; then retry connect.', 1);
    }
    const config = await loadConfig(configPath);
    const state = config.paths.stateDir, socketPath = resolveSocketPath(state);
    const status = await statusDaemon(socketPath);
    if (!status.running) {
        if (status.code && status.code !== 'no_socket')
            throw new Error(`Service is not safely stopped (${status.code}); inspect before retrying.`);
        const started = await startDaemon({ binPath: fileURLToPath(new URL('../bin/pi-durable.js', import.meta.url)), configPath, stateDir: state, socketPath });
        if (!started.ok)
            throw new Error('Service did not start; inspect its private log.');
    }
    const c = await PiClient.connect({ socketPath, timeoutMs: 55000 });
    try {
        const caps = await c.call('service.capabilities');
        const live = await c.call('service.status');
        if (!caps.operations?.['workflow.open'] || live.packageVersion !== packageVersion() || live.stateDir !== state || live.configFile !== resolve(configPath))
            throw new Error('Service/runtime mismatch. Upgrade while idle; connect never replaces a live service.');
        const threadId = f.get('thread-id') ?? process.env.CODEX_THREAD_ID;
        if (!threadId)
            throw new CliUsageError('thread_required', 'An existing Codex chat is required.');
        const wake = await c.call('manager.status');
        if (!wake.enabled)
            throw new Error('Manager wake delivery is disabled; enable the configured Codex queue transport before delegation.');
        let workflow;
        if (f.has('workflow-id')) {
            const s = await c.call('workflow.status', { id: f.get('workflow-id') });
            workflow = s.workflow;
            if (workflow.threadId !== threadId)
                throw new Error('This task belongs to another chat; explicit transfer is required.');
            if (workflow.state === 'active') {
                const r = await c.call('workflow.open', { projectId: workflow.projectId, threadId, objective: workflow.objective, roadmap: workflow.roadmap }, `${workflow.id}:reconnect`);
                workflow = r.workflow;
            }
        }
        else {
            const requestId = f.get('request-id');
            if (!requestId)
                throw new CliUsageError('request_id_required', 'Persist a stable --request-id before connecting a new task.');
            const objectivePath = f.get('objective-file'), roadmapPath = f.get('roadmap-file');
            if (!objectivePath || !roadmapPath)
                throw new CliUsageError('plan_required', 'Supply --objective-file and --roadmap-file.');
            const objective = await readTextFileBounded(objectivePath, 12000), roadmap = await readTextFileBounded(roadmapPath, 24000);
            let projectId = f.get('project-id');
            if (!projectId) {
                const path = f.get('path');
                if (!path)
                    throw new CliUsageError('path_required', 'Supply an explicit --path or --project-id.');
                const target = resolve(path);
                let exists = true;
                try {
                    await access(target);
                }
                catch (e) {
                    if (e.code === 'ENOENT')
                        exists = false;
                    else
                        throw e;
                }
                if (!exists)
                    await mkdir(dirname(target), { recursive: true });
                const project = await c.call(exists ? 'projects.import' : 'projects.create', { path: target, name: basename(target) }, `${requestId}:project`);
                projectId = project.project.id;
            }
            const result = await c.call('workflow.open', { projectId, threadId, objective, roadmap }, `${requestId}:open`);
            workflow = result.workflow;
        }
        const guard = await ensureGuard(state, configPath, threadId);
        const url = await ensureTerminal(state, configPath);
        const terminal = new URL(url);
        terminal.searchParams.set('workflowId', workflow.id);
        const terminalUrl = terminal.href;
        const snapshot = await c.call('workflow.status', { id: workflow.id });
        return { workflowId: workflow.id, projectId: workflow.projectId, terminalUrl, guard, snapshot, workerCreated: false,
            operatorUrlPrivate: true,
            next: workflow.state === 'active' ? 'Open terminalUrl beside the chat. Keep its operator fragment out of worker prompts, roadmaps, public logs and shared files. Review snapshot; submit only the next agreed scope with workflow.submit.' : 'Task is retired. Display history only; do not restart.' };
    }
    finally {
        c.close();
    }
}
//# sourceMappingURL=cli-connect.js.map