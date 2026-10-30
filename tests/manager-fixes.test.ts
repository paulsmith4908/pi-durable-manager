/**
 * Focused regression tests for the CTO correctness fixes (issues 1-8) that
 * hardened event-driven manager wake-up. Everything here uses a FAKE CLI/adapter
 * only: no real Codex, no daemon, no private home, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MetadataStore, type ManagerEventRecord } from "../src/store.js";
import { ManagerWakeCoordinator } from "../src/manager-coordinator.js";
import { ManagerDispatcher, buildManagerEnv, MANAGER_ENV_ALLOWLIST } from "../src/manager-dispatcher.js";
import { buildWakePrompt, PROMPT_BATCH_MAX } from "../src/manager-events.js";

async function makeStore(): Promise<{ store: MetadataStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pdm-mgr-fixes-"));
  assert.ok(dir.startsWith(tmpdir()), "fixture must live under the OS temp dir");
  const store = await MetadataStore.open(join(dir, "metadata.sqlite"));
  const now = Date.now();
  store.insertProject({ id: "p1", name: "demo", path: join(dir, "proj"), origin: "created", requestId: "r1", createdAt: now, updatedAt: now });
  return { store, dir };
}

async function cleanup(dir: string): Promise<void> {
  assert.ok(dir.startsWith(tmpdir()), "refuse to clean a non-temp path");
  await rm(dir, { recursive: true, force: true });
}

function event(overrides: Partial<ManagerEventRecord> & { eventId: string; dedupKey: string }): ManagerEventRecord {
  const now = Date.now();
  return {
    projectId: "p1",
    assignmentId: "a1",
    conversationId: null,
    kind: "failed",
    state: "failed",
    threadId: null,
    summary: "s",
    payload: "{}",
    deliveryState: "pending",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    receipt: null,
    acked: false,
    ackedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---- Issue #1: atomic transition + outbox (rollback together) --------------

test("issue1: a failing outbox insert rolls back the assignment state change", async () => {
  const { store, dir } = await makeStore();
  try {
    const project = store.getProject("p1")!;
    assert.ok(project.id === "p1");
    // Simulate the engine's atomic chokepoint: patch + event in one txn, where
    // the event write throws, so BOTH must roll back.
    let threw = false;
    try {
      store.withTransaction(() => {
        // The "state change" — represented here by a defining write we can undo.
        store.upsertManagerBinding({
          projectId: "p1",
          threadId: "11111111-2222-3333-4444-555555555555",
          requestId: "b",
          boundAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        store.insertManagerEvent(event({ eventId: "mw-x", dedupKey: "k" }));
        throw new Error("event-write-failure");
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    assert.equal(store.getManagerBinding("p1"), undefined, "binding write must roll back");
    assert.equal(store.listManagerEvents().length, 0, "no event may survive a rollback");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("issue1: a committed transaction persists BOTH the write and the event", async () => {
  const { store, dir } = await makeStore();
  try {
    store.withTransaction(() => {
      store.upsertManagerBinding({
        projectId: "p1",
        threadId: "11111111-2222-3333-4444-555555555555",
        requestId: "b",
        boundAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      store.insertManagerEvent(event({ eventId: "mw-ok", dedupKey: "ok" }));
    });
    assert.equal(store.getManagerBinding("p1")?.threadId, "11111111-2222-3333-4444-555555555555");
    assert.equal(store.listManagerEvents().length, 1);
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// ---- Issue #3: bind-from-NOW; no historical replay; rebind isolation -------

test("issue3: binding supersedes pre-bind pending events (no historical replay)", async () => {
  const { store, dir } = await makeStore();
  try {
    // An event recorded BEFORE any binding exists.
    store.insertManagerEvent(event({ eventId: "mw-old", dedupKey: "old", createdAt: 1000, updatedAt: 1000 }));
    const boundAt = Date.now();
    store.upsertManagerBinding({
      projectId: "p1",
      threadId: "11111111-2222-3333-4444-555555555555",
      requestId: "b",
      boundAt,
      createdAt: boundAt,
      updatedAt: boundAt,
    });
    const superseded = store.supersedePendingManagerEvents("p1", boundAt);
    assert.equal(superseded, 1);
    assert.equal(store.getManagerEvent("mw-old")?.deliveryState, "superseded");
    assert.equal(store.listDueManagerEvents("p1", Date.now()).length, 0, "superseded event is never due");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("issue3: rebind does not route an old-target event to the new thread", async () => {
  const { store, dir } = await makeStore();
  try {
    const t1 = "11111111-2222-3333-4444-555555555555";
    const t2 = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    store.upsertManagerBinding({ projectId: "p1", threadId: t1, requestId: "b1", boundAt: 1000, createdAt: 1000, updatedAt: 1000 });
    // Event recorded while bound to t1.
    store.insertManagerEvent(event({ eventId: "mw-t1", dedupKey: "t1", threadId: t1, createdAt: 1500, updatedAt: 1500 }));
    // Rebind to t2 with a later watermark.
    store.upsertManagerBinding({ projectId: "p1", threadId: t2, requestId: "b2", boundAt: 2000, createdAt: 1000, updatedAt: 2000 });
    store.supersedePendingManagerEvents("p1", 2000);
    assert.equal(store.getManagerEvent("mw-t1")?.deliveryState, "superseded");
    assert.equal(store.listDueManagerEvents("p1", Date.now()).length, 0);
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// ---- Issue #4: coordinator retry correctness -------------------------------

test("issue4: a failed dispatch is retried and preserves the earliest backoff deadline", async () => {
  const { store, dir } = await makeStore();
  try {
    let calls = 0;
    const dispatcher = new ManagerDispatcher({
      executable: "codex",
      exec: async () => {
        calls += 1;
        return calls === 1 ? { stdout: "", stderr: "offline", code: 1 } : { stdout: "Queued message m for thread t.", stderr: "", code: 0 };
      },
    });
    store.upsertManagerBinding({ projectId: "p1", threadId: "11111111-2222-3333-4444-555555555555", requestId: "b", boundAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
    const timers: (() => void)[] = [];
    const coord = new ManagerWakeCoordinator({
      metadata: store,
      dispatcher,
      schedule: (fn) => {
        timers.push(fn);
        return setTimeout(() => undefined, 0);
      },
      coalesceMs: 0,
      maxAttempts: 5,
    });
    const id = coord.recordTransition({ assignmentId: "a1", projectId: "p1", conversationId: null, state: "failed", prevState: "running" })!;
    // Run the first pass (fails, schedules a bounded retry).
    timers.shift()!();
    await new Promise((r) => setTimeout(r, 10));
    const afterFail = store.getManagerEvent(id)!;
    assert.equal(afterFail.deliveryState, "pending");
    assert.equal(afterFail.attempts, 1);
    assert.ok(afterFail.nextAttemptAt !== null && afterFail.nextAttemptAt > Date.now(), "a future backoff deadline is set");
    // The coordinator re-armed a timer for that deadline.
    assert.ok(timers.length >= 1, "retry timer must be scheduled (delay not lost)");
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("issue4: parked (exhausted) events are never due again", async () => {
  const { store, dir } = await makeStore();
  try {
    const dispatcher = new ManagerDispatcher({ executable: "codex", exec: async () => ({ stdout: "", stderr: "offline", code: 1 }) });
    store.upsertManagerBinding({ projectId: "p1", threadId: "11111111-2222-3333-4444-555555555555", requestId: "b", boundAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
    const timers: (() => void)[] = [];
    const coord = new ManagerWakeCoordinator({
      metadata: store,
      dispatcher,
      schedule: (fn) => {
        timers.push(fn);
        return setTimeout(() => undefined, 0);
      },
      coalesceMs: 0,
      maxAttempts: 1,
    });
    const id = coord.recordTransition({ assignmentId: "a1", projectId: "p1", conversationId: null, state: "failed", prevState: "running" })!;
    timers.shift()!();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.getManagerEvent(id)?.deliveryState, "parked");
    // A restart-style drain finds nothing due and schedules nothing.
    assert.equal(store.listDueManagerEvents("p1", Date.now() + 10_000_000).length, 0);
    assert.deepEqual(store.listProjectsWithDueManagerEvents(Date.now() + 10_000_000), []);
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("issue4: concurrent projects are delivered fairly (project-scoped batches)", async () => {
  const { store, dir } = await makeStore();
  try {
    store.insertProject({ id: "p2", name: "other", path: join(dir, "proj2"), origin: "created", requestId: "r2", createdAt: Date.now(), updatedAt: Date.now() });
    store.upsertManagerBinding({ projectId: "p1", threadId: "11111111-2222-3333-4444-555555555555", requestId: "b1", boundAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
    store.upsertManagerBinding({ projectId: "p2", threadId: "66666666-7777-8888-9999-aaaaaaaaaaaa", requestId: "b2", boundAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
    const delivered: string[] = [];
    const coord = new ManagerWakeCoordinator({
      metadata: store,
      dispatcher: {
        dispatch: async (threadId: string) => {
          delivered.push(threadId);
          return { ok: true, receipt: "r", error: null, permanent: false };
        },
        stop: async () => undefined,
      } as never,
      coalesceMs: 1,
    });
    coord.recordTransition({ assignmentId: "a1", projectId: "p1", conversationId: null, state: "failed", prevState: "running" });
    coord.recordTransition({ assignmentId: "a2", projectId: "p2", conversationId: null, state: "blocked", prevState: "running" });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual([...delivered].sort(), ["11111111-2222-3333-4444-555555555555", "66666666-7777-8888-9999-aaaaaaaaaaaa"]);
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// ---- Issue #5: stop() aborts AND joins in-flight CLI children --------------

test("issue5: stop() aborts and JOINS a blocked in-flight dispatch before returning", async () => {
  const { store, dir } = await makeStore();
  try {
    let started = false;
    let aborted = false;
    let settled = false;
    const dispatcher = new ManagerDispatcher({
      executable: "codex",
      exec: async (_file, _args, options) => {
        started = true;
        return await new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            aborted = true;
            const err = new Error("aborted") as NodeJS.ErrnoException;
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    });
    const op = dispatcher.dispatch("11111111-2222-3333-4444-555555555555", "hi").then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(started, true, "child started");
    await dispatcher.stop();
    assert.equal(aborted, true, "stop aborted the child");
    const result = await op;
    assert.equal(settled, true, "stop JOINED the in-flight dispatch");
    assert.equal(result.ok, false);
    assert.equal(result.permanent, true);
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// ---- Issue #7: wake prompt keeps all ids, ack-after-action ------------------

test("issue7: a bounded batch still lists every event id with ack-after-action instructions", () => {
  // A batch is BOUNDED (PROMPT_BATCH_MAX); the caller delivers more batches
  // rather than truncating ids. Within the bound every id is present and the
  // essential ack-after-action instruction survives ahead of optional detail.
  const ids = Array.from({ length: PROMPT_BATCH_MAX }, (_, i) => `mw-id-${i}`);
  const prompt = buildWakePrompt({
    eventIds: ids,
    projectId: "p1",
    projectName: "demo",
    threadId: "11111111-2222-3333-4444-555555555555",
    events: ids.map((_, i) => ({ kind: "failed", assignmentId: `a${i}`, state: "failed", summary: "x".repeat(200) })),
  });
  for (const id of ids) assert.match(prompt, new RegExp(id), `prompt must keep id ${id}`);
  // Ack instructions must come AFTER the decision/action instruction.
  const actionIdx = prompt.indexOf("FIRST persist");
  const ackIdx = prompt.indexOf("THEN acknowledge");
  assert.ok(actionIdx >= 0, "prompt must instruct to persist the action first");
  assert.ok(ackIdx > actionIdx, "ack instruction must follow the action instruction");
});

test("issue7: an over-large batch throws rather than silently dropping ids", () => {
  const ids = Array.from({ length: PROMPT_BATCH_MAX + 1 }, (_, i) => `mw-id-${i}`);
  assert.throws(
    () =>
      buildWakePrompt({
        eventIds: ids,
        projectId: "p1",
        projectName: "demo",
        threadId: null,
        events: [],
      }),
    /batch too large/,
  );
});

// ---- Truthful disabled state: records events, never dispatches -------------

test("disabled coordinator still RECORDS durable events but never dispatches", async () => {
  const { store, dir } = await makeStore();
  try {
    // A bound project + a scripted dispatcher that would record a wake if it
    // were ever called. With `enabled:false` it must stay untouched.
    store.upsertManagerBinding({
      projectId: "p1",
      threadId: "11111111-2222-3333-4444-555555555555",
      requestId: "b",
      boundAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let dispatches = 0;
    const timers: (() => void)[] = [];
    const coord = new ManagerWakeCoordinator({
      metadata: store,
      dispatcher: {
        dispatch: async () => {
          dispatches += 1;
          return { ok: true, receipt: "r", error: null, permanent: false };
        },
        stop: async () => undefined,
        get isStopped() {
          return false;
        },
      } as never,
      enabled: false,
      schedule: (fn) => {
        timers.push(fn);
        return setTimeout(() => undefined, 0);
      },
      coalesceMs: 0,
    });
    // The durable event is still written (recording is preserved) ...
    const id = coord.recordTransition({
      assignmentId: "a1",
      projectId: "p1",
      conversationId: null,
      state: "failed",
      prevState: "running",
    });
    assert.ok(id !== null, "a durable event is still recorded when disabled");
    assert.equal(store.getManagerEvent(id!)?.deliveryState, "pending");
    // ... but NO pass is ever scheduled, so nothing can dispatch.
    assert.equal(timers.length, 0, "disabled coordinator must not schedule a pass");
    assert.equal(dispatches, 0, "disabled coordinator must never dispatch");
    // A startup drain is a no-op too.
    coord.drain();
    assert.equal(timers.length, 0, "drain must not schedule when disabled");
    await coord.stop();
    assert.equal(dispatches, 0);
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// ---- Issue #8: portable CODEX_HOME path in the allowlist, no secret --------

test("issue8: allowlist includes CODEX_HOME (a path) and forwards no secret", () => {
  assert.ok(MANAGER_ENV_ALLOWLIST.includes("CODEX_HOME"));
  const env = buildManagerEnv({
    PATH: "/usr/bin",
    CODEX_HOME: "/custom/codex/home",
    OPENAI_API_KEY: "sk-secret",
    ANTHROPIC_API_KEY: "sk-secret2",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CODEX_HOME, "/custom/codex/home");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  for (const key of Object.keys(env)) assert.ok(MANAGER_ENV_ALLOWLIST.includes(key));
});
