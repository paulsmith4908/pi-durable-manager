import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { AssignmentEngine } from "../src/assignments.js";
import { MetadataStore } from "../src/store.js";
import { ManagerWakeCoordinator } from "../src/manager-coordinator.js";

const MODEL = "faux/model";

interface Fixture {
  readonly engine: AssignmentEngine;
  readonly metadata: MetadataStore;
  readonly coordinator: ManagerWakeCoordinator;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly dispatches: { threadId: string; message: string }[];
  readonly addProject: (name: string) => Promise<string>;
  readonly waitForPauseIdle: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/**
 * Build a REAL engine over a REAL harness + REAL metadata store, wiring the
 * REAL coordinator through the engine's `onTransition` sink. Only the model
 * output and the CLI `exec` seam are scripted; no real Codex is contacted.
 */
async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pdm-mgr-engine-"));
  await mkdir(join(dir, "projects"), { recursive: true });
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });

  const metadata = await MetadataStore.open(join(stateDir, "meta.sqlite"));
  const storage = await openNodeSqliteStorage(join(stateDir, "pi.sqlite"));
  const registry = createRegistry();

  const faux = fauxProvider({ provider: "faux", models: [{ id: MODEL }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);

  const dispatches: { threadId: string; message: string }[] = [];
  // A fake dispatcher that records wakes but never spawns anything real.
  const coordinator = new ManagerWakeCoordinator({
    metadata,
    dispatcher: {
      dispatch: async (threadId: string, message: string) => {
        dispatches.push({ threadId, message });
        return { ok: true, receipt: `Queued message fake-receipt-${dispatches.length} for thread ${threadId}.`, error: null, permanent: false };
      },
      stop: async () => undefined,
      get isStopped() {
        return false;
      },
    } as never,
    // Run the coalescing pass synchronously so tests are deterministic.
    schedule: (fn) => {
      fn();
      return setTimeout(() => undefined, 0);
    },
  });

  const engine = new AssignmentEngine({
    harness,
    registry,
    metadata,
    config: {
      model: MODEL,
      limits: { maxSteps: 8, timeoutMs: 30_000 },
      tools: { commandTimeoutMs: null },
    },
    providerId: faux.provider.id,
    stateDir,
    configFile: null,
    unsandboxedForTesting: true,
    onTransition: (transition) => {
      coordinator.recordTransition(transition);
    },
  });
  await engine.preloadProjects();

  const addProject = async (name: string): Promise<string> => {
    const path = join(dir, "projects", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "README.md"), `# ${name}\n`);
    await new Promise<void>((resolveInit, rejectInit) => {
      execFile("git", ["init", "-q"], { cwd: path }, (err) => (err ? rejectInit(err) : resolveInit()));
    });
    const id = randomUUID();
    const now = Date.now();
    metadata.insertProject({
      id,
      name,
      path,
      origin: "created",
      requestId: `req-${name}`,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  };

  return {
    engine,
    metadata,
    coordinator,
    faux,
    dispatches,
    addProject,
    waitForPauseIdle: () => engine.whenManagerPauseIdle(),
    stop: async () => {
      await engine.whenManagerPauseIdle().catch(() => undefined);
      await coordinator.stop();
      engine.shutdownEngine();
      await engine.stopAll();
      await harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
      metadata.close();
      await storage.close(BACKGROUND_CONTEXT);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("accepting a reviewed assignment writes no manager event and never wakes", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("accept");
    // Bind from NOW so the needs_review wake has a target.
    fx.metadata.upsertManagerBinding({
      projectId,
      threadId: "thread-accept",
      requestId: "req-bind",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    fx.faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const submitted = await fx.engine.submit({ projectId, task: "do it", requestId: "req-a-1" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 10_000 });

    // The terminal needs_review transition wakes exactly once.
    const afterRun = fx.metadata.listManagerEvents(projectId, false);
    assert.equal(afterRun.length, 1);
    assert.equal(afterRun[0]?.state, "needs_review");
    assert.equal(fx.dispatches.length, 1);

    // Routine operator accept writes NO new event and wakes NO one.
    await fx.engine.review({ id: submitted.assignment.id, decision: "accept" });
    const afterAccept = fx.metadata.listManagerEvents(projectId, false);
    assert.equal(afterAccept.length, 1, "accept must not add a manager event");
    assert.equal(fx.dispatches.length, 1, "accept must not wake the manager");
  } finally {
    await fx.stop();
  }
});

test("a request_manager tool call pauses (blocked) and wakes exactly once with a bounded prompt", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("block");
    fx.metadata.upsertManagerBinding({
      projectId,
      threadId: "thread-block",
      requestId: "req-bind",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    fx.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("request_manager", {
          question: "Which environment should I deploy to?",
          context: "staging vs prod",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("should never run after pause", { stopReason: "stop" }),
    ]);
    const submitted = await fx.engine.submit({ projectId, task: "do it", requestId: "req-b-1" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 10_000 });

    const record = fx.engine.show({ id: submitted.assignment.id });
    assert.equal(record.state, "blocked");
    assert.equal(record.stopReason, "manager_request", "pause reason is explicit and truthful");
    assert.notEqual(
      fx.metadata.getAssignment(submitted.assignment.id)?.leasePath ?? null,
      null,
      "the writer lease is RETAINED until the manager reviews/responds/cancels",
    );

    const events = fx.metadata.listManagerEvents(projectId, false);
    const requests = events.filter((e) => e.kind === "manager_request");
    assert.equal(requests.length, 1, "request_manager emits exactly one event");
    assert.equal(requests[0]?.threadId, "thread-block");
    // The prompt carries the event id and instructions, never a raw transcript.
    assert.equal(fx.dispatches.length, 1);
    assert.match(fx.dispatches[0]!.message, /mw-/);
    assert.match(fx.dispatches[0]!.message, /ack/i);
    assert.doesNotMatch(fx.dispatches[0]!.message, /should never run after pause/);
  } finally {
    await fx.stop();
  }
});

test("parallel bash + request_manager: late writer is killed, no write after the paused notice", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("parallel");
    fx.metadata.upsertManagerBinding({
      projectId,
      threadId: "thread-parallel",
      requestId: "req-bind",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const project = fx.metadata.getProject(projectId)!;

    // ONE assistant turn issues TWO parallel tool calls: a bash that would write
    // `late.txt` after a delay, and a request_manager that must pause the run and
    // kill THIS project's process groups before the late write lands.
    fx.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "sleep 1.5 && echo late > late.txt" }),
          fauxToolCall("request_manager", { question: "Late write race?", context: "parallel bash" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("must never run", { stopReason: "stop" }),
    ]);
    const submitted = await fx.engine.submit({ projectId, task: "race", requestId: "req-par-1" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 10_000 });
    await fx.waitForPauseIdle();

    const record = fx.engine.show({ id: submitted.assignment.id });
    assert.equal(record.state, "blocked");
    assert.equal(record.stopReason, "manager_request");
    assert.notEqual(fx.metadata.getAssignment(submitted.assignment.id)?.leasePath ?? null, null, "lease retained");

    // Exactly ONE manager_request event, and its durable intent is completed
    // with the REAL persisted event id (never a fabricated one).
    const requests = fx.metadata.listManagerEvents(projectId, false).filter((e) => e.kind === "manager_request");
    assert.equal(requests.length, 1, "exactly one manager_request event");
    const intent = fx.metadata.getManagerPauseIntentForAssignment(submitted.assignment.id);
    assert.ok(intent !== undefined, "a durable pause intent exists");
    assert.equal(intent!.status, "completed");
    assert.equal(intent!.eventId, requests[0]!.eventId, "intent records the ACTUAL outbox event id");

    // No write may land after the paused notice: give the (killed) writer time.
    await new Promise((r) => setTimeout(r, 1800));
    await assert.rejects(
      () => import("node:fs/promises").then((fs) => fs.stat(join(project.path, "late.txt"))),
      "late.txt must NEVER be written after the pause",
    );
  } finally {
    await fx.stop();
  }
});

test("event-insert fault rolls back the final state+event transaction atomically", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("fault");
    fx.metadata.upsertManagerBinding({
      projectId,
      threadId: "thread-fault",
      requestId: "req-bind",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // Force the FINALIZER's event insert to throw: the transition must roll back
    // the whole transaction and the intent must be marked failed (fail closed),
    // never silently lose the question.
    const originalInsert = fx.metadata.insertManagerEvent.bind(fx.metadata);
    // Arm BEFORE submit: the intent phase suppresses the event, so the ONLY
    // manager_request insert is the finalizer's, which must throw.
    (fx.metadata as unknown as { insertManagerEvent: typeof originalInsert }).insertManagerEvent = (record) => {
      if (record.kind === "manager_request") throw new Error("injected outbox fault");
      return originalInsert(record);
    };

    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("request_manager", { question: "fault?", context: null }), { stopReason: "toolUse" }),
      fauxAssistantMessage("nope", { stopReason: "stop" }),
    ]);
    const submitted = await fx.engine.submit({ projectId, task: "fault", requestId: "req-f-1" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 10_000 });
    await fx.waitForPauseIdle();

    // The paused state survives (written by the intent phase) and the intent is
    // truthfully failed, never lost.
    const record = fx.engine.show({ id: submitted.assignment.id });
    assert.equal(record.state, "blocked");
    assert.equal(record.stopReason, "manager_request");
    const intent = fx.metadata.getManagerPauseIntentForAssignment(submitted.assignment.id);
    assert.ok(intent !== undefined);
    assert.equal(intent!.status, "failed");
    assert.equal(intent!.eventId, null);
    // No manager_request outbox event was committed (the txn rolled back).
    assert.equal(
      fx.metadata.listManagerEvents(projectId, false).filter((e) => e.kind === "manager_request").length,
      0,
    );
  } finally {
    await fx.stop();
  }
});

