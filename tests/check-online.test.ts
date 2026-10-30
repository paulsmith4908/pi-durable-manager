// Tests for the ONLINE check path (src/check.ts: runOnlineCheck / verifyOnlineCheck).
//
// The online path is exercised against a REAL config whose endpoint is the
// deterministic loopback fixture server — so this is a genuine config → service →
// transport → wake cycle, just pointed at the fixture instead of Modal. That is
// exactly the contract the manager relies on: they run the same code against a
// real endpoint. These tests NEVER start a real LLM worker and NEVER read a key.
//
// The service steps are gated behind the same "can this sandbox host a UDS
// socket" probe used elsewhere: a host that cannot host the service records an
// honest SKIP (service_start FAILs only if the daemon was supposed to start and
// did not). A required ONLINE failure is a FAIL, never a silent SKIP.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOnlineCheck, verifyOnlineCheck, fixtureConfig, type CheckReport } from "../src/check.js";
import { startFixtureServer, type FixtureServer } from "../src/check-fixture.js";
import { defaultSetupDeps } from "../src/cli-setup.js";

const THREAD_ID = "11111111-2222-3333-4444-555555555555";

// The fixture config references its credential by NAME (`PI_DURABLE_FIXTURE_KEY`),
// never a raw key. The online service resolves that reference from ITS OWN env,
// so the harness sets a dummy value (never a real secret) for the daemon child.
process.env.PI_DURABLE_FIXTURE_KEY ??= "fixture-not-a-real-key";


function makeTmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  const base = realpathSync(tmpdir());
  const withSep = base.endsWith("/") ? base : `${base}/`;
  assert.ok(dir === base || dir.startsWith(withSep), `tmp ${dir} under ${base}`);
  return dir;
}

/** Write a REAL config (validated by loadConfig) pointing at the fixture endpoint. */
function writeConfig(dir: string, endpoint: string): string {
  const cfg = fixtureConfig(dir, { endpoint }) as Record<string, unknown>;
  // The online check reads via loadConfig, which insists on a real credential
  // reference. Keep it a reference (never a raw key).
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfgPath;
}

function hasServiceSteps(report: CheckReport): boolean {
  return report.steps.some((s) => s.id === "project_create");
}

test("runOnlineCheck: rejects a non-UUID thread id", async () => {
  await assert.rejects(
    runOnlineCheck({
      deps: defaultSetupDeps(),
      binPath: join(process.cwd(), "bin", "pi-durable.js"),
      configPath: join(process.cwd(), "does-not-exist.json"),
      threadId: "not-a-uuid",
    }),
    /thread UUID/,
  );
});

test("runOnlineCheck: rejects a missing config", async () => {
  await assert.rejects(
    runOnlineCheck({
      deps: defaultSetupDeps(),
      binPath: join(process.cwd(), "bin", "pi-durable.js"),
      configPath: join(process.cwd(), "definitely-missing-config.json"),
      threadId: THREAD_ID,
    }),
    /Config not found/,
  );
});

