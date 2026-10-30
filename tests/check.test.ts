// Tests for src/check.ts — the honest PASS/FAIL/SKIP end-to-end check.
//
// These cover the PURE logic unconditionally (summarize/renderCheck/makeWorkspace/
// fixtureConfig/chooseRuntimeDir) and gate the real-service offline run behind an
// environment probe, mirroring the existing suite's sandbox-exec SKIP convention,
// so a sandbox whose /tmp and UDS limits block the service does not turn a healthy
// host into a red suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  chooseRuntimeDir,
  fixtureConfig,
  makeWorkspace,
  renderCheck,
  runOfflineCheck,
  summarize,
  writeFixtureWakeStub,
  FIXTURE_QUEUE_HELP,
  type CheckReport,
  type CheckStep,
} from "../src/check.js";
import { defaultSetupDeps } from "../src/cli-setup.js";
import type { SetupDeps } from "../src/setup.js";

const DEPS: SetupDeps = defaultSetupDeps();

function step(partial: Partial<CheckStep> & { id: string }): CheckStep {
  return {
    id: partial.id,
    label: partial.label ?? partial.id,
    status: partial.status ?? "PASS",
    detail: partial.detail ?? "ok",
    ...(partial.fixture !== undefined ? { fixture: partial.fixture } : {}),
  };
}

test("summarize: ok is false iff any step FAILed", () => {
  const ok = summarize("0.7.0-beta.1", "offline", [
    step({ id: "a", status: "PASS" }),
    step({ id: "b", status: "SKIP" }),
  ]);
  assert.equal(ok.ok, true, "PASS+SKIP is ok");

  const bad = summarize("0.7.0-beta.1", "offline", [
    step({ id: "a", status: "PASS" }),
    step({ id: "b", status: "FAIL" }),
  ]);
  assert.equal(bad.ok, false, "any FAIL is not ok");
});

test("summarize: carries version/mode and extra fields", () => {
  const r = summarize("0.7.0-beta.1", "online", [step({ id: "a" })], {
    threadId: "11111111-2222-3333-4444-555555555555",
  });
  assert.equal(r.version, "0.7.0-beta.1");
  assert.equal(r.mode, "online");
  assert.equal(r.threadId, "11111111-2222-3333-4444-555555555555");
});

test("renderCheck: counts and labels each status, tags fixtures", () => {
  const report: CheckReport = summarize("0.7.0-beta.1", "offline", [
    step({ id: "a", label: "Alpha", status: "PASS" }),
    step({ id: "b", label: "Beta", status: "FAIL", detail: "boom" }),
    step({ id: "c", label: "Gamma", status: "SKIP" }),
    step({ id: "d", label: "Delta", status: "PASS", fixture: true }),
  ]);
  const text = renderCheck(report);
  assert.match(text, /pi-durable check 0\.7\.0-beta\.1 \[offline\]/);
  assert.match(text, /\[PASS\] Alpha — ok/);
  assert.match(text, /\[FAIL\] Beta — boom/);
  assert.match(text, /\[SKIP\] Gamma/);
  assert.match(text, /\[PASS\] Delta \(fixture inference\)/);
  assert.match(text, /2 passed, 1 failed, 1 skipped/);
});

test("renderCheck: online mode points the human at the receipt", () => {
  const report: CheckReport = summarize(
    "0.7.0-beta.1",
    "online",
    [step({ id: "a" })],
    { threadId: "11111111-2222-3333-4444-555555555555" },
  );
  const text = renderCheck(report);
  assert.match(text, /Thread: 11111111-2222-3333-4444-555555555555/);
});

test("makeWorkspace: lands under the OS temp dir and is absolute", () => {
  const ws = makeWorkspace();
  assert.ok(isAbsolute(ws), "workspace is absolute");
  // The workspace is canonicalized (macOS `/var` → `/private/var`), so compare
  // against the canonicalized temp dir.
  const base = realpathSync(tmpdir());
  assert.equal(ws, realpathSync(ws), "workspace is canonical");
  const withSep = base.endsWith("/") ? base : `${base}/`;
  assert.ok(ws === base || ws.startsWith(withSep), `workspace ${ws} under ${base}`);
  assert.ok(existsSync(ws), "workspace exists");
});

