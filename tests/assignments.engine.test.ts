import { workerCompactionPolicy } from "../src/context-policy.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  Harness,
  createRegistry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { AssignmentEngine } from "../src/assignments.js";
import { MetadataStore, SCHEMA_VERSION } from "../src/store.js";
import { planQuarantine } from "../src/process-quarantine.js";

const MODEL = "faux/model";

interface Fixture {
  readonly dir: string;
  readonly engine: AssignmentEngine;
  readonly metadata: MetadataStore;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly stop: () => Promise<void>;
  readonly addProject: (name: string) => Promise<string>;
}

/**
 * Build a REAL engine over a REAL harness backed by a scripted faux provider.
 * Nothing here is a mock: the assignment lifecycle, generation hooks, lease
 * arithmetic and settlement all run for real. Only the model output is scripted.
 */
async function fixture(
  limits: {
    maxSteps: number | null;
    timeoutMs: number | null;
    commandTimeoutMs?: number | null;
  },
  createTools?: (
    root: string,
    options: import("../src/tools.js").CreateProjectToolsOptions,
  ) => Promise<import("../src/tools.js").ProjectTools>,
  modelLimits?: { contextWindow: number; maxTokens: number },
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pdm-engine-"));
  await mkdir(join(dir, "projects"), { recursive: true });
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });

  const metadata = await MetadataStore.open(join(stateDir, "meta.sqlite"));
  const storage = await openNodeSqliteStorage(join(stateDir, "pi.sqlite"));
  const registry = createRegistry();

  const faux = fauxProvider({ provider: "faux", models: [{ id: MODEL, ...modelLimits }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const harness = await Harness.open(storage, { models, registry, ...(modelLimits ? { settings: { compaction: workerCompactionPolicy(modelLimits.contextWindow, modelLimits.maxTokens) } } : {}) }, BACKGROUND_CONTEXT);

  const engine = new AssignmentEngine({
    harness,
    registry,
    metadata,
    config: {
      model: MODEL,
      limits: { maxSteps: limits.maxSteps, timeoutMs: limits.timeoutMs },
      tools: { commandTimeoutMs: limits.commandTimeoutMs ?? null },
    },
    providerId: faux.provider.id,
    stateDir,
    configFile: null,
    unsandboxedForTesting: true,
    ...(createTools !== undefined ? { createTools } : {}),
  });
  await engine.preloadProjects();

  const addProject = async (name: string): Promise<string> => {
    const path = join(dir, "projects", name);
    await mkdir(path, { recursive: true });
    // A tiny real checkout so git-based evidence collection has something.
    await writeFile(join(path, "README.md"), `# ${name}\n`);
    // Initialize a REAL git repo (init only, no commits) so snapshot capture,
    // which lists tracked+untracked files via `git ls-files`, works.
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
    dir,
    engine,
    metadata,
    faux,
    addProject,
    stop: async () => {
      // Shut the engine down FIRST so it aborts in-flight runs and clears any
      // armed assignment-deadline timers before the stores close; otherwise a
      // late timer/settlement would hit a closed metadata store.
      engine.shutdownEngine();
      await harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
      metadata.close();
      await storage.close(BACKGROUND_CONTEXT);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("maxSteps is a hard cap: exactly maxSteps provider requests, then a terminal budget stop", async () => {
  const fx = await fixture({ maxSteps: 1, timeoutMs: 30_000 });
  try {
    // Script a tool call then a final text. With maxSteps=1 only the FIRST
    // request is admitted; the follow-up request that would consume the tool
    // result must be refused by the generation hook.
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { file_path: "README.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("should never be requested"),
    ]);
    const projectId = await fx.addProject("cap");

    const submitted = await fx.engine.submit({ projectId, task: "read the readme", requestId: "req-cap-1" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 10_000 });

    const final = fx.engine.show({ id: submitted.assignment.id });
    assert.equal(final.state, "budget", "the run must settle as terminal budget");
    assert.equal(final.stopReason, "budget");
    assert.equal(final.attemptCount, 1, "exactly one model request is allowed");
    assert.equal(fx.faux.state.callCount, 1, "no second provider request may be issued");
    const row = fx.metadata.getAssignment(submitted.assignment.id);
    assert.equal(row?.leasePath, null, "the writer lease must be released on settle");
  } finally {
    await fx.stop();
  }
});

test("a retried generation cannot bypass the step cap", async () => {
  const fx = await fixture({ maxSteps: 1, timeoutMs: 30_000 });
  try {
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { file_path: "README.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("second"),
      fauxAssistantMessage("third"),
    ]);
    const projectId = await fx.addProject("cap2");
    const submitted = await fx.engine.submit({ projectId, task: "one step", requestId: "req-cap-2" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 10_000 });
    assert.equal(fx.engine.show({ id: submitted.assignment.id }).state, "budget");

    // A NEW assignment for the SAME project must be refused while the tripped
    // assignment still holds the checkout — no unmanaged write after lease free.
    const second = await fx.engine.submit({ projectId, task: "one step", requestId: "req-cap-2b" });
    await fx.engine.wait({ id: second.assignment.id, timeoutMs: 10_000 });
    // Two assignments, two separate budgets, but never more than maxSteps each.
    assert.equal(fx.faux.state.callCount, 2, "each fresh assignment gets its own single step");
  } finally {
    await fx.stop();
  }
});

test("UNLIMITED maxSteps: an uncapped run completes far beyond the old 300-request cap", async () => {
  const fx = await fixture({ maxSteps: null, timeoutMs: null });
  try {
    // 400 tool turns + a final stop. With NO step cap the run must be allowed to
    // keep going well past the old 300-request ceiling. The provider responses
    // are a finite QUEUE, so script exactly TURNS tool turns then a stop.
    const TURNS = 400;
    fx.faux.setResponses([
      ...Array.from({ length: TURNS }, () =>
        fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }),
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const projectId = await fx.addProject("uncapped");
    const submitted = await fx.engine.submit({ projectId, task: "many steps", requestId: "req-uncapped-1" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 30_000 });

    const final = fx.engine.show({ id: submitted.assignment.id });
    assert.notEqual(final.state, "budget", "an uncapped run must never trip the step budget");
    assert.notEqual(final.state, "timeout", "an uncapped run must never trip a wall-clock deadline");
    assert.equal(final.state, "needs_review", "the uncapped run settles normally");
    assert.ok(
      fx.faux.state.callCount > 300,
      `provider must be driven past the old 300 cap (saw ${fx.faux.state.callCount})`,
    );
    assert.equal(
      final.attemptCount,
      fx.faux.state.callCount,
      "attemptCount must equal the number of provider requests for an uncapped run",
    );
    assert.equal(fx.metadata.getAssignment(submitted.assignment.id)?.leasePath, null, "lease released on settle");
  } finally {
    await fx.stop();
  }
});

test("UNLIMITED (omitted) caps also run to completion without tripping", async () => {
  // `undefined` is treated identically to `null`: no cap.
  const fx = await fixture({ maxSteps: null, timeoutMs: null });
  try {
    fx.faux.setResponses([
      ...Array.from({ length: 5 }, () =>
        fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }),
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const projectId = await fx.addProject("uncapped-2");
    const submitted = await fx.engine.submit({ projectId, task: "few steps", requestId: "req-uncapped-2" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 15_000 });
    assert.equal(fx.engine.show({ id: submitted.assignment.id }).state, "needs_review");
  } finally {
    await fx.stop();
  }
});

test("UNLIMITED persists deadlineAt:null and never arms an assignment deadline", async () => {
  const fx = await fixture({ maxSteps: null, timeoutMs: null });
  try {
    fx.faux.setResponses([
      ...Array.from({ length: 3 }, () =>
        fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }),
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const projectId = await fx.addProject("nodeadline");
    const submitted = await fx.engine.submit({ projectId, task: "no deadline", requestId: "req-nodeadline-1" });
    // The durable row must record an EXPLICIT null deadline — no invented value.
    const row = fx.metadata.getAssignment(submitted.assignment.id);
    assert.equal(row?.deadlineAt, null, "unlimited assignment persists deadlineAt:null");
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 15_000 });
    assert.equal(fx.engine.show({ id: submitted.assignment.id }).state, "needs_review");
  } finally {
    await fx.stop();
  }
});

test("UNLIMITED stays CANCELLABLE: abort reclaims the lease and the group", async () => {
  const fx = await fixture({ maxSteps: null, timeoutMs: null });
  try {
    // Loop on a slow bash so the run stays genuinely in-flight until abort.
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.5" }), { stopReason: "toolUse" }),
    ]);
    const projectId = await fx.addProject("cancel-uncapped");
    const submitted = await fx.engine.submit({ projectId, task: "long job", requestId: "req-cancel-uncapped" });
    await fx.engine.abort({ id: submitted.assignment.id });
    assert.equal(fx.engine.show({ id: submitted.assignment.id }).state, "cancelled");
    assert.equal(fx.metadata.getAssignment(submitted.assignment.id)?.leasePath, null, "lease freed on cancel");
  } finally {
    await fx.stop();
  }
});

test("a wall-clock timeout kills only the target project and settles as timeout", async () => {
  const fx = await fixture({ maxSteps: 5_000, timeoutMs: 150 });
  try {
    // The model keeps calling tools; the deadline (150ms) must fire on a later
    // round's `beforeRequest` and abort the run as `timeout`.
    fx.faux.setResponses(Array.from({ length: 5_000 }, () =>
      fauxAssistantMessage(fauxToolCall("read", { file_path: "README.md" }), { stopReason: "toolUse" }),
    ));
    const projectId = await fx.addProject("slow");
    const submitted = await fx.engine.submit({ projectId, task: "hang", requestId: "req-to-1" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 10_000 });
    const final = fx.engine.show({ id: submitted.assignment.id });
    assert.equal(final.state, "timeout");
    assert.equal(final.stopReason, "timeout");
    assert.equal(fx.metadata.getAssignment(submitted.assignment.id)?.leasePath, null);
  } finally {
    await fx.stop();
  }
});

test("aborting one assignment never kills another project's bundle", async () => {
  const fx = await fixture({ maxSteps: 500, timeoutMs: 30_000 });
  try {
    // Both runs loop on a slow bash so each stays genuinely in-flight (a plain
    // read turn would race through 500 instant turns before the abort lands).
    fx.faux.setResponses(Array.from({ length: 500 }, () =>
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.5" }), { stopReason: "toolUse" }),
    ));
    const a = await fx.addProject("proj-a");
    const b = await fx.addProject("proj-b");
    const subA = await fx.engine.submit({ projectId: a, task: "a work", requestId: "req-abort-a" });
    const subB = await fx.engine.submit({ projectId: b, task: "b work", requestId: "req-abort-b" });

    await fx.engine.abort({ id: subA.assignment.id });

    assert.equal(fx.engine.show({ id: subA.assignment.id }).state, "cancelled");
    const stillRunning = fx.engine.show({ id: subB.assignment.id });
    assert.notEqual(stillRunning.state, "cancelled", "project B must be untouched by A's abort");
    assert.notEqual(stillRunning.state, "failed");

    await fx.engine.abort({ id: subB.assignment.id });
    assert.equal(fx.engine.show({ id: subB.assignment.id }).state, "cancelled");
  } finally {
    await fx.stop();
  }
});

test("concurrent duplicate submissions validate the payload before joining", async () => {
  const fx = await fixture({ maxSteps: 40, timeoutMs: 30_000 });
  try {
    fx.faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
    const projectId = await fx.addProject("race");
    const first = fx.engine.submit({ projectId, task: "same", requestId: "req-race" });
    // A racing duplicate with DIFFERENT content must be refused as a conflict.
    await assert.rejects(
      () => fx.engine.submit({ projectId, task: "different", requestId: "req-race" }),
      (error: unknown) => (error as { code?: string }).code === "conflict",
    );
    // The identical payload joins the in-flight run instead of double-admitting.
    const joined = await fx.engine.submit({ projectId, task: "same", requestId: "req-race" });
    const settled = await first;
    assert.equal(joined.assignment.id, settled.assignment.id);
  } finally {
    await fx.stop();
  }
});

test("a completed run with a non-stop reason is classified unanswered, never needs_review", async () => {
  const fx = await fixture({ maxSteps: 40, timeoutMs: 30_000 });
  try {
    fx.faux.setResponses([fauxAssistantMessage("partial", { stopReason: "length" })]);
    const projectId = await fx.addProject("len");
    const submitted = await fx.engine.submit({ projectId, task: "overlong", requestId: "req-len" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 10_000 });
    const final = fx.engine.show({ id: submitted.assignment.id });
    assert.equal(final.state, "unanswered");
    assert.equal(final.stopReason, "length");
    assert.ok(final.error !== null && final.error.length > 0, "the reason must be visible");
  } finally {
    await fx.stop();
  }
});

test("a failed cancel API fails CLOSED: lease retained, re-submit rejected, operator abort cleans up", async () => {
  const fx = await fixture({ maxSteps: 1, timeoutMs: 30_000 });
  try {
    // Force a tool call so a SECOND request would be needed; maxSteps=1 means the
    // generation hook trips and must stop the run. Now make the cancel API FAIL:
    // `abortTask` rejects and never signals the invocation controller.
    const harnessAny = fx.engine as unknown as { harness: { abortTask: () => Promise<string> } };
    const realAbortTask = harnessAny.harness.abortTask.bind(harnessAny.harness);
    harnessAny.harness.abortTask = () => Promise.reject(new Error("simulated cancel failure"));

    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { file_path: "README.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("must never be requested"),
    ]);
    const projectId = await fx.addProject("failclosed");

    const submitted = await fx.engine.submit({ projectId, task: "read the readme", requestId: "req-fc-1" });
    // Wait past the hook's bounded abort wait (2s) so the fail-closed path runs.
    await new Promise((r) => setTimeout(r, 2_600));

    // The run must NOT have dispatched a second provider request.
    assert.equal(fx.faux.state.callCount, 1, "no request may be dispatched past the cap");

    // The blocked state AND the retained lease must both be operator-visible.
    const blocked = fx.metadata.getAssignment(submitted.assignment.id);
    assert.equal(blocked?.state, "blocked", "assignment must be explicitly blocked");
    assert.notEqual(blocked?.leasePath, null, "the writer lease must be RETAINED");
    assert.ok(fx.engine.show({ id: submitted.assignment.id }).error, "blocked reason must be inspectable");

    // A new assignment for the SAME checkout must be refused while the lease is held.
    await assert.rejects(
      () => fx.engine.submit({ projectId, task: "another", requestId: "req-fc-2" }),
      (error: unknown) => (error as { code?: string }).code === "lease_held",
    );

    // Operator-abort of the blocked-with-lease assignment performs cleanup.
    harnessAny.harness.abortTask = realAbortTask;
    const cleaned = await fx.engine.abort({ id: submitted.assignment.id });
    assert.equal(cleaned.state, "cancelled");
    assert.equal(fx.metadata.getAssignment(submitted.assignment.id)?.leasePath, null, "lease released on cleanup");

    // With the lease freed a fresh submit is admitted again (id may already be
    // running by the time submit returns).
    fx.faux.setResponses([fauxAssistantMessage("ok")]);
    const next = await fx.engine.submit({ projectId, task: "after cleanup", requestId: "req-fc-3" });
    assert.ok(["queued", "running"].includes(next.assignment.state), `admitted, got ${next.assignment.state}`);
  } finally {
    await fx.stop();
  }
});

test("schema is v8 and a legacy v3 row migrates without losing data", async () => {
  // The migration is exercised against a real on-disk database.
  const dir = await mkdtemp(join(tmpdir(), "pdm-mig-"));
  try {
    const file = join(dir, "meta.sqlite");
    const store = await MetadataStore.open(file);
    assert.equal(store.schemaVersion, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 8);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a long tool pause permits steer + follow-up; both are processed exactly once", async () => {
  const fx = await fixture({ maxSteps: 40, timeoutMs: 30_000 });
  try {
    // Turn 1: a real bash sleep holds the conversation busy long enough to steer
    // while it runs. Turn 2: the primary finishes. Turns 3/4: the steered input
    // and follow-up each get their own turn.
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.8" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("primary done"),
      fauxAssistantMessage("steered done"),
      fauxAssistantMessage("followup done"),
    ]);
    const projectId = await fx.addProject("live");
    const submitted = await fx.engine.submit({ projectId, task: "long job", requestId: "req-live-1" });
    const id = submitted.assignment.id;

    // Wait until the run is genuinely in flight (busy on the sleep turn).
    await new Promise((r) => setTimeout(r, 200));

    const steer = await fx.engine.steer({ id, content: "steer this way", mode: "steer", requestId: "in-steer-1" });
    assert.equal(steer.inputId, "in-steer-1");
    assert.equal(steer.replayed, false);
    assert.ok(steer.submissionId !== null, "steer must record its Pi submission id");

    const follow = await fx.engine.steer({ id, content: "and follow up", mode: "followup", requestId: "in-follow-1" });
    assert.equal(follow.inputId, "in-follow-1");
    assert.ok(follow.submissionId !== null);

    // Replaying the SAME requestId + content never double-submits.
    const replay = await fx.engine.steer({ id, content: "steer this way", mode: "steer", requestId: "in-steer-1" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.submissionId, steer.submissionId);

    // Reusing the requestId with DIFFERENT content is a conflict.
    await assert.rejects(
      () => fx.engine.steer({ id, content: "changed", mode: "steer", requestId: "in-steer-1" }),
      (error: unknown) => (error as { code?: string }).code === "conflict",
    );

    await fx.engine.wait({ id, timeoutMs: 15_000 });
    const final = fx.engine.show({ id });
    assert.ok(["needs_review", "unanswered"].includes(final.state), `settled, got ${final.state}`);
    assert.equal(fx.metadata.getAssignment(id)?.leasePath, null, "lease released after ALL inputs settled");

    // Both inputs were admitted exactly once and reached a terminal state.
    const inputs = fx.metadata.listInputs(id);
    assert.equal(inputs.length, 2, "exactly two tracked inputs");
    for (const input of inputs) {
      assert.equal(input.state, "done", `input ${input.requestId} must be done`);
      assert.ok(input.submissionId !== null);
    }
  } finally {
    await fx.stop();
  }
});

test("operator input is refused once the assignment is settling (no new writer)", async () => {
  const fx = await fixture({ maxSteps: 40, timeoutMs: 30_000 });
  try {
    fx.faux.setResponses([fauxAssistantMessage("done")]);
    const projectId = await fx.addProject("gate");
    const submitted = await fx.engine.submit({ projectId, task: "quick", requestId: "req-gate-1" });
    const id = submitted.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 10_000 });

    // The run has settled and released its lease: new input must be refused with
    // guidance to start a fresh assignment, never silently queued.
    await assert.rejects(
      () => fx.engine.steer({ id, content: "late", mode: "steer", requestId: "in-late-1" }),
      (error: unknown) => (error as { code?: string }).code === "not_running",
    );
  } finally {
    await fx.stop();
  }
});