test("runOnlineCheck: drives a real config → service → fixture transport → wake", async () => {
  const dir = makeTmp("pdm-online-");
  let fixture: FixtureServer | undefined;
  let report: CheckReport | undefined;
  const binPath = join(process.cwd(), "bin", "pi-durable.js");
  try {
    fixture = await startFixtureServer();
    const cfgPath = writeConfig(dir, fixture.baseUrl);
    report = await runOnlineCheck({
      deps: defaultSetupDeps(),
      binPath,
      configPath: cfgPath,
      threadId: THREAD_ID,
    });

    assert.equal(report.version, "0.7.0-beta.3");
    assert.equal(report.mode, "online");
    assert.equal(report.threadId, THREAD_ID);

    const ids = report.steps.map((s) => s.id);
    assert.ok(ids.includes("service_start"), "service_start step present");

    if (hasServiceSteps(report)) {
      // The full online surface ran. Binding must precede submit; the run record
      // must exist with all ids; the state must be honest (never a fake PASS on
      // dispatch/ack); the event must be left UNACKED for the user.
      assert.ok(ids.includes("service_compat"), "compat check present");
      assert.ok(ids.includes("manager_bind"), "bind step present");
      assert.ok(ids.includes("assignment_submit"), "submit step present");
      assert.ok(ids.includes("manager_event"), "event step present");
      assert.ok(ids.includes("run_record"), "run record step present");
      assert.ok(ids.includes("resume"), "resume hint present");

      const bindIdx = ids.indexOf("manager_bind");
      const submitIdx = ids.indexOf("assignment_submit");
      assert.ok(bindIdx < submitIdx, "manager thread is bound BEFORE submit");

      // The fixture transport must have actually been dialed by the worker.
      assert.ok(fixture.requestCount() > 0, "production transport dialed the fixture");

      // The persisted run record must contain every id BEFORE the call returns.
      assert.ok(typeof report.runFile === "string" && existsSync(report.runFile!), "run file persisted");
      const run = JSON.parse(readFileSync(report.runFile!, "utf8")) as Record<string, unknown>;
      assert.equal(run.threadId, THREAD_ID);
      assert.ok(typeof run.runId === "string" && run.runId.length > 0);
      assert.ok(typeof run.projectId === "string");
      assert.ok(typeof run.sessionId === "string");
      assert.ok(typeof run.assignmentId === "string");
      assert.ok(typeof run.requestId === "string");
      assert.ok(typeof run.receiptId === "string" || run.receiptId === null);
      // Honest state: submitted/pending, never claimed "delivered"/"reviewed".
      assert.ok(
        typeof run.status === "string" && run.status !== "delivered" && run.status !== "reviewed",
        `honest status (${String(run.status)})`,
      );

      // The event must be UNACKED: no manager.ack was issued by the run.
      const eventState = report.steps.find((s) => s.id === "manager_event");
      assert.ok(eventState, "manager_event present");
      assert.match(eventState!.detail, /UNACKED|unacked|left unacked/i);

      // Honest verdict: a freshly-submitted run is NOT yet a success. The
      // manager event is left UNACKED (and usually still queued/pending), so
      // the run is legitimately PENDING — never a false FAIL, and never a false
      // PASS before review. No step may be a hard FAIL.
      const failed = report.steps.filter((s) => s.status === "FAIL");
      assert.deepEqual(
        failed.map((s) => `${s.id}:${s.detail}`),
        [],
        `no step may FAIL on a clean online run: ${report.steps.map((s) => `${s.id}=${s.status}`).join(" ")}`,
      );
      assert.equal(
        report.ok,
        report.steps.every((s) => s.status === "PASS"),
        `ok is true only when every step PASSes: ${report.steps.map((s) => `${s.id}=${s.status}`).join(" ")}`,
      );
    } else {
      // Honest skip if the sandbox cannot host a service; never a false FAIL.
      assert.equal(
        report.ok,
        true,
        `no service steps ⇒ honest skip; steps=${report.steps.map((s) => `${s.id}=${s.status}:${s.detail}`).join(" | ")}`,
      );
    }
  } finally {
    if (fixture !== undefined) await fixture.close();
  }
});

test("verifyOnlineCheck: re-opens a run record and reports state without acking", async () => {
  const dir = makeTmp("pdm-online-verify-");
  let fixture: FixtureServer | undefined;
  try {
    fixture = await startFixtureServer();
    const cfgPath = writeConfig(dir, fixture.baseUrl);
    const run = await runOnlineCheck({
      deps: defaultSetupDeps(),
      binPath: join(process.cwd(), "bin", "pi-durable.js"),
      configPath: cfgPath,
      threadId: THREAD_ID,
    });

    if (run.runFile === undefined || !existsSync(run.runFile)) {
      // Service could not be hosted here — nothing persisted. Honest skip.
      return;
    }
    const runId = JSON.parse(readFileSync(run.runFile, "utf8")).runId as string;
    const verified = await verifyOnlineCheck({
      runId,
      configPath: cfgPath,
      binPath: join(process.cwd(), "bin", "pi-durable.js"),
    });
    assert.equal(verified.mode, "online");
    const ids = verified.steps.map((s) => s.id);
    assert.ok(ids.includes("run_record"), "loads the run record");
    // The run was just submitted and the manager event is UNACKED, so the
    // verdict is PENDING (running/needsreview/unacked) — never a false PASS
    // before review, and never a false FAIL for a healthy in-flight run.
    assert.ok(ids.includes("verify_verdict"), "verify produces a verdict");
    const failed = verified.steps.filter((s) => s.status === "FAIL");
    assert.deepEqual(
      failed.map((s) => `${s.id}:${s.detail}`),
      [],
      `no step may FAIL on a healthy unacked run: ${verified.steps.map((s) => `${s.id}=${s.status}`).join(" ")}`,
    );
    assert.equal(
      verified.ok,
      verified.steps.every((s) => s.status === "PASS"),
      verified.steps.map((s) => `${s.id}=${s.status}`).join(" "),
    );
    // --verify must NEVER ack on our behalf.
    assert.ok(!ids.includes("manager_ack"), "verify never acks");
  } finally {
    if (fixture !== undefined) await fixture.close();
  }
});

