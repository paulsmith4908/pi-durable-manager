// Tests for the pi-durable CLI (bin/pi-durable.js).
//
// Pure-process tests only: help text, usage errors, JSON error envelopes, and
// --params-file parsing. No Unix socket is bound and no service is started, so
// these run in restricted sandboxes where nested UDS binds are unavailable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "pi-durable.js");

/** Run the CLI in a child process, capturing stdout/stderr and exit status. */
function run(args, opts = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    ...opts,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Make a scratch dir inside the OS temp root. */
function makeTmp() {
  return mkdtempSync(path.join(tmpdir(), "pdm-cli-"));
}

test("--help prints usage on stdout and exits 0", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /service start/);
  assert.match(r.stdout, /--params-file/);
});

test("no arguments prints help and exits 0", () => {
  const r = run([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage:/);
});

test("unknown command exits 2 and reports on stderr", () => {
  const r = run(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command/);
  assert.equal(r.stdout, "");
});

test("unknown command with --json emits a JSON error envelope on stdout", () => {
  const r = run(["frobnicate", "--json"]);
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "unknown_command");
  assert.equal(typeof parsed.error.message, "string");
});

test("unknown namespace exits 2", () => {
  const r = run(["widgets", "list", "--json"]);
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "unknown_namespace");
});

test("service with no action exits 2", () => {
  const r = run(["service", "--json"]);
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.error.code, "no_action");
});

test("config check without a path exits 2", () => {
  const r = run(["config", "check"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /requires a path/);
});

test("missing flag value exits 2", () => {
  const r = run(["service", "status", "--config"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /requires a value/);
});

test("call with no method exits 2 with JSON error", () => {
  const r = run(["call", "--json"]);
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "no_method");
});

test("unknown service action exits 2", () => {
  const r = run(["service", "restart", "--json"]);
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.error.code, "unknown_action");
});

test("--params-file with non-JSON content exits 2", () => {
  const dir = makeTmp();
  try {
    const file = path.join(dir, "bad.json");
    writeFileSync(file, "not json{");
    const r = run(["call", "service.ping", "--params-file", file, "--json"]);
    assert.equal(r.code, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.error.code, "params_parse");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--params-file with a JSON array is rejected as non-object", () => {
  const dir = makeTmp();
  try {
    const file = path.join(dir, "array.json");
    writeFileSync(file, "[1,2,3]");
    const r = run(["call", "service.ping", "--params-file", file, "--json"]);
    assert.equal(r.code, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.error.code, "params_shape");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing --params-file exits 2 with read error", () => {
  const r = run(["call", "service.ping", "--params-file", "/nonexistent/pdm.json", "--json"]);
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.error.code, "params_read");
});

test("service doctor --json reports node version without a config", () => {
  const r = run(["service", "doctor", "--config", "/nonexistent/config.json", "--json"]);
  // Doctor tolerates a missing config and still reports node/platform facts.
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.result.nodeOk, true);
  assert.equal(parsed.result.configPresent, false);
  assert.equal(parsed.result.platform, process.platform);
  // `ok` is strict health: a missing config means the command is not healthy.
  assert.equal(parsed.ok, false);
  assert.equal(r.code, 1);
});

// ---------------------------------------------------------------------------
// Regression: flags anywhere + command collection (defect: any flag cleared
// the command prefix, so `--config PATH service status` had an empty command).
// ---------------------------------------------------------------------------

test("flag before command still resolves the command (--config PATH service status)", () => {
  const dir = makeTmp();
  try {
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      configVersion: 1,
      endpoint: "https://inference.example.invalid/v1",
      model: "example-model-id",
      limits: { contextWindow: 65536, maxTokens: 8192, maxSteps: 40, timeoutMs: 1800000 },
      paths: { stateDir: path.join(dir, "state"), projectHome: path.join(dir, "projects"), allowedRoots: [path.join(dir, "projects")] },
      credential: { env: "PI_DURABLE_API_KEY" },
    }));
    const r = run(["--config", configPath, "service", "status", "--json"]);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.running, false);
    assert.equal(r.code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boolean flag before command still resolves the command (--json call service.status)", () => {
  const r = run(["--json", "call", "service.status", "--config", "/nonexistent/config.json"]);
  const parsed = JSON.parse(r.stdout);
  assert.notEqual(parsed.error?.code, "unknown_command");
});

