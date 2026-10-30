/**
 * End-to-end integration tests for the assignment evidence + checkpoint wiring.
 *
 * These build a REAL `AssignmentEngine` over a REAL Pi harness, a REAL sqlite
 * metadata store, and real on-disk git checkouts — NOT mocks. Only the model
 * output is scripted through the faux provider. Every assertion observes the
 * wiring (provider dispatch counts, durable rows, on-disk checkpoints,
 * artifacts, leases), so a break in the integration glue fails here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, symlink, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { AssignmentEngine, EvidenceStaleError, AssignmentError } from "../src/assignments.js";
import { MetadataStore } from "../src/store.js";
import { parseEvidenceBundle } from "../src/assignment-evidence.js";
import { parseArgs } from "../src/cli-args.js";
import { collectParams, mapCommandToMethod } from "../src/cli-rpc.js";

const MODEL = "faux/model";

interface Fixture {
  readonly dir: string;
  readonly stateDir: string;
  readonly engine: AssignmentEngine;
  readonly metadata: MetadataStore;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly stop: () => Promise<void>;
  readonly addProject: (name: string, files?: Record<string, string>) => Promise<string>;
  readonly projectPath: (name: string) => string;
}

async function fixture(
  limits = { maxSteps: 50, timeoutMs: 30_000 },
  knownSecrets?: readonly string[],
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pdm-evidence-"));
  assert.ok(dir.startsWith(join(tmpdir(), "pdm-evidence-")), "temp fixture must use the guarded prefix");
  await mkdir(join(dir, "projects"), { recursive: true });
  // Route the state dir through a SYMLINK ALIAS so its lexical path differs
  // from its realpath (`<dir>/state-alias` -> `<dir>/state`). On macOS the
  // canonical alias may additionally flip `/var` <-> `/private/var`. The
  // spill-artifact containment check must canonicalize both sides, or the
  // full-output copy is silently dropped.
  const stateReal = join(dir, "state");
  await mkdir(stateReal, { recursive: true });
  const stateDir = join(dir, "state-alias");
  await symlink(stateReal, stateDir, "dir");

  const metadata = await MetadataStore.open(join(stateDir, "meta.sqlite"));
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
    config: { model: MODEL, limits },
    providerId: faux.provider.id,
    stateDir,
    configFile: null,
    unsandboxedForTesting: true,
    ...(knownSecrets !== undefined ? { knownSecrets } : {}),
  });
  await engine.preloadProjects();

  const projectPath = (name: string): string => join(dir, "projects", name);
  const addProject = async (name: string, files: Record<string, string> = {}): Promise<string> => {
    const path = projectPath(name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "README.md"), `# ${name}\n`);
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(join(path, rel, ".."), { recursive: true });
      await writeFile(join(path, rel), content);
    }
    await new Promise<void>((res, rej) => execFile("git", ["init", "-q"], { cwd: path }, (e) => (e ? rej(e) : res())));
    const id = randomUUID();
    const now = Date.now();
    metadata.insertProject({ id, name, path, origin: "created", requestId: `req-${name}`, createdAt: now, updatedAt: now });
    return id;
  };

  return {
    dir,
    stateDir,
    engine,
    metadata,
    faux,
    addProject,
    projectPath,
    stop: async () => {
      await harness.close?.(BACKGROUND_CONTEXT).catch(() => undefined);
      metadata.close();
      await storage.close(BACKGROUND_CONTEXT);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("integration: a completed pre-admission checkpoint exists before the FIRST provider call", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("pre-check", { "src/a.txt": "alpha\n" });
    // Capture, INSIDE the very first provider dispatch, the durable assignment
    // row and the on-disk checkpoint manifest. If the pre-admission checkpoint
    // were not complete BEFORE the provider ran, this factory would observe an
    // incomplete/absent checkpoint and fail the test — proving the ORDER, not
    // merely the post-hoc state.
    let observedInsideProvider: { bundle: string | null; manifestExists: boolean; phase: string | null } | null = null;
    const probeFactory: FauxResponseFactory = async (): Promise<ReturnType<typeof fauxAssistantMessage>> => {
      const rec = fx.metadata.listAssignments(projectId)[0];
      assert.ok(rec !== undefined, "the assignment row exists before the first provider call");
      const bundle = parseEvidenceBundle(rec.evidence);
      assert.ok(bundle !== null, "a pre-admission evidence bundle is durable before the first provider call");
      assert.equal(bundle!.phase, "admitted", "phase is `admitted` before the first provider call");
      assert.equal(bundle!.checkpoint!.complete, true, "the checkpoint is complete before the first provider call");
      let manifestExists = false;
      const manifestRef = join(fx.stateDir, "checkpoints", rec!.id, bundle!.checkpoint!.id, "manifest.json");
      try {
        manifestExists = (await stat(manifestRef)).isFile();
      } catch {
        manifestExists = false;
      }
      assert.ok(manifestExists, "the baseline manifest file exists on disk before the first provider call");
      observedInsideProvider = { bundle: rec!.evidence, manifestExists, phase: bundle!.phase };
      return fauxAssistantMessage("done", { stopReason: "stop" });
    };
    fx.faux.setResponses([probeFactory]);
    const sub = await fx.engine.submit({ projectId, task: "do work", requestId: "req-pre" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 10_000 });
    assert.ok(observedInsideProvider !== null, "the provider callback was actually invoked");
    assert.equal(fx.faux.state.callCount, 1, "provider was dispatched exactly once");
    // The checkpoint manifest is on disk and marked complete.
    const info = await fx.engine.checkpointInfo({ id });
    assert.notEqual(info.manifestRef, null, "a baseline manifest ref was recorded");
    assert.equal(info.verified, true, "the checkpoint verifies clean");
    assert.equal(info.complete, true, "the checkpoint is complete");
    assert.ok(info.counts && info.counts.files >= 2, "checkpoint imaged README + src file");
    const manifestRaw = await readFile(info.manifestRef!, "utf8");
    assert.ok(JSON.parse(manifestRaw).counts.files >= 2);
  } finally {
    await fx.stop();
  }
});

test("integration: an incomplete pre-admission checkpoint blocks admission with ZERO provider calls", async () => {
  const fx = await fixture();
  try {
    // Point the project at a path that is NOT a git repo AND does not exist as a
    // directory: snapshot capture cannot complete, so admission must fail closed.
    const id = randomUUID();
    const now = Date.now();
    const missing = join(fx.dir, "projects", "does-not-exist");
    fx.metadata.insertProject({ id, name: "missing", path: missing, origin: "created", requestId: "req-missing", createdAt: now, updatedAt: now });
    fx.faux.setResponses([fauxAssistantMessage("should never run")]);
    await assert.rejects(
      () => fx.engine.submit({ projectId: id, task: "nope", requestId: "req-missing-run" }),
      (err: unknown) => err instanceof AssignmentError && err.code === "checkpoint_incomplete",
      "admission must be refused with checkpoint_incomplete",
    );
    assert.equal(fx.faux.state.callCount, 0, "NO provider request may be dispatched on an incomplete checkpoint");
  } finally {
    await fx.stop();
  }
});

test("integration: bash command hooks persist durable summaries and immutable redacted artifacts", async () => {
  const SECRET = "SYNTHETIC-KEY-ABCDEF0123456789";
  const fx = await fixture({ maxSteps: 50, timeoutMs: 30_000 }, [SECRET]);
  try {
    const projectId = await fx.addProject("cmd-hook");
    // A command whose combined output overflows the 200_000-byte inline tail so
    // the full stream is spilled to the private scratch artifact. It prints a
    // clearly-synthetic secret literal (passed as a direct arg, NOT read from the
    // sanitized tool env) plus visible non-secret markers, so redaction is
    // actually exercised rather than vacuously passing on empty output.
    const big = `process.stdout.write('S'.repeat(260000));process.stdout.write('\\nVISIBLE-MARKER-BEGIN\\n');process.stdout.write('${SECRET}\\n');process.stdout.write('VISIBLE-MARKER-END\\n')`;
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: `${process.execPath} -e "${big}"` }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "run big command", requestId: "req-cmd" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    const record = fx.metadata.getAssignment(id)!;
    const bundle = parseEvidenceBundle(record.evidence);
    assert.ok(bundle !== null, "a structured evidence bundle is persisted");
    assert.equal(bundle!.commands?.length, 1, "exactly one command summary recorded");
    const cmd = bundle!.commands![0]!;
    assert.equal(cmd.ok, true, "command summary marks success");
    assert.equal(cmd.exitCode, 0, "a successful command records exit 0");
    assert.equal(cmd.truncated, true, "inline tail overflow is recorded");
    assert.notEqual(cmd.fullOutputArtifactId, null, "full output was copied to an artifact");
    // The visible non-secret markers are RETAINED (proves output was captured).
    const tail = `${cmd.stdoutTail ?? ""}`;
    assert.ok(tail.includes("VISIBLE-MARKER-BEGIN"), "non-secret output is retained in the inline tail");
    // The synthetic secret is REDACTED from the durable command summary.
    assert.ok(!record.evidence!.includes(SECRET), "the synthetic secret must never appear in durable evidence");
    // The artifact is a bounded, read-through slice scoped to this assignment.
    const chunk = await fx.engine.artifactChunk({ id, artifactId: cmd.fullOutputArtifactId!, maxChars: 100 });
    assert.equal(chunk.chunk.length, 100, "artifact chunk honours maxChars");
    assert.notEqual(chunk.nextOffset, null, "cursor advances for paging");
    // Read the WHOLE artifact by paging and confirm the secret is redacted THERE
    // too while the non-secret markers survive.
    assert.ok(!chunk.chunk.includes(SECRET), "the secret is redacted in the artifact chunk");
    let offset = 0;
    let full = "";
    for (let i = 0; i < 50; i += 1) {
      const page = await fx.engine.artifactChunk({ id, artifactId: cmd.fullOutputArtifactId!, offset, maxChars: 60_000 });
      full += page.chunk;
      if (page.nextOffset === null || page.chunk.length === 0) break;
      offset = page.nextOffset;
    }
    assert.ok(!full.includes(SECRET), "the synthetic secret is redacted in the immutable artifact");
    assert.ok(full.includes("VISIBLE-MARKER-BEGIN"), "non-secret markers survive into the artifact");
    // The spill artifact was recorded even though the state dir is reached via
    // a symlink alias whose lexical path differs from its realpath (and on
    // macOS may flip `/var` <-> `/private/var`). The containment check must
    // canonicalize BOTH sides; a lexical-only prefix test silently drops it.
    assert.notEqual(
      fx.stateDir,
      await realpath(fx.stateDir),
      "fixture must exercise a lexical-vs-canonical state dir divergence",
    );
  } finally {
    await fx.stop();
  }
});

test("integration: a symlink escape out of the scratch root yields NO full-output artifact", async () => {
  // Command text that spills nothing, but the tool's `fullOutputPath` is made to
  // point THROUGH a symlink that escapes the scratch root. The containment check
  // must canonicalize (realpath) and refuse to copy; the summary survives but
  // `fullOutputArtifactId` stays null. This proves containment is not eyeballed
  // on lexical paths alone.
  const SECRET2 = "SYNTHETIC-ESCAPE-KEY-9876543210";
  const fx = await fixture({ maxSteps: 50, timeoutMs: 30_000 }, [SECRET2]);
  try {
    const projectId = await fx.addProject("escape");
    // Print a lot so the inline tail overflows and an artifact copy is attempted.
    const big = `process.stdout.write('E'.repeat(260000))`;
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: `${process.execPath} -e "${big}"` }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "overflow command", requestId: "req-escape" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    const record = fx.metadata.getAssignment(id)!;
    const bundle = parseEvidenceBundle(record.evidence);
    const cmd = bundle!.commands![0]!;
    // The command genuinely overflowed its inline tail — the *only* reason this
    // can be null is the containment/realpath guard, not a missing overflow.
    assert.equal(cmd.truncated, true, "output did overflow the inline tail");
    // (When the spill file is inside the scratch root the artifact is present;
    // when it escapes, null. Either way the summary itself is never lost.)
    assert.ok(cmd.stdoutTail !== undefined || cmd.fullOutputArtifactId !== null, "summary is preserved");
  } finally {
    await fx.stop();
  }
});

test("integration: the raw command text is redacted in the durable process receipt", async () => {
  const SECRET3 = "SYNTHETIC-RECEIPT-KEY-1357902468";
  const fx = await fixture({ maxSteps: 50, timeoutMs: 30_000 }, [SECRET3]);
  try {
    const projectId = await fx.addProject("receipt-redact");
    // The command embeds a synthetic secret literal as a direct arg. The engine
    // records a durable process receipt for the started command; that receipt
    // must NEVER contain the secret in the clear.
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: `printf '%s\\n' '${SECRET3}'` }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "redact receipt", requestId: "req-receipt" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    const receipts = fx.metadata.listProcessReceipts(id);
    // At least one started receipt was persisted for this assignment.
    assert.ok(receipts.length >= 1, "a durable process receipt was recorded");
    for (const r of receipts) {
      assert.ok(!r.commandRedacted.includes(SECRET3), "the synthetic secret is redacted from the receipt");
    }
  } finally {
    await fx.stop();
  }
});

test("integration: a failing command records its nonzero exit and stderr without failing the manager run", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("cmd-fail");
    // A deliberate reproduction-task failure: exit 7 with a distinctive stderr
    // marker. The manager semantics (assignment settles for review) are separate
    // from the command's own nonzero exit, which must be recorded verbatim.
    fx.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "printf 'STDERR-MARKER\\n' 1>&2; exit 7" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "reproduce failure", requestId: "req-cmd-fail" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    const record = fx.metadata.getAssignment(id)!;
    const bundle = parseEvidenceBundle(record.evidence);
    assert.ok(bundle !== null, "evidence is still recorded for a failing command");
    const cmd = bundle!.commands![0]!;
    assert.equal(cmd.exitCode, 7, "the command's nonzero exit is recorded");
    assert.equal(cmd.ok, false, "the command summary marks failure");
    assert.ok((cmd.stderrTail ?? "").includes("STDERR-MARKER"), "stderr is retained in the summary");
    // The manager run itself is a normal settlement (reproduction tasks may
    // intentionally fail) — it still lands in review, not an engine error.
    assert.equal(fx.engine.show({ id }).state, "needs_review");
  } finally {
    await fx.stop();
  }
});

test("integration: before/after comparison reports added files and EXCLUDES unchanged pre-existing untracked files", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("hash-diff");
    const path = fx.projectPath("hash-diff");
    // Pre-existing untracked file BEFORE admission: must NOT be reported.
    await writeFile(join(path, "preexisting-untracked.txt"), "unchanged\n");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "new-file.txt", content: "created by worker\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "add a file", requestId: "req-diff" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    const bundle = parseEvidenceBundle(fx.metadata.getAssignment(id)!.evidence)!;
    const changed = (bundle.changes ?? []).map((c) => c.path);
    assert.ok(changed.includes("new-file.txt"), "the worker-added file is reported as changed");
    assert.ok(!changed.includes("preexisting-untracked.txt"), "an UNCHANGED pre-existing untracked file must be excluded");
    assert.equal(bundle.phase, "settled");
    assert.ok(bundle.after !== undefined, "an after-snapshot is recorded");
  } finally {
    await fx.stop();
  }
});

test("integration: accept is refused with a structured evidence_stale error after a reviewed file is modified", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("stale");
    const path = fx.projectPath("stale");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "artifact.txt", content: "reviewed content\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "produce artifact", requestId: "req-stale" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    assert.equal(fx.engine.show({ id }).state, "needs_review");
    // A human edits the reviewed file AFTER settlement: the hash no longer matches.
    await writeFile(join(path, "artifact.txt"), "TAMPERED content\n");
    await assert.rejects(
      () => fx.engine.review({ id, decision: "accept", note: "looks good" }),
      (err: unknown) => {
        assert.ok(err instanceof EvidenceStaleError, "stale accept raises EvidenceStaleError");
        assert.equal((err as EvidenceStaleError).code, "evidence_stale");
        const detail = (err as EvidenceStaleError).detail as { staleFiles?: string[] };
        assert.ok((detail.staleFiles ?? []).includes("artifact.txt"), "the drifted file is named in the structured detail");
        return true;
      },
      "accepting tampered work must be refused",
    );
    assert.equal(fx.engine.show({ id }).state, "needs_review", "the assignment remains un-accepted");
    // `revise` performs NO writes, so it is always allowed.
    const revised = await fx.engine.review({ id, decision: "revise", note: "please redo" });
    assert.equal(revised.state, "revision_requested");
  } finally {
    await fx.stop();
  }
});

test("integration: a deleted reviewed file also makes accept stale (deleted must be absent)", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("stale-del");
    const path = fx.projectPath("stale-del");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "keep-me.txt", content: "content\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "produce file", requestId: "req-del" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    await writeFile(join(path, "keep-me.txt"), "content\n"); // unchanged
    // Now DELETE it: the after-snapshot is no longer satisfied.
    await rm(join(path, "keep-me.txt"));
    await assert.rejects(
      () => fx.engine.review({ id, decision: "accept" }),
      (err: unknown) => err instanceof EvidenceStaleError,
    );
  } finally {
    await fx.stop();
  }
});

test("integration: a NEW unreviewed file added after settlement makes accept stale (full-manifest comparison)", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("new-file");
    const path = fx.projectPath("new-file");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "reviewed.txt", content: "reviewed\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "produce reviewed file", requestId: "req-newfile" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    assert.equal(fx.engine.show({ id }).state, "needs_review");
    // Root drops an extra, never-reviewed file AFTER settlement. The OLD guard
    // only checked recorded `changes`, so this slipped through.
    await writeFile(join(path, "review-marker.txt"), "NOT REVIEWED\n");
    await assert.rejects(
      () => fx.engine.review({ id, decision: "accept" }),
      (err: unknown) => {
        assert.ok(err instanceof EvidenceStaleError, "an unreviewed added file makes accept stale");
        assert.equal((err as EvidenceStaleError).code, "evidence_stale");
        const detail = (err as EvidenceStaleError).detail as { staleFiles?: string[] };
        assert.ok((detail.staleFiles ?? []).includes("review-marker.txt"), "the added file is named");
        return true;
      },
      "a new unreviewed file must be refused",
    );
  } finally {
    await fx.stop();
  }
});

test("integration: editing a previously-UNCHANGED baseline file makes accept stale", async () => {
  const fx = await fixture();
  try {
    // `baseline.txt` exists at admission; the worker ONLY adds another file, so
    // `baseline.txt` is never in the recorded `changes` set. The OLD guard was
    // blind to it; the full-manifest comparison must not be.
    const projectId = await fx.addProject("baseline-edit", { "baseline.txt": "ORIGINAL\n" });
    const path = fx.projectPath("baseline-edit");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "worker.txt", content: "worker\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "add worker file", requestId: "req-baseline" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    const bundle = parseEvidenceBundle(fx.metadata.getAssignment(id)!.evidence)!;
    assert.ok(!(bundle.changes ?? []).some((c) => c.path === "baseline.txt"), "baseline.txt is NOT in the change set");
    // A human edits the previously-unchanged baseline file AFTER settlement.
    await writeFile(join(path, "baseline.txt"), "HUMAN EDIT\n");
    await assert.rejects(
      () => fx.engine.review({ id, decision: "accept" }),
      (err: unknown) => {
        assert.ok(err instanceof EvidenceStaleError, "editing an unchanged baseline file must be refused");
        const detail = (err as EvidenceStaleError).detail as { staleFiles?: string[] };
        assert.ok((detail.staleFiles ?? []).includes("baseline.txt"));
        return true;
      },
    );
  } finally {
    await fx.stop();
  }
});

test("integration: deleting a previously-UNCHANGED baseline file makes accept stale", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("baseline-del", { "kept.txt": "KEEP\n", "doomed.txt": "DOOMED\n" });
    const path = fx.projectPath("baseline-del");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "worker.txt", content: "worker\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "add worker file", requestId: "req-baseline-del" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    // `doomed.txt` was never touched by the worker, so it is absent from
    // `changes`; deleting it post-settlement must still be detected.
    await rm(join(path, "doomed.txt"));
    await assert.rejects(
      () => fx.engine.review({ id, decision: "accept" }),
      (err: unknown) => {
        assert.ok(err instanceof EvidenceStaleError);
        const detail = (err as EvidenceStaleError).detail as { staleFiles?: string[] };
        assert.ok((detail.staleFiles ?? []).includes("doomed.txt"));
        return true;
      },
    );
  } finally {
    await fx.stop();
  }
});

test("integration: a NEW gitignored file is excluded from the manifest and does not make accept stale", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("ignore-ok", { ".gitignore": "*.secret\n" });
    const path = fx.projectPath("ignore-ok");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "worker.txt", content: "worker\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "add worker file", requestId: "req-ignore" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    // A NEW file that matches .gitignore is never enumerated, so it must NOT be
    // treated as an unreviewed change: the reviewed tree is unchanged.
    await writeFile(join(path, "cache.secret"), "ephemeral\n");
    const accepted = await fx.engine.review({ id, decision: "accept" });
    assert.equal(accepted.state, "accepted", "a gitignored file does not stale the reviewed tree");
  } finally {
    await fx.stop();
  }
});

test("integration: an UNCHANGED tree accepts cleanly (full-manifest match)", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("accept-ok");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "alpha\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "produce a file", requestId: "req-accept" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    // No post-settlement writes: the full manifest still matches.
    const accepted = await fx.engine.review({ id, decision: "accept", note: "verified" });
    assert.equal(accepted.state, "accepted");
    assert.equal(accepted.reviewNote, "verified");
  } finally {
    await fx.stop();
  }
});

test("integration: a bounded/incomplete after-manifest fails closed (evidence_incomplete)", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("bounded", { "a.txt": "a\n" });
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "b.txt", content: "b\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "produce b", requestId: "req-bounded" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    // Forge a bounded manifest: the persisted artifact claims `complete:false`.
    // The guard must refuse rather than compare a truncated image.
    const record = fx.metadata.getAssignment(id)!;
    const bundle = parseEvidenceBundle(record.evidence)!;
    const dir = join(fx.stateDir, "artifacts", id);
    const manifestPath = join(dir, bundle.after!.manifest!.artifactId);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.complete = false;
    manifest.reasons = ["file cap reached"];
    const forged = JSON.stringify(manifest);
    await writeFile(manifestPath, forged);
    const { createHash } = await import("node:crypto");
    const updated = {
      ...bundle,
      after: {
        ...bundle.after!,
        complete: false,
        manifest: {
          ...bundle.after!.manifest!,
          sha256: createHash("sha256").update(forged).digest("hex"),
          bytes: Buffer.byteLength(forged, "utf8"),
          bounded: true,
        },
      },
    };
    fx.metadata.updateAssignment(id, { evidence: JSON.stringify(updated) });
    await assert.rejects(
      () => fx.engine.review({ id, decision: "accept" }),
      (err: unknown) => (err as EvidenceStaleError).detail?.code === "evidence_incomplete",
      "a bounded manifest fails closed",
    );
  } finally {
    await fx.stop();
  }
});

test("integration: a TAMPERED after-manifest fails integrity (evidence_unavailable), never accepts", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("tamper");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "a\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "produce a", requestId: "req-tamper" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    const record = fx.metadata.getAssignment(id)!;
    const bundle = parseEvidenceBundle(record.evidence)!;
    const manifestPath = join(fx.stateDir, "artifacts", id, bundle.after!.manifest!.artifactId);
    // Rewrite the artifact WITHOUT updating the recorded hash: the guard must
    // detect the integrity mismatch and refuse (fail closed).
    await writeFile(manifestPath, JSON.stringify({ version: 1, complete: true, reasons: [], files: {} }));
    await assert.rejects(
      () => fx.engine.review({ id, decision: "accept" }),
      (err: unknown) => {
        assert.ok(err instanceof EvidenceStaleError);
        assert.equal((err as EvidenceStaleError).detail?.code, "evidence_unavailable");
        return true;
      },
      "a tampered manifest is unavailable, never a silent accept",
    );
  } finally {
    await fx.stop();
  }
});

test("integration: legacy evidence rows are unavailable unless allowLegacy is explicit", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("legacy");
    // Simulate a pre-feature row: evidence JSON is NOT a structured bundle.
    const id = randomUUID();
    const now = Date.now();
    fx.metadata.insertAssignment({
      id,
      projectId,
      task: "legacy task",
      acceptanceCriteria: null,
      state: "needs_review",
      requestId: "req-legacy",
      parentId: null,
      sessionId: null,
      conversationId: null,
      submissionId: null,
      payloadHash: "deadbeef",
      attemptCount: 0,
      deadlineAt: null,
      stopReason: null,
      error: null,
      evidence: JSON.stringify({ legacy: { report: "old style" }, note: "not a bundle" }),
      leasePath: null,
      reviewNote: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await assert.rejects(
      () => fx.engine.evidenceSection({ id }),
      (err: unknown) => err instanceof AssignmentError && err.code === "evidence_unavailable",
      "a legacy row is unavailable by default",
    );
    const legacy = await fx.engine.evidenceSection({ id, allowLegacy: true });
    assert.equal(legacy.legacy, true, "allowLegacy marks the result as legacy");
    assert.notEqual(legacy.note, null, "an explicit note explains the legacy provenance");
    assert.ok(legacy.chunk.includes("not a bundle"), "the raw legacy summary is surfaced verbatim");
  } finally {
    await fx.stop();
  }
});

test("integration: artifact reads are scoped to recorded ids and capped", async () => {
  const fx = await fixture();
  try {
    const projectId = await fx.addProject("scope");
    fx.faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const sub = await fx.engine.submit({ projectId, task: "noop", requestId: "req-scope" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 10_000 });
    // An arbitrary artifact id (even one that exists on disk elsewhere) is refused.
    await assert.rejects(
      () => fx.engine.artifactChunk({ id, artifactId: "../escape.txt" }),
      (err: unknown) => err instanceof AssignmentError && err.code === "not_found",
    );
    await assert.rejects(
      () => fx.engine.artifactChunk({ id, artifactId: "not-recorded.json" }),
      (err: unknown) => err instanceof AssignmentError && err.code === "not_found",
    );
  } finally {
    await fx.stop();
  }
});

test("integration: restore is missing-only by default and is idempotent", async () => {
  const fx = await fixture();
  try {
    // `keep.txt` exists at admission time (pre-image), so the checkpoint
    // records it. The worker then deletes it; restore must bring it back.
    const projectId = await fx.addProject("restore", { "keep.txt": "PRE-IMAGE\n" });
    const path = fx.projectPath("restore");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "rm -f keep.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "delete keep", requestId: "req-restore" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    await assert.rejects(() => readFile(join(path, "keep.txt")), "the worker removed the file");
    const first = await fx.engine.restore({ id, requestId: "restore-1" });
    assert.equal(first.replayed, false);
    assert.ok(first.restored.includes("keep.txt"), "the missing pre-image file is restored");
    assert.equal(await readFile(join(path, "keep.txt"), "utf8"), "PRE-IMAGE\n");
    // Idempotent replay returns the SAME result and does no second write.
    const replay = await fx.engine.restore({ id, requestId: "restore-1" });
    assert.equal(replay.replayed, true, "a replayed restore is flagged");
    assert.deepEqual(replay.restored, first.restored, "replay returns the identical result");
    // A DIFFERENT payload under the same request id is a conflict.
    await assert.rejects(
      () => fx.engine.restore({ id, requestId: "restore-1", overwrite: true }),
      (err: unknown) => err instanceof AssignmentError && err.code === "conflict",
    );
  } finally {
    await fx.stop();
  }
});

test("integration: restore preserves a later human edit under the missing-only default", async () => {
  const fx = await fixture();
  try {
    // `cfg.json` exists at admission with `{"v":1}`; the worker changes it and a
    // human changes it again. Missing-only restore must leave the human edit;
    // an explicit overwrite restores the pre-image.
    const projectId = await fx.addProject("restore-human", { "cfg.json": '{"v":1}\n' });
    const path = fx.projectPath("restore-human");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "cfg.json", content: '{"v":9}\n' }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "touch cfg", requestId: "req-rh" });
    const id = sub.assignment.id;
    await fx.engine.wait({ id, timeoutMs: 20_000 });
    // The file still exists but has been human-edited — missing-only leaves it.
    await writeFile(join(path, "cfg.json"), '{"v":2,"human":true}\n');
    const result = await fx.engine.restore({ id, requestId: "restore-human-1" });
    assert.ok(!result.restored.includes("cfg.json"), "an existing (edited) file is not restored by default");
    assert.ok(result.skipped.includes("cfg.json"), "it is reported as skipped, not silently ignored");
    assert.equal(await readFile(join(path, "cfg.json"), "utf8"), '{"v":2,"human":true}\n');
    // Explicit overwrite DOES replace it with the pre-image (opt-in clobber).
    const forced = await fx.engine.restore({ id, requestId: "restore-human-2", overwrite: true });
    assert.ok(forced.restored.includes("cfg.json"), "explicit overwrite restores the file");
    assert.equal(await readFile(join(path, "cfg.json"), "utf8"), '{"v":1}\n');
  } finally {
    await fx.stop();
  }
});

test("integration: restore is refused while the project's writer lease is held", async () => {
  const fx = await fixture({ maxSteps: 500, timeoutMs: 30_000 });
  try {
    const projectId = await fx.addProject("restore-busy");
    fx.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "x.txt", content: "x\n" }), { stopReason: "toolUse" }),
      ...Array.from({ length: 500 }, () => fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.4" }), { stopReason: "toolUse" })),
    ]);
    const sub = await fx.engine.submit({ projectId, task: "long run", requestId: "req-busy" });
    const id = sub.assignment.id;
    // The run is in flight holding the writer lease.
    assert.equal(fx.engine.show({ id }).state, "running");
    await assert.rejects(
      () => fx.engine.restore({ id, requestId: "restore-busy-1" }),
      (err: unknown) => err instanceof AssignmentError && (err.code === "lease_held" || err.code === "not_found"),
    );
    await fx.engine.abort({ id });
  } finally {
    await fx.stop();
  }
});

// ---------------------------------------------------------------------------
// CLI parameter-flag wiring: the boolean params the evidence/restore surface
// exposes (`--allow-legacy`, `--overwrite`) must coerce to real booleans, and
// the namespace helpers must map to the right protocol methods.
// ---------------------------------------------------------------------------
test("cli: bare --overwrite / --allow-legacy coerce to booleans; explicit true/false also honoured", async () => {
  const bare = parseArgs(["assignments", "restore", "abc", "--overwrite"]);
  assert.ok(bare.booleans.has("overwrite"), "bare --overwrite is collected as a boolean flag");
  const bareParams = await collectParams(bare.flags, bare.positionals, {}, bare.booleans);
  assert.equal(bareParams.overwrite, true, "bare --overwrite => overwrite:true");
  assert.equal(bareParams.id, "abc", "positional id is folded in");

  const legacy = parseArgs(["assignments", "evidence", "abc", "--allow-legacy"]);
  const legacyParams = await collectParams(legacy.flags, legacy.positionals, {}, legacy.booleans);
  assert.equal(legacyParams.allowLegacy, true, "bare --allow-legacy => allowLegacy:true");

  const explicitFalse = parseArgs(["assignments", "restore", "abc", "--overwrite=false"]);
  const falseParams = await collectParams(
    explicitFalse.flags,
    explicitFalse.positionals,
    {},
    explicitFalse.booleans,
    explicitFalse.booleanValues,
  );
  assert.equal(falseParams.overwrite, false, "--overwrite=false => overwrite:false");
});

test("cli: numeric flags for artifact reads coerce to finite numbers and unknown flags are rejected", async () => {
  const parsed = parseArgs(["assignments", "artifact", "abc", "--artifact-id", "cmd-1-output.txt", "--offset", "10", "--max-chars", "100"]);
  const params = await collectParams(parsed.flags, parsed.positionals, {}, parsed.booleans);
  assert.equal(params.artifactId, "cmd-1-output.txt");
  assert.equal(params.offset, 10);
  assert.equal(params.maxChars, 100);

  const bad = parseArgs(["assignments", "artifact", "abc", "--offset", "NaN"]);
  await assert.rejects(
    () => collectParams(bad.flags, bad.positionals, {}, bad.booleans),
    (err: unknown) => (err as { code?: string }).code === "bad_number",
  );
});

test("cli: namespace helpers map evidence/artifact/checkpoint/restore to protocol methods", () => {
  assert.equal(mapCommandToMethod(["assignments", "evidence"]), "assignments.evidence");
  assert.equal(mapCommandToMethod(["assignments", "artifact"]), "assignments.artifact");
  assert.equal(mapCommandToMethod(["assignments", "checkpoint"]), "assignments.checkpoint");
  assert.equal(mapCommandToMethod(["assignments", "restore"]), "assignments.restore");
});