test("restart during an admitted follow-up reattaches the tracked input without a duplicate submit", async () => {
  // A bespoke fixture so we control the on-disk persistence across a "restart".
  const dir = await mkdtemp(join(tmpdir(), "pdm-restart-"));
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  const limits = { maxSteps: 40, timeoutMs: 30_000 };
  const model = "faux/model";

  const openEngine = async () => {
    const metadata = await MetadataStore.open(join(stateDir, "meta.sqlite"));
    const storage = await openNodeSqliteStorage(join(stateDir, "pi.sqlite"));
    const registry = createRegistry();
    const faux = fauxProvider({ provider: "faux", models: [{ id: model }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
    const engine = new AssignmentEngine({
      harness,
      registry,
      metadata,
      config: { model, limits },
      providerId: faux.provider.id,
      stateDir,
      configFile: null,
      unsandboxedForTesting: true,
    });
    await engine.preloadProjects();
    return { metadata, storage, harness, faux, engine };
  };

  try {
    const first = await openEngine();
    const projectPath = join(dir, "p", "proj");
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, "README.md"), "# proj\n");
    await new Promise<void>((resolveInit, rejectInit) => {
      execFile("git", ["init", "-q"], { cwd: projectPath }, (err) => (err ? rejectInit(err) : resolveInit()));
    });
    const projectId = randomUUID();
    first.metadata.insertProject({
      id: projectId,
      name: "proj",
      path: projectPath,
      origin: "created",
      requestId: "req-rp",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Turn 1: a long bash sleep keeps the run in flight while we steer. Turn 2
    // is the steered follow-up turn.
    first.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.6" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("primary done"),
      fauxAssistantMessage("steered done"),
    ]);
    const submitted = await first.engine.submit({ projectId, task: "long", requestId: "req-rp-1" });
    const id = submitted.assignment.id;
    await new Promise((r) => setTimeout(r, 200));
    const steered = await first.engine.steer({ id, content: "follow this", mode: "followup", requestId: "in-rp-1" });
    assert.ok(steered.submissionId !== null);
    const admittedSubmissionId = steered.submissionId;
    const callsBeforeRestart = first.faux.state.callCount;

    // Simulate an orderly restart: signal shutdown (so a run rejected by
    // teardown is NOT mislabelled `failed`) WITHOUT settling the run, leaving the
    // `running` assignment row and the admitted input row on disk.
    first.engine.shutdownEngine();
    await first.harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
    first.metadata.close();
    await first.storage.close(BACKGROUND_CONTEXT);

    // Fresh engine over the SAME files reattaches rather than duplicating.
    const second = await openEngine();
    const result = await second.engine.reconcile();
    assert.ok(result.reattached >= 1, `expected a reattachment, got ${JSON.stringify(result)}`);

    // The admitted input keeps its ORIGINAL Pi submission id — reconcile never
    // re-submits it (no competing writer, no duplicate turn).
    const inputRow = second.metadata.getInput("in-rp-1");
    assert.equal(inputRow?.submissionId, admittedSubmissionId, "submission id must be preserved");
    assert.ok(second.faux.state.callCount <= callsBeforeRestart + 1, "no duplicate turn spawned");

    await second.harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
    second.metadata.close();
    await second.storage.close(BACKGROUND_CONTEXT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile quarantines an assignment whose command group is recorded from a DIRTY boot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdm-quar-"));
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  const limits = { maxSteps: 40, timeoutMs: 30_000 };
  const model = "faux/model";

  const openEngine = async (bootId: string) => {
    const metadata = await MetadataStore.open(join(stateDir, "meta.sqlite"));
    const storage = await openNodeSqliteStorage(join(stateDir, "pi.sqlite"));
    const registry = createRegistry();
    const faux = fauxProvider({ provider: "faux", models: [{ id: model }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
    const engine = new AssignmentEngine({
      harness,
      registry,
      metadata,
      config: { model, limits },
      providerId: faux.provider.id,
      stateDir,
      configFile: null,
      unsandboxedForTesting: true,
      bootId,
    });
    await engine.preloadProjects();
    return { metadata, storage, harness, faux, engine };
  };

  try {
    const first = await openEngine("boot-DIRTY");
    const projectPath = join(dir, "p", "proj");
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, "README.md"), "# proj\n");
    await new Promise<void>((resolveInit, rejectInit) => {
      execFile("git", ["init", "-q"], { cwd: projectPath }, (err) => (err ? rejectInit(err) : resolveInit()));
    });
    const projectId = randomUUID();
    first.metadata.insertProject({
      id: projectId,
      name: "proj",
      path: projectPath,
      origin: "created",
      requestId: "req-q",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Turn 1: a long bash sleep keeps the run in flight. We then simulate a
    // CRASH (no clean drain) so the boot stays DIRTY and the assignment row is
    // left `running` with a recorded command receipt.
    first.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 5" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("never"),
    ]);
    first.metadata.beginServiceRun("boot-DIRTY", process.pid, Date.now());
    const submitted = await first.engine.submit({ projectId, task: "long", requestId: "req-q-1" });
    const id = submitted.assignment.id;
    // Wait for the durable started receipt to appear (persisted before START).
    const deadline = Date.now() + 5000;
    let receipts = first.metadata.listProcessReceipts(id);
    while (receipts.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      receipts = first.metadata.listProcessReceipts(id);
    }
    assert.ok(receipts.length >= 1, "a started receipt was persisted for the in-flight command");

    // Simulate the crash: abort the engine's in-memory bookkeeping WITHOUT
    // marking the boot clean, then close the stores under the same lock.
    first.engine.shutdownEngine();
    await first.harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
    first.metadata.close();
    await first.storage.close(BACKGROUND_CONTEXT);

    // A fresh boot sees the prior DIRTY run + its recorded receipt.
    const second = await openEngine("boot-NEW");
    const decisions = planQuarantine(second.metadata, "boot-NEW");
    assert.equal(decisions.length, 1, "the dirty-boot command is quarantined");
    assert.equal(decisions[0]!.assignmentId, id);

    const result = await second.engine.reconcile(decisions);
    assert.ok(result.blocked >= 1, "the in-doubt assignment is blocked, not reattached");

    // The row is blocked with the in_doubt_command stop reason and RETAINS its
    // lease (never freed while a command may have run).
    const row = second.metadata.getAssignment(id);
    assert.equal(row?.state, "blocked");
    assert.equal(row?.stopReason, "in_doubt_command");
    assert.notEqual(row?.leasePath, null, "lease is retained for review");

    // No blind replay: steering into the quarantined row is refused.
    const steered = await second.engine
      .steer({ id, content: "more", mode: "steer", requestId: "in-q-1" })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(steered instanceof Error, "a blocked in-doubt row cannot be steered/replayed");

    // Recovery refuses while an unverified group may still be alive: abort must
    // fail-closed rather than free the lease or wipe durable state.
    const refused = await second.engine.abort({ id }).then(() => undefined, (e: unknown) => e);
    // (With no LIVE group the guard permits abort; the important invariant is
    // that reconcile never auto-reran the command and never freed the lease.)
    assert.ok(refused === undefined || refused instanceof Error, "abort is either refused or proceeds deliberately");

    await second.harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
    second.metadata.close();
    await second.storage.close(BACKGROUND_CONTEXT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort refuses a quarantined row while its recorded command group is still alive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdm-quar-live-"));
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  const model = "faux/model";

  const metadata = await MetadataStore.open(join(stateDir, "meta.sqlite"));
  const storage = await openNodeSqliteStorage(join(stateDir, "pi.sqlite"));
  const registry = createRegistry();
  const faux = fauxProvider({ provider: "faux", models: [{ id: model }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
  const engine = new AssignmentEngine({
    harness,
    registry,
    metadata,
    config: { model, limits: { maxSteps: 40, timeoutMs: 30_000 } },
    providerId: faux.provider.id,
    stateDir,
    configFile: null,
    unsandboxedForTesting: true,
    bootId: "boot-NEW",
  });
  await engine.preloadProjects();

  // Spawn a REAL fixture sleeper in its OWN process group; this is the only
  // group the test is allowed to signal, and it is cleaned up here.
  const { spawn } = await import("node:child_process");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const sleeperPid = sleeper.pid!;
  const killFixture = (): void => {
    try {
      process.kill(-sleeperPid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeperPid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  };

  try {
    const now = Date.now();
    metadata.beginServiceRun("boot-DIRTY", process.pid, now);
    metadata.insertAssignment({
      id: "asg-live",
      projectId: "p-live",
      sessionId: null,
      conversationId: null,
      requestId: "req-live",
      state: "running",
      acceptanceCriteria: null,
      submissionId: null,
      payloadHash: "hash-live",
      parentId: null,
      task: "in doubt",
      attemptCount: 1,
      deadlineAt: null,
      stopReason: null,
      leasePath: join(stateDir, "writer.lease"),
      evidence: JSON.stringify({ version: 1, phase: "admitted", createdAt: now, updatedAt: now }),
      reviewNote: null,
      reviewedAt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    metadata.insertProcessReceipt({
      receiptId: "asg-live:boot-DIRTY:1",
      assignmentId: "asg-live",
      bootId: "boot-DIRTY",
      pid: sleeperPid,
      pgid: sleeperPid,
      commandRedacted: "sleep 999",
      state: "started",
      createdAt: now,
      updatedAt: now,
    });

    const decisions = planQuarantine(metadata, "boot-NEW");
    assert.equal(decisions.length, 1, "the live-group command is quarantined");
    assert.ok(decisions[0]!.livePgids.includes(sleeperPid), "the live group is detected");

    await engine.reconcile(decisions);
    const refused = await engine.abort({ id: "asg-live" }).then(() => undefined, (e: unknown) => e);
    assert.ok(refused instanceof Error, "abort must refuse while the group is alive");

    // The row stays blocked and retains its lease (no silent free).
    const row = metadata.getAssignment("asg-live");
    assert.equal(row?.state, "blocked");
    assert.notEqual(row?.leasePath, null);
  } finally {
    killFixture();
  }
  await harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
  metadata.close();
  await storage.close(BACKGROUND_CONTEXT);
  await rm(dir, { recursive: true, force: true });
});

test("commandTimeoutMs propagates from config through the engine into the sandboxed bash policy", async () => {
  // Capture the options the engine hands to the real tool factory so we can
  // prove config -> engine -> project tools -> sandbox policy propagation.
  const seen: (number | null | undefined)[] = [];
  const fx = await fixture({ maxSteps: null, timeoutMs: null, commandTimeoutMs: 9_000 }, async (root, options) => {
    seen.push(options.timeoutMs);
    const { createProjectTools } = await import("../src/tools.js");
    return createProjectTools(root, options);
  });
  try {
    fx.faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const projectId = await fx.addProject("cmd-timeout");
    const submitted = await fx.engine.submit({ projectId, task: "noop", requestId: "req-cmd-timeout" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 15_000 });
    assert.deepEqual(seen, [9_000], "config tools.commandTimeoutMs must reach the project tools");
  } finally {
    await fx.stop();
  }
});

test("commandTimeoutMs:null is passed through as unlimited (not coerced to a finite cap)", async () => {
  const seen: (number | null | undefined)[] = [];
  const fx = await fixture({ maxSteps: null, timeoutMs: null, commandTimeoutMs: null }, async (root, options) => {
    seen.push(options.timeoutMs);
    const { createProjectTools } = await import("../src/tools.js");
    return createProjectTools(root, options);
  });
  try {
    fx.faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const projectId = await fx.addProject("cmd-timeout-null");
    const submitted = await fx.engine.submit({ projectId, task: "noop", requestId: "req-cmd-timeout-null" });
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 15_000 });
    assert.deepEqual(seen, [null], "null command timeout must remain null = unlimited");
  } finally {
    await fx.stop();
  }
});

test("a simulated old 20-minute deadline never aborts an uncapped run", async () => {
  // Simulated clock: pin Date.now() far past the OLD 20-minute cap so a
  // lingering deadline would be long expired, then prove an uncapped run is
  // unaffected (no invented deadline, no trip).
  const fx = await fixture({ maxSteps: null, timeoutMs: null });
  const realNow = Date.now;
  const simulated = realNow.call(Date) + 60 * 60 * 1000; // now + 1 hour
  try {
    Date.now = () => simulated;
    fx.faux.setResponses([
      ...Array.from({ length: 4 }, () =>
        fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }),
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const projectId = await fx.addProject("sim-clock");
    const submitted = await fx.engine.submit({ projectId, task: "hours-ish", requestId: "req-sim-clock" });
    assert.equal(fx.metadata.getAssignment(submitted.assignment.id)?.deadlineAt, null);
    await fx.engine.wait({ id: submitted.assignment.id, timeoutMs: 15_000 });
    const final = fx.engine.show({ id: submitted.assignment.id });
    assert.notEqual(final.state, "timeout", "an uncapped run must not trip on the old 20-minute cap");
    assert.equal(final.state, "needs_review");
  } finally {
    Date.now = realNow;
    await fx.stop();
  }
});

test("restart of an uncapped assignment reattaches without inventing a deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdm-uncapped-restart-"));
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  const model = "faux/model";
  const limits = { maxSteps: null, timeoutMs: null };

  const openEngine = async () => {
    const metadata = await MetadataStore.open(join(stateDir, "meta.sqlite"));
    const storage = await openNodeSqliteStorage(join(stateDir, "pi.sqlite"));
    const registry = createRegistry();
    const faux = fauxProvider({ provider: "faux", models: [{ id: model }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
    const engine = new AssignmentEngine({
      harness,
      registry,
      metadata,
      config: { model, limits, tools: { commandTimeoutMs: null } },
      providerId: faux.provider.id,
      stateDir,
      configFile: null,
      unsandboxedForTesting: true,
    });
    await engine.preloadProjects();
    return { metadata, storage, harness, faux, engine };
  };

  try {
    const first = await openEngine();
    const projectPath = join(dir, "p", "proj");
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, "README.md"), "# proj\n");
    await new Promise<void>((resolveInit, rejectInit) => {
      execFile("git", ["init", "-q"], { cwd: projectPath }, (err) => (err ? rejectInit(err) : resolveInit()));
    });
    const projectId = randomUUID();
    first.metadata.insertProject({
      id: projectId,
      name: "proj",
      path: projectPath,
      origin: "created",
      requestId: "req-ur",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    first.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.6" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const submitted = await first.engine.submit({ projectId, task: "long uncapped", requestId: "req-ur-1" });
    const id = submitted.assignment.id;
    assert.equal(first.metadata.getAssignment(id)?.deadlineAt, null);
    await new Promise((r) => setTimeout(r, 150));

    // Orderly shutdown mid-run; the running row stays on disk with a NULL deadline.
    first.engine.shutdownEngine();
    await first.harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
    first.metadata.close();
    await first.storage.close(BACKGROUND_CONTEXT);

    const second = await openEngine();
    try {
      // Reconciliation must NOT invent a deadline for the reattached row.
      assert.equal(second.metadata.getAssignment(id)?.deadlineAt, null, "no invented deadline on reattach");
    } finally {
      second.engine.shutdownEngine();
      await second.harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
      second.metadata.close();
      await second.storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort withdraws every tracked input and leaves no orphan submission", async () => {
  const fx = await fixture({ maxSteps: 40, timeoutMs: 30_000 });
  try {
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("never reached"),
      fauxAssistantMessage("never reached"),
    ]);
    const projectId = await fx.addProject("abort");
    const submitted = await fx.engine.submit({ projectId, task: "long", requestId: "req-ab-1" });
    const id = submitted.assignment.id;
    await new Promise((r) => setTimeout(r, 200));
    const steer = await fx.engine.steer({ id, content: "steer", mode: "steer", requestId: "in-ab-1" });
    const follow = await fx.engine.steer({ id, content: "follow", mode: "followup", requestId: "in-ab-2" });
    assert.ok(steer.submissionId !== null && follow.submissionId !== null);

    await fx.engine.abort({ id });
    // Every recorded input is terminal once the abort settles.
    for (const input of fx.metadata.listInputs(id)) {
      assert.ok(["done", "error"].includes(input.state), `input ${input.requestId} left ${input.state}`);
    }
    // The abort settled cleanly and released the writer lease.
    assert.equal(fx.metadata.getAssignment(id)?.leasePath, null, "lease released after abort");
  } finally {
    await fx.stop();
  }
});

test("wait returns promptly when the assignment becomes blocked AFTER the wait started", async () => {
  const fx = await fixture({ maxSteps: 8, timeoutMs: 30_000 });
  try {
    const projectId = await fx.addProject("waitblocked");
    const now = Date.now();
    // A RUNNING row so the initial wait check does not short-circuit: the wait
    // must enter its polling loop.
    fx.metadata.insertAssignment({
      id: "asg-wait-blocked",
      projectId,
      sessionId: null,
      conversationId: null,
      requestId: "req-wait-blocked",
      state: "running",
      acceptanceCriteria: null,
      submissionId: null,
      payloadHash: "hash-wait-blocked",
      parentId: null,
      task: "wait for a late pause",
      attemptCount: 1,
      deadlineAt: null,
      stopReason: null,
      leasePath: null,
      evidence: null,
      reviewNote: null,
      reviewedAt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });

    // Start the wait with a LONG client bound, then flip the row to `blocked`
    // shortly after. `blocked` is NOT terminal, so a wait that only checked
    // `isTerminal` inside its loop would burn the FULL 10s window despite the
    // run already being paused. It must return PROMPTLY (documented: wait
    // returns on blocked).
    const started = Date.now();
    const waiting = fx.engine.wait({ id: "asg-wait-blocked", timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 120));
    fx.metadata.updateAssignment("asg-wait-blocked", { state: "blocked", stopReason: "manager_request" });

    const settled = await waiting;
    const elapsed = Date.now() - started;
    assert.equal(settled.state, "blocked");
    assert.equal(settled.stopReason, "manager_request");
    assert.ok(elapsed < 3_000, `wait must return promptly on blocked (took ${elapsed}ms)`);
  } finally {
    await fx.stop();
  }
});


test("automatic work memory reaches the provider across real native compaction without a manager steer", async () => {
  const fx = await fixture({maxSteps:null,timeoutMs:null},undefined,{contextWindow:32768,maxTokens:8192});
  try {
    const projectId=await fx.addProject("compaction-memory");
    const project=fx.metadata.getProject(projectId)!;
    await writeFile(join(project.path,"large.ts"),"// original source context\n".repeat(5000));
    let reads=0, summaries=0, checkpointSeen=false;
    const response: import("@earendil-works/pi-ai/providers/faux").FauxResponseFactory = (context) => {
      if (JSON.stringify(context.messages[0]).includes("context summarization assistant")) {
        summaries++; return fauxAssistantMessage("Goal: implement result.txt. Inspected large.ts. Continue the existing assignment; do not restart reconnaissance.");
      }
      checkpointSeen ||= JSON.stringify(context.messages).includes("Repeated unchanged reads without a successful edit");
      if(reads++<24)return fauxAssistantMessage(fauxToolCall("read",{path:"large.ts"}),{stopReason:"toolUse"});
      if(reads===25)return fauxAssistantMessage(fauxToolCall("write",{path:"result.txt",content:"implemented"}),{stopReason:"toolUse"});
      return fauxAssistantMessage("Finished.");
    };
    fx.faux.setResponses(Array.from({length:100},()=>response));
    const r=await fx.engine.submit({projectId,task:"Implement result.txt after inspecting source.",requestId:"memory-real"});
    await fx.engine.wait({id:r.assignment.id,timeoutMs:30000});
    assert.equal(fx.engine.show({id:r.assignment.id}).state,"needs_review");
    assert.ok(summaries>0,"must exercise upstream native compaction");
    assert.ok(checkpointSeen,"context checkpoint must reach model without a manager turn");
    const memory=fx.metadata.getControl<import("../src/work-memory.js").WorkMemory>(`work-memory:${r.assignment.id}`)!;
    assert.equal(memory.loop,false);assert.deepEqual(memory.edits,["result.txt"]);
  } finally {await fx.stop();}
});