test("-h prints usage on stdout and exits 0", () => {
  const r = run(["-h"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage:/);
});

test("a value-taking flag followed by another flag is a missing-value error", () => {
  const r = run(["service", "status", "--config", "--json"]);
  assert.equal(r.code, 2);
});

test("unknown flag on a call is rejected as a usage error (exit 2)", () => {
  const r = run(["call", "service.status", "--config", "/nonexistent/config.json", "--bogus-flag", "x"]);
  assert.equal(r.code, 2);
});

test("unknown flag on a call is reported in the JSON error envelope", () => {
  const r = run(["call", "service.status", "--bogus-flag", "x", "--json"]);
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "unknown_flag");
});

// ---------------------------------------------------------------------------
// Regression: task file -> params (defect: --task-file/--criteria-file and the
// common param flags were silently ignored by runRpc).
// ---------------------------------------------------------------------------

test("--task-file that does not exist is a usage error (exit 2)", () => {
  const r = run(["call", "assignments.create", "--task-file", "/nonexistent/task.txt", "--json"]);
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.error.code, "file_read");
});

test("--task-file content is consumed before any socket work", () => {
  const dir = makeTmp();
  try {
    const taskPath = path.join(dir, "task.txt");
    writeFileSync(taskPath, "do the thing");
    // No live service: the call fails at connect time, proving the file was
    // consumed (file_read/file_too_large would have exited 2 first).
    const r = run(["call", "assignments.create", "--task-file", taskPath, "--config", "/nonexistent/config.json", "--json"]);
    assert.notEqual(r.code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectParams maps --task-file content to the task param", async () => {
  const { collectParams } = await import("../dist/cli-rpc.js");
  const dir = makeTmp();
  try {
    const taskPath = path.join(dir, "task.txt");
    writeFileSync(taskPath, "hello task");
    const params = await collectParams(new Map([["task-file", taskPath]]), [], {});
    assert.equal(params.task, "hello task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectParams rejects unknown flags and maps common flags", async () => {
  const { collectParams } = await import("../dist/cli-rpc.js");
  const params = await collectParams(
    new Map([["project-id", "p1"], ["session-id", "s1"], ["limit", "5"]]),
    [],
    {},
  );
  assert.deepEqual(params, { projectId: "p1", sessionId: "s1", limit: 5 });
  await assert.rejects(
    () => collectParams(new Map([["bogus", "x"]]), [], {}),
    /Unknown flag/,
  );
});

test("assignments.wait forwards --timeout-ms and the client waits longer", async () => {
  const { resolveWaitTimeouts } = await import("../dist/cli.js");
  // Flag value is forwarded to the server AND used to size the client wait.
  const params = {};
  const r = resolveWaitTimeouts("assignments.wait", params, 30_000);
  assert.equal(params.timeoutMs, 30_000, "params.timeoutMs must be set from --timeout-ms");
  assert.equal(r.clientTimeoutMs, 35_000, "client waits requested + 5s");
  // Client is capped at 65s even for a large request (server caps at 60s).
  const big = {};
  assert.equal(resolveWaitTimeouts("assignments.wait", big, 120_000).clientTimeoutMs, 65_000);
  // A wait bound supplied via --params-file still sizes the client wait.
  const fromFile = { timeoutMs: 10_000 };
  assert.equal(resolveWaitTimeouts("assignments.wait", fromFile, undefined).clientTimeoutMs, 15_000);
  assert.equal(fromFile.timeoutMs, 10_000, "params-file value untouched");
  // No bound at all: client waits the full capped window.
  assert.equal(resolveWaitTimeouts("assignments.wait", {}, undefined).clientTimeoutMs, 65_000);
  // Other methods only get the raw client timeout, and params are untouched.
  const other = {};
  assert.equal(resolveWaitTimeouts("service.ping", other, 1_000).clientTimeoutMs, 1_000);
  assert.deepEqual(other, {});
});

// ---------------------------------------------------------------------------
// Regression: `serve` must forward --config/--socket to serveMain even though
// parseArgs consumed them (defect: rest was empty, child could not start).
// ---------------------------------------------------------------------------

test("buildServeArgs reconstructs --config/--socket for serveMain", async () => {
  const { buildServeArgs } = await import("../dist/cli.js");
  const flags = new Map([["config", "/tmp/x/config.json"], ["socket", "/tmp/x/s"]]);
  assert.deepEqual(buildServeArgs(flags), ["--config", "/tmp/x/config.json", "--socket", "/tmp/x/s"]);
  const onlyConfig = new Map([["config", "/tmp/y/config.json"]]);
  assert.deepEqual(buildServeArgs(onlyConfig), ["--config", "/tmp/y/config.json"]);
});

// ---------------------------------------------------------------------------
// Regression: parseArgs collects the command regardless of flag position.
// ---------------------------------------------------------------------------

test("parseArgs keeps the command across interleaved flags and positionals", async () => {
  const { parseArgs } = await import("../dist/cli-args.js");
  const p = parseArgs(["--config", "/c", "projects", "--json", "create", "extra"]);
  assert.deepEqual([...p.command], ["projects", "create"]);
  assert.deepEqual([...p.positionals], ["extra"]);
  assert.equal(p.flags.get("config"), "/c");
  assert.equal(p.booleans.has("json"), true);
});

test("parseArgs rejects a value flag whose value is another flag", async () => {
  const { parseArgs } = await import("../dist/cli-args.js");
  assert.throws(() => parseArgs(["--config", "--json"]), /requires a value/);
});

test("parseArgs maps -h to the help boolean", async () => {
  const { parseArgs } = await import("../dist/cli-args.js");
  const p = parseArgs(["-h"]);
  assert.equal(p.booleans.has("help"), true);
});

// ---------------------------------------------------------------------------
// Regression: daemon start cleans up its own child on readiness failure.
// ---------------------------------------------------------------------------

test("startDaemon terminates its child when readiness times out (no orphan)", async () => {
  const { startDaemon } = await import("../dist/cli-daemon.js");
  const dir = makeTmp();
  try {
    const binPath = path.join(dir, "fake.js");
    writeFileSync(binPath, "setTimeout(() => {}, 60000);\n");
    const result = await startDaemon({
      binPath,
      configPath: path.join(dir, "config.json"),
      socketPath: path.join(dir, "s"),
      stateDir: dir,
      readyTimeoutMs: 700,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "start_timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startDaemon reports a bounded failure (spawn_failed/start_timeout)", async () => {
  const { startDaemon } = await import("../dist/cli-daemon.js");
  const dir = makeTmp();
  try {
    const result = await startDaemon({
      binPath: path.join(dir, "nope.js"),
      configPath: path.join(dir, "config.json"),
      socketPath: path.join(dir, "s"),
      stateDir: dir,
      readyTimeoutMs: 300,
    });
    assert.equal(result.ok, false);
    assert.ok(["start_timeout", "spawn_failed"].includes(result.code));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --replace preserves unknown/forward-compat config fields through the real CLI", () => {
  const dir = makeTmp();
  try {
    const cfg = path.join(dir, "config.json");
    writeFileSync(
      cfg,
      JSON.stringify(
        {
          configVersion: 1,
          endpoint: "https://old.example/v1",
          model: "old-model",
          futureTop: { hello: "world" },
          limits: { contextWindow: 1, maxTokens: 2, maxSteps: null, timeoutMs: null, extraLimit: 7 },
        },
        null,
        2,
      ),
    );
    const r = run([
      "setup",
      "--config", cfg,
      "--endpoint", "https://new.example/v1",
      "--model", "new-model",
      "--credential-env", "MY_KEY",
      "--install-target", "none",
      "--replace",
      "--json",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const updated = JSON.parse(readFileSync(cfg, "utf8"));
    assert.equal(updated.endpoint, "https://new.example/v1", "endpoint updated");
    assert.equal(updated.model, "new-model", "model updated");
    assert.deepEqual(updated.futureTop, { hello: "world" }, "unknown top-level field preserved");
    assert.equal(updated.limits.extraLimit, 7, "unknown nested field preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
