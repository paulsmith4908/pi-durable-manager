import { randomUUID } from "node:crypto";
import { readFile, open, mkdir, rm, writeFile, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { PiClient } from "./client.js";
import { resolveSocketPath } from "./service.js";
import { startDaemon } from "./cli-daemon.js";
import { ManagerDispatcher } from "./manager-dispatcher.js";
export function guardDecision(input) {
    if (input.paused)
        return "paused";
    if (input.healthy)
        return "healthy";
    return input.owner === "dead" ? "start" : "hold";
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== "ESRCH";
    }
}
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
/** Separate code-only process: detects daemon failure even when its in-process timers are gone. */
export async function runRuntimeGuard(options) {
    if (!/^[a-f0-9-]{36}$/i.test(options.threadId))
        throw new Error("Guard requires an existing explicit manager thread UUID.");
    for (const value of [options.intervalMs ?? 10000, options.alertAfterMs ?? 30000]) {
        if (!Number.isSafeInteger(value) || value < 1000 || value > 3600000)
            throw new Error("Guard intervals must be 1000..3600000 milliseconds.");
    }
    const config = await loadConfig(options.configPath); // Credential reference only, never credential resolution.
    const state = config.paths.stateDir;
    await mkdir(state, { recursive: true, mode: 0o700 });
    const lock = join(state, "runtime-guard.lock");
    const token = randomUUID();
    const previous = await readJson(lock);
    if (previous) {
        if (typeof previous.pid !== "number" || alive(previous.pid))
            throw new Error("A guard owner is live or unknown; review before starting another guard.");
        await rm(lock); // Verified-dead owner, never signal or replace a live/reused PID.
    }
    const fd = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await fd.writeFile(JSON.stringify({ pid: process.pid, token, threadId: options.threadId }));
    await fd.close();
    const receiptFile = join(state, "runtime-guard-status.json");
    const journal = await open(join(state, "runtime-guard-journal.jsonl"), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const dispatcher = new ManagerDispatcher({ executable: config.manager?.cliExecutable ?? "codex", baseArgs: config.manager?.cliBaseArgs });
    const interval = Math.max(1000, options.intervalMs ?? 10000);
    let incident = null;
    const old = await readJson(receiptFile).catch(() => null);
    if (old?.incident && typeof old.incident === "object") {
        const value = old.incident;
        if (typeof value.id === "string" && typeof value.since === "number")
            incident = {
                id: value.id, since: value.since, notified: value.notified === true,
                notifyAttempts: value.notifyAttempts ?? 0, nextNotifyAt: value.nextNotifyAt ?? 0,
            };
    }
    let lastNoteAt = 0;
    let restartAfter = 0;
    let restartAttempts = 0;
    const persist = async (report) => {
        await journal.write(JSON.stringify(report) + "\n");
        const staged = receiptFile + ".next";
        await writeFile(staged, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
        await rename(staged, receiptFile);
    };
    try {
        while (!options.signal.aborted) {
            const at = Date.now();
            let client = null;
            let healthy = false;
            let owner = "unknown";
            let pid = null;
            let detail = "";
            const pauseRecord = await readJson(join(state, "guard-pause.json")).catch(() => ({ invalid: true }));
            const paused = pauseRecord?.reason === "Explicit service.shutdown";
            const invalidPause = pauseRecord !== null && !paused;
            try {
                client = await PiClient.connect({ socketPath: resolveSocketPath(state), timeoutMs: 3000 });
                const status = await client.call("service.status", {});
                healthy = status.stateDir === state && status.configFile === options.configPath;
                pid = status.pid;
            }
            catch {
                client?.close();
                client = null;
            }
            if (!healthy) {
                try {
                    const record = await readJson(join(state, "service.lock"));
                    owner = record === null ? "dead" : typeof record.pid === "number" ? alive(record.pid) ? "alive" : "dead" : "unknown";
                }
                catch {
                    owner = "unknown";
                }
            }
            const action = guardDecision({ healthy, paused, owner: invalidPause ? "unknown" : owner });
            try {
                if (action === "healthy") {
                    if (incident || at - lastNoteAt >= 60000) {
                        await client.call("activity.note", { tag: "guard.health", message: `${incident ? `Recovered incident ${incident.id}; outage history is retained in runtime-guard-journal.jsonl. ` : ""}Guard checked daemon PID ${pid}; next independent health check at ${new Date(at + interval).toISOString()}.` }, `guard-health:${token}:${at}`);
                        lastNoteAt = at;
                    }
                    incident = null;
                    restartAttempts = 0;
                }
                else if (action === "paused") {
                    detail = "Explicit operator stop respected; automatic restart is paused.";
                }
                else {
                    incident ??= { id: `guard-${randomUUID()}`, since: at, notified: false, notifyAttempts: 0, nextNotifyAt: 0 };
                    await persist({ guardPid: process.pid, phase: action, lastCheckAt: at, incident });
                    if (action === "start" && at >= restartAfter) {
                        restartAttempts++;
                        restartAfter = at + Math.min(120000, interval * Math.pow(2, Math.min(restartAttempts, 4)));
                        const started = await startDaemon({ binPath: options.binPath, configPath: options.configPath,
                            stateDir: state, socketPath: resolveSocketPath(state) });
                        detail = started.ok ? "Restarted after verifying the old owner is gone. In-doubt commands remain subject to normal checkpoint/quarantine review." : "Restart did not become healthy; inspect the private service log.";
                    }
                    else
                        detail = "Socket unavailable with a live/unknown owner, or restart backoff active. No process was killed and no command replay was forced.";
                    if (config.manager?.enabled !== false && !incident.notified && incident.notifyAttempts < 8 && at >= incident.nextNotifyAt && at - incident.since >= (options.alertAfterMs ?? 30000)) {
                        incident.notifyAttempts++;
                        incident.nextNotifyAt = at + Math.min(300000, 5000 * Math.pow(2, incident.notifyAttempts));
                        await persist({ guardPid: process.pid, phase: action, lastCheckAt: at, detail, incident });
                        // Workflow-aware installs notify only current task owners. An empty
                        // target set deliberately suppresses idle/retired-task interruptions.
                        const scope = await readJson(join(state, "workflow-managers.json"));
                        const targets = scope ? (Array.isArray(scope.targets) ? scope.targets : []) : [{ threadId: options.threadId }];
                        if (targets.length === 0) {
                            incident.notifyAttempts--;
                            incident.nextNotifyAt = at + interval;
                        }
                        let delivered = targets.length > 0;
                        const visited = new Set();
                        for (const target of targets) {
                            if (!target || typeof target.threadId !== "string" || visited.has(target.threadId))
                                continue;
                            visited.add(target.threadId);
                            const sent = await dispatcher.dispatch(target.threadId, `Pi runtime guard needs attention. Incident ${incident.id}. ${detail} Read ${receiptFile}. First check workflow.list/status: continue only an ACTIVE task owned by this chat. Never restart a retired task or duplicate a writer. This is a daemon-health incident.`);
                            delivered = delivered && sent.ok;
                        }
                        if (delivered)
                            incident.notified = true;
                    }
                }
            }
            catch {
                detail = "Health check or restart failed; preserving ownership and state for review.";
            }
            finally {
                client?.close();
            }
            const report = { guardPid: process.pid, phase: action, servicePid: pid, lastCheckAt: at, nextCheckAt: Date.now() + interval, detail, incident };
            await persist(report);
            await new Promise(resolve => {
                const done = () => { clearTimeout(timer); options.signal.removeEventListener("abort", done); resolve(); };
                const timer = setTimeout(done, interval);
                options.signal.addEventListener("abort", done, { once: true });
                if (options.signal.aborted)
                    done();
            });
        }
    }
    finally {
        await dispatcher.stop();
        await persist({ guardPid: process.pid, phase: "stopped", lastCheckAt: Date.now(), nextCheckAt: null,
            detail: "Guard stopped; daemon and workers were left running.", incident });
        await journal.close();
        if ((await readJson(lock).catch(() => null))?.token === token)
            await rm(lock, { force: true });
    }
}
//# sourceMappingURL=runtime-guard.js.map