test("verifyOnlineCheck: an unknown run id is a usage error", async () => {
  const dir = makeTmp("pdm-online-norun-");
  const cfgPath = writeConfig(dir, "http://127.0.0.1:9/v1");
  await assert.rejects(
    verifyOnlineCheck({
      runId: "does-not-exist",
      configPath: cfgPath,
      binPath: join(process.cwd(), "bin", "pi-durable.js"),
      runDir: join(dir, "empty-runs"),
    }),
    /No online run record/,
  );
});

test("runOnlineCheck: a slow fixture beyond the observation window still progresses after check returns", async () => {
  // The online check must NOT stop the daemon it started (it is a persistent,
  // same-GUI manager workflow). A slow provider whose FIRST response arrives
  // AFTER the bounded observation window proves the run returns with an honest
  // PENDING receipt while the daemon keeps working and eventually records the
  // wake event the GUI would receive.
  const dir = makeTmp("pdm-online-slow-");
  let fixture: FixtureServer | undefined;
  const binPath = join(process.cwd(), "bin", "pi-durable.js");
  try {
    // Every scripted turn is delayed well beyond the (tiny) observation window.
    fixture = await startFixtureServer({ delayMs: 1500 });
    const cfgPath = writeConfig(dir, fixture.baseUrl);
    const report = await runOnlineCheck({
      deps: defaultSetupDeps(),
      binPath,
      configPath: cfgPath,
      threadId: THREAD_ID,
      eventWaitMs: 50, // bounded observation: expire before the worker finishes
    });

    if (!hasServiceSteps(report)) {
      // Sandbox cannot host a service; honest skip (never a false FAIL).
      assert.equal(report.ok, true, report.steps.map((s) => `${s.id}=${s.status}`).join(" "));
      return;
    }

    // The run record exists and records an honest pending/delivered state.
    assert.ok(typeof report.runFile === "string" && existsSync(report.runFile!), "run file persisted");
    const run = JSON.parse(readFileSync(report.runFile!, "utf8")) as Record<string, unknown>;
    assert.ok(typeof run.assignmentId === "string" && run.assignmentId.length > 0, "assignment was submitted");
    assert.ok(
      run.deliveryState === null ||
        run.deliveryState === "pending" ||
        run.deliveryState === "delivered",
      `honest deliveryState (${String(run.deliveryState)})`,
    );

    // THE KEY ASSERTION: the daemon is still ALIVE after the check returns.
    // Query the running service directly — if the check had stopped it, this
    // reconnect would fail. A persistent manager workflow must keep it up.
    const { PiClient } = await import("../src/client.js");
    if (PiClient !== undefined) {
      const { resolveServiceSocket } = await import("../src/check.js");
      const { loadConfig } = await import("../src/config.js");
      const resolved = await loadConfig(cfgPath);
      const sock = resolveServiceSocket(resolved.paths.stateDir);
      const client = await PiClient.connect({ socketPath: sock.socketPath, timeoutMs: 8000 });
      try {
        const status = (await client.call("service.status", {}, "slow-status")) as { pid?: number };
        assert.equal(typeof status?.pid, "number", "daemon still running after check returned");

        // Now wait past the delay and confirm the daemon progresses the
        // assignment and records the wake event the GUI would receive.
        const deadline = Date.now() + 20000;
        let eventSeen = false;
        while (Date.now() < deadline && !eventSeen) {
          const events = (await client.call(
            "manager.events",
            { projectId: run.projectId },
            "slow-events",
          )) as { events?: { eventId?: string }[] };
          const list = Array.isArray(events?.events) ? events.events : [];
          if (list.some((e) => typeof e.eventId === "string")) eventSeen = true;
          if (!eventSeen) await new Promise((r) => setTimeout(r, 500));
        }
        assert.ok(eventSeen, "wake event eventually delivered after check returned");
      } finally {
        client.close();
      }
    }
  } finally {
    if (fixture !== undefined) await fixture.close();
  }
});