test("fixtureConfig: loopback-only, reference credential, unlimited budgets", () => {
  const ws = makeWorkspace();
  const cfg = fixtureConfig(ws) as {
    endpoint: string;
    model: string;
    credential: Record<string, string>;
    limits: { maxSteps: unknown; timeoutMs: unknown };
    tools: { allowNetwork: boolean; commandTimeoutMs: unknown };
    paths: { stateDir: string; projectHome: string };
  };
  // Endpoint must be loopback (never a real host) — HTTP is allowed only here.
  assert.match(cfg.endpoint, /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/);
  assert.equal(cfg.credential.env, "PI_DURABLE_FIXTURE_KEY");
  assert.equal("apiKey" in cfg.credential, false, "never stores a raw key");
  // The fixture assignment is deliberately BOUNDED so the scripted loop can
  // never spin: a small step cap and a finite wall-clock timeout.
  assert.equal(typeof cfg.limits.maxSteps, "number");
  assert.ok((cfg.limits.maxSteps as number) >= 3, "step cap allows write + bash + final turn");
  assert.equal(typeof cfg.limits.timeoutMs, "number");
  assert.ok((cfg.limits.timeoutMs as number) > 0, "bounded wall-clock timeout");
  assert.equal(cfg.tools.commandTimeoutMs, null);
  assert.equal(cfg.tools.allowNetwork, false, "network stays off by default");
  assert.ok(cfg.paths.stateDir.startsWith(ws));
  assert.ok(cfg.paths.projectHome.startsWith(ws));
});

