// Tests for `pi-durable check` — the honest end-to-end health check.
//
// Offline mode spins up a REAL isolated service on a loopback socket and uses a
// deterministic LOCAL FIXTURE provider (never real inference). It creates its own
// temp workspace and cleans it up. Where the sandbox forbids a usable runtime
// directory the run is honestly SKIPPED rather than faked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "pi-durable.js");
const PROJECT_ROOT = path.join(HERE, "..");

function run(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", ...opts });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function makeTmp() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "pi-check-test-")));
}

// Create an owned, writable temporary directory even where `os.tmpdir()` is
// not writable (sandboxed hosts). Probes the same candidates the CLI uses.
function makeWritableTmp(prefix) {
  const cands = [
    tmpdir(),
    path.join(PROJECT_ROOT, ".pi-durable-runtime"),
    path.join(PROJECT_ROOT, ".s"),
  ];
  for (const c of cands) {
    if (!c) continue;
    try {
      const base = realpathSync(c);
      const d = mkdtempSync(path.join(base, prefix));
      return realpathSync(d);
    } catch {
      // try next candidate
    }
  }
  throw new Error("no writable temp directory available for the offline check test");
}

test("check --help exits 0 and documents both modes", () => {
  const res = run(["check", "--help"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /pi-durable check/);
  assert.match(res.stdout, /--offline/);
  assert.match(res.stdout, /--online/);
  assert.match(res.stdout, /--thread-id/);
  assert.match(res.stdout, /FIXTURE/i, "labels offline inference as a fixture");
});

test("check --online without --thread-id fails with exit code 2 (never invents a thread)", () => {
  const res = run(["check", "--online"]);
  assert.equal(res.code, 2, `expected 2, got ${res.code}`);
  assert.match(res.stdout + res.stderr, /thread-id|thread UUID/i);
});

test("check --online --json without --thread-id emits a truthful error envelope", () => {
  const res = run(["check", "--online", "--json"]);
  assert.equal(res.code, 2);
  const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.error, "has an error object");
});

test("check rejects conflicting --offline and --online", () => {
  const res = run(["check", "--offline", "--online", "--thread-id", "0".repeat(8)]);
  assert.notEqual(res.code, 0);
});

test("check rejects an invalid --thread-id UUID in online mode", () => {
  const res = run(["check", "--online", "--thread-id", "not-a-uuid"]);
  assert.notEqual(res.code, 0);
});

// Offline end-to-end: run only where a usable runtime dir exists. Mirrors the
// CLI's own candidate order (PI_DURABLE_RUNTIME_DIR, /tmp, <cwd>/.pi-durable-runtime)
// plus the short-socket fallback under <cwd>/.s.
function runtimeDirUsable() {
  const cands = [
    process.env.PI_DURABLE_RUNTIME_DIR,
    "/tmp",
    path.join(PROJECT_ROOT, ".pi-durable-runtime"),
    path.join(PROJECT_ROOT, ".s"),
  ];
  for (const c of cands) {
    if (!c) continue;
    try {
      const d = mkdtempSync(path.join(realpathSync(c), "pdm-probe-"));
      rmSync(d, { recursive: true, force: true });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

test("offline end-to-end run passes and cleans up after itself", { skip: !runtimeDirUsable() }, () => {
  // Run in a DEDICATED, owned cwd so this child's `<cwd>/.s/pdm<pidhex>-<key>`
  // fallback directory cannot collide with short-socket dirs created by other
  // test files running in parallel. The assertion only covers dirs this run
  // could have created (its own isolated `.s`).
  const isolatedCwd = makeWritableTmp("pdm-check-iso-");
  const sDir = path.join(isolatedCwd, ".s");
  const before = existsSync(sDir) ? readdirSync(sDir) : [];

  try {
    const res = run(["check", "--offline"], { cwd: isolatedCwd });
    assert.equal(res.code, 0, `offline check failed:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /PASS/);
    assert.match(res.stdout, /FIXTURE/i, "labels fixture inference");

    // No leftover short-socket dirs inside this run's own `.s`.
    const after = existsSync(sDir) ? readdirSync(sDir) : [];
    const leaked = after.filter((n) => !before.includes(n));
    assert.deepEqual(leaked, [], `leaked short-socket dirs: ${leaked.join(", ")}`);
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
});

test("offline --json emits a single truthful envelope with PASS/FAIL/SKIP steps", { skip: !runtimeDirUsable() }, () => {
  const res = run(["check", "--offline", "--json"], { cwd: PROJECT_ROOT });
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, "exactly one JSON line on stdout");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.mode, "offline");
  assert.equal(parsed.result.version, "0.7.0-beta.2");
  assert.ok(Array.isArray(parsed.result.steps));
  for (const step of parsed.result.steps) {
    assert.ok(["PASS", "FAIL", "SKIP"].includes(step.status), `bad status ${step.status}`);
  }
  // The offline run must have exercised a project + session and a REAL fixture
  // assignment dialed through the production transport.
  const ids = parsed.result.steps.map((s) => s.id);
  assert.ok(ids.includes("project_create"), "created a project");
  assert.ok(ids.includes("session_create"), "created a session");
  assert.ok(ids.includes("fixture_server"), "started the loopback fixture provider");
  assert.ok(ids.includes("assignment_run"), "ran the bounded fixture assignment");
  assert.ok(ids.includes("fixture_dialed"), "production transport dialed the fixture");
  assert.ok(ids.includes("assignment_wrote_file"), "worker created the hashed fixture file");
});

test("offline run does not touch a real user config directory", { skip: !runtimeDirUsable() }, () => {
  const home = makeTmp();
  const res = run(["check", "--offline"], { cwd: PROJECT_ROOT, env: { ...process.env, HOME: home } });
  assert.equal(res.code, 0, res.stderr);
  // A clean isolated HOME should not gain a pi-durable config from a check run.
  assert.ok(
    !existsSync(path.join(home, ".config", "pi-durable-manager", "config.json")),
    "check must not write the user's real config",
  );
  rmSync(home, { recursive: true, force: true });
});

test("offline run works from a working directory containing spaces", { skip: !runtimeDirUsable() }, () => {
  const base = makeTmp();
  const spaced = path.join(base, "my dir with spaces");
  try {
    execFileSync("mkdir", ["-p", spaced]);
    const res = run(["check", "--offline", "--json"], { cwd: spaced });
    assert.equal(res.code, 0, `offline check in spaced cwd failed:\n${res.stdout}\n${res.stderr}`);
    const parsed = JSON.parse(res.stdout.split("\n").filter((l) => l.trim())[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.mode, "offline");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