test("runOnlineCheck: a receipt that CANNOT be durably persisted is FATAL — nothing is submitted", async () => {
  // Block 1 regression. The initial run receipt is the only durable evidence a
  // run happened; if it cannot be written the check must FAIL (non-zero) and
  // submit NOTHING — no project, session, bind, or assignment mutation. The old
  // code swallowed the write error and reported run_record PASS, then proceeded
  // to mutate, defeating durable ids / crash recovery.
  const dir = makeTmp("pdm-online-persistfail-");
  let fixture: FixtureServer | undefined;
  const binPath = join(process.cwd(), "bin", "pi-durable.js");
  try {
    fixture = await startFixtureServer();
    const cfgPath = writeConfig(dir, fixture.baseUrl);
    const projectHome = join(dir, "projects");
    let writeAttempts = 0;
    const report = await runOnlineCheck({
      deps: defaultSetupDeps(),
      binPath,
      configPath: cfgPath,
      threadId: THREAD_ID,
      runFs: {
        mkdir: async () => {
          throw new Error("EACCES: injected mkdir denial (test)");
        },
        write: async () => {
          writeAttempts += 1;
          throw new Error("ENOSPC: injected write denial (test)");
        },
        rename: async () => {
          throw new Error("EACCES: injected rename denial (test)");
        },
      },
    });

    assert.equal(report.ok, false, "receipt-persist failure => report.ok === false");
    const record = report.steps.find((s) => s.id === "run_record");
    assert.ok(record, "run_record step present");
    assert.equal(record!.status, "FAIL", "run_record is FAIL");
    assert.match(record!.detail, /refusing to mutate anything/i);

    for (const id of ["project_create", "manager_bind", "session_create", "assignment_submit"]) {
      const step = report.steps.find((s) => s.id === id);
      assert.equal(step, undefined, "no " + id + " step after a fatal receipt failure");
    }

    if (hasServiceSteps(report)) {
      const runId = report.runFile ? report.runFile.split("/").pop()!.replace(/\.json$/, "") : "";
      const projectPath = join(projectHome, "online-check-" + runId);
      assert.equal(existsSync(projectPath), false, "no project directory created");
    }
    assert.ok(writeAttempts <= 1, "no repeated writes (" + writeAttempts + ")");
  } finally {
    if (fixture !== undefined) await fixture.close();
  }
});

test("runOnlineCheck: a receipt write failure AFTER a durable submit is reported truthfully, never re-submitted", async () => {
  const dir = makeTmp("pdm-online-latepersistfail-");
  let fixture: FixtureServer | undefined;
  const binPath = join(process.cwd(), "bin", "pi-durable.js");
  try {
    fixture = await startFixtureServer();
    const cfgPath = writeConfig(dir, fixture.baseUrl);
    const realFs = await import("node:fs/promises");
    let writes = 0;
    const report = await runOnlineCheck({
      deps: defaultSetupDeps(),
      binPath,
      configPath: cfgPath,
      threadId: THREAD_ID,
      runFs: {
        mkdir: async (d, m) => {
          await realFs.mkdir(d, { recursive: true, mode: m });
        },
        write: async (file, data, mode) => {
          writes += 1;
          if (writes > 1) throw new Error("EIO: injected late write denial (test)");
          await realFs.writeFile(file, data, { mode });
          await realFs.chmod(file, mode);
        },
        rename: async (from, to) => {
          await realFs.rename(from, to);
        },
      },
    });

    const runFileStep = report.steps.find((s) => s.id === "run_record");
    assert.ok(runFileStep, "run_record step present");
    if (writes <= 1) {
      assert.equal(runFileStep!.status === "PASS", report.ok === true, "consistent verdict");
      return;
    }
    assert.equal(report.ok, false, "post-submit persist failure => report.ok === false");
    assert.ok(typeof report.runFile === "string" && existsSync(report.runFile!), "initial receipt preserved");
  } finally {
    if (fixture !== undefined) await fixture.close();
  }
});
