import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MetadataStore } from "../src/store.js";
import {
  buildManagerEnv,
  parseQueueReceipt,
  ManagerDispatcher,
  retryBackoffMs,
  MANAGER_ENV_ALLOWLIST,
} from "../src/manager-dispatcher.js";
import { ManagerWakeCoordinator } from "../src/manager-coordinator.js";
import { buildWakePrompt, isWakeState, wakeDedupKey, PROMPT_BATCH_MAX } from "../src/manager-events.js";

async function makeStore(): Promise<{ store: MetadataStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pdm-manager-"));
  assert.ok(dir.startsWith(tmpdir()), "fixture must live under the OS temp dir");
  const store = await MetadataStore.open(join(dir, "metadata.sqlite"));
  const now = Date.now();
  store.insertProject({
    id: "p1",
    name: "demo",
    path: join(dir, "proj"),
    origin: "created",
    requestId: "r1",
    createdAt: now,
    updatedAt: now,
  });
  return { store, dir };
}

async function cleanup(dir: string): Promise<void> {
  assert.ok(dir.startsWith(tmpdir()), "refuse to clean a non-temp path");
  await rm(dir, { recursive: true, force: true });
}

// ---- Classification --------------------------------------------------------

test("wake classification: only meaningful states wake; routine states do not", () => {
  assert.equal(isWakeState("needs_review", "running"), true);
  assert.equal(isWakeState("blocked", "running"), true);
  assert.equal(isWakeState("failed", "running"), true);
  assert.equal(isWakeState("unanswered", "running"), true);
  assert.equal(isWakeState("budget", "running"), true);
  assert.equal(isWakeState("timeout", "running"), true);
  // Routine / operator-cancel transitions never wake.
  assert.equal(isWakeState("accepted", "needs_review"), false);
  assert.equal(isWakeState("revision_requested", "needs_review"), false);
  assert.equal(isWakeState("running", "queued"), false);
  assert.equal(isWakeState("cancelled", "running"), false);
  assert.equal(isWakeState("cancelling", "running"), false);
  // Re-observing the SAME state is not a transition.
  assert.equal(isWakeState("failed", "failed"), false);
});

