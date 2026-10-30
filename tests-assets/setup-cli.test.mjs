// Tests for `pi-durable setup` (the guided onboarding entry point).
//
// Runs the real CLI in a child process with an ISOLATED HOME so nothing touches
// the developer's real config. No secrets: only env-var NAME references and
// throwaway temp files are used. No real service is required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "pi-durable.js");

// Run the CLI in a child process. cwd is a neutral temp dir. HOME is overridden
// per-call so config lands in a throwaway tree, never the developer's real one.
function run(args, opts = {}) {
  const { env, ...rest } = opts;
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
      ...rest,
      env: { ...process.env, ...(env ?? {}) },
    });
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
  return realpathSync(mkdtempSync(path.join(tmpdir(), "pi-setup-test-")));
}

test("setup --help prints usage and exits 0", () => {
  const res = run(["setup", "--help"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /pi-durable setup/);
  assert.match(res.stdout, /--credential-env/);
  assert.match(res.stdout, /never stored, echoed, or read/);
});

test("setup --help --json emits one JSON envelope", () => {
  const res = run(["setup", "--help", "--json"]);
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.ok, true);
  assert.match(parsed.result.help, /pi-durable setup/);
});

test("noninteractive setup writes a private 0600 config with a reference credential", () => {
  const home = makeTmp();
  const res = run(
    [
      "setup",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "test-model",
      "--credential-env",
      "MY_TEST_KEY",
      "--json",
    ],
    { env: { HOME: home } },
  );
  assert.equal(res.code, 0, res.stderr);
  const envelope = JSON.parse(res.stdout.trim());
  assert.equal(envelope.ok, true);
  assert.equal(envelope.result.version, "0.7.0-beta.2");
  assert.equal(envelope.result.configWritten, true);
  assert.equal(envelope.result.skillInstalled, false, "no installer => not claimed installed");

  const configPath = path.join(home, ".config", "pi-durable-manager", "config.json");
  assert.ok(existsSync(configPath), "config written under isolated HOME");
  const mode = statSync(configPath).mode & 0o777;
  assert.equal(mode, 0o600, `config mode ${mode.toString(8)} should be 0600`);

  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(cfg.endpoint, "https://example.invalid/v1");
  assert.equal(cfg.model, "test-model");
  assert.deepEqual(cfg.credential, { env: "MY_TEST_KEY" });
  // Unlimited budgets.
  assert.equal(cfg.limits.maxSteps, null);
  assert.equal(cfg.limits.timeoutMs, null);
  assert.equal(cfg.tools.commandTimeoutMs, null);
  // Network off by default.
  assert.equal(cfg.tools.allowNetwork, false);
  rmSync(home, { recursive: true, force: true });
});

test("setup JSON output never contains the credential value, only its name", () => {
  const home = makeTmp();
  const secret = "sk-super-secret-value-DO-NOT-LEAK";
  const res = run(
    [
      "setup",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--credential-env",
      "MY_TEST_KEY",
      "--json",
    ],
    { env: { HOME: home, MY_TEST_KEY: secret } },
  );
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!res.stdout.includes(secret), "secret value must never appear in output");
  assert.ok(!res.stderr.includes(secret), "secret value must never appear on stderr");
  const cfg = readFileSync(
    path.join(home, ".config", "pi-durable-manager", "config.json"),
    "utf8",
  );
  assert.ok(!cfg.includes(secret), "secret value must never be written to disk");
  assert.match(cfg, /"env": "MY_TEST_KEY"/);
  rmSync(home, { recursive: true, force: true });
});

test("setup rejects a pasted raw key flag (usage error, exit 2)", () => {
  const home = makeTmp();
  const res = run(
    [
      "setup",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--api-key",
      "sk-raw-key-should-be-rejected",
    ],
    { env: { HOME: home } },
  );
  assert.notEqual(res.code, 0);
  // Must not write anything.
  assert.ok(!existsSync(path.join(home, ".config", "pi-durable-manager", "config.json")));
  const all = res.stdout + res.stderr;
  assert.ok(!all.includes("sk-raw-key-should-be-rejected"), "raw key must not be echoed");
  rmSync(home, { recursive: true, force: true });
});