test("startup reconciliation finishes a durable pending pause intent safely", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("restart");
    fx.metadata.upsertManagerBinding({
      projectId,
      threadId: "thread-restart",
      requestId: "req-bind",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("request_manager", { question: "restart?", context: null }), { stopReason: "toolUse" }),
      fauxAssistantMessage("nope", { stopReason: "stop" }),
    ]);
    const submitted = await fx.engine.submit({ projectId, task: "restart", requestId: "req-s-1" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 10_000 });
    await fx.waitForPauseIdle();
    const eventId = fx.metadata.listManagerEvents(projectId, false).find((e) => e.kind === "manager_request")!.eventId;

    // Simulate a crash between intent and finalize: rewind the intent to
    // pending with no event, then reconcile. Reconciliation must re-emit the
    // SAME deduplicated event (idempotent), not lose the question or duplicate.
    fx.metadata.insertManagerPauseIntent({
      intentId: "mp-crash",
      projectId,
      assignmentId: submitted.assignment.id,
      conversationId: null,
      taskId: "task-crash",
      question: "restart?",
      context: null,
      detail: "Worker requested manager help: restart?",
      status: "pending",
      eventId: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await fx.engine.reconcile();
    await fx.waitForPauseIdle();

    const reconciled = fx.metadata.getManagerPauseIntent("mp-crash");
    assert.ok(reconciled !== undefined);
    assert.equal(reconciled!.status, "completed", "reconciliation completes the pending intent");
    assert.equal(reconciled!.eventId, eventId, "reconciliation is idempotent (same deduped event id)");
    assert.equal(
      fx.metadata.listManagerEvents(projectId, false).filter((e) => e.kind === "manager_request").length,
      1,
      "no duplicate event on reconciliation",
    );
  } finally {
    await fx.stop();
  }
});

