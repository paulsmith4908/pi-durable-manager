import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startFixtureServer } from "../dist/check-fixture.js";
import { PiClient } from "../dist/client.js";
import { runRuntimeGuard } from "../dist/runtime-guard.js";
import { startDaemon, stopDaemon } from "../dist/cli-daemon.js";
import { resolveSocketPath } from "../dist/service.js";

async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout; let value;
  while (Date.now() < end) { try { value = await fn(); if (value) return value; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw Error("Fixture did not reach the expected recovery state.");
}

test("independent guard recovers a killed daemon, quarantines an in-doubt command once, and respects explicit stop", { timeout: 45000 }, async () => {
  if (process.platform !== "darwin") return;
  const dir = await mkdtemp(join(tmpdir(), "pdm-guard-it-"));
  const stateDir = join(dir, "state"), projectHome = join(dir, "projects");
  await mkdir(projectHome); const configPath = join(dir, "config.json");
  const binPath = resolve("bin/pi-durable.js"); const socketPath = resolveSocketPath(stateDir);
  // Known synthetic credential; no production endpoint/key is read.
  const oldFixture = process.env.PDM_GUARD_FIXTURE_TOKEN;
  process.env.PDM_GUARD_FIXTURE_TOKEN = "synthetic-fixture-token";
  const endpoint = await startFixtureServer({ command: `node -e "require('fs').appendFileSync('effects.log','once\\n');setTimeout(()=>{},60000)"` });
  const config = { configVersion: 1, endpoint: endpoint.baseUrl, model: "guard-fixture-model",
    limits: { contextWindow: 65536, maxTokens: 1024, maxSteps: null, timeoutMs: null },
    paths: { stateDir, projectHome, allowedRoots: [projectHome] }, credential: { env: "PDM_GUARD_FIXTURE_TOKEN" },
    tools: { allowNetwork: false, commandTimeoutMs: null }, manager: { enabled: false } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  let client; let guard; let child; let id;
  try {
    const start = await startDaemon({ binPath, configPath, stateDir, socketPath }); assert.equal(start.ok, true);
    const firstPid = start.pid;
    child = spawn(process.execPath, [binPath, "guard", "--config", configPath, "--thread-id", "11111111-2222-4333-8444-555555555555", "--interval-ms", "1000"], { stdio: "ignore" });
    await until(async () => JSON.parse(await readFile(join(stateDir, "runtime-guard-status.json"), "utf8")).phase === "healthy");
    // Duplicate guard ownership must fail, without displacing the running guard.
    const controller = new AbortController();
    await assert.rejects(() => runRuntimeGuard({ configPath, binPath, threadId: "11111111-2222-4333-8444-555555555555", signal: controller.signal }), /guard owner/);
    client = await PiClient.connect({ socketPath });
    const project = await client.call("projects.create", { name: "guard-probe", path: join(projectHome, "probe") }, "guard-project");
    const assignment = await client.call("assignments.submit", { projectId: project.project.id, task: "Fixture crash probe", criteria: "Side effect must never repeat after an in-doubt command." }, "guard-assignment");
    id = assignment.assignment.id;
    await until(async () => (await readFile(join(projectHome, "probe", "effects.log"), "utf8")) === "once\n");
    client.close(); client = null;
    process.kill(firstPid, "SIGKILL"); // Deliberate crash of this fixture's known child only.
    const recovered = await until(async () => {
      const c = await PiClient.connect({ socketPath, timeoutMs: 500 });
      try { const status = await c.call("service.status", {}); return status.pid !== firstPid ? status : null; } finally { c.close(); }
    });
    assert.notEqual(recovered.pid, firstPid);
    client = await PiClient.connect({ socketPath });
    const row = await client.call("assignments.show", { id });
    assert.equal(row.state, "blocked"); assert.equal(row.stopReason, "in_doubt_command");
    assert.equal(await readFile(join(projectHome, "probe", "effects.log"), "utf8"), "once\n");
    assert.equal((await client.call("assignments.checkpoint", { id })).verified, true);
    await client.call("assignments.cancel", { id });
    assert.equal(await readFile(join(projectHome, "probe", "effects.log"), "utf8"), "once\n");
    client.close(); client = null;
    assert.equal((await stopDaemon(socketPath)).ok, true);
    await until(async () => JSON.parse(await readFile(join(stateDir, "runtime-guard-status.json"), "utf8")).phase === "paused");
    await new Promise(r => setTimeout(r, 1500));
    await assert.rejects(() => PiClient.connect({ socketPath, timeoutMs: 500 }));
  } finally {
    client?.close();
    if (child && child.exitCode === null) { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; }
    await stopDaemon(socketPath).catch(() => {});
    await endpoint.close();
    if (oldFixture === undefined) delete process.env.PDM_GUARD_FIXTURE_TOKEN; else process.env.PDM_GUARD_FIXTURE_TOKEN = oldFixture;
    await rm(dir, { recursive: true, force: true });
  }
});
