import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MetadataStore,
  StoreError,
  SCHEMA_VERSION,
  canonicalJson,
  payloadHash,
} from "../src/store.js";

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pdm-store-"));
}

test("canonicalJson sorts keys and payloadHash is stable across key order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(payloadHash({ b: 1, a: 2 }), payloadHash({ a: 2, b: 1 }));
  assert.notEqual(payloadHash({ a: 1 }), payloadHash({ a: 2 }));
});

test("MetadataStore.open creates the schema and reports its version", async () => {
  const dir = await makeDir();
  try {
    const store = await MetadataStore.open(join(dir, "nested", "metadata.sqlite"));
    assert.equal(store.schemaVersion, SCHEMA_VERSION);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MetadataStore.open creates private directory and file permissions", async () => {
  const dir = await makeDir();
  try {
    const dbPath = join(dir, "state", "metadata.sqlite");
    const store = await MetadataStore.open(dbPath);
    store.close();
    const dirInfo = await stat(join(dir, "state"));
    assert.equal(dirInfo.mode & 0o077, 0, "state dir must be owner-only");
    const fileInfo = await stat(dbPath);
    assert.equal(fileInfo.mode & 0o077, 0, "db file must be owner-only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("journal begin is idempotent for the same payload and reports replay", async () => {
  const dir = await makeDir();
  try {
    const store = await MetadataStore.open(join(dir, "metadata.sqlite"));
    const first = store.beginJournal("project.create", "req-1", { name: "a", path: "/x" });
    assert.equal(first.replayed, false);
    store.completeJournal("project.create", "req-1", "proj-1");

    const second = store.beginJournal("project.create", "req-1", { path: "/x", name: "a" });
    assert.equal(second.replayed, true);
    assert.equal(second.record.resultId, "proj-1");
    assert.equal(second.record.status, "ready");
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("journal begin rejects a conflicting payload for the same request id", async () => {
  const dir = await makeDir();
  try {
    const store = await MetadataStore.open(join(dir, "metadata.sqlite"));
    store.beginJournal("project.create", "req-1", { name: "a" });
    assert.throws(
      () => store.beginJournal("project.create", "req-1", { name: "b" }),
      (error: unknown) => error instanceof StoreError && error.code === "conflict",
    );
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pendingJournal lists only entries left preparing", async () => {
  const dir = await makeDir();
  try {
    const store = await MetadataStore.open(join(dir, "metadata.sqlite"));
    store.beginJournal("project.create", "req-1", { a: 1 });
    store.beginJournal("project.create", "req-2", { a: 2 });
    store.completeJournal("project.create", "req-2", "proj-2");

    const pending = store.pendingJournal();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.requestId, "req-1");
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("projects round-trip through the store", async () => {
  const dir = await makeDir();
  try {
    const store = await MetadataStore.open(join(dir, "metadata.sqlite"));
    const now = Date.now();
    store.insertProject({
      id: "p1",
      name: "demo",
      path: "/tmp/demo",
      origin: "created",
      requestId: "r1",
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(store.getProject("p1")?.name, "demo");
    assert.equal(store.getProjectByPath("/tmp/demo")?.id, "p1");
    assert.equal(store.listProjects().length, 1);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sessions round-trip and can be listed per project", async () => {
  const dir = await makeDir();
  try {
    const store = await MetadataStore.open(join(dir, "metadata.sqlite"));
    const now = Date.now();
    store.insertProject({
      id: "p1",
      name: "demo",
      path: "/tmp/demo",
      origin: "created",
      requestId: "r1",
      createdAt: now,
      updatedAt: now,
    });
    store.insertSession({
      id: "s1",
      projectId: "p1",
      conversationId: "42",
      requestId: "sr1",
      createdAt: now,
    });
    assert.equal(store.getSession("s1")?.conversationId, "42");
    assert.equal(store.getSessionByConversation("42")?.id, "s1");
    assert.equal(store.getSessionByRequest("sr1")?.id, "s1");
    assert.equal(store.listSessions("p1").length, 1);
    assert.equal(store.listSessions("other").length, 0);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operator inputs are created preparing, replay idempotently, and conflict on new content", async () => {
  const dir = await makeDir();
  try {
    const store = await MetadataStore.open(join(dir, "metadata.sqlite"));
    // A tracked input is persisted in `preparing` BEFORE any Pi admission.
    const created = store.beginInput({
      requestId: "in-1",
      assignmentId: "a1",
      mode: "steer",
      contentHash: payloadHash("do a thing"),
      redactedContent: "do a thing",
    });
    assert.equal(created.state, "preparing");
    assert.equal(created.submissionId, null);

    // Same requestId + same content replays (no new row, no throw).
    const replay = store.beginInput({
      requestId: "in-1",
      assignmentId: "a1",
      mode: "steer",
      contentHash: payloadHash("do a thing"),
      redactedContent: "do a thing",
    });
    assert.equal(replay.requestId, "in-1");
    assert.equal(store.listInputs("a1").length, 1);

    // Same requestId + different content is a hard conflict.
    assert.throws(
      () =>
        store.beginInput({
          requestId: "in-1",
          assignmentId: "a1",
          mode: "steer",
          contentHash: payloadHash("different"),
          redactedContent: "different",
        }),
      (error: unknown) => error instanceof StoreError && error.code === "conflict",
    );

    // Admit it and drive it to done.
    store.markInputAdmitted("in-1", "sub-99");
    assert.equal(store.getInput("in-1")?.submissionId, "sub-99");
    assert.equal(store.getInput("in-1")?.state, "admitted");
    store.setInputState("in-1", "done");
    assert.equal(store.getInput("in-1")?.state, "done");
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a closed store rejects further reads", async () => {  const dir = await makeDir();
  try {
    const store = await MetadataStore.open(join(dir, "metadata.sqlite"));
    store.close();
    assert.throws(
      () => store.listProjects(),
      (error: unknown) => error instanceof StoreError && error.code === "closed",
    );
    // close is idempotent
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
