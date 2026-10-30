import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PiClient } from "./client.js";
import { loadConfig } from "./config.js";
import { resolveSocketPath } from "./service.js";
import { formatActivity } from "./activity.js";
const sleep = (ms, signal) => new Promise(resolve => {
    if (signal?.aborted)
        return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
});
async function clientFor(configPath, socketOverride) {
    const config = await loadConfig(configPath); // References only; credentials are never resolved here.
    // Honor the same explicit socket override the rest of the CLI supports
    // (`service start --socket`). Default stays the config-derived path.
    const client = await PiClient.connect({ socketPath: resolveSocketPath(config.paths.stateDir, socketOverride), timeoutMs: 5000 });
    try {
        const capabilities = await client.call("service.capabilities", {});
        if (!capabilities.methods.includes("activity.list"))
            throw new Error("This service needs the local reliability update before the live console can attach.");
        return client;
    }
    catch (error) {
        client.close();
        throw error;
    }
}
/** Read-only actual terminal viewer. A disappearing viewer never stops the daemon or workers. */
export async function watchActivity(configPath, options, write = (text) => { process.stdout.write(text); }) {
    let cursor = options.after ?? 0;
    let client = null;
    const signal = options.signal;
    try {
        while (!signal?.aborted) {
            try {
                if (!client) {
                    client = await clientFor(configPath, options.socketPath);
                    if (!options.json)
                        write(`Pi Durable live activity attached. Cursor ${cursor}. Closing this viewer leaves workers running.\n`);
                }
                const page = await client.call("activity.list", { after: cursor, limit: 50, projectId: options.projectId });
                for (const entry of page.entries)
                    write(options.json ? JSON.stringify(entry) + "\n" : formatActivity(entry));
                cursor = page.nextCursor;
                if (page.entries.length)
                    continue;
                if (options.once)
                    return;
                await sleep(1500, signal);
            }
            catch (error) {
                client?.close();
                client = null;
                if (options.once || (error instanceof Error && error.message.includes("needs the local reliability update")))
                    throw error;
                if (!options.json)
                    write(`Connection unavailable; will reconnect from cursor ${cursor}. No work was restarted.\n`);
                await sleep(5000, signal);
            }
        }
    }
    finally {
        client?.close();
    }
}
export async function startLiveConsole(configPath, options = {}) {
    const config = await loadConfig(configPath);
    const guardStatus = async () => {
        try {
            const row = JSON.parse(await readFile(join(config.paths.stateDir, "runtime-guard-status.json"), "utf8"));
            const fresh = row.phase === "stopped" || typeof row.nextCheckAt === "number" && Date.now() <= row.nextCheckAt + 15000;
            return { phase: fresh ? row.phase : "stale", observedPhase: row.phase, lastCheckAt: row.lastCheckAt, nextCheckAt: row.nextCheckAt, detail: row.detail };
        }
        catch {
            return null;
        }
    };
    // Attach lazily so the viewer survives a daemon restart with the same cursor.
    let client = null;
    let origin;
    const server = createServer(async (req, res) => {
        const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
        const reply = (status, value) => { res.writeHead(status, headers); res.end(JSON.stringify(value)); };
        if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin)
            return reply(403, { error: "Loopback console only." });
        if (req.method !== "GET" && req.method !== "HEAD")
            return reply(405, { error: "Read-only console." });
        const url = new URL(req.url ?? "/", origin);
        if (url.pathname === "/") {
            res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
            res.end(CONSOLE_HTML);
            return;
        }
        if (url.pathname !== "/activity")
            return reply(404, { error: "Unknown route." });
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0)
            return reply(400, { error: "Invalid cursor." });
        try {
            client ??= await clientFor(configPath, options.socketPath);
            const page = await client.call("activity.list", { after, limit: 50, projectId: options.projectId });
            const supervision = await client.call("supervision.status", { projectId: options.projectId });
            const manager = await client.call("manager.status", options.projectId ? { projectId: options.projectId } : {});
            return reply(200, { connected: true, at: Date.now(), page, supervision, manager, guard: await guardStatus() });
        }
        catch {
            client?.close();
            client = null;
            return reply(503, { connected: false, guard: await guardStatus(), error: "Pi service unavailable. This view will reconnect; it does not control worker execution." });
        }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    server.on("close", () => { client?.close(); });
    return { server, url: origin };
}
const CONSOLE_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Live Console</title>
<style>body{margin:0;background:#101513;color:#dceade;font:13px ui-monospace,SFMono-Regular,monospace}header{position:sticky;top:0;background:#18211c;padding:16px;border-bottom:1px solid #3b5142}h1{font-size:18px;margin:0 0 9px}#health{color:#bbd9aa}#checks{white-space:pre-wrap;color:#b7c5bc;font-size:12px}main{padding:12px 16px}article{border-bottom:1px solid #2d3e32;padding:12px 0}strong{color:#c4e1b2}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;line-height:1.5}button{background:#263b2c;color:#e4f0df;border:1px solid #57715a;padding:5px 10px;cursor:pointer}small{color:#b7c5bc}a{color:#c4e1b2}</style>
<header><h1>Pi Live Console</h1><div id="health">Connecting to the real service…</div><p><small>Read-only activity view · persistent journal · no model calls for refreshing this panel</small></p><div id="checks"></div><button id="pause">Pause scrolling</button> <button id="reload">Replay saved history</button></header><main id="log" aria-live="polite"></main>
<script>let cursor=Number(sessionStorage.getItem('pi-cursor')||0),paused=false,busy=false;
const log=document.getElementById('log'),health=document.getElementById('health'),checks=document.getElementById('checks');
// A page reload replays history so the visible buffer and cursor cannot diverge.
cursor=0;document.getElementById('pause').onclick=()=>{paused=!paused;document.getElementById('pause').textContent=paused?'Resume scrolling':'Pause scrolling'};
document.getElementById('reload').onclick=()=>{cursor=0;log.replaceChildren()};
async function tick(){if(busy)return;busy=true;try{const r=await fetch('/activity?after='+cursor,{cache:'no-store'});const s=await r.json();const guard=s.guard?'Independent daemon guard: '+s.guard.phase+' · checked '+new Date(s.guard.lastCheckAt).toLocaleTimeString()+' · next '+(s.guard.nextCheckAt?new Date(s.guard.nextCheckAt).toLocaleTimeString():'none')+'\\n':'';if(!r.ok){checks.textContent=guard;throw Error(s.error)}
health.textContent='Connected · last refresh '+new Date(s.at).toLocaleTimeString()+' · pending wakes '+s.manager.pending+' · unacknowledged '+s.manager.unacked;
checks.textContent=guard+(s.supervision.snapshots.filter(x=>x.nextCheckAt!==null).map(x=>x.assignmentId+'\\n'+x.phase+' · last progress '+new Date(x.lastProgressAt).toLocaleTimeString()+' · checked '+new Date(x.lastCheckAt).toLocaleTimeString()+' · next '+new Date(x.nextCheckAt).toLocaleTimeString()+'\\n'+x.reason).join('\\n\\n')||'No active worker checks scheduled.');
for(const e of s.page.entries){const article=document.createElement('article'),title=document.createElement('strong'),text=document.createElement('pre');title.textContent='#'+e.seq+' '+new Date(e.at).toLocaleTimeString()+' '+e.kind+(e.assignmentId?' · '+e.assignmentId:'');text.textContent=JSON.stringify(e.data,null,2);article.append(title,text);log.append(article)}
cursor=s.page.nextCursor;sessionStorage.setItem('pi-cursor',String(cursor));while(log.children.length>600)log.firstElementChild.remove();if(!paused&&s.page.entries.length)window.scrollTo(0,document.body.scrollHeight);
if(s.page.entries.length===50)setTimeout(tick,0);
}catch(e){health.textContent=e.message}finally{busy=false}}tick();setInterval(tick,2000);</script></html>`;
//# sourceMappingURL=live-console.js.map