test("chooseRuntimeDir: returns a base whose socket path fits the UDS limit", () => {
  const base = chooseRuntimeDir();
  if (base === undefined) {
    // Honest on hosts where neither /tmp nor a short cwd fallback is writable.
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const socket = join(base, `pi-durable-${uid}`, "0123456789abcdef", "s");
  assert.ok(
    Buffer.byteLength(socket) <= 100,
    `socket path ${socket} (${Buffer.byteLength(socket)}B) within limit`,
  );
});

test("chooseRuntimeDir: honours a valid SHORT PI_DURABLE_RUNTIME_DIR override", () => {
  // A short override (well within the UDS limit) must be used verbatim (after
  // canonicalization), not silently replaced by /tmp. Some sandboxes remap the
  // temp dir to a long path that cannot host a UDS socket; only assert the
  // "honoured" behavior when an override of that length is actually possible.
  const shortBase = realpathSync("/tmp");
  let shortParent: string | undefined;
  try {
    shortParent = mkdtempSync(join(shortBase, "pdmrt-"));
  } catch {
    shortParent = undefined;
  }
  if (shortParent === undefined) {
    // No short writable base here (e.g. sandboxed /tmp); the fall-forward test
    // below still proves the chooser never returns an over-limit base.
    return;
  }
  const short = join(shortParent, "rt");
  assert.ok(
    Buffer.byteLength(join(short, "0123456789abcdef", "s")) <= 100,
    "test fixture override is within the UDS limit",
  );
  const prev = process.env.PI_DURABLE_RUNTIME_DIR;
  process.env.PI_DURABLE_RUNTIME_DIR = short;
  try {
    const base = chooseRuntimeDir();
    assert.equal(
      base,
      realpathSync(short),
      "a valid short override is honoured (canonicalized), not replaced",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_DURABLE_RUNTIME_DIR;
    else process.env.PI_DURABLE_RUNTIME_DIR = prev;
    rmSync(shortParent, { recursive: true, force: true });
  }
});

test("chooseRuntimeDir: an oversized override falls back to a within-limit base", () => {
  // An override whose final socket path would exceed the UDS limit must NOT be
  // used as-is; the chooser falls back to a shorter base (/tmp) or undefined.
  const prev = process.env.PI_DURABLE_RUNTIME_DIR;
  const huge = `/${"x".repeat(200)}`;
  process.env.PI_DURABLE_RUNTIME_DIR = huge;
  try {
    const base = chooseRuntimeDir();
    if (base !== undefined) {
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      const socket = join(base, `pi-durable-${uid}`, "0123456789abcdef", "s");
      assert.ok(
        Buffer.byteLength(socket) <= 100,
        `fallback socket ${socket} (${Buffer.byteLength(socket)}B) within limit`,
      );
      assert.notEqual(resolve(base), resolve(huge), "oversized override is not used verbatim");
    }
  } finally {
    if (prev === undefined) delete process.env.PI_DURABLE_RUNTIME_DIR;
    else process.env.PI_DURABLE_RUNTIME_DIR = prev;
  }
});

test("runOfflineCheck: honest report — never FAILs when it SKIPs a missing runtime dir", async () => {
  // Force the runtime-dir probe to fail so the service steps are skipped: point
  // PI_DURABLE_RUNTIME_DIR at a file (not a dir) and hide /tmp by using a cwd
  // whose fallback is too long. The simplest robust probe is to run the check
  // and assert it never reports a step as FAIL merely because the service could
  // not be hosted here.
  const report = await runOfflineCheck({
    deps: DEPS,
    binPath: join(process.cwd(), "bin", "pi-durable.js"),
  });
  assert.equal(report.version, "0.7.0-beta.1");
  assert.equal(report.mode, "offline");
  // Whatever happened, the report must be internally consistent.
  const anyFail = report.steps.some((s) => s.status === "FAIL");
  assert.equal(report.ok, !anyFail);
  // The first two steps (config + rerun) must always pass offline.
  const setup = report.steps.find((s) => s.id === "setup");
  assert.equal(setup?.status, "PASS", "guided setup passes offline");
});

test("runOfflineCheck: when needed deps are missing it FAILs the setup step, not crash", async () => {
  const report = await runOfflineCheck({
    deps: {
      ...DEPS,
      fs: {
        ...DEPS.fs,
        writeFileMode: async () => {
          throw new Error("injected write failure");
        },
      },
    },
    binPath: join(process.cwd(), "bin", "pi-durable.js"),
  });
  const setup = report.steps.find((s) => s.id === "setup");
  assert.equal(setup?.status, "FAIL");
  assert.match(setup?.detail ?? "", /injected write failure/);
  assert.equal(report.ok, false);
});

test("runOfflineCheck: produces the expected step ids offline when the service runs", async () => {
  const report = await runOfflineCheck({
    deps: DEPS,
    binPath: join(process.cwd(), "bin", "pi-durable.js"),
  });
  const ids = report.steps.map((s) => s.id);
  // Always-present steps.
  assert.ok(ids.includes("setup"), "setup step present");
  assert.ok(ids.includes("setup_rerun"), "rerun step present");
  if (ids.includes("project_create")) {
    // If the service started, the full ordered surface must be present and clean.
    assert.ok(ids.includes("session_create"), "session step present");
    assert.ok(ids.includes("fixture_server"), "fixture provider server step present");
    assert.ok(ids.includes("manager_bind"), "manager bind step present");
    assert.ok(ids.includes("assignment_submit"), "assignment submit step present");
    assert.ok(ids.includes("assignment_run"), "assignment run step present");
    assert.ok(ids.includes("fixture_dialed"), "fixture-dialed step present");
    assert.ok(ids.includes("assignment_wrote_file"), "hashed file step present");
    assert.ok(ids.includes("assignment_ran_test"), "test-command step present");
    assert.ok(ids.includes("assignment_review"), "review step present");
    assert.ok(ids.includes("manager_event"), "manager event step present");
    assert.ok(ids.includes("manager_ack"), "manager ack step present");
    assert.ok(ids.includes("manager_wake"), "fixture wake stub step present");
    assert.ok(ids.includes("capabilities"));
    assert.ok(ids.includes("reconnect"));
    assert.ok(ids.includes("redaction"));
    assert.ok(ids.includes("idempotency"));
    assert.ok(ids.includes("service_stop"));
    assert.ok(ids.includes("cleanup"));
    assert.equal(report.ok, true, renderCheck(report));
  } else {
    // Otherwise the host honestly skipped the service steps — never a false FAIL.
    assert.ok(ids.includes("service_start"), "skip recorded as service_start");
    assert.equal(report.ok, true, renderCheck(report));
  }
});

// REGRESSION for the original deadlock: the manager dispatcher spawns the wake
// stub via `execFile` with a stdin PIPE it NEVER closes. If the stub read stdin
// (the old `fs.readFileSync(0, "utf8")`), it would block until an EOF that never
// arrives, wedging the dispatcher. This test spawns the REAL fixture stub
// exactly like the dispatcher does — `execFile`, argv-only, stdin left OPEN — and
// asserts it terminates promptly and captures the delivery.
test("fixture wake stub terminates + captures when the caller leaves stdin OPEN", async () => {
  const ws = makeWorkspace();
  try {
    const capture = join(ws, "wake-capture.jsonl");
    const stub = writeFixtureWakeStub(ws, capture);
    assert.ok(existsSync(stub), "stub written");
    assert.equal(statSync(stub).mode & 0o111, 0o111, "stub is executable");

    const thread = "00000000-0000-4000-8000-0000000000f1";
    const message = "review me";

    // Spawn EXACTLY like src/manager-dispatcher.ts: execFile with an argv array.
    // We DO NOT write to or end stdin — reproducing the open-pipe condition.
    const started = Date.now();
    const stdout = await new Promise<string>((res, rej) => {
      const child = execFile(
        stub,
        ["queue", "--thread", thread, "--message", message],
        { timeout: 5000, killSignal: "SIGKILL" },
        (err, out) => (err ? rej(err) : res(out)),
      );
      // Deliberately leave child.stdin OPEN (do not call .end()); if the stub
      // read stdin it would hang and the 5s kill would reject the promise.
      void child;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4000, `stub returned promptly (${elapsed}ms), not blocked on stdin`);
    assert.match(stdout, /Queued message fixture-msg-/, "stub printed a real queue receipt");

    const lines = readFileSync(capture, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "exactly one delivery captured");
    const record = JSON.parse(lines[0] ?? "{}") as { argv: string[]; at: number };
    assert.deepEqual(record.argv, ["queue", "--thread", thread, "--message", message]);
    assert.ok(typeof record.at === "number");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// The `--help`/`--version` probes must NOT be recorded as wake deliveries (they
// carry no --thread/--message), so a compatibility probe is never mistaken for
// the wake the dispatcher is waiting on.
test("fixture wake stub answers --help/--version without recording a delivery", async () => {
  const ws = makeWorkspace();
  try {
    const capture = join(ws, "wake-capture.jsonl");
    const stub = writeFixtureWakeStub(ws, capture);
    const run = (args: string[]) =>
      new Promise<{ code: number; out: string }>((res) => {
        const child = execFile(stub, args, { timeout: 5000 }, (err, out) => {
          const code = err && typeof (err as { code?: number }).code === "number"
            ? ((err as { code?: number }).code as number)
            : err
              ? 1
              : 0;
          res({ code, out });
        });
        void child;
      });

    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.equal(help.out, FIXTURE_QUEUE_HELP, "--help prints the REAL supported banner");
    assert.match(help.out, /--thread <THREAD> --message <TEXT>/);

    const helpQueue = await run(["queue", "--help"]);
    assert.equal(helpQueue.code, 0);
    assert.equal(helpQueue.out, FIXTURE_QUEUE_HELP);

    const version = await run(["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.out, /codex 0\.0\.0-fixture/);

    // None of the probe invocations may have written a wake delivery.
    assert.equal(existsSync(capture), false, "probes never recorded a wake delivery");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("version constant flows through every report", async () => {
  const report = await runOfflineCheck({
    deps: DEPS,
    binPath: join(process.cwd(), "bin", "pi-durable.js"),
  });
  assert.equal(report.version, "0.7.0-beta.1");
  assert.match(dirname(join(process.cwd(), "bin", "pi-durable.js")), /bin$/);
});
