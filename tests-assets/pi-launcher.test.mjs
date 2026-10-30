// Tests for skill/pi-durable/scripts/pi.mjs using a fake CLI executable.
// No secrets, no real service calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(HERE, "..", "skill", "pi-durable", "scripts", "pi.mjs");

// The launcher source, used to create an extension-less PATH alias that re-enters itself.
function launcherAsShim() {
  return readFileSync(LAUNCHER, "utf8");
}

function makeTmp() {
  return mkdtempSync(path.join(tmpdir(), "pi-launch-test-"));
}

// A fake CLI as a plain executable shell script that echoes argv and config.
function writeFakeShCli(dir, name = "pi-durable-fake") {
  const p = path.join(dir, name);
  writeFileSync(
    p,
    [
      "#!/bin/sh",
      'echo "argv:$@"',
      'echo "config:$PI_DURABLE_CONFIG"',
      'echo "stderr-line" 1>&2',
      "exit 7",
      "",
    ].join("\n"),
  );
  chmodSync(p, 0o755);
  return p;
}

// A fake CLI as a .mjs file to exercise the process.execPath branch.
function writeFakeJsCli(dir, name = "pi-durable-fake.mjs") {
  const p = path.join(dir, name);
  writeFileSync(
    p,
    [
      'console.log("js-argv:" + process.argv.slice(2).join(","));',
      'console.log("js-config:" + (process.env.PI_DURABLE_CONFIG || ""));',
      "process.exit(3);",
      "",
    ].join("\n"),
  );
  return p;
}

function runLauncher(args, env) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("forwards argv and config via PI_DURABLE_BIN (executable branch) and mirrors exit code", () => {
  const base = makeTmp();
  const cli = writeFakeShCli(base);
  const cfg = path.join(base, "config.json");
  writeFileSync(cfg, "{}");
  const res = runLauncher(["service", "doctor", "--flag"], {
    PI_DURABLE_BIN: cli,
    PI_DURABLE_CONFIG: cfg,
  });
  assert.equal(res.status, 7, "exit code propagated");
  assert.match(res.stdout, /argv:service doctor --flag/);
  assert.match(res.stdout, new RegExp(`config:${cfg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(res.stderr, /stderr-line/);
  rmSync(base, { recursive: true, force: true });
});

test("spawns .mjs CLI with process.execPath and forwards args without shell interpolation", () => {
  const base = makeTmp();
  const cli = writeFakeJsCli(base);
  const res = runLauncher(["projects", "create", "--name", "a b;c"], {
    PI_DURABLE_BIN: cli,
  });
  assert.equal(res.status, 3);
  // The special characters must survive as a single argv element, uninterpreted.
  assert.match(res.stdout, /js-argv:projects,create,--name,a b;c/);
  rmSync(base, { recursive: true, force: true });
});

test("resolves CLI from installed local-settings.json", () => {
  const base = makeTmp();
  const cli = writeFakeShCli(base);
  const skillDir = path.join(base, "pi-durable");
  execFileSync("mkdir", ["-p", path.join(skillDir, "scripts")]);
  // Simulate the installed skill layout by copying the launcher.
  execFileSync("cp", [LAUNCHER, path.join(skillDir, "scripts", "pi.mjs")]);
  writeFileSync(
    path.join(skillDir, "local-settings.json"),
    JSON.stringify({ bin: cli }),
  );
  const res = spawnSync(process.execPath, [path.join(skillDir, "scripts", "pi.mjs"), "status"], {
    encoding: "utf8",
    env: { ...process.env, PI_DURABLE_BIN: "" },
  });
  assert.match(res.stdout, /argv:status/);
  rmSync(base, { recursive: true, force: true });
});

test("PI_DURABLE_BIN overrides local-settings.json", () => {
  const base = makeTmp();
  const envCli = writeFakeShCli(base, "env-cli");
  const fileCli = writeFakeShCli(base, "file-cli");
  const skillDir = path.join(base, "pi-durable");
  execFileSync("mkdir", ["-p", path.join(skillDir, "scripts")]);
  execFileSync("cp", [LAUNCHER, path.join(skillDir, "scripts", "pi.mjs")]);
  writeFileSync(
    path.join(skillDir, "local-settings.json"),
    JSON.stringify({ bin: fileCli }),
  );
  // Env wins: the fake env CLI prints a distinguishing argv.
  writeFileSync(
    envCli,
    "#!/bin/sh\necho from-env\n",
  );
  chmodSync(envCli, 0o755);
  const res = spawnSync(process.execPath, [path.join(skillDir, "scripts", "pi.mjs")], {
    encoding: "utf8",
    env: { ...process.env, PI_DURABLE_BIN: envCli },
  });
  assert.match(res.stdout, /from-env/);
  rmSync(base, { recursive: true, force: true });
});

test("missing CLI yields nonzero exit (ENOENT -> 127)", () => {
  const res = runLauncher(["status"], { PI_DURABLE_BIN: "/nonexistent/definitely-not-here" });
  assert.equal(res.status, 127);
  assert.match(res.stderr, /failed to launch/);
});

test("refuses to recursively invoke itself", () => {
  const res = runLauncher(["status"], { PI_DURABLE_BIN: LAUNCHER });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /recursion/);
});

test("refuses to recursively invoke itself through a symlink alias", () => {
  const base = makeTmp();
  const alias = path.join(base, "pi-alias.mjs");
  symlinkSync(LAUNCHER, alias);
  const res = runLauncher(["status"], { PI_DURABLE_BIN: alias });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /recursion/);
  rmSync(base, { recursive: true, force: true });
});

test("bounds recursion through a PATH alias that shadows the launcher", () => {
  const base = makeTmp();
  // A launcher template invoked as `pi` fails the extension test, so it is spawned via
  // PATH resolution; the depth sentinel must still stop it re-forking itself forever.
  const selfAsJs = path.join(base, "pi-durable");
  writeFileSync(selfAsJs, launcherAsShim());
  chmodSync(selfAsJs, 0o755);
  // Keep the real PATH (so `node` resolves) while putting our alias dir first.
  const res = runLauncher([], {
    PI_DURABLE_BIN: "pi-durable",
    PATH: `${base}${path.delimiter}${process.env.PATH}`,
  });
  // It must terminate with a nonzero status and a clear recursion message. The lexical
  // self-guard cannot see a bare PATH name, so this must be the depth sentinel firing.
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /recursion limit/i);
  rmSync(base, { recursive: true, force: true });
});

test("launcher error messages do not dump the config contents", () => {
  const base = makeTmp();
  const cfg = path.join(base, "config.json");
  writeFileSync(cfg, JSON.stringify({ secretToken: "super-secret-value" }));
  const res = runLauncher(["status"], {
    PI_DURABLE_BIN: path.join(base, "missing-bin"),
    PI_DURABLE_CONFIG: cfg,
  });
  assert.equal(res.status, 127);
  assert.doesNotMatch(res.stdout, /super-secret-value/);
  assert.doesNotMatch(res.stderr, /super-secret-value/);
  rmSync(base, { recursive: true, force: true });
});

test("recursion guard trips at the bounded depth sentinel", () => {
  const res = runLauncher(["status"], {
    PI_DURABLE_BIN: LAUNCHER,
    PI_DURABLE_LAUNCH_DEPTH: "99",
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /recursion/);
});