test("setup rejects a non-loopback HTTP endpoint (HTTPS required)", () => {
  const home = makeTmp();
  const res = run(
    [
      "setup",
      "--endpoint",
      "http://evil.example.com/v1",
      "--model",
      "m",
      "--credential-env",
      "K",
    ],
    { env: { HOME: home } },
  );
  assert.notEqual(res.code, 0, "non-HTTPS endpoint must fail");
  assert.match(res.stdout + res.stderr, /HTTPS/);
  assert.ok(!existsSync(path.join(home, ".config", "pi-durable-manager", "config.json")));
  rmSync(home, { recursive: true, force: true });
});

test("setup permits loopback HTTP (fixtures) but still enforces HTTPS for real hosts", () => {
  const home = makeTmp();
  const ok = run(
    [
      "setup",
      "--endpoint",
      "http://127.0.0.1:9/v1",
      "--model",
      "m",
      "--credential-env",
      "K",
      "--config",
      path.join(home, "loop.json"),
      "--json",
    ],
    { env: { HOME: home } },
  );
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(existsSync(path.join(home, "loop.json")));
  rmSync(home, { recursive: true, force: true });
});

test("setup rejects ambiguous/invalid credential references", () => {
  const home = makeTmp();
  // Both env and file -> conflict.
  const both = run(
    [
      "setup",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--credential-env",
      "A",
      "--credential-file",
      path.join(home, "k.pem"),
    ],
    { env: { HOME: home } },
  );
  assert.notEqual(both.code, 0);
  assert.ok(!existsSync(path.join(home, ".config", "pi-durable-manager", "config.json")));

  // Neither -> missing.
  const neither = run(
    ["setup", "--endpoint", "https://example.invalid/v1", "--model", "m"],
    { env: { HOME: home } },
  );
  assert.notEqual(neither.code, 0);
  rmSync(home, { recursive: true, force: true });
});

test("setup --dry-run writes nothing but reports checks", () => {
  const home = makeTmp();
  const res = run(
    [
      "setup",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--credential-env",
      "K",
      "--dry-run",
      "--json",
    ],
    { env: { HOME: home } },
  );
  assert.equal(res.code, 0, res.stderr);
  const envelope = JSON.parse(res.stdout.trim());
  assert.equal(envelope.result.dryRun, true);
  assert.equal(envelope.result.configWritten, false);
  assert.ok(!existsSync(path.join(home, ".config", "pi-durable-manager")), "nothing written on dry-run");
  rmSync(home, { recursive: true, force: true });
});

test("re-running setup is idempotent and non-destructive (--replace backs up, preserves on decline)", () => {
  const home = makeTmp();
  const base = [
    "setup",
    "--endpoint",
    "https://example.invalid/v1",
    "--model",
    "m",
    "--credential-env",
    "K",
  ];
  assert.equal(run(base, { env: { HOME: home } }).code, 0);
  // Second run with IDENTICAL args is idempotent: exits 0 and rewrites nothing.
  const configPath = path.join(home, ".config", "pi-durable-manager", "config.json");
  const before = readFileSync(configPath, "utf8");
  const second = run([...base, "--json"], { env: { HOME: home } });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout.trim()).result.configWritten, false, "no rewrite on identical rerun");
  assert.equal(readFileSync(configPath, "utf8"), before, "config bytes unchanged");
  assert.ok(existsSync(configPath), "original config preserved");
  // A DIFFERENT config without --replace must fail safely (no clobber).
  const differ = run([...base, "--model", "different"], { env: { HOME: home } });
  assert.notEqual(differ.code, 0, "must refuse to clobber a different existing config without --replace");
  assert.equal(readFileSync(configPath, "utf8"), before, "config still unchanged after refusal");
  // Third run WITH --replace succeeds and leaves a backup.
  const third = run([...base, "--replace"], { env: { HOME: home } });
  assert.equal(third.code, 0, third.stderr);
  assert.ok(existsSync(configPath), "config replaced in place");
  rmSync(home, { recursive: true, force: true });
});

test("setup refuses to write through a symlinked config path", () => {
  const home = makeTmp();
  const dir = path.join(home, "cfg");
  execFileSync("mkdir", ["-p", dir]);
  const realTarget = path.join(home, "real.json");
  const link = path.join(dir, "config.json");
  execFileSync("sh", ["-c", `printf '{}' > '${realTarget}' && ln -s '${realTarget}' '${link}'`]);
  const res = run(
    [
      "setup",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--credential-env",
      "K",
      "--config",
      link,
      "--replace",
    ],
    { env: { HOME: home } },
  );
  assert.notEqual(res.code, 0, "must refuse a symlinked config path");
  rmSync(home, { recursive: true, force: true });
});

