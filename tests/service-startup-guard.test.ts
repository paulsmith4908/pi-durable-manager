/**
 * SERVICE STARTUP admission-gate regression.
 *
 * The manager records an assignment row and drives a durable Pi conversation. If
 * the service dies mid-tool, `harness.resume()` on the NEXT boot re-drives that
 * durable submission. `harness.abortSubmission` CANNOT stop an already-placed
 * turn (it returns `already_placed`), so blocking the metadata row alone is not
 * sufficient. The authoritative defense is the `beforeTool`/`beforeExecute`
 * admission gate installed per project: a tool call is refused unless the
 * owning assignment is CURRENTLY admitted (`queued`/`running`/`cancelling`),
 * BEFORE any side effect. A conversation that EVER carried an in-doubt command
 * is RETIRED — its session can never be reused, so an old quarantined tool call
 * cannot borrow a fresh assignment's admission when Pi reuses the conversation.
 *
 * These tests exercise the REAL `PiDurableService.start()` startup path over a
 * state dir seeded by a REAL `Harness` + `MetadataStore`, mirroring
 * `tests/assignments.engine.test.ts`. They are NON-VACUOUS: the clean-boot
 * control proves a blind resume WOULD append (and settle `needs_review`), while
 * the dirty-boot case proves the gate refuses the re-driven call (marker
 * unchanged, row `blocked`/`in_doubt_command`, lease RETAINED), that the retired
 * session cannot be reused, and that a fresh session works after explicit abort.
 *
 * Isolated fixtures only: each test owns a throwaway `mkdtemp` state dir and a
 * short private socket dir under `.s/`. Nothing here stops a real manager or
 * signals a real process group.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { AssignmentEngine } from "../src/assignments.js";
import { PiClient } from "../src/client.js";
import type { PiDurableConfig } from "../src/config.js";
import type { ResolvedCredential } from "../src/credential.js";
import { PiDurableService, type ServiceHost } from "../src/service.js";
import { MetadataStore } from "../src/store.js";

const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
const LIMITS = { maxSteps: 40, timeoutMs: 30_000 } as const;
const KEY = "sk-fake-startup-guard-not-real";

/** Short private socket dir (macOS 104-byte limit); `.s/` is git-ignored. */
function shortSocketDir(): { dir: string; socketPath: string } {
  const dir = join(process.cwd(), ".s", randomUUID().slice(0, 6));
  const socketPath = join(dir, "s");
  assert.ok(Buffer.byteLength(socketPath) < 100, `socket path too long: ${socketPath}`);
  return { dir, socketPath };
}

function makeConfig(dir: string, stateDir: string): PiDurableConfig {
  return {
    configVersion: 1,
    endpoint: "https://inference.example.invalid/v1",
    model: MODEL,
    limits: { contextWindow: 65536, maxTokens: 8192, ...LIMITS },
    paths: { stateDir, projectHome: join(dir, "projects"), allowedRoots: [join(dir, "projects")] },
    credential: { env: "PI_DURABLE_TEST_KEY_UNUSED" },
  };
}

function gitInit(cwd: string): Promise<void> {
  return new Promise((res, rej) => execFile("git", ["init", "-q"], { cwd }, (e) => (e ? rej(e) : res())));
}

