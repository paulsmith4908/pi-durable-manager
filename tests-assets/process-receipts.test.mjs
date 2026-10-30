// Integration tests for durable process receipts + unclean-command quarantine.
//
// These exercise the REAL compiled modules (`dist/store.js`,
// `dist/process-quarantine.js`) against an isolated, repo-local temp directory.
// No real manager/supervisor pid is ever signalled: the only processes touched
// are ones this test spawns itself, and only via a known-prefix guard.
//
// Safety: temp dirs use a known prefix under the OS temp root and are removed in
// `finally`. We never read OLDPWD, never use shell `mktemp`, and never signal a
// pid we did not spawn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const storeMod = await import(path.join(ROOT, "dist", "store.js"));
const quarantineMod = await import(path.join(ROOT, "dist", "process-quarantine.js"));

const { MetadataStore } = storeMod;
const { planQuarantine, waitForGroupsGone, canReleaseQuarantine, isAlive, isGroupAlive } = quarantineMod;

// Only pids this test started may be signalled.
const ownPids = new Set();
function guard(pid) {
  if (!ownPids.has(pid)) throw new Error(`refusing to signal untracked pid ${pid}`);
  return pid;
}

function makeTmp() {
  return mkdtempSync(path.join(tmpdir(), "pi-receipts-test-"));
}

async function openStore(dir) {
  return MetadataStore.open(path.join(dir, "meta.sqlite"));
}

// A trivial spawner for a long-lived child we own, so we have a real pgid to
// record. The child ignores SIGTERM to prove cleanup is forceful.
function spawnSleeper() {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  ownPids.add(child.pid);
  child.unref();
  return child;
}

async function killOwn(child) {
  try {
    process.kill(-guard(child.pid), "SIGKILL");
  } catch {
    /* already gone */
  }
}