test("an explicit manager abort then a NEW answered assignment works", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("abort-then-new");
    fx.metadata.upsertManagerBinding({
      projectId,
      threadId: "thread-new",
      requestId: "req-bind",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("request_manager", { question: "need help", context: null }), { stopReason: "toolUse" }),
      fauxAssistantMessage("nope", { stopReason: "stop" }),
    ]);
    const first = await fx.engine.submit({ projectId, task: "first", requestId: "req-n-1" });
    await fx.engine.wait({ id: first.assignment.id, timeoutMs: 10_000 });
    await fx.waitForPauseIdle();
    assert.equal(fx.engine.show({ id: first.assignment.id }).state, "blocked");

    // Explicit manager abort releases the lease and reaches a terminal state.
    await fx.engine.abort({ id: first.assignment.id });
    const aborted = fx.engine.show({ id: first.assignment.id });
    assert.ok(["cancelled", "blocked", "failed"].includes(aborted.state), `terminal after abort, got ${aborted.state}`);
    assert.equal(fx.metadata.getAssignment(first.assignment.id)?.leasePath ?? null, null, "lease released by abort");

    // A NEW assignment on the same project then runs to a truthful terminal
    // state (not blocked by a stale intent / lease).
    fx.faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const second = await fx.engine.submit({ projectId, task: "second", requestId: "req-n-2" });
    await fx.engine.wait({ id: second.assignment.id, timeoutMs: 10_000 });
    const done = fx.engine.show({ id: second.assignment.id });
    assert.equal(done.state, "needs_review", "new assignment answers normally");
  } finally {
    await fx.stop();
  }
});

test("routine running transitions never wake; only terminal wakes are recorded", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("routine");
    fx.faux.setResponses([fauxAssistantMessage("all good", { stopReason: "stop" })]);
    const submitted = await fx.engine.submit({ projectId, task: "go", requestId: "req-r-1" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 10_000 });

    const events = fx.metadata.listManagerEvents(projectId, false);
    // Only the terminal needs_review is a wake; the intermediate `running`
    // transition (prevState queued->running) is NOT.
    assert.deepEqual(
      events.map((e) => e.state),
      ["needs_review"],
    );
  } finally {
    await fx.stop();
  }
});