/** Raw stores + engine over `stateDir`, mirroring the engine test fixture. */
async function openRawEngine(stateDir: string, bootId: string) {
  const metadata = await MetadataStore.open(join(stateDir, "metadata.sqlite"));
  const storage = await openNodeSqliteStorage(join(stateDir, "pi.sqlite"));
  const registry = createRegistry();
  const faux = fauxProvider({ provider: "faux", models: [{ id: MODEL }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
  const engine = new AssignmentEngine({
    harness,
    registry,
    metadata,
    config: { model: MODEL, limits: { ...LIMITS } },
    providerId: faux.provider.id,
    stateDir,
    configFile: null,
    unsandboxedForTesting: true,
    bootId,
  });
  await engine.preloadProjects();
  return { metadata, storage, harness, faux, engine };
}

interface Seeded {
  readonly dir: string;
  readonly stateDir: string;
  readonly marker: string;
  readonly projectPath: string;
  readonly projectId: string;
  readonly assignmentId: string;
  readonly conversationId: string;
}

/**
 * Seed one project + assignment whose durable Pi conversation issues a bash
 * tool call (`append PRIMARY`). We stop as soon as the tool's process receipt
 * exists — i.e. mid-tool, before the result commits — then tear the raw stores
 * down (clean or dirty per `opts.clean`) so the REAL service can start over the
 * same dir.
 */
async function seedMidTool(opts: { clean: boolean }): Promise<Seeded> {
  const dir = await mkdtemp(join(tmpdir(), "pdm-guard-"));
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(dir, "projects"), { recursive: true });
  const projectPath = join(dir, "projects", "proj");
  await mkdir(projectPath, { recursive: true });
  const marker = join(projectPath, "marker.txt");
  await writeFile(marker, "");
  await gitInit(projectPath);

  const first = await openRawEngine(stateDir, "boot-ONE");
  const projectId = randomUUID();
  first.metadata.insertProject({
    id: projectId,
    name: "proj",
    path: projectPath,
    origin: "created",
    requestId: "req-p",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  // Response 1: the in-doubt command that runs on the dirty boot. Response 2 is
  // what a BLIND resume would run next; the gate must refuse it.
  first.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'PRIMARY\\n' >> marker.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'RESUME\\n' >> marker.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  first.metadata.beginServiceRun("boot-ONE", process.pid, Date.now());
  const submitted = await first.engine.submit({ projectId, task: "go", requestId: "req-1" });
  const assignmentId = submitted.assignment.id;

  const deadline = Date.now() + 5_000;
  let receipts = first.metadata.listProcessReceipts(assignmentId);
  while (receipts.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    receipts = first.metadata.listProcessReceipts(assignmentId);
  }
  assert.ok(receipts.length > 0, "durable conversation issued a bash tool before teardown");

  const row = first.metadata.getAssignment(assignmentId);
  assert.ok(row?.conversationId !== null && row?.conversationId !== undefined, "assignment recorded a conversation id");
  const conversationId = row.conversationId;
  // Record a session pointing at this conversation, exactly as a real caller
  // would after creating the conversation, so the reuse path can be exercised.
  first.metadata.insertSession({
    id: "sess-1",
    projectId,
    conversationId,
    requestId: "req-1",
    createdAt: Date.now(),
  });

  if (opts.clean) first.metadata.markServiceRunClean("boot-ONE", Date.now());
  first.engine.shutdownEngine();
  await first.harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
  first.metadata.close();
  await first.storage.close(BACKGROUND_CONTEXT);

  return { dir, stateDir, marker, projectPath, projectId, assignmentId, conversationId };
}

/** Start the REAL service over a seeded state dir, scripting ONLY the RESUME turn. */
async function startServiceOver(
  seeded: Seeded,
): Promise<{ service: PiDurableService; socketParent: string; faux: ReturnType<typeof fauxProvider> }> {
  const faux = fauxProvider({ provider: "faux", models: [{ id: MODEL }] });
  // The ONLY response the restarted service may consume. If a quarantined
  // durable submission were blindly re-driven this call would run and append
  // RESUME; the gate must refuse it.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'RESUME\\n' >> marker.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const host: ServiceHost = {
    config: makeConfig(seeded.dir, seeded.stateDir),
    providerId: faux.provider.id,
    createModels: () => models,
    resolveCredential: async (): Promise<ResolvedCredential> => ({ apiKey: KEY, source: "test" }),
    // CRITICAL: the service derives its metadata DB from `runtimeDir`; it MUST
    // equal the seeded state dir so both share one database.
    runtimeDir: seeded.stateDir,
    unsandboxedForTesting: true,
  };
  const { dir: socketParent, socketPath } = shortSocketDir();
  const service = await PiDurableService.start({ host, socketPath });
  return { service, socketParent, faux };
}

/** Reopen only the metadata DB to assert durable rows (service may still run). */
async function readAssignment(stateDir: string, id: string) {
  const meta = await MetadataStore.open(join(stateDir, "metadata.sqlite"));
  try {
    return meta.getAssignment(id);
  } finally {
    meta.close();
  }
}

test("CONTROL: a CLEAN prior boot lets resume re-drive the durable call (appends)", async () => {
  const seeded = await seedMidTool({ clean: true });
  const { service, socketParent, faux } = await startServiceOver(seeded);
  try {
    await new Promise((r) => setTimeout(r, 500));
    const text = await readFile(seeded.marker, "utf8");
    assert.equal(text, "PRIMARY\nRESUME\n", "control: blind resume appends RESUME (proves non-vacuous)");
    assert.equal(faux.state.callCount, 2, "control: service consumes the RESUME turn");
    const row = await readAssignment(seeded.stateDir, seeded.assignmentId);
    assert.notEqual(row?.state, "blocked", "control row is not quarantined");
  } finally {
    await service.stop();
    await rm(seeded.dir, { recursive: true, force: true });
    await rm(socketParent, { recursive: true, force: true });
  }
});

test("DIRTY boot: gate refuses the re-driven call; lease retained; retired session rejected; fresh session works after abort", async () => {
  const seeded = await seedMidTool({ clean: false });
  const { service, socketParent, faux } = await startServiceOver(seeded);
  let client: PiClient | undefined;
  try {
    await new Promise((r) => setTimeout(r, 500));

    // (1) NO duplicate append / no external tool ran on the dirty boot.
    const text = await readFile(seeded.marker, "utf8");
    assert.equal(text, "PRIMARY\n", "gate refuses the re-driven bash call: no RESUME append");

    // (2) The row is quarantined with a retained lease (operator-visible).
    const row = await readAssignment(seeded.stateDir, seeded.assignmentId);
    assert.equal(row?.state, "blocked", "quarantined row is blocked");
    assert.equal(row?.stopReason, "in_doubt_command", "stop reason records the in-doubt command");
    assert.ok(row?.leasePath !== null && row?.leasePath !== undefined, "quarantined row RETAINS its lease");

    // (3) Non-vacuous: the re-driven generation DID consume the RESUME turn (the
    //     model ran) — the GATE, not the model, prevented the append.
    assert.equal(faux.state.callCount, 2, "resume did re-drive the model (non-vacuous)");

    // (4) The service is reachable over the real UDS: the gate is authoritative,
    //     not a hang.
    client = await PiClient.connect({ socketPath: service.path, timeoutMs: 10_000 });
    const pong = await client.call<{ pong: boolean }>("service.ping");
    assert.equal(pong.pong, true, "service is serving; the gate is not a hang");

    // (5) Explicit abort succeeds once the recorded group is gone (recoverable,
    //     not wedged) — releasing the retained lease / quarantine.
    const aborted = await client.call<{ id: string; state: string }>("assignments.abort", { id: seeded.assignmentId });
    assert.equal(aborted.id, seeded.assignmentId, "abort returns the assignment detail");
    assert.equal(aborted.state, "cancelled", "aborted assignment reaches a terminal state");

    // (6) Retirement: with the lease now RELEASED, reusing the quarantined
    //     conversation's session for a NEW assignment is still REFUSED
    //     (fail-closed on the retired conversation), so an old in-doubt tool
    //     call can never be re-driven under a fresh admission.
    await assert.rejects(
      () =>
        client!.call(
          "assignments.submit",
          { projectId: seeded.projectId, task: "reuse", sessionId: "sess-1" },
          "req-reuse",
        ),
      (error: unknown) => /retired|review/i.test(`${(error as Error).message} ${(error as { code?: string }).code}`),
      "reusing a retired session is refused",
    );

    // (7) A FRESH session is NOT retired and may be submitted independently.
    // (7) A FRESH assignment (no reused session; a brand-new conversation) is
    //     admitted independently — recovery via a fresh session works.
    const fresh = await client.call<{ assignment: { id: string; conversationId: string | null } }>(
      "assignments.submit",
      { projectId: seeded.projectId, task: "fresh work" },
      "req-fresh",
    );
    assert.notEqual(fresh.assignment.id, seeded.assignmentId, "a fresh session starts new work");
    assert.notEqual(fresh.assignment.conversationId, seeded.conversationId, "fresh work uses a new conversation");
  } finally {
    client?.close();
    await service.stop();
    await rm(seeded.dir, { recursive: true, force: true });
    await rm(socketParent, { recursive: true, force: true });
  }
});
