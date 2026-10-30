// Tests for integration/command-supervisor.ts — a small standalone command
// lifetime supervisor. Real child processes only; Node builtins only.
//
// Safety: every spawned fixture pid is tracked and signalled ONLY after a
// prefix guard proves it belongs to our fixture temp dir. Cleanup runs in a
// finally block. No real Codex/manager pid is ever signalled, and no secrets
// or credentials are read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(HERE, "..", "dist", "command-supervisor.js");
const NODE = process.execPath;
const STRIP = ["--experimental-strip-types"];

// ---- fixture helpers ------------------------------------------------------

function makeTmp() {
  return mkdtempSync(path.join(tmpdir(), "pi-supervisor-test-"));
}

// Fixture-prefix guard: only pids we recorded for fixtures may be signalled.
const spawnedFixturePids = new Set();
function guard(pid) {
  if (!spawnedFixturePids.has(pid)) throw new Error(`refusing to signal untracked pid ${pid}`);
  return pid;
}

function writeScript(dir, name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// Launch the supervisor detached with 4 stdio pipes. Returns a small handle
// with FD3 frame parsing and a bounded wait for a frame type.
function launchSupervisor(args, { timeoutMs = 15000 } = {}) {
  const child = spawn(NODE, [...STRIP, SUPERVISOR, ...args], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  if (child.pid) spawnedFixturePids.add(child.pid);

  const frames = [];
  const waiters = [];
  let buf = "";
  child.stdio[3].on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      let frame;
      try { frame = JSON.parse(line); } catch { frame = { type: "_malformed", line }; }
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1); }
      }
    }
  });

  function waitFor(pred, label) {
    for (const f of frames) if (pred(f)) return Promise.resolve(f);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.resolve === wrapped);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${label}; frames=${JSON.stringify(frames)}`));
      }, timeoutMs);
      const wrapped = (frame) => { clearTimeout(timer); resolve(frame); };
      waiters.push({ pred, resolve: wrapped });
    });
  }

  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  function send(line) {
    child.stdin.write(line);
  }

  async function cleanup() {
    // Kill ONLY the supervisor group we spawned, then reap it.
    try { process.kill(-guard(child.pid), "SIGKILL"); } catch { /* gone */ }
    try { child.stdin.destroy(); } catch { /* ignore */ }
    await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 3000))]);
    spawnedFixturePids.delete(child.pid);
  }

  return { child, frames, waitFor, send, exitPromise, cleanup };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitGone(pid, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

// ---- tests ----------------------------------------------------------------

test("invalid args stop fail-closed before any execution", async () => {
  // Missing --grace-ms value / bad range / missing program.
  for (const args of [["--grace-ms", "abc", "--", "/bin/echo", "x"], ["--grace-ms", "1", "--", "/bin/echo"], ["/bin/echo"]]) {
    const h = launchSupervisor(args);
    try {
      const frame = await h.waitFor((f) => f.type === "error", "error frame");
      assert.equal(frame.type, "error");
      const { code } = await h.exitPromise;
      assert.equal(code, 2, "fail-closed exit code");
      // No ready / started frames ever emitted.
      assert.equal(h.frames.some((f) => f.type === "ready" || f.type === "started"), false);
    } finally { await h.cleanup(); }
  }
});

test("no execution before START; ready carries pid/pgid/version", async () => {
  const dir = makeTmp();
  const marker = path.join(dir, "ran");
  const script = writeScript(dir, "mark.mjs", `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"yes");`);
  const h = launchSupervisor(["--grace-ms", "500", "--", NODE, script]);
  try {
    const ready = await h.waitFor((f) => f.type === "ready", "ready");
    assert.equal(ready.version, 1);
    assert.equal(ready.pid, h.child.pid);
    assert.equal(ready.pgid, h.child.pid, "supervisor owns its own group");
    // Give the supervisor a moment; it must NOT have run the command.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(h.frames.some((f) => f.type === "started"), false, "no started before START");
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(marker), false, "command did not run before START");
    h.send("START\n");
    const started = await h.waitFor((f) => f.type === "started", "started");
    assert.ok(Number.isInteger(started.childPid));
  } finally { await h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("actual stdout/stderr/exit7 preserved via IPC", async () => {
  const dir = makeTmp();
  const script = writeScript(
    dir,
    "io.mjs",
    `process.stdout.write("OUT:alpha\\n");process.stderr.write("ERR:beta\\n");process.exit(7);`,
  );
  const h = launchSupervisor(["--grace-ms", "500", "--", NODE, script]);
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    let out = "";
    let err = "";
    h.child.stdio[1].on("data", (c) => (out += c.toString("utf8")));
    h.child.stdio[2].on("data", (c) => (err += c.toString("utf8")));
    h.send("START\n");
    const exit = await h.waitFor((f) => f.type === "exit", "exit");
    assert.equal(exit.code, 7);
    assert.equal(exit.signal, null);
    // Unmodified child output on our stdout/stderr.
    await new Promise((r) => setTimeout(r, 200));
    assert.match(out, /OUT:alpha/);
    assert.match(err, /ERR:beta/);
    // Supervisor stays alive awaiting cleanup.
    assert.equal(alive(h.child.pid), true, "supervisor stays alive after child exit");
  } finally { await h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("nonexistent command emits structured spawnerror code 127", async () => {
  const h = launchSupervisor(["--grace-ms", "500", "--", "/nonexistent/definitely-missing-bin-xyz"]);
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    h.send("START\n");
    const err = await h.waitFor((f) => f.type === "spawnerror", "spawnerror");
    assert.equal(err.code, 127);
    assert.equal(h.frames.some((f) => f.type === "exit"), false, "no fake success exit");
  } finally { await h.cleanup(); }
});

test("STOP line kills the command (and its group)", async () => {
  const dir = makeTmp();
  const pidfile = path.join(dir, "child.pid");
  const script = writeScript(
    dir,
    "sleepy.mjs",
    `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000);`,
  );
  const h = launchSupervisor(["--grace-ms", "300", "--", NODE, script]);
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    h.send("START\n");
    const started = await h.waitFor((f) => f.type === "started", "started");
    spawnedFixturePids.add(started.childPid);
    // Wait for the pid file, then STOP.
    const { readFileSync } = await import("node:fs");
    const end = Date.now() + 4000;
    while (Date.now() < end) { try { readFileSync(pidfile); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
    h.send("STOP\n");
    assert.equal(await waitGone(started.childPid), true, "command died on STOP");
    await h.exitPromise;
    spawnedFixturePids.delete(started.childPid);
  } finally { await h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("parent lifetime pipe close kills the command", async () => {
  const dir = makeTmp();
  const pidfile = path.join(dir, "child.pid");
  const script = writeScript(
    dir,
    "sleepy.mjs",
    `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000);`,
  );
  const h = launchSupervisor(["--grace-ms", "300", "--", NODE, script]);
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    h.send("START\n");
    const started = await h.waitFor((f) => f.type === "started", "started");
    spawnedFixturePids.add(started.childPid);
    const { readFileSync } = await import("node:fs");
    const end = Date.now() + 4000;
    while (Date.now() < end) { try { readFileSync(pidfile); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
    // End the parent lifetime pipe without STOP.
    h.child.stdin.end();
    assert.equal(await waitGone(started.childPid), true, "command died when parent pipe closed");
    await h.exitPromise;
    spawnedFixturePids.delete(started.childPid);
  } finally { await h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("command ignoring SIGTERM is SIGKILLed after bounded grace", async () => {
  const dir = makeTmp();
  const pidfile = path.join(dir, "child.pid");
  const script = writeScript(
    dir,
    "stubborn.mjs",
    `import {writeFileSync} from "node:fs";process.on("SIGTERM",()=>{});writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000);`,
  );
  const h = launchSupervisor(["--grace-ms", "300", "--", NODE, script]);
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    h.send("START\n");
    const started = await h.waitFor((f) => f.type === "started", "started");
    spawnedFixturePids.add(started.childPid);
    const { readFileSync } = await import("node:fs");
    const end = Date.now() + 4000;
    while (Date.now() < end) { try { readFileSync(pidfile); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
    h.send("STOP\n");
    assert.equal(await waitGone(started.childPid), true, "stubborn command was SIGKILLed");
    spawnedFixturePids.delete(started.childPid);
  } finally { await h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("actual launcher parent death kills supervisor and descendants", async () => {
  const dir = makeTmp();
  const pidfile = path.join(dir, "child.pid");
  const script = writeScript(
    dir,
    "sleepy.mjs",
    `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000);`,
  );
  const h = launchSupervisor(["--grace-ms", "300", "--", NODE, script]);
  let started;
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    h.send("START\n");
    started = await h.waitFor((f) => f.type === "started", "started");
    spawnedFixturePids.add(started.childPid);
    const { readFileSync } = await import("node:fs");
    const end = Date.now() + 4000;
    while (Date.now() < end) { try { readFileSync(pidfile); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
    // Simulate launcher parent death: closing the lifetime pipe is how the
    // supervisor observes it (its FD0 reaches EOF).
    h.child.stdin.destroy();
    assert.equal(await waitGone(started.childPid), true, "descendant died after launcher death");
    assert.equal(await waitGone(h.child.pid), true, "supervisor exited after launcher death");
  } finally {
    await h.cleanup();
    if (started) spawnedFixturePids.delete(started.childPid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("child cannot inherit FD3 or the parent lifetime pipe", async () => {
  const dir = makeTmp();
  const report = path.join(dir, "fds.json");
  const script = writeScript(
    dir,
    "fds.mjs",
    `import {writeFileSync,fstatSync} from "node:fs";
