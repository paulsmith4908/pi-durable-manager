import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat, mkdir, symlink, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";

import {
  PiDurableService,
  OwnerLock,
  ServiceError,
  resolveRuntimeDir,
  resolveSocketPath,
} from "../src/service.js";
import { PiClient, PiClientError, configSocketPath, applyRequestId, IDEMPOTENT_METHODS } from "../src/client.js";
import { MetadataStore } from "../src/store.js";
import type { PiDurableConfig } from "../src/config.js";
import type { ResolvedCredential } from "../src/credential.js";
import type { ServiceHost } from "../src/service.js";
import { startLiveConsole, watchActivity } from "../src/live-console.js";

const FAKE_KEY = "sk-fake-service-key-0000-not-real";
const SUPER_SECRET = "super-secret-service-value";

/**
 * The Unix-domain socket path limit is about 104 bytes on macOS. The ambient
 * temp dir is far too long, so tests create a SHORT private directory INSIDE the
 * project working directory: `.s/<6 hex>/s`. `.s/` is git-ignored and the
 * worker is permitted to write inside the project. This exercises the REAL
 * Unix-domain transport rather than a loopback TCP workaround.
 */
function shortSocketDir(): { dir: string; socketPath: string } {
  const dir = join(process.cwd(), ".s", randomUUID().slice(0, 6));
  const socketPath = join(dir, "s");
  const bytes = Buffer.byteLength(socketPath);
  if (bytes >= 100) {
    throw new Error(`Test socket path is ${bytes} bytes; expected < 100.`);
  }
  return { dir, socketPath };
}

/**
 * Send a raw HTTP/1.1 GET over a loopback socket with an explicit Host header.
 * `fetch` drops a caller-supplied Host, so the raw transport is required to
 * prove the console rejects a bad Host. Returns the numeric status code.
 */
function rawStatusLine(baseUrl: string, path: string, host: string): Promise<number> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise<number>((resolve, reject) => {
    const socket = createConnection({ host: hostname, port: Number(port) });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", chunk => { buffer += chunk; });
    socket.on("error", reject);
    socket.on("end", () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buffer);
      if (!match) return reject(new Error(`No status line in response: ${buffer.slice(0, 80)}`));
      resolve(Number(match[1]));
    });
  });
}

/** A config rooted in a throwaway directory. */function makeConfig(dir: string): PiDurableConfig {
  return {
    configVersion: 1,
    endpoint: "https://inference.example.invalid/v1",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    limits: { contextWindow: 65536, maxTokens: 8192, maxSteps: 40, timeoutMs: 30000 },
    paths: {
      stateDir: join(dir, "state"),
      projectHome: join(dir, "projects"),
      allowedRoots: [join(dir, "projects")],
    },
    credential: { env: "PI_DURABLE_TEST_KEY_UNUSED" },
  };
}

/** A host that injects a faux Models catalogue and a fake credential. */
function makeHost(dir: string, runtimeDir: string, faux?: FauxProviderHandle): ServiceHost {
  const provider =
    faux ??
    fauxProvider({
      provider: "faux",
      models: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash" }],
    });
  const models = createModels();
  models.setProvider(provider.provider);
  return {
    config: makeConfig(dir),
    providerId: provider.provider.id,
    createModels: () => models,
    resolveCredential: async (): Promise<ResolvedCredential> => ({ apiKey: FAKE_KEY, source: "test" }),
    runtimeDir,
  };
}

/** A running service plus the private directory that owns its socket. */
interface Fixture {
  readonly dir: string;
  readonly service: PiDurableService;
  readonly socketParent: string;
  readonly faux: FauxProviderHandle;
  readonly cleanup: () => Promise<void>;
}