test("setup --allow-network must be explicit; default is disabled", () => {
  const home = makeTmp();
  const off = run(
    [
      "setup",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--credential-env",
      "K",
      "--config",
      path.join(home, "a.json"),
      "--json",
    ],
    { env: { HOME: home } },
  );
  assert.equal(off.code, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout.trim()).result.networkEnabled, false);

  const on = run(
    [
      "setup",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--credential-env",
      "K",
      "--config",
      path.join(home, "b.json"),
      "--allow-network",
      "--json",
    ],
    { env: { HOME: home } },
  );
  assert.equal(on.code, 0, on.stderr);
  assert.equal(JSON.parse(on.stdout.trim()).result.networkEnabled, true);
  rmSync(home, { recursive: true, force: true });
});

test("setup --json output is exactly one JSON object on stdout", () => {
  const home = makeTmp();
  const res = run(
    [
      "setup",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--credential-env",
      "K",
      "--dry-run",
      "--json",
    ],
    { env: { HOME: home } },
  );
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, `expected a single JSON line, got ${lines.length}`);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
  rmSync(home, { recursive: true, force: true });
});

test("setup rejects an unexpected extra positional argument (usage exit 2)", () => {
  const home = makeTmp();
  const res = run(
    ["setup", "oops", "--endpoint", "https://example.invalid/v1", "--model", "m", "--credential-env", "K"],
    { env: { HOME: home } },
  );
  assert.equal(res.code, 2, `expected usage exit 2, got ${res.code}`);
  assert.match(res.stderr, /extra argument/i);
  rmSync(home, { recursive: true, force: true });
});

test("setup rejects an unknown flag (usage exit 2) and writes nothing", () => {
  const home = makeTmp();
  const res = run(
    ["setup", "--totally-bogus", "--endpoint", "https://example.invalid/v1", "--model", "m", "--credential-env", "K"],
    { env: { HOME: home } },
  );
  assert.equal(res.code, 2, `expected usage exit 2, got ${res.code}`);
  assert.match(res.stderr, /unknown flag/i);
  assert.ok(!existsSync(path.join(home, ".config", "pi-durable-manager", "config.json")));
  rmSync(home, { recursive: true, force: true });
});

test("setup rejects an invalid boolean value (usage exit 2), not a silent truthy", () => {
  const home = makeTmp();
  const res = run(
    [
      "setup",
      "--allow-network=maybe",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--credential-env",
      "K",
    ],
    { env: { HOME: home } },
  );
  assert.equal(res.code, 2, `expected usage exit 2, got ${res.code}`);
  assert.match(res.stderr, /boolean/i);
  rmSync(home, { recursive: true, force: true });
});

test("setup accepts comma-separated --allow-root values", () => {
  const home = makeTmp();
  const a = path.join(home, "a");
  const b = path.join(home, "b");
  const res = run(
    [
      "setup",
      "--endpoint",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--credential-env",
      "K",
      "--config",
      path.join(home, "c.json"),
      "--allow-root",
      `${a},${b}`,
      "--json",
    ],
    { env: { HOME: home } },
  );
  assert.equal(res.code, 0, res.stderr);
  const cfg = JSON.parse(readFileSync(path.join(home, "c.json"), "utf8"));
  assert.ok(cfg.paths.allowedRoots.includes(a), "first root recorded");
  assert.ok(cfg.paths.allowedRoots.includes(b), "second root recorded");
  rmSync(home, { recursive: true, force: true });
});

test("guided setup collects project dir, network consent and integration choice", () => {
  const home = makeTmp();
  const answers = [
    "https://example.invalid/v1", // endpoint
    "guided-model", // model
    "", // credential reference -> env var
    "GUIDED_KEY", // env var name
    path.join(home, "proj"), // project directory
    "y", // allow network
    "n", // integration: none
  ].join("\n");
  const res = run(["setup", "--json"], {
    env: { HOME: home, PI_DURABLE_SETUP_INTERACTIVE: "1" },
    input: `${answers}\n`,
  });
  assert.equal(res.code, 0, res.stderr);
  const result = JSON.parse(res.stdout.trim()).result;
  assert.equal(result.ok, true);
  assert.equal(result.configWritten, true);
  assert.equal(result.networkEnabled, true);
  assert.equal(result.projectHome, path.join(home, "proj"));
  assert.equal(result.skillInstalled, false, "chose none");
  rmSync(home, { recursive: true, force: true });
});