test("dedup key is stable and scoped per project/assignment/kind/state", () => {
  const a = wakeDedupKey({ projectId: "p1", assignmentId: "a1", kind: "failed", state: "failed" });
  const b = wakeDedupKey({ projectId: "p1", assignmentId: "a1", kind: "failed", state: "failed" });
  const c = wakeDedupKey({ projectId: "p2", assignmentId: "a1", kind: "failed", state: "failed" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("wake prompt carries ids + summaries, never a raw transcript", () => {
  const prompt = buildWakePrompt({
    eventIds: ["mw-1"],
    projectId: "p1",
    projectName: "demo",
    threadId: "11111111-2222-3333-4444-555555555555",
    events: [{ kind: "failed", assignmentId: "a1", state: "failed", summary: "assignment failed" }],
  });
  assert.match(prompt, /mw-1/);
  assert.match(prompt, /IDEMPOTENTLY/i);
  assert.match(prompt, /UNTRUSTED/i);
});

test("wake prompt: all ids + essential ack instructions precede optional summaries", () => {
  const ids = Array.from({ length: PROMPT_BATCH_MAX }, (_, i) => `mw-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const events = ids.map((_, i) => ({
    kind: "manager_request",
    assignmentId: `a-${i}`,
    state: "blocked",
    summary: "x".repeat(300),
  }));
  const prompt = buildWakePrompt({
    eventIds: ids,
    projectId: "p1",
    projectName: "n".repeat(200),
    threadId: "11111111-2222-3333-4444-555555555555",
    events,
  });
  assert.ok(prompt.length <= 4000, `prompt must fit the transport cap, got ${prompt.length}`);
  for (const id of ids) assert.ok(prompt.includes(id), `every id must be present: ${id}`);
  assert.match(prompt, /manager\.ack/, "ack instruction must be present");
  // The essential ack instruction must appear BEFORE the optional summary block.
  const ackAt = prompt.indexOf("manager.ack");
  const summaryAt = prompt.indexOf("Summary (optional detail");
  if (summaryAt !== -1) assert.ok(ackAt < summaryAt, "ack instruction must precede optional summary");
});

test("wake prompt: refuses an over-large batch rather than dropping ids", () => {
  const ids = Array.from({ length: PROMPT_BATCH_MAX + 1 }, () => "mw-x");
  assert.throws(
    () => buildWakePrompt({ eventIds: ids, projectId: "p1", projectName: "d", threadId: null, events: [] }),
    /batch too large/,
  );
});

test("100 real-length mw-UUID events deliver in bounded batches; every delivered event is identifiable", async () => {
  const { store, dir } = await makeStore();
  try {
    const now = Date.now();
    store.upsertManagerBinding({ projectId: "p1", threadId: "t-p1", requestId: "b1", createdAt: now, updatedAt: now });
    const longName = "EmberVault-" + "N".repeat(180);
    store.insertProject({
      id: "p2",
      name: longName,
      path: join(dir, "p2"),
      origin: "created",
      requestId: "r2",
      createdAt: now,
      updatedAt: now,
    });
    store.upsertManagerBinding({ projectId: "p2", threadId: "t-p2", requestId: "b2", createdAt: now, updatedAt: now });

    const longSummary = "S".repeat(360);
    const ids: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const eventId = `mw-${String(i).padStart(8, "0")}-abcd-4def-8abc-${String(i).padStart(12, "0")}`;
      ids.push(eventId);
      store.insertManagerEvent({
        eventId,
        projectId: "p1",
        assignmentId: `a-${i}`,
        conversationId: null,
        kind: "manager_request",
        state: "blocked",
        dedupKey: `p1:a-${i}:manager_request:blocked`,
        threadId: "t-p1",
        summary: longSummary,
        payload: "{}",
        deliveryState: "pending",
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        receipt: null,
        acked: false,
        ackedAt: null,
        createdAt: now + i,
        updatedAt: now + i,
      });
    }

    const messages: { threadId: string; message: string }[] = [];
    const dispatcher = {
      dispatch: async (threadId: string, message: string) => {
        assert.ok(message.length <= 4000, `prompt exceeded transport cap: ${message.length}`);
        messages.push({ threadId, message });
        return { ok: true, receipt: "r", error: null, permanent: false };
      },
      stop: async () => undefined,
    };
    // Scheduler that flushes every armed timer until quiescent, so multiple
    // bounded batches run back-to-back without waiting on real time.
    const timers: (() => void)[] = [];
    const coord = new ManagerWakeCoordinator({
      metadata: store,
      dispatcher: dispatcher as never,
      coalesceMs: 0,
      schedule: (fn) => {
        timers.push(fn);
        return setTimeout(() => undefined, 0);
      },
    });

    coord.drain();
    // Drain until no more timers are armed (bounded iterations to avoid hangs).
    for (let i = 0; i < 50 && timers.length > 0; i += 1) {
      const fn = timers.shift()!;
      fn();
      await new Promise((r) => setTimeout(r, 5));
    }

    assert.ok(messages.length >= Math.ceil(100 / PROMPT_BATCH_MAX), "events were split into at least this many batches");
    // Every event marked DELIVERED must be identifiable from the message that
    // carried it: its id must appear verbatim in exactly one delivered message,
    // and that message must contain the ack instruction.
    const deliveredIds = new Set<string>();
    for (const { message } of messages) {
      assert.match(message, /manager\.ack/, "each batch must carry the ack instruction");
      for (const id of ids) if (message.includes(id)) deliveredIds.add(id);
    }
    for (const event of store.listManagerEvents("p1", false)) {
      if (event.deliveryState === "delivered") {
        assert.ok(deliveredIds.has(event.eventId), `delivered event ${event.eventId} was not identifiable from its message`);
      }
    }
    assert.equal(deliveredIds.size, 100, "all 100 event ids must appear in delivered messages");
    assert.equal(store.countPendingManagerEvents("p1"), 0, "all events delivered");
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// ---- Durable store atomicity / idempotency ---------------------------------

test("insertManagerEvent is idempotent on dedup key and never re-inserts", async () => {
  const { store, dir } = await makeStore();
  try {
    const now = Date.now();
    const rec = {
      eventId: "mw-1",
      projectId: "p1",
      assignmentId: "a1",
      conversationId: null,
      kind: "failed",
      state: "failed",
      dedupKey: "p1:a1:failed:failed",
      threadId: null,
      summary: "failed",
      payload: "{}",
      deliveryState: "pending" as const,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      receipt: null,
      acked: false,
      ackedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const first = store.insertManagerEvent(rec);
    assert.equal(first.inserted, true);
    const second = store.insertManagerEvent({ ...rec, eventId: "mw-2" });
    assert.equal(second.inserted, false, "duplicate dedup key must not insert");
    assert.equal(second.record.eventId, "mw-1");
    assert.equal(store.countPendingManagerEvents("p1"), 1);
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("ackManagerEvent is idempotent and removes the event from pending", async () => {
  const { store, dir } = await makeStore();
  try {
    const now = Date.now();
    store.insertManagerEvent({
      eventId: "mw-1",
      projectId: "p1",
      assignmentId: "a1",
      conversationId: null,
      kind: "blocked",
      state: "blocked",
      dedupKey: "p1:a1:blocked:blocked",
      threadId: null,
      summary: "blocked",
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
    });
    store.ackManagerEvent("mw-1", now);
    store.ackManagerEvent("mw-1", now + 1); // no-op
    assert.equal(store.getManagerEvent("mw-1")?.acked, true);
    assert.equal(store.countPendingManagerEvents("p1"), 0);
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// ---- Dispatcher (fake CLI only) --------------------------------------------

test("dispatcher builds a codex queue ARGV array (no shell) with allowlisted env", async () => {
  const seen: { file: string; args: readonly string[]; env: Record<string, string> }[] = [];
  const dispatcher = new ManagerDispatcher({
    executable: "/opt/codex/bin/codex",
    exec: async (file, args, options) => {
      seen.push({ file, args, env: options.env });
      return { stdout: "Queued message abc-123 for thread t-1.\n", stderr: "", code: 0 };
    },
  });
  const result = await dispatcher.dispatch("t-1", "hello manager");
  assert.equal(result.ok, true);
  assert.equal(result.receipt, "abc-123");
  assert.equal(seen.length, 1);
  const call = seen[0]!;
  assert.equal(call.file, "/opt/codex/bin/codex");
  assert.deepEqual(call.args, ["queue", "--thread", "t-1", "--message", "hello manager"]);
  // No secrets leak: only allowlisted keys, and nothing resembling a model key.
  for (const key of Object.keys(call.env)) {
    assert.ok(MANAGER_ENV_ALLOWLIST.includes(key), `unexpected env key leaked: ${key}`);
    assert.ok(!/API_?KEY|TOKEN|SECRET/i.test(key), `secret-looking env key leaked: ${key}`);
  }
});

test("dispatcher surfaces a non-zero exit honestly (no false success)", async () => {
  const dispatcher = new ManagerDispatcher({
    executable: "codex",
    exec: async () => ({ stdout: "", stderr: "no such thread", code: 2 }),
  });
  const result = await dispatcher.dispatch("t-1", "hi");
  assert.equal(result.ok, false);
  assert.equal(result.receipt, null);
  assert.match(result.error ?? "", /codex queue exited 2/);
});

test("dispatcher marks a missing binary (ENOENT) permanent", async () => {
  const dispatcher = new ManagerDispatcher({
    executable: "definitely-not-installed",
    exec: async () => {
      const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
  });
  const result = await dispatcher.dispatch("t-1", "hi");
  assert.equal(result.ok, false);
  assert.equal(result.permanent, true);
});

test("parseQueueReceipt accepts trusted exit-0 with or without an id", () => {
  assert.deepEqual(parseQueueReceipt("Queued message m-1 for thread t.", 0), { receipt: "m-1", ok: true });
  assert.deepEqual(parseQueueReceipt("ok\n", 0), { receipt: null, ok: true });
  assert.deepEqual(parseQueueReceipt("Queued message m-1", 1), { receipt: null, ok: false });
});

test("buildManagerEnv forwards only allowlisted, non-empty vars", () => {
  const env = buildManagerEnv({ PATH: "/usr/bin", HOME: "/home/u", OPENAI_API_KEY: "sk-x", EMPTY: "" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.EMPTY, undefined);
});

test("retryBackoffMs grows exponentially and is capped", () => {
  const first = retryBackoffMs(1, 1000, 10_000);
  const later = retryBackoffMs(8, 1000, 10_000);
  assert.ok(first >= 1000 && first <= 2000);
  assert.ok(later <= 10_000);
});

// ---- Coordinator (fake dispatcher only) ------------------------------------

function instantScheduler(): { schedule: (fn: () => void, ms: number) => NodeJS.Timeout; run: () => void } {
  const queue: (() => void)[] = [];
  return {
    schedule: (fn) => {
      queue.push(fn);
      return setTimeout(() => undefined, 0);
    },
    run: () => {
      while (queue.length > 0) queue.shift()!();
    },
  };
}

test("coordinator records an event only for a wake transition (no routine event)", async () => {
  const { store, dir } = await makeStore();
  try {
    const dispatcher = new ManagerDispatcher({
      executable: "codex",
      exec: async () => ({ stdout: "Queued message x for thread y.", stderr: "", code: 0 }),
    });
    const sched = instantScheduler();
    const coord = new ManagerWakeCoordinator({ metadata: store, dispatcher, schedule: sched.schedule, coalesceMs: 0 });
    const routine = coord.recordTransition({
      assignmentId: "a1",
      projectId: "p1",
      conversationId: null,
      state: "accepted",
      prevState: "needs_review",
    });
    assert.equal(routine, null, "accepted must not create an event");
    const wake = coord.recordTransition({
      assignmentId: "a2",
      projectId: "p1",
      conversationId: null,
      state: "failed",
      prevState: "running",
    });
    assert.ok(wake !== null);
    assert.equal(store.listManagerEvents().length, 1);
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("coordinator dedups the same transition and never double-delivers", async () => {
  const { store, dir } = await makeStore();
  try {
    let calls = 0;
    const dispatcher = new ManagerDispatcher({
      executable: "codex",
      exec: async () => {
        calls += 1;
        return { stdout: "Queued message m for thread t.", stderr: "", code: 0 };
      },
    });
    store.upsertManagerBinding({
      projectId: "p1",
      threadId: "t-1",
      requestId: "req-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const sched = instantScheduler();
    const coord = new ManagerWakeCoordinator({ metadata: store, dispatcher, schedule: sched.schedule, coalesceMs: 0 });
    const t = { assignmentId: "a1", projectId: "p1", conversationId: null, state: "failed", prevState: "running" };
    const e1 = coord.recordTransition(t);
    const e2 = coord.recordTransition(t);
    assert.equal(e1, e2, "same transition returns the same event id");
    sched.run();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 1, "dedup means exactly one CLI dispatch");
    assert.equal(store.getManagerEvent(e1!)?.deliveryState, "delivered");
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("unbound project leaves events pending and does not spin the CLI", async () => {
  const { store, dir } = await makeStore();
  try {
    let calls = 0;
    const dispatcher = new ManagerDispatcher({
      executable: "codex",
      exec: async () => {
        calls += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    const sched = instantScheduler();
    const coord = new ManagerWakeCoordinator({ metadata: store, dispatcher, schedule: sched.schedule, coalesceMs: 0 });
    coord.recordTransition({
      assignmentId: "a1",
      projectId: "p1",
      conversationId: null,
      state: "blocked",
      prevState: "running",
    });
    sched.run();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 0, "unbound project must never call the CLI");
    assert.equal(store.countPendingManagerEvents("p1"), 1);
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("unbound project with a stale failed-retry pending event never schedules an idle timer (fake clock)", async () => {
  const { store, dir } = await makeStore();
  try {
    let calls = 0;
    const dispatcher = new ManagerDispatcher({
      executable: "codex",
      exec: async () => {
        calls += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    const now = Date.now();
    // A pending event that had already failed once: it carries a stale
    // `next_attempt_at` a full backoff window in the future. Before the fix,
    // `runPass` would skip deliver (unbound) but `rearm` would keep reading
    // this deadline and reschedule forever — a hot loop with zero LM calls.
    store.insertManagerEvent({
      eventId: "mw-stale",
      projectId: "p1",
      assignmentId: "a1",
      conversationId: null,
      kind: "blocked",
      state: "blocked",
      dedupKey: "p1:a1:blocked:blocked",
      threadId: null,
      summary: "blocked",
      payload: "{}",
      deliveryState: "pending",
      attempts: 1,
      nextAttemptAt: now + retryBackoffMs(1),
      lastError: "offline",
      receipt: null,
      acked: false,
      ackedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // Fake clock: manual `now`, and a scheduler that records however many
    // timers are armed and lets us advance time deterministically. `scheduled`
    // and `passes` must not grow while unbound.
    let clock = now;
    const timers = new Map<number, () => void>();
    let nextHandle = 1;
    let scheduled = 0;
    const coord = new ManagerWakeCoordinator({
      metadata: store,
      dispatcher,
      coalesceMs: 0,
      now: () => clock,
      schedule: (fn) => {
        scheduled += 1;
        const handle = nextHandle++;
        timers.set(handle, fn);
        return { ref() {}, unref() {}, hasRef: () => false, refresh: () => handle, [Symbol.toPrimitive]: () => handle } as unknown as NodeJS.Timeout;
      },
      cancel: ((handle: unknown) => {
        timers.delete(Number(handle));
      }) as never,
    });

    // Kick off one pass (as a startup drain would); it must PARK, not re-arm.
    coord.drain();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 0, "unbound project must never call the CLI");
    assert.equal(timers.size, 0, "unbound project must have NO idle query timer");

    // Advance the fake clock a LONG way and run any timer that might be armed.
    for (let i = 0; i < 50; i += 1) {
      clock += 60_000;
      for (const [handle, fn] of [...timers.entries()]) {
        timers.delete(handle);
        fn();
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    assert.equal(scheduled, 0, "no additional pass/timer may be scheduled while unbound");
    assert.equal(timers.size, 0, "no timer may remain armed while unbound");
    assert.equal(calls, 0, "still zero CLI calls after a long interval");
    assert.equal(store.getManagerEvent("mw-stale")?.deliveryState, "pending", "event preserved for a future bind");
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("bound pending retry still honors its backoff (no busy loop) — fake clock", async () => {
  const { store, dir } = await makeStore();
  try {
    let calls = 0;
    const dispatcher = new ManagerDispatcher({
      executable: "codex",
      exec: async () => {
        calls += 1;
        return { stdout: "", stderr: "still down", code: 1 };
      },
    });
    const now = Date.now();
    store.upsertManagerBinding({ projectId: "p1", threadId: "t-1", requestId: "req-1", createdAt: now, updatedAt: now });
    let clock = now;
    const timers = new Map<number, () => void>();
    let nextHandle = 1;
    let scheduled = 0;
    const coord = new ManagerWakeCoordinator({
      metadata: store,
      dispatcher,
      coalesceMs: 0,
      maxAttempts: 5,
      now: () => clock,
      schedule: (fn) => {
        scheduled += 1;
        const handle = nextHandle++;
        timers.set(handle, fn);
        return { refresh: () => handle, [Symbol.toPrimitive]: () => handle } as unknown as NodeJS.Timeout;
      },
      cancel: ((handle: unknown) => {
        timers.delete(Number(handle));
      }) as never,
    });
    const id = coord.recordTransition({
      assignmentId: "a1",
      projectId: "p1",
      conversationId: null,
      state: "failed",
      prevState: "running",
    });
    assert.ok(id !== null);
    // Run the initial (coalesce 0) pass.
    for (const [handle, fn] of [...timers.entries()]) {
      timers.delete(handle);
      fn();
    }
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 1, "first attempt dispatches once");
    assert.equal(timers.size, 1, "a single bounded backoff timer is armed");
    // The retry is not due until the backoff elapses: advancing by less than the
    // backoff must NOT trigger another pass.
    clock += retryBackoffMs(1) - 1;
    assert.equal(calls, 1, "no early retry before the backoff window");
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("delivery failure PARKS the event after maxAttempts (never redelivered on restart)", async () => {
  const { store, dir } = await makeStore();
  try {
    const dispatcher = new ManagerDispatcher({
      executable: "codex",
      exec: async () => ({ stdout: "", stderr: "offline", code: 1 }),
    });
    store.upsertManagerBinding({
      projectId: "p1",
      threadId: "t-1",
      requestId: "req-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const sched = instantScheduler();
    const coord = new ManagerWakeCoordinator({
      metadata: store,
      dispatcher,
      schedule: sched.schedule,
      coalesceMs: 0,
      maxAttempts: 1,
    });
    const id = coord.recordTransition({
      assignmentId: "a1",
      projectId: "p1",
      conversationId: null,
      state: "failed",
      prevState: "running",
    });
    sched.run();
    await new Promise((r) => setTimeout(r, 5));
    const row = store.getManagerEvent(id!);
    assert.equal(row?.deliveryState, "parked");
    assert.equal(row?.attempts, 1);
    assert.match(row?.lastError ?? "", /offline/);
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// ---- Dispatcher: argv/env secrecy & malformed output ----------------------

test("dispatcher argv is a plain array: no shell, secrets absent from args and env", async () => {
  const seen: { file: string; args: readonly string[]; env: Record<string, string> }[] = [];
  const dispatcher = new ManagerDispatcher({
    executable: "/opt/manager/bin/codex",
    exec: async (file, args, options) => {
      seen.push({ file, args, env: options.env });
      return { stdout: `Queued message msg-1 for thread t1.\n`, stderr: "", code: 0 };
    },
  });
  const secret = "sk-super-secret-provider-key";
  process.env.PDM_TEST_ONLY_SECRET = secret;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  try {
    const result = await dispatcher.dispatch("t1", "manager prompt");
    assert.equal(result.ok, true);
    assert.equal(result.receipt, "msg-1");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.file, "/opt/manager/bin/codex");
    assert.deepEqual(seen[0]!.args, ["queue", "--thread", "t1", "--message", "manager prompt"]);
    const envJson = JSON.stringify(seen[0]!.env);
    assert.doesNotMatch(envJson, /sk-super-secret-provider-key/, "no provider secret may reach the CLI env");
    assert.equal(seen[0]!.env.OPENAI_API_KEY, undefined);
    assert.equal(seen[0]!.env.PDM_TEST_ONLY_SECRET, undefined);
    for (const key of Object.keys(seen[0]!.env)) {
      assert.ok(MANAGER_ENV_ALLOWLIST.includes(key), `unexpected env key ${key}`);
    }
  } finally {
    delete process.env.PDM_TEST_ONLY_SECRET;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  }
});

test("dispatcher tolerates malformed queue output without false success", async () => {
  const dispatcher = new ManagerDispatcher({
    executable: "codex",
    exec: async () => ({ stdout: "garbage\nblargh", stderr: "boom", code: 2 }),
  });
  const result = await dispatcher.dispatch("t9", "x");
  assert.equal(result.ok, false);
  assert.equal(result.receipt, null);
  assert.match(result.error ?? "", /exited 2/);
});

test("parseQueueReceipt tolerates whitespace, case, and missing trailing punctuation", () => {
  assert.equal(parseQueueReceipt("queued   MESSAGE abc-123 for thread z", 0).receipt, "abc-123");
  assert.equal(parseQueueReceipt("Queued message m1 for thread", 0).receipt, "m1");
  assert.equal(parseQueueReceipt("", 1).ok, false);
  assert.equal(parseQueueReceipt("Queued message m1", 1).ok, false);
});

// ---- Coordinator: concurrency, coalescing, no cross-project leak ----------

test("concurrent projects are delivered independently and never cross-leak", async () => {
  const { store, dir } = await makeStore();
  try {
    const now = Date.now();
    store.insertProject({ id: "p2", name: "other", path: join(dir, "proj2"), origin: "created", requestId: "r2", createdAt: now, updatedAt: now });
    store.upsertManagerBinding({ projectId: "p1", threadId: "t-p1", requestId: "b1", createdAt: now, updatedAt: now });
    store.upsertManagerBinding({ projectId: "p2", threadId: "t-p2", requestId: "b2", createdAt: now, updatedAt: now });

    const delivered: { threadId: string; message: string }[] = [];
    const coord = new ManagerWakeCoordinator({
      metadata: store,
      dispatcher: {
        dispatch: async (threadId: string, message: string) => {
          delivered.push({ threadId, message });
          return { ok: true, receipt: "r", error: null, permanent: false };
        },
        stop: async () => undefined,
      } as never,
      coalesceMs: 1,
    });

    coord.recordTransition({ assignmentId: "ASSIGN-P1-ONLY", projectId: "p1", conversationId: null, state: "failed", prevState: "running" });
    coord.recordTransition({ assignmentId: "ASSIGN-P2-ONLY", projectId: "p2", conversationId: null, state: "blocked", prevState: "running" });
    // One pass per project; real timers fire independently.
    await new Promise((r) => setTimeout(r, 30));

    const threads = delivered.map((d) => d.threadId).sort();
    assert.deepEqual(threads, ["t-p1", "t-p2"]);
    const p1 = delivered.find((d) => d.threadId === "t-p1")!;
    const p2 = delivered.find((d) => d.threadId === "t-p2")!;
    assert.match(p1.message, /ASSIGN-P1-ONLY/);
    assert.doesNotMatch(p1.message, /ASSIGN-P2-ONLY/, "p1 wake must not mention p2's assignment");
    assert.match(p2.message, /ASSIGN-P2-ONLY/);
    assert.doesNotMatch(p2.message, /ASSIGN-P1-ONLY/, "p2 wake must not mention p1's assignment");
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("multiple events in one project coalesce into a single wake carrying each id", async () => {
  const { store, dir } = await makeStore();
  try {
    const now = Date.now();
    store.upsertManagerBinding({ projectId: "p1", threadId: "t-p1", requestId: "b1", createdAt: now, updatedAt: now });
    const delivered: string[] = [];
    const sched = { fn: null as (() => void) | null, run() { const f = this.fn; this.fn = null; f?.(); } };
    const coord = new ManagerWakeCoordinator({
      metadata: store,
      dispatcher: {
        dispatch: async (_t: string, message: string) => {
          delivered.push(message);
          return { ok: true, receipt: "r", error: null, permanent: false };
        },
        stop: async () => undefined,
      } as never,
      schedule: (fn) => { sched.fn = fn; return setTimeout(() => undefined, 0); },
    });

    coord.recordTransition({ assignmentId: "a1", projectId: "p1", conversationId: null, state: "failed", prevState: "running" });
    coord.recordTransition({ assignmentId: "a2", projectId: "p1", conversationId: null, state: "blocked", prevState: "running" });
    sched.run();
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(delivered.length, 1, "two events coalesce into one wake");
    const events = store.listManagerEvents("p1", false);
    assert.equal(events.length, 2);
    for (const event of events) assert.match(delivered[0]!, new RegExp(event.eventId));
    for (const event of events) assert.equal(store.getManagerEvent(event.eventId)?.deliveryState, "delivered");
    await coord.stop();
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test('restart restores a future wake retry without another transition or polling', async () => {
  const fx = await makeStore();
  let store = fx.store;
  let clock = 100000, calls = 0, handle = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const create = () => new ManagerWakeCoordinator({
    metadata: store, coalesceMs: 0, now: () => clock,
    dispatcher: new ManagerDispatcher({ executable: 'codex', exec: async () => {
      calls++;
      return calls === 1 ? { stdout: '', stderr: 'offline', code: 1 } : { stdout: '', stderr: '', code: 0 };
    }}),
    schedule: (fn, ms) => { const id = ++handle; timers.set(id, { due: clock + ms, fn }); return id as unknown as NodeJS.Timeout; },
    cancel: timer => { timers.delete(timer as unknown as number); },
  });
  const runReady = async () => {
    for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.fn(); }
    await new Promise(resolve => setTimeout(resolve, 5));
  };
  let coordinator = create();
  try {
    store.upsertManagerBinding({ projectId: 'p1', threadId: 't1', requestId: 'bind', createdAt: clock, updatedAt: clock });
    const eventId = coordinator.recordTransition({ assignmentId: 'a1', projectId: 'p1', conversationId: null, state: 'blocked', prevState: 'running' })!;
    await runReady();
    assert.equal(calls, 1);
    const due = store.getManagerEvent(eventId)!.nextAttemptAt!;
    assert.ok(due > clock);
    await coordinator.stop();
    assert.equal(timers.size, 0);
    store.close();
    store = await MetadataStore.open(join(fx.dir, 'metadata.sqlite'));
    clock = due - 1;
    coordinator = create();
    coordinator.drain();
    assert.equal(timers.size, 1, 'startup must restore the durable future deadline');
    assert.equal([...timers.values()][0]!.due, due);
    await runReady();
    assert.equal(calls, 1, 'must not deliver before the deadline');
    clock = due;
    await runReady();
    assert.equal(calls, 2, 'retry dispatches with no other activity');
    assert.equal(store.getManagerEvent(eventId)!.deliveryState, 'delivered');
    assert.equal(timers.size, 0, 'no idle polling timer after delivery');
  } finally { await coordinator.stop(); store.close(); await cleanup(fx.dir); }
});
