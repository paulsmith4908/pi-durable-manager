import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore, type AssignmentRecord } from "../src/store.js";
import { ManagerWakeCoordinator } from "../src/manager-coordinator.js";
import { AdaptiveSupervisor, supervisionPolicy } from "../src/supervision.js";
import { formatActivity } from "../src/activity.js";
import { guardDecision } from "../src/runtime-guard.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pdm-reliable-"));
  const path = join(dir, "metadata.sqlite"); const store = await MetadataStore.open(path);
  const clock = { now: Date.now() };
  store.insertProject({ id: "p", name: "fixture", path: join(dir, "project"), origin: "created", requestId: "p", createdAt: clock.now, updatedAt: clock.now });
  const row: AssignmentRecord = { id: "a", projectId: "p", sessionId: null, conversationId: null, requestId: "a", state: "running",
    acceptanceCriteria: null, submissionId: null, payloadHash: "fixture", parentId: null, task: "fixture task", attemptCount: 0,
    deadlineAt: null, stopReason: null, leasePath: join(dir, "project"), evidence: null, reviewNote: null, reviewedAt: null,
    error: null, createdAt: clock.now, updatedAt: clock.now };
  store.insertAssignment(row);
  store.upsertManagerBinding({ projectId: "p", threadId: "11111111-2222-4333-8444-555555555555", requestId: "bind", boundAt: clock.now, createdAt: clock.now, updatedAt: clock.now });
  const manager = new ManagerWakeCoordinator({ metadata: store, dispatcher: null, enabled: false, now: () => clock.now });
  const supervisor = new AdaptiveSupervisor(store, manager, () => clock.now);
  return { dir, path, store, clock, manager, supervisor, close: async () => { supervisor.stop(); await manager.stop(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("activity journal replays in order after reopen, deduplicates, redacts and rolls back with state", async () => {
  const f = await fixture();
  try {
    f.store.setActivitySecrets(["synthetic-fixture-sensitive"]);
    const input = { kind: "worker.message", projectId: "p", assignmentId: "a", requestId: null, dedupKey: "once", data: { text: "hello synthetic-fixture-sensitive", apiKey: "synthetic-fixture-sensitive", thinking: "not emitted" } };
    const first = f.store.appendActivity(input); assert.equal(f.store.appendActivity(input).seq, first.seq);
    assert.ok(!JSON.stringify(first).includes("synthetic-fixture-sensitive")); assert.ok(!JSON.stringify(first).includes("not emitted"));
    assert.throws(() => f.store.withTransaction(() => { f.store.appendActivity({ ...input, dedupKey: "rollback" }); f.store.updateAssignment("a", { state: "failed" }); throw Error("rollback"); }));
    assert.equal(f.store.getAssignment("a")?.state, "running");
    const other = await MetadataStore.open(f.path);
    try { assert.deepEqual(other.listActivity(0), [first]); assert.deepEqual(other.listActivity(first.seq), []); }
    finally { other.close(); }
    const terminal = formatActivity({ ...first, data: "\x1b]52;c;fixture\x07\x1b[2J" });
    assert.ok(!terminal.includes("\x1b"));
  } finally { await f.close(); }
});

test("adaptive checks persist next time, distinguish a live command, and never clear its lease", async () => {
  const f = await fixture();
  try {
    f.supervisor.configure("a", { startIntervalMs: 1000, commandIntervalMs: 10000, idleWarningMs: 2000 });
    f.supervisor.stop();
    const first = f.supervisor.snapshot("a")!; assert.equal(first.nextCheckAt, f.clock.now + 1000);
    f.store.insertProcessReceipt({ receiptId: "r", assignmentId: "a", bootId: "fixture", pid: 999, pgid: 999, commandRedacted: "fixture long command", state: "started", createdAt: f.clock.now, updatedAt: f.clock.now });
    f.clock.now += 1000; f.supervisor.tick();
    assert.equal(f.supervisor.snapshot("a")?.phase, "command"); assert.equal(f.supervisor.snapshot("a")?.intervalMs, 10000);
    const replacement = new AdaptiveSupervisor(f.store, f.manager, () => f.clock.now);
    replacement.tick(); assert.equal(replacement.snapshot("a")?.nextCheckAt, f.clock.now + 10000);
    f.clock.now += 10000; replacement.tick();
    assert.equal(f.store.getAssignment("a")?.state, "running"); assert.ok(f.store.getAssignment("a")?.leasePath);
    assert.equal(f.store.listManagerEvents().filter(e => e.kind === "stale_progress").length, 1);
    f.clock.now += 10000; replacement.tick();
    assert.equal(f.store.listManagerEvents().filter(e => e.kind === "stale_progress").length, 1);
  } finally { await f.close(); }
});

test("expected quiet work defers inactivity attention but not the explicit manager review", async () => {
  const f = await fixture();
  try {
    f.supervisor.configure("a", { startIntervalMs: 1000, idleWarningMs: 1000, expectedQuietUntil: f.clock.now + 20000, nextReviewAt: f.clock.now + 1500, reason: "Known long build; review separately" });
    f.supervisor.stop(); f.clock.now += 2000; f.supervisor.tick();
    const events = f.store.listManagerEvents(); assert.equal(events.length, 1); assert.equal(events[0]!.kind, "review_due");
    assert.equal(f.supervisor.policy("a").nextReviewAt, null); assert.equal(f.store.getAssignment("a")?.deadlineAt, null);
  } finally { await f.close(); }
});

test("a delivered-but-unhandled wake reuses its event ID with bounded durable reminders", async () => {
  const f = await fixture();
  try {
    f.supervisor.configure("a", { ackReminderMs: 1000, maxAckReminders: 1 }); f.supervisor.stop();
    const id = f.manager.recordTransition({ assignmentId: "a", projectId: "p", conversationId: null, state: "needs_review", prevState: "running" })!;
    f.store.updateAssignment("a", { state: "needs_review" }); f.store.updateManagerEventDelivery(id, { deliveryState: "delivered" });
    f.clock.now += 2000; f.supervisor.tick(); assert.equal(f.store.getManagerEvent(id)?.deliveryState, "pending");
    f.store.updateManagerEventDelivery(id, { deliveryState: "delivered" }); f.clock.now += 10000; f.supervisor.tick();
    assert.equal(f.store.getManagerEvent(id)?.deliveryState, "delivered"); assert.equal(f.store.listManagerEvents().length, 1);
    assert.equal(f.store.listActivity().filter(e => e.kind === "wake.reminder").length, 1);
  } finally { await f.close(); }
});

test("supervision rejects deadlines and malformed policy rather than creating hidden run limits", () => {
  assert.throws(() => supervisionPolicy({ timeoutMs: 1000 }), /Unknown supervision/);
  assert.throws(() => supervisionPolicy({ activeIntervalMs: 0 }), /must be between/);
  assert.throws(() => supervisionPolicy({ maxAckReminders: 100 }), /reminder/);
});

test("independent guard respects operator stops and never restarts over a live/unknown owner", () => {
  assert.equal(guardDecision({ healthy: false, paused: true, owner: "dead" }), "paused");
  assert.equal(guardDecision({ healthy: false, paused: false, owner: "alive" }), "hold");
  assert.equal(guardDecision({ healthy: false, paused: false, owner: "unknown" }), "hold");
  assert.equal(guardDecision({ healthy: false, paused: false, owner: "dead" }), "start");
  assert.equal(guardDecision({ healthy: true, paused: false, owner: "alive" }), "healthy");
});

test("a settled snapshot follows later manager acceptance without remaining falsely awaiting review", async () => {
  const f = await fixture();
  try {
    f.supervisor.tick();
    f.store.updateAssignment("a", { state: "needs_review" }); f.supervisor.tick();
    assert.equal(f.supervisor.snapshot("a")?.phase, "awaiting_manager");
    f.store.updateAssignment("a", { state: "accepted" }); f.supervisor.tick();
    assert.equal(f.supervisor.snapshot("a")?.phase, "settled");
    assert.equal(f.supervisor.snapshot("a")?.state, "accepted");
    assert.equal(f.supervisor.snapshot("a")?.nextCheckAt, null);
  } finally { await f.close(); }
});

test("repeated reads surface as a loop once per edit epoch, never cancel a writer", async () => {
  const f=await fixture();
  try {
    f.store.setControl("work-memory:a",{seen:[],reads:[],edits:[],readsSinceEdit:60,lastEditAt:null,loop:true});
    f.supervisor.configure("a",{startIntervalMs:1000,activeIntervalMs:1000,idleWarningMs:86400000});
    f.supervisor.stop();
    assert.equal(f.supervisor.snapshot("a")?.phase,"read_loop");
    for(let i=0;i<3;i++){f.clock.now+=2000;f.supervisor.tick();}
    assert.equal(f.store.listManagerEvents("p",true).filter(e=>e.dedupKey.startsWith("read-loop:")).length,1);
    assert.equal(f.store.getAssignment("a")?.state,"running");
    assert.ok(f.store.getAssignment("a")?.leasePath);
  } finally {await f.close();}
});
