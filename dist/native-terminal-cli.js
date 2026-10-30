import { writeFile, rename, readFile, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { runNativeObserver, connectObserver } from './native-terminal.js';
import { startTerminalBrowser } from './native-terminal-browser.js';
export async function main(argv) {
    const args = new Map();
    let browser = false;
    let managed = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--managed') {
            managed = true;
            continue;
        }
        if (a === '--browser') {
            browser = true;
            continue;
        }
        if (a === '--help') {
            console.log('pi-durable-terminal --config PATH [--assignment-id ID] [--socket PATH] [--browser --port 5183]\nRead-only actual Pi UI attached to an EXISTING Durable assignment. No agent is created.');
            return;
        }
        if (!['--config', '--assignment-id', '--socket', '--port'].includes(a) || !argv[i + 1] || argv[i + 1].startsWith('--'))
            throw new Error('Invalid arguments; use --help.');
        args.set(a, argv[++i]);
    }
    const configPath = args.get('--config');
    if (!configPath)
        throw new Error('--config PATH is required; the observer reads references only.');
    const config = await loadConfig(configPath);
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort());
    process.once('SIGINT', () => controller.abort());
    if (browser) {
        let lockHandle;
        const lock = join(config.paths.stateDir, 'terminal-view.lock');
        if (managed) {
            try {
                const old = JSON.parse(await readFile(lock, 'utf8'));
                let live = true;
                try {
                    process.kill(old.pid, 0);
                }
                catch (e) {
                    live = e.code !== 'ESRCH';
                }
                if (live)
                    throw new Error('A terminal owner is already live.');
                await rm(lock);
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw e;
            }
            lockHandle = await open(lock, 'wx', 0o600);
            await lockHandle.writeFile(JSON.stringify({ pid: process.pid }));
            await lockHandle.close();
        }
        const port = Number(args.get('--port') ?? 5183);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
            throw new Error('Invalid port.');
        const app = await startTerminalBrowser({ stateDir: config.paths.stateDir, assignmentId: args.get('--assignment-id'), socketPath: args.get('--socket'), port });
        if (managed) {
            const status = await (await fetch(app.url + '/status')).json();
            const path = join(config.paths.stateDir, 'terminal-view.json');
            await writeFile(path + '.next', JSON.stringify({ url: app.url, operatorUrl: app.operatorUrl, pid: process.pid, instance: status.instance }), { mode: 0o600 });
            await rename(path + '.next', path);
        }
        // Managed stdout is a log: the operator capability belongs only in the private receipt.
        console.log(JSON.stringify({ url: managed ? app.url : app.operatorUrl, observerUrl: app.url, readOnly: true, renderer: 'Pi TUI 1.4.0', agentCreated: false }));
        controller.signal.addEventListener('abort', () => { void app.close().then(async () => { if (managed)
            await rm(lock, { force: true }); }); }, { once: true });
        return;
    }
    const connection = await connectObserver(config.paths.stateDir, args.get('--socket'));
    try {
        let id = args.get('--assignment-id');
        if (!id) {
            const list = await connection.rpc.call('assignments.list');
            id = list.assignments.sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
        }
        if (!id)
            throw new Error('No existing assignment to observe. No agent was started.');
        await runNativeObserver(config.paths.stateDir, id, controller.signal, args.get('--socket'));
    }
    finally {
        connection.close();
    }
}
//# sourceMappingURL=native-terminal-cli.js.map