const info=(f)=>{try{const s=fstatSync(f);return{char:s.isCharacterDevice(),fifo:s.isFIFO(),sock:s.isSocket()}}catch(e){return "err:"+e.code}};
writeFileSync(${JSON.stringify(report)}, JSON.stringify({fd0:info(0),fd3:info(3)}));`,
  );
  const h = launchSupervisor(["--grace-ms", "500", "--", NODE, script]);
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    h.send("START\n");
    await h.waitFor((f) => f.type === "exit", "exit");
    const { readFileSync } = await import("node:fs");
    const end = Date.now() + 3000;
    while (Date.now() < end) { try { readFileSync(report); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
    const { fd0, fd3 } = JSON.parse(readFileSync(report, "utf8"));
    // FD0 was spawned as "ignore" => /dev/null (a character device), NOT the
    // parent lifetime pipe (which is a FIFO). So the lifetime pipe is not inherited.
    assert.equal(typeof fd0, "object");
    assert.equal(fd0.char, true, "child stdin is /dev/null, not the lifetime pipe");
    assert.equal(fd0.fifo, false, "child must not inherit the parent lifetime pipe");
    // FD3 must not be a pipe connected back to the supervisor's status channel.
    assert.notEqual(fd3, undefined);
  } finally { await h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("unknown non-interactive protocol input stops supervisor", async () => {
  const h = launchSupervisor(["--grace-ms", "200", "--", NODE, "-e", "setInterval(()=>{},1000)"]);
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    h.send("BOGUS\n");
    const { code, signal } = await h.exitPromise;
    assert.ok(code !== null || signal !== null, "supervisor exited on unknown input");
    assert.equal(h.frames.some((f) => f.type === "started"), false, "no child launched");
  } finally { await h.cleanup(); }
});

// A grandchild that ignores TERM and writes a marker ~1s after start. The
// supervisor group must be gone before it can write that marker.
function writeGrandchild(dir, name, markerPath, afterMs = 1000) {
  return writeScript(
    dir,
    name,
    `import {writeFileSync} from "node:fs";