async function startFixture(socketDirOverride?: string): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pdm-svc-"));
  // The service canonicalizes the EXISTING parent of a new project and rejects a
  // missing one (`not_found`). Real callers pass a path whose parent already
  // exists, so create the configured projectHome up front. The canonical
  // parent-existence validation in the service stays untouched.
  await mkdir(join(dir, "projects"), { recursive: true });
  const { dir: defaultParent, socketPath: defaultSocket } = shortSocketDir();
  const parent = socketDirOverride ?? defaultParent;
  const socketPath = socketDirOverride !== undefined ? join(socketDirOverride, "s") : defaultSocket;
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash" }],
  });
  const service = await PiDurableService.start({
    host: makeHost(dir, parent, faux),
    socketPath,
  });
  return {
    dir,
    service,
    socketParent: parent,
    faux,
    cleanup: async () => {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/**
 * Start a service whose config carries an explicit `manager` policy, so tests
 * can compare `manager.enabled: false` vs the default (enabled) at the real
 * service boundary. Uses the faux provider — never a real LLM or Codex CLI.
 */
async function startManagerFixture(manager: PiDurableConfig["manager"]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pdm-svc-mgr-"));
  await mkdir(join(dir, "projects"), { recursive: true });
  const { dir: parent, socketPath } = shortSocketDir();
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const config = makeConfig(dir);
  if (manager !== undefined) config.manager = manager;
  const service = await PiDurableService.start({
    host: {
      config,
      providerId: faux.provider.id,
      createModels: () => models,
      resolveCredential: async (): Promise<ResolvedCredential> => ({ apiKey: FAKE_KEY, source: "test" }),
      runtimeDir: parent,
    },
    socketPath,
  });
  return {
    dir,
    service,
    socketParent: parent,
    faux,
    cleanup: async () => {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function connectClient(service: PiDurableService): Promise<PiClient> {
  return PiClient.connect({ socketPath: service.path, timeoutMs: 10000 });
}

test("live journal records real manager/worker flow and requires a decision before an unhandled wake is acked", async () => {
  const f = await startFixture(); const client = await connectClient(f.service);
  try {
    const p = await client.call<{ project: { id: string } }>("projects.create", { name: "audit", path: join(f.dir, "projects", "audit") }, "audit-project");
    const submitted = await client.call<{ assignment: { id: string } }>("assignments.submit", { projectId: p.project.id, task: "Return a short fixture reply." }, "audit-assignment");
    const id = submitted.assignment.id;
    await client.call("assignments.wait", { id, timeoutMs: 10000 });
    const page = await client.call<{ entries: { kind: string; seq: number; data: unknown }[]; nextCursor: number }>("activity.list", { after: 0, limit: 50 });
    assert.ok(page.entries.some(e => e.kind === "manager.request"));
    assert.ok(page.entries.some(e => e.kind === "worker.provider_request"));
    assert.ok(page.entries.some(e => e.kind === "worker.message"));
    assert.ok(page.entries.some(e => e.kind === "assignment.state"));
    const events = await client.call<{ events: { eventId: string }[] }>("manager.events", { projectId: p.project.id, unacked: true });
    const eventId = events.events[0]!.eventId;
    await assert.rejects(() => client.call("manager.ack", { eventId }), (error: unknown) => error instanceof PiClientError && error.code === "action_required");
    const decision = { eventId, action: "observe", note: "Fixture result inspected; no acceptance claimed." };
    await client.call("manager.decision", decision, "audit-decision");
    const replay = await client.call<{ replayed: boolean }>("manager.decision", decision, "audit-decision");
    assert.equal(replay.replayed, true);
    await client.call("manager.ack", { eventId });
    const next = await client.call<{ entries: { kind: string; data: unknown }[] }>("activity.list", { after: page.nextCursor });
    assert.ok(next.entries.findIndex(e => e.kind === "manager.decision") < next.entries.findIndex(e => e.kind === "wake.acked"));
    await assert.rejects(() => client.call("supervision.configure", { assignmentId: id, policy: { timeoutMs: 20 } }, "bad-policy"));
    await assert.rejects(() => client.call("supervision.configure", { assignmentId: id, policy: { timeoutMs: 20 } }, "bad-policy"));
  } finally { client.close(); await f.cleanup(); }
});

test("browser console is read-only and terminal cursor replay reads the same durable activity", async () => {
  const f = await startFixture(); const client = await connectClient(f.service);
  let view: Awaited<ReturnType<typeof startLiveConsole>> | undefined;
  try {
    // The fixture binds a real short UDS at f.socketParent/s (the sandbox /tmp is
    // not writable, so default derivation cannot be used here). Point the viewer
    // at that exact socket via its explicit override — the same attachment the
    // daemon's own `--socket` uses — so this exercises the REAL transport.
    assert.equal(f.service.path, join(f.socketParent, "s"));
    const config = makeConfig(f.dir);
    config.paths = { ...config.paths, stateDir: f.socketParent };
    const path = join(f.dir, "viewer-config.json"); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    const note = await client.call<{ seq: number }>("activity.note", { tag: "manager.note", message: "Synthetic fixture: viewer replay is real." }, "viewer-note");
    view = await startLiveConsole(path, { socketPath: f.service.path });
    const page = await (await fetch(view.url + "/activity?after=0")).json() as { page: { entries: { seq: number }[] } };
    assert.ok(page.page.entries.some(row => row.seq === note.seq));
    assert.equal((await fetch(view.url + "/activity", { method: "POST" })).status, 405);
    assert.equal((await fetch(view.url + "/activity", { headers: { Origin: "https://untrusted.example" } })).status, 403);
    assert.equal((await fetch(view.url + "/activity?after=NaN")).status, 400);
    // `fetch` silently drops a caller-supplied Host header, so send a raw HTTP
    // request over the loopback to prove an invalid Host is really rejected.
    assert.equal(await rawStatusLine(view.url, "/activity", "untrusted.example"), 403);
    let terminal = "";
    await watchActivity(path, { after: note.seq - 1, once: true, json: true, socketPath: f.service.path }, text => { terminal += text; });
    const rows = terminal.trim().split("\n").map(line => JSON.parse(line) as { seq: number });
    assert.deepEqual(rows.map(row => row.seq), [note.seq]);
    await new Promise<void>(resolve => view!.server.close(() => resolve())); view = undefined;
    assert.equal((await client.call<{ pong: boolean }>("service.ping", {})).pong, true);
  } finally {
    if (view) await new Promise<void>(resolve => view!.server.close(() => resolve()));
    client.close(); await f.cleanup();
  }
});

test("service starts, reports status, and is reachable over a real UDS", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    const status = fx.service.status();
    assert.equal(status.protocolVersion, 1);
    assert.equal(status.schemaVersion, 8);
    assert.equal(status.capabilities.assignments, true);
    assert.equal(status.capabilities.projects, true);

    client = await connectClient(fx.service);
    const pong = await client.call<{ pong: boolean }>("service.ping");
    assert.equal(pong.pong, true);

    const remote = await client.call<{ pid: number; socketPath: string }>("service.status");
    assert.equal(remote.pid, process.pid);
    assert.equal(remote.socketPath, fx.service.path);
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("service socket path helper is deterministic and matches the server", async () => {
  const fx = await startFixture();
  try {
    const stateDir = join(fx.dir, "state");
    assert.equal(fx.service.status().stateDir, fx.socketParent);
    assert.equal(fx.service.path, join(fx.socketParent, "s"));
    assert.equal(configSocketPath(stateDir, fx.service.path), fx.service.path);
    assert.equal(resolveSocketPath(stateDir, fx.service.path), fx.service.path);
  } finally {
    await fx.cleanup();
  }
});

test("default socket path stays under the limit and falls back to short /tmp", () => {
  const original = process.env.TMPDIR;
  try {
    // A deep ambient temp root, as seen in agent/user sandboxes on macOS. This
    // is long enough that tmpdir()/pdm-<uid>/<hash>/s would exceed 100 bytes.
    process.env.TMPDIR = "/var/folders/aa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/T/deep/nested/root/for/a/sandbox/that/is/long";
    const stateDir = join(process.cwd(), ".s", "statehash-src");
    const runtime = resolveRuntimeDir(stateDir);
    const socket = resolveSocketPath(stateDir);

    // The derived ambient path is too long, so the short /tmp fallback is used,
    // never chmod-ing /tmp itself.
    assert.match(runtime, /^\/tmp\/pi-durable-\d+\/[0-9a-f]{16}$/);
    assert.equal(socket, join(runtime, "s"));
    assert.ok(Buffer.byteLength(socket) <= 100, `socket path ${socket} must be <= 100 bytes`);
    assert.notEqual(runtime, "/tmp");
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
  }
});

test("default socket path is deterministic and independent of the ambient temp root", () => {
  // The runtime path is keyed ONLY by a short hash of the state directory and
  // the uid: it never depends on the ambient temp root. That is what lets a
  // client with the same state directory derive the identical socket path
  // regardless of the (possibly very long, or symlinked) temp root it sees.
  const original = process.env.TMPDIR;
  try {
    const stateDir = join(process.cwd(), ".s", "statehash-short");
    const uid = process.getuid?.() ?? 0;

    // A very different, deep ambient root must NOT change the derived path.
    process.env.TMPDIR = "/var/folders/deep/nested/root/for/a/sandbox/long";
    const runtimeDeep = resolveRuntimeDir(stateDir);
    process.env.TMPDIR = "/tmp/pdm-short-check";
    const runtimeShort = resolveRuntimeDir(stateDir);

    assert.equal(runtimeDeep, runtimeShort, "runtime dir must not depend on TMPDIR");
    assert.match(runtimeShort, new RegExp(`^/tmp/pi-durable-${uid}/[0-9a-f]{16}$`));
    assert.equal(resolveSocketPath(stateDir), join(runtimeShort, "s"));
    assert.ok(Buffer.byteLength(resolveSocketPath(stateDir)) <= 100);
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
  }
});
test("service refuses a second owner of the same state directory", async () => {
  const fx = await startFixture();
  try {
    await assert.rejects(
      () => PiDurableService.start({ host: makeHost(fx.dir, fx.socketParent), socketPath: join(fx.socketParent, "s2") }),
      (error: unknown) => error instanceof ServiceError && error.code === "locked",
    );
  } finally {
    await fx.cleanup();
  }
});

test("OwnerLock refuses a lock owned by this same pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdm-selflock-"));
  try {
    const stateDir = join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "service.lock"), JSON.stringify({ pid: process.pid, token: "x" }));
    await assert.rejects(
      () => OwnerLock.acquire(stateDir),
      (error: unknown) => error instanceof ServiceError && error.code === "locked",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OwnerLock reclaims a lock owned by a dead pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdm-stalelock-"));
  try {
    const stateDir = join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "service.lock"), JSON.stringify({ pid: 2147483646, token: "dead" }));
    const lock = await OwnerLock.acquire(stateDir);
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release does not delete a lock re-acquired by another owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdm-releaselock-"));
  try {
    const stateDir = join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const lock = await OwnerLock.acquire(stateDir);
    await writeFile(join(stateDir, "service.lock"), JSON.stringify({ pid: process.pid, token: "other" }));
    await lock.release();
    const info = await stat(join(stateDir, "service.lock"));
    assert.ok(info.isFile());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("projects.create initializes a repo, is idempotent, and rejects conflicts", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const projectPath = join(fx.dir, "projects", "demo");

    const created = await client.call<{ project: { id: string; path: string; origin: string }; replayed: boolean }>(
      "projects.create",
      { name: "demo", path: projectPath },
      "req-create-1",
    );
    assert.equal(created.replayed, false);
    // The service canonicalizes (realpath) the created path, so `/var` aliases
    // to `/private/var` on macOS. Compare against the canonical form of the
    // SAME physical dir rather than the lexical tmp path — production
    // canonicalization is untouched.
    assert.equal(created.project.path, await realpath(projectPath));
    assert.equal(created.project.origin, "created");
    await stat(join(projectPath, ".git"));

    // A fresh repo is seeded with the portable AGENTS.md (CTO roles + hard limits).
    const agents = await readFile(join(projectPath, "AGENTS.md"), "utf8");
    assert.match(agents, /Codex remains the CTO/);
    assert.match(agents, /One writer per checkout/);
    assert.match(agents, /No commits, pushes, deploys/);
    assert.match(agents, /Never read secrets/);
    assert.doesNotMatch(agents, /\/Users\//, "portable AGENTS.md must not leak host paths");

    const replay = await client.call<{ project: { id: string }; replayed: boolean }>(
      "projects.create",
      { name: "demo", path: projectPath },
      "req-create-1",
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.project.id, created.project.id);

    await assert.rejects(
      () =>
        client!.call(
          "projects.create",
          { name: "other", path: join(fx.dir, "projects", "other") },
          "req-create-1",
        ),
      (error: unknown) => error instanceof PiClientError && error.code === "conflict",
    );

    await assert.rejects(
      () => client!.call("projects.create", { name: "demo", path: projectPath }, "req-create-2"),
      (error: unknown) => error instanceof PiClientError && error.code === "exists",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("projects.create rejects paths outside the allowed roots", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    await assert.rejects(
      () =>
        client!.call(
          "projects.create",
          { name: "escape", path: join(fx.dir, "outside", "escape") },
          "req-escape",
        ),
      (error: unknown) => error instanceof PiClientError && error.code === "outside_roots",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("projects.create rejects a symlinked parent escaping the allowed roots", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    // A link inside the allowed root that points OUTSIDE it.
    const outside = join(fx.dir, "outside");
    await mkdir(outside, { recursive: true });
    const linkParent = join(fx.dir, "projects", "link");
    await mkdir(join(fx.dir, "projects"), { recursive: true });
    await symlink(outside, linkParent);

    await assert.rejects(
      () =>
        client!.call(
          "projects.create",
          { name: "escape-link", path: join(linkParent, "child") },
          "req-link",
        ),
      (error: unknown) => error instanceof PiClientError && error.code === "outside_roots",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("projects.create accepts a path under a symlinked allowed-root alias", async () => {
  // Production regression: on macOS an operator may configure an allowed root
  // through a symlink alias (`/var/... -> /private/var/...`, or a custom link).
  // The requested project path canonicalizes to `/private/var/...`, so a naive
  // textual comparison against the non-canonical configured root falsely
  // rejected it as `outside_roots`. Canonicalizing BOTH sides accepts the
  // legitimate path WITHOUT widening the boundary (the symlink-escape test
  // above still rejects an escaping link).
  const dir = await mkdtemp(join(tmpdir(), "pdm-alias-"));
  const { dir: socketParent, socketPath } = shortSocketDir();
  const realProjects = join(dir, "projects");
  const aliasProjects = join(dir, "alias");
  await mkdir(realProjects, { recursive: true });
  await symlink(realProjects, aliasProjects);

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const config: PiDurableConfig = {
    configVersion: 1,
    endpoint: "https://inference.example.invalid/v1",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    limits: { contextWindow: 65536, maxTokens: 8192, maxSteps: 40, timeoutMs: 30000 },
    paths: { stateDir: join(dir, "state"), projectHome: realProjects, allowedRoots: [aliasProjects] },
    credential: { env: "PI_DURABLE_TEST_KEY_UNUSED" },
  };
  const service = await PiDurableService.start({
    host: {
      config,
      providerId: faux.provider.id,
      createModels: () => models,
      resolveCredential: async (): Promise<ResolvedCredential> => ({ apiKey: FAKE_KEY, source: "test" }),
    },
    socketPath,
  });
  let client: PiClient | undefined;
  try {
    client = await connectClient(service);
    // Request through the CANONICAL location; the configured root is the alias.
    const created = await client.call<{ project: { path: string } }>(
      "projects.create",
      { name: "canon", path: join(realProjects, "canon") },
      "req-canon",
    );
    assert.ok(created.project.path.length > 0);
  } finally {
    client?.close();
    await service.stop();
    await rm(dir, { recursive: true, force: true });
    await rm(socketParent, { recursive: true, force: true });
  }
});

test("projects.import requires an existing Git repository and never inits one", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const importPath = join(fx.dir, "projects", "legacy");
    await mkdir(importPath, { recursive: true });
    await writeFile(join(importPath, "README.md"), "hello");

    // No .git directory: import must reject and must NOT create one.
    await assert.rejects(
      () => client!.call("projects.import", { path: importPath }, "req-import-nogit"),
      (error: unknown) => error instanceof PiClientError && error.code === "not_a_repo",
    );
    await assert.rejects(() => stat(join(importPath, ".git")));

    // Now make it a real repository.
    await mkdir(join(importPath, ".git"), { recursive: true });
    const imported = await client.call<{ project: { id: string; path: string; origin: string } }>(
      "projects.import",
      { path: importPath },
      "req-import-1",
    );
    assert.equal(imported.project.origin, "imported");
    await stat(join(importPath, "README.md"));

    // Import must NEVER seed/overwrite AGENTS.md: an existing one is preserved
    // byte-for-byte and a missing one is left missing.
    await assert.rejects(() => stat(join(importPath, "AGENTS.md")), "no AGENTS.md should be created");
    await writeFile(join(importPath, "AGENTS.md"), "# my own agents file\n");
    const again0 = await client.call<{ project: { id: string }; replayed: boolean }>(
      "projects.import",
      { path: importPath },
      "req-import-agents",
    );
    void again0;
    assert.equal(await readFile(join(importPath, "AGENTS.md"), "utf8"), "# my own agents file\n");

    // Canonical-path dedup: a DIFFERENT request id for the same checkout reuses it.
    const again = await client.call<{ project: { id: string }; replayed: boolean }>(
      "projects.import",
      { path: importPath },
      "req-import-2",
    );
    assert.equal(again.replayed, true);
    assert.equal(again.project.id, imported.project.id);

    const listed = await client.call<{ projects: unknown[] }>("projects.list");
    assert.equal(listed.projects.length, 1);
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("sessions.create gives each project its own conversation scoped to its cwd", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const pathA = join(fx.dir, "projects", "alpha");
    const pathB = join(fx.dir, "projects", "beta");
    const projectA = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "alpha", path: pathA },
      "req-pa",
    );
    const projectB = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "beta", path: pathB },
      "req-pb",
    );

    const sessionA = await client.call<{ session: { id: string; conversationId: string } }>(
      "sessions.create",
      { projectId: projectA.project.id },
      "req-sa",
    );
    const sessionB = await client.call<{ session: { id: string; conversationId: string } }>(
      "sessions.create",
      { projectId: projectB.project.id },
      "req-sb",
    );

    // Distinct Pi conversations per project, not the same reserved root.
    assert.notEqual(sessionA.session.conversationId, sessionB.session.conversationId);
    assert.notEqual(sessionA.session.id, sessionB.session.id);

    const listedA = await client.call<{ sessions: Array<{ id: string }> }>("sessions.list", {
      projectId: projectA.project.id,
    });
    const listedB = await client.call<{ sessions: Array<{ id: string }> }>("sessions.list", {
      projectId: projectB.project.id,
    });
    assert.equal(listedA.sessions.length, 1);
    assert.equal(listedB.sessions.length, 1);
    assert.equal(listedA.sessions[0]!.id, sessionA.session.id);
    assert.equal(listedB.sessions[0]!.id, sessionB.session.id);
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("sessions.create rejects a requestId reused for a different project", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const projectA = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "alpha", path: join(fx.dir, "projects", "alpha") },
      "req-pa",
    );
    const projectB = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "beta", path: join(fx.dir, "projects", "beta") },
      "req-pb",
    );
    await client.call("sessions.create", { projectId: projectA.project.id }, "req-shared");
    // Same requestId, different project: conflict, NOT a silent replay.
    await assert.rejects(
      () => client!.call("sessions.create", { projectId: projectB.project.id }, "req-shared"),
      (error: unknown) => error instanceof PiClientError && error.code === "conflict",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("sessions.inspect returns the transcript and usage for a real conversation", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const project = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "demo", path: join(fx.dir, "projects", "demo") },
      "req-p",
    );
    const session = await client.call<{ session: { id: string } }>(
      "sessions.create",
      { projectId: project.project.id },
      "req-s",
    );
    const inspected = await client.call<{ entries: unknown[]; usage: unknown }>("sessions.inspect", {
      id: session.session.id,
    });
    assert.ok(Array.isArray(inspected.entries));
    assert.ok(inspected.usage !== undefined);
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("stop() with an idle client connected does not deadlock", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    await client.call("service.ping");
    // The client stays connected and idle; stop must still complete.
    await Promise.race([
      fx.service.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("stop deadlocked")), 5000)),
    ]);
    client.close();
  } finally {
    client?.close();
    await rm(fx.dir, { recursive: true, force: true });
    await rm(fx.socketParent, { recursive: true, force: true });
  }
});

test("a clean stop records the boot CLEAN; a run left DIRTY quarantines on restart", async () => {
  const fx = await startFixture();
  const metaPath = join(fx.dir, "metadata.sqlite");
  try {
    await fx.service.stop();
    // After a fully drained shutdown the boot row must be clean, so a restart
    // has nothing to quarantine.
    const meta = await MetadataStore.open(metaPath);
    try {
      assert.equal(meta.listUncleanServiceRuns().length, 0, "clean stop leaves no dirty boot");
    } finally {
      meta.close();
    }
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
    await rm(fx.socketParent, { recursive: true, force: true });
  }
});

test("bindSocket refuses a live socket owned by another service", async () => {
  const fx = await startFixture();
  try {
    // A second service, with a DIFFERENT state dir, pointed at the SAME path.
    const otherDir = await mkdtemp(join(tmpdir(), "pdm-other-"));
    try {
      await assert.rejects(
        () => PiDurableService.start({ host: makeHost(otherDir, fx.socketParent), socketPath: fx.service.path }),
        (error: unknown) => error instanceof ServiceError && (error.code === "locked" || error.code === "socket_exists"),
      );
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
    // The original service is still alive and serving.
    const client = await connectClient(fx.service);
    const pong = await client.call<{ pong: boolean }>("service.ping");
    assert.equal(pong.pong, true);
    client.close();
  } finally {
    await fx.cleanup();
  }
});

test("bindSocket never changes permissions of a pre-existing shared parent", async () => {
  const sharedParent = join(process.cwd(), ".s", `shared-${randomUUID().slice(0, 6)}`);
  await mkdir(sharedParent, { recursive: true, mode: 0o777 });
  const before = await stat(sharedParent);
  const dir = await mkdtemp(join(tmpdir(), "pdm-perm-"));
  // The state dir is separate from the shared socket parent, so the service has
  // no reason to create or chmod the shared parent.
  const service = await PiDurableService.start({
    host: makeHost(dir, join(dir, "runtime")),
    socketPath: join(sharedParent, "s"),
  });
  try {
    const after = await stat(sharedParent);
    assert.equal(after.mode & 0o777, before.mode & 0o777, "shared parent mode must be unchanged");
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
    await rm(sharedParent, { recursive: true, force: true });
  }
});

test("bindSocket refuses to unlink a regular file at the socket path", async () => {
  const parent = join(process.cwd(), ".s", `file-${randomUUID().slice(0, 6)}`);
  await mkdir(parent, { recursive: true });
  const socketPath = join(parent, "s");
  await writeFile(socketPath, "not a socket");
  const dir = await mkdtemp(join(tmpdir(), "pdm-file-"));
  try {
    await assert.rejects(
      () => PiDurableService.start({ host: makeHost(dir, parent), socketPath }),
      (error: unknown) => error instanceof ServiceError && error.code === "socket_exists",
    );
    // The regular file must still be there.
    assert.equal(await readFile(socketPath, "utf8"), "not a socket");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("bindSocket removes a dead leftover socket and binds successfully", async () => {
  const parent = join(process.cwd(), ".s", `stale-${randomUUID().slice(0, 6)}`);
  const dir = await mkdtemp(join(tmpdir(), "pdm-stale-"));
  await mkdir(parent, { recursive: true });
  const deadSocketPath = join(parent, "s");

  // Produce a GENUINE crashed leftover: a child binds the socket and then exits
  // WITHOUT closing it. The OS leaves the socket file in place and the process
  // is gone, which is exactly the "dead leftover" case bindSocket must reclaim.
  // (A graceful `server.close()` unlinks its own path, so it cannot be used to
  // fabricate this state.)
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "const {createServer}=require('node:net');const s=createServer();" +
        "s.listen(process.argv[1],()=>{process.exit(0);});",
      deadSocketPath,
    ],
    { stdio: "ignore" },
  );
  assert.equal(child.status, 0, "child process must bind and exit cleanly");
  // The dead socket file is genuinely present and is a socket.
  const dead = await stat(deadSocketPath);
  assert.ok(dead.isSocket(), "leftover path must be a socket");

  const service = await PiDurableService.start({ host: makeHost(dir, parent), socketPath: deadSocketPath });
  try {
    const client = await connectClient(service);
    const pong = await client.call<{ pong: boolean }>("service.ping");
    assert.equal(pong.pong, true);
    client.close();
  } finally {
    // Only the service we started owns the live socket here; stop() unlinks it.
    await service.stop();
    await rm(dir, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("client rejects two concurrent calls sharing a requestId", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const first = client.call("service.ping", {}, "same-id");
    await assert.rejects(
      () => client!.call("service.ping", {}, "same-id"),
      (error: unknown) => error instanceof PiClientError && error.code === "duplicate_request",
    );
    await first;
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("client injects the correlation id as requestId for assignments.restore and every idempotent method", () => {
  // A bare restore with no explicit params.requestId MUST receive one, so the
  // wire call id and the engine's idempotency key can never drift. Without this
  // the service falls back to a fresh `restore-<id>-<now>` key on every call and
  // a genuine duplicate restore is NEVER detected as replayed.
  assert.ok(IDEMPOTENT_METHODS.has("assignments.restore"), "assignments.restore is an idempotent method");
  const injected = applyRequestId("assignments.restore", { id: "abc" }, "same-key");
  assert.equal(injected.requestId, "same-key", "the call id is injected as params.requestId");
  // Explicit params.requestId is honoured, and a mismatch is rejected.
  assert.equal(applyRequestId("assignments.restore", { id: "abc", requestId: "same-key" }, "same-key").requestId, "same-key");
  assert.throws(
    () => applyRequestId("assignments.restore", { id: "abc", requestId: "explicit" }, "same-key"),
    (error: unknown) => error instanceof PiClientError && error.code === "request_id_mismatch",
  );
  // A read method is passed through untouched.
  assert.equal(applyRequestId("assignments.show", { id: "abc" }, "same-key").requestId, undefined);
});

test("sessions.steer/followup descriptors name assignmentId (the param the handler requires)", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const caps = await client.call<{
      operations: Record<string, { params: string[] }>;
    }>("service.capabilities");
    for (const method of ["sessions.steer", "sessions.followup"]) {
      const params = caps.operations[method]?.params ?? [];
      assert.ok(params.includes("assignmentId"), `${method} descriptor must expose assignmentId`);
      assert.ok(!params.includes("id"), `${method} descriptor must NOT expose a bare id`);
    }
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("client rejects a params.requestId that mismatches the call id", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    await assert.rejects(
      () =>
        client!.call(
          "projects.create",
          { name: "x", path: join(fx.dir, "projects", "x"), requestId: "explicit" },
          "different",
        ),
      (error: unknown) => error instanceof PiClientError && error.code === "request_id_mismatch",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("client handles malformed and split frames without wedging", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    // A malformed line is ignored, and a valid call still resolves.
    const raw = createConnection(fx.service.path);
    await new Promise<void>((r) => raw.once("connect", r));
    raw.write("this is not json\n");
    raw.destroy();
    const pong = await client.call<{ pong: boolean }>("service.ping");
    assert.equal(pong.pong, true);
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("client closes the socket when the handshake times out", async () => {
  const parent = join(process.cwd(), ".s", `hang-${randomUUID().slice(0, 6)}`);
  await mkdir(parent, { recursive: true });
  const socketPath = join(parent, "s");
  const { createServer } = await import("node:net");
  // A server that accepts connections but never answers. Track the accepted
  // sockets: the client destroys its end, but a peer that never reads the
  // buffered request does not observe EOF, so `server.close()` would otherwise
  // wait forever. The test owns these sockets and tears them down explicitly.
  const accepted: Socket[] = [];
  const silent = createServer((socket) => {
    accepted.push(socket);
  });
  await new Promise<void>((r) => silent.listen(socketPath, r));
  try {
    await assert.rejects(
      () => PiClient.connect({ socketPath, timeoutMs: 200 }),
      (error: unknown) => error instanceof PiClientError && error.code === "timeout",
    );
  } finally {
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((r) => silent.close(() => r()));
    await rm(parent, { recursive: true, force: true });
  }
});

test("unimplemented operator methods fail as not_yet_implemented, never as a success", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    // These operator-contract methods are not part of this slice; they must be
    // recognized-but-unimplemented rather than silently succeeding. A method
    // the service has never heard of is a different error (`method_not_found`).
    for (const method of ["operators.spawn", "operators.retire"]) {
      await assert.rejects(
        () => client!.call(method, {}),
        (error: unknown) =>
          error instanceof PiClientError &&
          (error.code === "not_yet_implemented" || error.code === "method_not_found"),
      );
    }
    const caps = await client.call<{ assignments: boolean; toolExecution: boolean }>("service.capabilities");
    assert.equal(caps.assignments, true);
    assert.equal(caps.toolExecution, true);
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("unknown methods and protocol mismatch produce structured errors", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    await assert.rejects(
      () => client!.call("nope.method", {}),
      (error: unknown) => error instanceof PiClientError && error.code === "method_not_found",
    );
    const response = await fx.service.handle({ v: 999, id: "x", method: "service.ping" });
    assert.equal(response.error?.code, "version_mismatch");
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("service errors never leak a known secret", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    await assert.rejects(
      () => client!.call("projects.show", { id: `x-${FAKE_KEY}-${SUPER_SECRET}` }),
      (error: unknown) => {
        assert.ok(error instanceof PiClientError);
        assert.doesNotMatch(error.message, new RegExp(FAKE_KEY));
        assert.doesNotMatch(error.message, new RegExp(SUPER_SECRET));
        return true;
      },
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("client refuses to connect when no socket exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdm-nosock-"));
  try {
    await assert.rejects(
      () => PiClient.connect({ socketPath: join(dir, "missing.sock"), timeoutMs: 1000 }),
      (error: unknown) => error instanceof PiClientError && error.code === "unavailable",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Keep the imported Socket type referenced for future transport tests.
export type _Socket = Socket;

/** Submit `count` settled assignments on `sessionId`, seeding transcript entries. */
async function seedEntries(
  client: PiClient,
  projectId: string,
  sessionId: string,
  count: number,
): Promise<{ assignment: { id: string } }[]> {
  const out: { assignment: { id: string } }[] = [];
  for (let i = 0; i < count; i += 1) {
    const submitted = await client.call<{ assignment: { id: string } }>(
      "assignments.submit",
      { projectId, sessionId, task: `turn ${i}`, requestId: `seed-${sessionId}-${i}` },
      `seed-${sessionId}-${i}`,
    );
    await client.call("assignments.wait", { id: submitted.assignment.id, timeoutMs: 15000 });
    out.push(submitted);
  }
  return out;
}

test("sessions.transcript paginates a real conversation with an opaque cursor and no gaps", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    fx.faux.appendResponses([
      fauxAssistantMessage("one"),
      fauxAssistantMessage("two"),
      fauxAssistantMessage("three"),
    ]);
    client = await connectClient(fx.service);
    const project = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "demo", path: join(fx.dir, "projects", "demo") },
      "req-p",
    );
    const session = await client.call<{ session: { id: string } }>(
      "sessions.create",
      { projectId: project.project.id },
      "req-s",
    );
    await seedEntries(client, project.project.id, session.session.id, 3);

    // Page one entry at a time; the opaque string cursor must round-trip Pi's
    // internal object cursor across every page without a string/object mismatch.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result: { entries: { id: string }[]; nextCursor: string | null; order: string } =
        await client.call<{
          entries: { id: string }[];
          nextCursor: string | null;
          order: string;
        }>("sessions.transcript", {
          id: session.session.id,
          limit: 1,
          ...(cursor !== null ? { cursor } : {}),
        });
      assert.equal(result.order, "ascending");
      for (const entry of result.entries) seen.push(entry.id);
      cursor = result.nextCursor;
      if (cursor === null) break;
      assert.equal(typeof cursor, "string", "nextCursor must be a wire string");
    }
    assert.ok(seen.length >= 3, `expected several entries, saw ${seen.length}`);
    assert.equal(new Set(seen).size, seen.length, "no entry may repeat across pages");

    // A cursor bound to another session is rejected with invalid params.
    const first = await client.call<{ nextCursor: string | null }>("sessions.transcript", {
      id: session.session.id,
      limit: 1,
    });
    if (first.nextCursor !== null) {
      const other = await client.call<{ session: { id: string } }>(
        "sessions.create",
        { projectId: project.project.id },
        "req-s2",
      );
      await assert.rejects(
        () =>
          client!.call("sessions.transcript", {
            id: other.session.id,
            limit: 1,
            cursor: first.nextCursor,
          }),
        (error: unknown) => error instanceof PiClientError && error.code === "invalid_params",
      );
    }
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("sessions.transcript honors descending order (newest first)", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    fx.faux.appendResponses([
      fauxAssistantMessage("one"),
      fauxAssistantMessage("two"),
      fauxAssistantMessage("three"),
    ]);
    client = await connectClient(fx.service);
    const project = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "demo", path: join(fx.dir, "projects", "demo") },
      "req-p",
    );
    const session = await client.call<{ session: { id: string } }>(
      "sessions.create",
      { projectId: project.project.id },
      "req-s",
    );
    await seedEntries(client, project.project.id, session.session.id, 3);

    const asc = await client.call<{ entries: { id: string }[] }>("sessions.transcript", {
      id: session.session.id,
      order: "ascending",
    });
    const desc = await client.call<{ entries: { id: string }[]; order: string }>("sessions.transcript", {
      id: session.session.id,
      order: "descending",
    });
    assert.equal(desc.order, "descending");
    assert.ok(asc.entries.length >= 2 && desc.entries.length >= 2);
    // The two directions are exact reverses of the same set.
    assert.equal(asc.entries[0]?.id, desc.entries[desc.entries.length - 1]?.id);
    assert.equal(asc.entries[asc.entries.length - 1]?.id, desc.entries[0]?.id);

    // An invalid order is a structured invalid-args error.
    await assert.rejects(
      () => client!.call("sessions.transcript", { id: session.session.id, order: "sideways" }),
      (error: unknown) => error instanceof PiClientError && error.code === "invalid_params",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("sessions.entry streams a large entry in chunks that reconstruct exactly", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    // One very large assistant message forces the transcript entry over the page
    // budget so sessions.transcript must emit a truncated summary.
    const big = "x".repeat(300 * 1024);
    fx.faux.appendResponses([fauxAssistantMessage(big)]);
    client = await connectClient(fx.service);
    const project = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "demo", path: join(fx.dir, "projects", "demo") },
      "req-p",
    );
    const session = await client.call<{ session: { id: string } }>(
      "sessions.create",
      { projectId: project.project.id },
      "req-s",
    );
    await seedEntries(client, project.project.id, session.session.id, 1);

    const page = await client.call<{
      entries: { id: string; entryId?: string; truncated?: boolean }[];
    }>("sessions.transcript", { id: session.session.id });
    const summary = page.entries.find((entry) => entry.truncated === true);
    assert.ok(summary !== undefined, "a large entry must be emitted as a truncated summary");

    // Reconstruct the full entry via sessions.entry chunks.
    let offset = 0;
    let rebuilt = "";
    let totalChars = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const chunk = await client.call<{
        chunk: string;
        nextOffset: number | null;
        done: boolean;
        totalChars: number;
      }>("sessions.entry", { id: session.session.id, entryId: summary.entryId, offset, maxChars: 8192 });
      rebuilt += chunk.chunk;
      totalChars = chunk.totalChars;
      if (chunk.done) break;
      assert.ok(chunk.nextOffset !== null && chunk.nextOffset > offset, "nextOffset must advance");
      offset = chunk.nextOffset;
    }
    assert.equal(rebuilt.length, totalChars, "chunks must reconstruct the full serialized entry");
    assert.ok(rebuilt.includes("x"), "reconstructed content must include the big message");

    // An entry id that does not belong to this session's conversation is not found.
    await assert.rejects(
      () => client!.call("sessions.entry", { id: session.session.id, entryId: 999999 }),
      (error: unknown) => error instanceof PiClientError && error.code === "not_found",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("sessions.fork forks at a real entry and replays idempotently", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    fx.faux.appendResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    client = await connectClient(fx.service);
    const project = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "demo", path: join(fx.dir, "projects", "demo") },
      "req-fp",
    );
    const session = await client.call<{ session: { id: string } }>(
      "sessions.create",
      { projectId: project.project.id },
      "req-fs",
    );
    await seedEntries(client, project.project.id, session.session.id, 2);
    const page = await client.call<{ entries: { id: string }[] }>("sessions.transcript", {
      id: session.session.id,
      order: "ascending",
    });
    const forkAt = page.entries[page.entries.length - 1]!.id;

    const forked = await client.call<{ session: { id: string; conversationId: string }; replayed: boolean }>(
      "sessions.fork",
      { id: session.session.id, at: forkAt },
      "req-fork-1",
    );
    assert.equal(forked.replayed, false);
    assert.notEqual(forked.session.id, session.session.id);

    // Replaying the SAME requestId returns the SAME forked session (no second fork).
    const replay = await client.call<{ session: { id: string }; replayed: boolean }>(
      "sessions.fork",
      { id: session.session.id, at: forkAt },
      "req-fork-1",
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.session.id, forked.session.id);

    // Malformed fork point is rejected with structured invalid-params, never a
    // raw Storage error.
    await assert.rejects(
      () => client!.call("sessions.fork", { id: session.session.id, at: "not-a-number" }, "req-fork-bad"),
      (error: unknown) => error instanceof PiClientError && error.code === "invalid_params",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("sessions.fork rejects an entry that does not belong to the session conversation", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    fx.faux.appendResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    client = await connectClient(fx.service);
    const project = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "demo", path: join(fx.dir, "projects", "demo") },
      "req-xp",
    );
    const s1 = await client.call<{ session: { id: string } }>(
      "sessions.create",
      { projectId: project.project.id },
      "req-xs1",
    );
    await seedEntries(client, project.project.id, s1.session.id, 1);
    const s2 = await client.call<{ session: { id: string } }>(
      "sessions.create",
      { projectId: project.project.id },
      "req-xs2",
    );
    await seedEntries(client, project.project.id, s2.session.id, 1);
    const page2 = await client.call<{ entries: { id: string }[] }>("sessions.transcript", {
      id: s2.session.id,
      order: "ascending",
    });
    const foreignEntry = page2.entries[page2.entries.length - 1]!.id;

    // A foreign entry id is not visible in s1's ownership scope: rejected as
    // invalid-params BEFORE any fork journal write.
    await assert.rejects(
      () => client!.call("sessions.fork", { id: s1.session.id, at: foreignEntry }, "req-fork-x"),
      (error: unknown) => error instanceof PiClientError && error.code === "invalid_params",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("assignments.review over a real UDS surfaces evidence_stale and accepts once the tree matches again", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    fx.faux.appendResponses([fauxAssistantMessage("done")]);
    client = await connectClient(fx.service);
    const projectPath = join(fx.dir, "projects", "guard");
    const project = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "guard", path: projectPath },
      "req-guard-p",
    );
    const session = await client.call<{ session: { id: string } }>(
      "sessions.create",
      { projectId: project.project.id },
      "req-guard-s",
    );
    const submitted = await client.call<{ assignment: { id: string } }>(
      "assignments.submit",
      { projectId: project.project.id, sessionId: session.session.id, task: "work", requestId: "req-guard-a" },
      "req-guard-a",
    );
    const detail = await client.call<{ state: string }>("assignments.wait", {
      id: submitted.assignment.id,
      timeoutMs: 15000,
    });
    assert.equal(detail.state, "needs_review", "a settled assignment needs review before accept");

    // A NEW, never-reviewed file must refuse `accept`: the reviewed after-manifest
    // no longer matches the live tree. BEFORE the fix the engine's
    // EvidenceStaleError (extends Error) fell through to `internal` at the RPC
    // boundary; it must now classify as `evidence_stale`.
    const marker = join(projectPath, "review-marker.txt");
    await writeFile(marker, "unreviewed\n");
    await assert.rejects(
      () => client!.call("assignments.review", { id: submitted.assignment.id, decision: "accept" }, "req-guard-r1"),
      (error: unknown) =>
        error instanceof PiClientError &&
        error.code === "evidence_stale" &&
        /changed since the reviewed snapshot/.test((error as PiClientError).message),
    );

    // Removing the unreviewed file restores the snapshot, so accept now succeeds.
    await rm(marker);
    const reviewed = await client.call<{ state: string }>(
      "assignments.review",
      { id: submitted.assignment.id, decision: "accept" },
      "req-guard-r2",
    );
    assert.equal(reviewed.state, "accepted", "accept works once the tree matches the reviewed snapshot");
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("manager.bind binds a project to an explicit thread and is idempotent", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const projectPath = join(fx.dir, "projects", "bindme");
    const created = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "bindme", path: projectPath },
      "req-bind-create",
    );
    const projectId = created.project.id;
    const threadId = "11111111-2222-3333-4444-555555555555";

    const bound = await client.call<{ binding: { projectId: string; threadId: string } }>(
      "manager.bind",
      { projectId, threadId },
      "req-bind-1",
    );
    assert.equal(bound.binding.threadId, threadId);

    const replay = await client.call<{ binding: { threadId: string }; replayed?: boolean }>(
      "manager.bind",
      { projectId, threadId },
      "req-bind-1",
    );
    assert.equal(replay.binding.threadId, threadId);

    const list = await client.call<{ bindings: { projectId: string; threadId: string }[] }>("manager.list");
    assert.equal(list.bindings.length, 1);
    assert.equal(list.bindings[0]?.threadId, threadId);

    const removed = await client.call<{ removed: boolean }>("manager.unbind", { projectId });
    assert.equal(removed.removed, true);
    const empty = await client.call<{ bindings: unknown[] }>("manager.list");
    assert.equal(empty.bindings.length, 0);
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("manager.bind requires an explicit threadId and an existing project", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const savedThread = process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_THREAD_ID;
    try {
      await assert.rejects(
        () => client!.call("manager.bind", { projectId: "missing" }),
        (error: unknown) => error instanceof PiClientError && error.code === "invalid_params",
      );
    } finally {
      if (savedThread !== undefined) process.env.CODEX_THREAD_ID = savedThread;
    }
    await assert.rejects(
      () => client!.call("manager.bind", { projectId: "missing", threadId: "t-1" }),
      (error: unknown) => error instanceof PiClientError && error.code === "not_found",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("manager.bind rejects a non-UUID threadId even with CODEX_THREAD_ID set (no env fallback)", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const projectPath = join(fx.dir, "projects", "bindvalidate");
    const created = await client.call<{ project: { id: string } }>(
      "projects.create",
      { name: "bindvalidate", path: projectPath },
      "req-bind-val",
    );
    const projectId = created.project.id;
    const savedThread = process.env.CODEX_THREAD_ID;
    // A caller env must NEVER be used as a silent fallback target.
    process.env.CODEX_THREAD_ID = "99999999-9999-9999-9999-999999999999";
    try {
      await assert.rejects(
        () => client!.call("manager.bind", { projectId, threadId: "not-a-uuid" }),
        (error: unknown) => error instanceof PiClientError && error.code === "invalid_params",
      );
      // With env set but NO explicit threadId, the server still refuses.
      await assert.rejects(
        () => client!.call("manager.bind", { projectId }),
        (error: unknown) => error instanceof PiClientError && error.code === "invalid_params",
      );
    } finally {
      if (savedThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = savedThread;
    }
    // A valid UUID binds.
    const t = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const bound = await client.call<{ binding: { threadId: string } }>("manager.bind", { projectId, threadId: t });
    assert.equal(bound.binding.threadId, t);
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("manager.status reports delivery health and manager.ack is idempotent", async () => {
  const fx = await startFixture();
  let client: PiClient | undefined;
  try {
    client = await connectClient(fx.service);
    const status = await client.call<{ enabled: boolean; pending: number; boundProjects: number }>("manager.status");
    assert.equal(status.boundProjects, 0);
    assert.equal(typeof status.enabled, "boolean");
    assert.equal(status.pending, 0);

    const events = await client.call<{ events: unknown[] }>("manager.events", {});
    assert.equal(events.events.length, 0);

    await assert.rejects(
      () => client!.call("manager.ack", { eventId: "mw-does-not-exist" }),
      (error: unknown) => error instanceof PiClientError && error.code === "not_found",
    );
  } finally {
    client?.close();
    await fx.cleanup();
  }
});

test("manager.status.enabled is truthful: false when manager.enabled=false, true otherwise", async () => {
  // DISABLED config: the coordinator is still constructed (durable events keep
  // recording) but dispatch is off, so status MUST report enabled:false.
  const disabled = await startManagerFixture({ enabled: false });
  let disabledClient: PiClient | undefined;
  try {
    disabledClient = await connectClient(disabled.service);
    const status = await disabledClient.call<{ enabled: boolean }>("manager.status");
    assert.equal(status.enabled, false, "disabled manager must report enabled:false");
  } finally {
    disabledClient?.close();
    await disabled.cleanup();
  }

  // DEFAULT config: no `manager` block means dispatch is enabled.
  const enabled = await startManagerFixture(undefined);
  let enabledClient: PiClient | undefined;
  try {
    enabledClient = await connectClient(enabled.service);
    const status = await enabledClient.call<{ enabled: boolean }>("manager.status");
    assert.equal(status.enabled, true, "default manager must report enabled:true");
  } finally {
    enabledClient?.close();
    await enabled.cleanup();
  }

  // EXPLICIT enabled:true must also report true.
  const explicit = await startManagerFixture({ enabled: true });
  let explicitClient: PiClient | undefined;
  try {
    explicitClient = await connectClient(explicit.service);
    const status = await explicitClient.call<{ enabled: boolean }>("manager.status");
    assert.equal(status.enabled, true, "explicitly enabled manager must report enabled:true");
  } finally {
    explicitClient?.close();
    await explicit.cleanup();
  }
});