async function waitGroupGone(pgid, ms = 4000) {
  const end = Date.now() + ms;
  const gone = () => {
    try {
      process.kill(-pgid, 0);
      return false;
    } catch {
      return true;
    }
  };
  while (Date.now() < end) {
    if (gone()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return gone();
}

// Spawn a leader whose ONLY child stays in the SAME process group while the
// leader exits immediately. The returned pid is the group id (the leader's pid,
// which becomes the pgid for the detached group). The leader is gone but the
// group is NOT — this is exactly the case a leader-only probe gets wrong.
function spawnLeaderExitsChildRemains() {
  // The child ignores SIGTERM to prove cleanup is forceful, and is re-parented
  // into the detached group so it shares the leader's pgid.
  const script =
    "const {spawn}=require('child_process');" +
    "spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});" +
    "process.exit(0);";
  const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  ownPids.add(leader.pid);
  leader.unref();
  return leader;
}

test("receipts persist started/stopped and schema is v8", async () => {
  const dir = makeTmp();
  try {
    const store = await openStore(dir);
    assert.equal(store.schemaVersion, 8);

    store.beginServiceRun("boot-A", 1234, 1000);
    // A fresh boot is DIRTY until it is explicitly marked clean.
    const unclean = store.listUncleanServiceRuns();
    assert.equal(unclean.length, 1);
    assert.equal(unclean[0].bootId, "boot-A");
    assert.equal(unclean[0].clean, false);

    store.insertProcessReceipt({
      receiptId: "r1",
      assignmentId: "asg-1",
      bootId: "boot-A",
      pid: 100,
      pgid: 100,
      commandRedacted: "git status",
      state: "started",
      createdAt: 1100,
      updatedAt: 1100,
    });
    store.setProcessReceiptState("r1", "stopped", 1200);

    const receipts = store.listProcessReceipts("asg-1");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, "stopped");
    assert.equal(receipts[0].pgid, 100);

    // Only marking the run clean clears it from the unclean set.
    store.markServiceRunClean("boot-A", 1300);
    assert.equal(store.listUncleanServiceRuns().length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planQuarantine finds assignments with receipts from prior DIRTY boots only", async () => {
  const dir = makeTmp();
  try {
    const store = await openStore(dir);
    store.beginServiceRun("boot-OLD", 1, 1000); // never marked clean => dirty
    store.beginServiceRun("boot-NOW", 2, 2000); // the current boot

    // A receipt recorded by the OLD boot: may have run an external command.
    store.insertProcessReceipt({
      receiptId: "old-1",
      assignmentId: "asg-old",
      bootId: "boot-OLD",
      pid: 424242,
      pgid: 424242,
      commandRedacted: "rm -rf build",
      state: "started",
      createdAt: 1050,
      updatedAt: 1050,
    });
    // A receipt from the CURRENT boot must NOT quarantine anything.
    store.insertProcessReceipt({
      receiptId: "now-1",
      assignmentId: "asg-now",
      bootId: "boot-NOW",
      pid: 9,
      pgid: 9,
      commandRedacted: "ls",
      state: "started",
      createdAt: 2050,
      updatedAt: 2050,
    });

    const decisions = planQuarantine(store, "boot-NOW");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].assignmentId, "asg-old");
    assert.equal(decisions[0].receipts.length, 1);
    assert.equal(decisions[0].receipts[0].commandRedacted, "rm -rf build");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForGroupsGone never signals and reports a live group as remaining", async () => {
  const dir = makeTmp();
  let child;
  try {
    const store = await openStore(dir);
    store.beginServiceRun("boot-OLD", 1, 1000);
    child = spawnSleeper();
    store.insertProcessReceipt({
      receiptId: "live-1",
      assignmentId: "asg-live",
      bootId: "boot-OLD",
      pid: child.pid,
      pgid: child.pid,
      commandRedacted: "sleep",
      state: "started",
      createdAt: 1000,
      updatedAt: 1000,
    });
    const decisions = planQuarantine(store, "boot-NOW");
    assert.equal(decisions.length, 1);
    // The recorded group is alive: the bounded wait must NOT kill it, and the
    // decision must report it as remaining.
    const result = await waitForGroupsGone(decisions, 300);
    assert.ok(result.remaining.length >= 1, "live group reported remaining");
    assert.equal(isAlive(child.pid), true, "waiter never killed the live group");
    // Release is refused while any recorded group is alive.
    const release = canReleaseQuarantine(decisions);
    assert.equal(release.ok, false);
    assert.ok(release.alive.length >= 1);
    store.close();
  } finally {
    if (child) await killOwn(child);
    if (child) await waitGroupGone(child.pid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dead leader with a live same-PGID child is still reported ALIVE (no false release)", async () => {
  const dir = makeTmp();
  let leader;
  try {
    const store = await openStore(dir);
    store.beginServiceRun("boot-OLD", 1, 1000);
    leader = spawnLeaderExitsChildRemains();
    const pgid = leader.pid;
    // Give the child a moment to be re-parented into the group.
    await new Promise((r) => setTimeout(r, 300));

    store.insertProcessReceipt({
      receiptId: "leader-dead-1",
      assignmentId: "asg-leader-dead",
      bootId: "boot-OLD",
      pid: pgid,
      pgid,
      commandRedacted: "node -e …",
      state: "started",
      createdAt: 1000,
      updatedAt: 1000,
    });

    // The LEADER pid is gone; a leader-only probe would say "dead". The GROUP
    // probe must still see the surviving same-PGID child.
    const leaderProbe = isAlive(pgid);
    const groupProbe = isGroupAlive(pgid);

    const decisions = planQuarantine(store, "boot-NEW");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].livePgids.includes(pgid), true, "live group is detected via -pgid probe");
    assert.equal(canReleaseQuarantine(decisions).ok, false, "release refused while the group lives");

    // Restart MUST NOT signal the possibly-reused old pgid; the bounded wait is
    // passive and leaves the group alone.
    const result = await waitForGroupsGone(decisions, 300);
    assert.ok(result.remaining.includes(pgid), "surviving group reported remaining");
    assert.equal(isGroupAlive(pgid), true, "no old-PGID kill happened on restart");

    // Sanity: at least one of the two probes captured liveness (the group one).
    assert.ok(groupProbe || leaderProbe, "group liveness observed");
    store.close();
  } finally {
    if (leader) {
      try {
        process.kill(-guard(leader.pid), "SIGKILL");
      } catch {
        /* gone */
      }
      await waitGroupGone(leader.pid);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("once the recorded group is gone, quarantine releases cleanly", async () => {
  const dir = makeTmp();
  try {
    const store = await openStore(dir);
    store.beginServiceRun("boot-OLD", 1, 1000);
    const child = spawnSleeper();
    store.insertProcessReceipt({
      receiptId: "gone-1",
      assignmentId: "asg-gone",
      bootId: "boot-OLD",
      pid: child.pid,
      pgid: child.pid,
      commandRedacted: "sleep",
      state: "started",
      createdAt: 1000,
      updatedAt: 1000,
    });
    const decisions = planQuarantine(store, "boot-NOW");
    // Force the group down ourselves (we own it), then wait.
    await killOwn(child);
    assert.equal(await waitGroupGone(child.pid), true);
    const result = await waitForGroupsGone(decisions, 2000);
    assert.equal(result.remaining.length, 0, "no groups remain");
    assert.equal(canReleaseQuarantine(decisions).ok, true, "release allowed after groups gone");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