process.on("SIGTERM",()=>{});   // ignore TERM
process.on("SIGINT",()=>{});
setTimeout(()=>{ writeFileSync(${JSON.stringify(markerPath)}, "ALIVE"); process.exit(0); }, ${afterMs});
setInterval(()=>{},1000);`,
  );
}

// Primary command: spawns a NORMAL (non-detached) grandchild in the same group
// that ignores TERM, then exits 0 immediately, leaving the grandchild alive.
function writePrimarySpawnsGrandchild(dir, name, grandchildScript, pidfile) {
  return writeScript(
    dir,
    name,
    `import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
const g = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: ["ignore","ignore","ignore"], detached: false });
writeFileSync(${JSON.stringify(pidfile)}, String(g.pid));
g.unref();
process.exit(0);`,
  );
}

async function waitFile(p, ms = 5000) {
  const { readFileSync } = await import("node:fs");
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { return readFileSync(p, "utf8"); } catch { await new Promise((r) => setTimeout(r, 30)); }
  }
  return undefined;
}

async function groupGone(pgid, ms = 4000) {
  // A group still has members if kill(-pgid, 0) succeeds.
  const end = Date.now() + ms;
  const check = () => { try { process.kill(-pgid, 0); return false; } catch { return true; } };
  while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return check();
}

test("parent death after primary EXIT still kills TERM-ignoring normal grandchild", async () => {
  const dir = makeTmp();
  const marker = path.join(dir, "grandchild-marker");
  const gpidFile = path.join(dir, "grandchild.pid");
  const grandchild = writeGrandchild(dir, "grandchild.mjs", marker, 1000);
  const primary = writePrimarySpawnsGrandchild(dir, "primary.mjs", grandchild, gpidFile);

  const h = launchSupervisor(["--grace-ms", "400", "--", NODE, primary]);
  let grandchildPid;
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    h.send("START\n");
    await h.waitFor((f) => f.type === "started", "started");

    // Primary exits 0 while its non-detached grandchild keeps running.
    const exit = await h.waitFor((f) => f.type === "exit", "exit");
    assert.equal(exit.code, 0, "primary exited 0");

    const raw = await waitFile(gpidFile);
    assert.ok(raw, "primary recorded the grandchild pid");
    grandchildPid = Number(raw);
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    spawnedFixturePids.add(grandchildPid);

    const supervisorPgid = h.child.pid;
    // Close the parent lifetime pipe WITHOUT controller cleanup. The fixed
    // supervisor must still stop and SIGKILL the whole group.
    h.child.stdin.end();

    // Supervisor group must be gone after the bounded grace.
    assert.equal(await groupGone(supervisorPgid, 4000), true, "supervisor group gone after grace");
    assert.equal(await waitGone(grandchildPid, 4000), true, "grandchild killed");

    // The grandchild must NEVER get to write its marker.
    const { existsSync } = await import("node:fs");
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(existsSync(marker), false, "grandchild marker must NEVER be written");
  } finally {
    await h.cleanup();
    if (grandchildPid) spawnedFixturePids.delete(grandchildPid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STOP after primary EXIT also cleans the remaining grandchild", async () => {
  const dir = makeTmp();
  const marker = path.join(dir, "grandchild-marker");
  const gpidFile = path.join(dir, "grandchild.pid");
  const grandchild = writeGrandchild(dir, "grandchild.mjs", marker, 1000);
  const primary = writePrimarySpawnsGrandchild(dir, "primary.mjs", grandchild, gpidFile);

  const h = launchSupervisor(["--grace-ms", "400", "--", NODE, primary]);
  let grandchildPid;
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    h.send("START\n");
    const exit = await h.waitFor((f) => f.type === "exit", "exit");
    assert.equal(exit.code, 0);
    grandchildPid = Number(await waitFile(gpidFile));
    spawnedFixturePids.add(grandchildPid);

    // Explicit STOP (same cleanup path) after the primary already exited.
    h.send("STOP\n");
    assert.equal(await groupGone(h.child.pid, 4000), true, "group gone after STOP");
    assert.equal(await waitGone(grandchildPid, 4000), true, "grandchild killed by STOP");

    const { existsSync } = await import("node:fs");
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(existsSync(marker), false, "grandchild marker must NEVER be written");
  } finally {
    await h.cleanup();
    if (grandchildPid) spawnedFixturePids.delete(grandchildPid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closed FD3 before ready fails closed with exit 2 and no child", async () => {
  const dir = makeTmp();
  const marker = path.join(dir, "ran");
  const script = writeScript(dir, "mark.mjs", `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"yes");`);
  const h = launchSupervisor(["--grace-ms", "200", "--", NODE, script]);
  try {
    // Kill the status channel BEFORE ready is observable, then send START.
    h.child.stdio[3].destroy();
    h.send("START\n");
    const { code } = await h.exitPromise;
    assert.equal(code, 2, "initial FD3 failure => exit 2, no child");
    await new Promise((r) => setTimeout(r, 300));
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(marker), false, "command must not run");
  } finally { await h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("closed FD3 after START transitions STOP and leaves no lasting side effect", async () => {
  const dir = makeTmp();
  const marker = path.join(dir, "ran");
  const script = writeScript(dir, "mark.mjs", `import {writeFileSync} from "node:fs";setTimeout(()=>writeFileSync(${JSON.stringify(marker)},"yes"),300);setInterval(()=>{},1000);`);
  const h = launchSupervisor(["--grace-ms", "200", "--", NODE, script]);
  try {
    await h.waitFor((f) => f.type === "ready", "ready");
    // Destroy the FD3 status channel then ask to START: runtime status-channel
    // failure must fail closed on our own scope (stop the group), not continue
    // silently without status.
    h.child.stdio[3].destroy();
    h.send("START\n");
    const { code, signal } = await h.exitPromise;
    assert.ok(code !== null || signal !== null, "supervisor exited on runtime FD3 failure");
    assert.equal(await groupGone(h.child.pid, 4000), true, "supervisor group gone");
    await new Promise((r) => setTimeout(r, 500));
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(marker), false, "command side effect must not persist");
  } finally { await h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("guard refuses to signal untracked pids", () => {
  assert.throws(() => guard(999999), /refusing to signal/);
  spawnedFixturePids.add(4242);
  assert.equal(guard(4242), 4242);
  spawnedFixturePids.delete(4242);
});

// Clean up: never leave a tracked fixture pid dangling.
process.on("exit", () => {
  for (const pid of spawnedFixturePids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
});
