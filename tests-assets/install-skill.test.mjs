// Tests for scripts/install-skill.mjs. Uses temporary destination directories only.
// No secrets, no real service calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.join(HERE, "..", "scripts", "install-skill.mjs");

// Import the installer module for dependency-injected failure tests.
const installer = await import(INSTALLER);

// Run the CLI installer in a child process. cwd defaults to a neutral temp dir so the
// test can prove relative --bin/--config values are normalized against the caller.
function run(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [INSTALLER, ...args], {
      encoding: "utf8",
      ...opts,
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
  // Canonicalize the base: on macOS `tmpdir()` is `/var/...` which resolves to
  // `/private/var/...`. The installer normalizes relative --bin/--config against
  // the child process cwd (the canonical real path), so compare against the same
  // canonical base. `/var` and `/private/var` are the same files, so every dest
  // path below still resolves identically.
  return realpathSync(mkdtempSync(path.join(tmpdir(), "pi-install-test-")));
}

// Install once so a subsequent install can exercise the replace path.
function installOwned(dest) {
  const res = run(["--destination", dest]);
  assert.equal(res.code, 0, res.stderr);
}

test("installs the skill into a fresh destination", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  const res = run(["--destination", dest]);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(existsSync(path.join(dest, "SKILL.md")), "SKILL.md copied");
  assert.ok(
    existsSync(path.join(dest, "scripts", "pi.mjs")),
    "launcher copied",
  );
  assert.ok(
    existsSync(path.join(dest, "references", "operations.md")),
    "references copied",
  );
  // No local-settings written when no bin/config supplied.
  assert.ok(!existsSync(path.join(dest, "local-settings.json")));
  rmSync(base, { recursive: true, force: true });
});

test("writes local-settings.json with 0600 mode inside the installed folder", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  const res = run([
    "--destination",
    dest,
    "--bin",
    "/opt/pi-durable",
    "--config",
    "/etc/pi-durable/config.json",
  ]);
  assert.equal(res.code, 0, res.stderr);
  const settings = path.join(dest, "local-settings.json");
  assert.ok(existsSync(settings), "settings written");
  const mode = statSync(settings).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  const parsed = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(parsed.bin, "/opt/pi-durable");
  assert.equal(parsed.configPath, "/etc/pi-durable/config.json");
  rmSync(base, { recursive: true, force: true });
});

test("dry-run writes nothing", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  const res = run(["--destination", dest, "--dry-run"]);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!existsSync(dest), "destination not created on dry-run");
  assert.match(res.stdout, /dry-run/);
  rmSync(base, { recursive: true, force: true });
});

test("refuses to overwrite a non-owned existing directory", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  // Pre-create a foreign directory.
  execFileSync("mkdir", ["-p", dest]);
  execFileSync("sh", ["-c", `printf 'not a skill' > '${dest}/random.txt'`]);
  const res = run(["--destination", dest, "--replace"]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /not the "pi-durable" skill/);
  rmSync(base, { recursive: true, force: true });
});

test("requires --replace to update an existing owned skill", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  assert.equal(run(["--destination", dest]).code, 0);
  const res = run(["--destination", dest]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /--replace/);
  // With --replace it succeeds.
  assert.equal(run(["--destination", dest, "--replace"]).code, 0);
  rmSync(base, { recursive: true, force: true });
});

test("rejects a symlinked destination", () => {
  const base = makeTmp();
  const real = path.join(base, "real");
  const dest = path.join(base, "link");
  execFileSync("mkdir", ["-p", real]);
  symlinkSync(real, dest);
  const res = run(["--destination", dest]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /symlink/);
  rmSync(base, { recursive: true, force: true });
});

test("rejects installing onto the source skill directory", () => {
  const source = path.join(HERE, "..", "skill", "pi-durable");
  const res = run(["--destination", source]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /source/);
});

test("unknown argument fails with usage error", () => {
  const res = run(["--nope"]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown argument/);
});

test("missing value for a flag fails with usage exit code 2", () => {
  const res = run(["--bin"]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /missing value for --bin/);

  const res2 = run(["--destination"]);
  assert.equal(res2.code, 2);
  assert.match(res2.stderr, /missing value for --destination/);

  const res3 = run(["--config"]);
  assert.equal(res3.code, 2);
  assert.match(res3.stderr, /missing value for --config/);
});

test("copies the skill metadata (agents/openai.yaml) into the install", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  const res = run(["--destination", dest]);
  assert.equal(res.code, 0, res.stderr);
  const meta = path.join(dest, "agents", "openai.yaml");
  assert.ok(existsSync(meta), "agents/openai.yaml copied");
  const body = readFileSync(meta, "utf8");
  assert.match(body, /interface:/);
  assert.match(body, /allow_implicit_invocation:\s*false/);
  rmSync(base, { recursive: true, force: true });
});

test("normalizes --bin and --config to absolute paths at install time", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  const res = run(
    [
      "--destination",
      dest,
      "--bin",
      "rel/bin/pi-durable",
      "--config",
      "rel/config.json",
    ],
    { cwd: base },
  );
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(readFileSync(path.join(dest, "local-settings.json"), "utf8"));
  assert.ok(path.isAbsolute(parsed.bin), `bin should be absolute: ${parsed.bin}`);
  assert.ok(path.isAbsolute(parsed.configPath), `config should be absolute: ${parsed.configPath}`);
  assert.equal(parsed.bin, path.join(base, "rel", "bin", "pi-durable"));
  assert.equal(parsed.configPath, path.join(base, "rel", "config.json"));
  rmSync(base, { recursive: true, force: true });
});

test("preserves existing local-settings values on --replace unless overridden", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  assert.equal(
    run([
      "--destination",
      dest,
      "--bin",
      "/orig/bin",
      "--config",
      "/orig/config.json",
    ]).code,
    0,
  );
  // Replace while overriding only --bin; config pointer must survive.
  const res = run(["--destination", dest, "--bin", "/new/bin", "--replace"]);
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(readFileSync(path.join(dest, "local-settings.json"), "utf8"));
  assert.equal(parsed.bin, "/new/bin");
  assert.equal(parsed.configPath, "/orig/config.json", "existing config pointer preserved");
  rmSync(base, { recursive: true, force: true });
});

test("--replace with no pointers keeps the existing local-settings pointers", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  assert.equal(
    run(["--destination", dest, "--bin", "/keep/bin", "--config", "/keep/config.json"]).code,
    0,
  );
  const res = run(["--destination", dest, "--replace"]);
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(readFileSync(path.join(dest, "local-settings.json"), "utf8"));
  assert.equal(parsed.bin, "/keep/bin");
  assert.equal(parsed.configPath, "/keep/config.json");
  rmSync(base, { recursive: true, force: true });
});

test("never copies local-settings.json into the distributable source skill", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  assert.equal(run(["--destination", dest, "--bin", "/opt/x"]).code, 0);
  const source = path.join(HERE, "..", "skill", "pi-durable");
  assert.ok(
    !existsSync(path.join(source, "local-settings.json")),
    "source skill must not contain local-settings.json",
  );
  rmSync(base, { recursive: true, force: true });
});

test("rejects a destination that resolves to the source via a symlinked ancestor", () => {
  const base = makeTmp();
  // symlink base/alias -> project root, then aim at the real source through the alias.
  const projectRoot = path.join(HERE, "..");
  const alias = path.join(base, "proj");
  symlinkSync(projectRoot, alias);
  const aliasedSource = path.join(alias, "skill", "pi-durable");
  const res = run(["--destination", aliasedSource]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /source/);
  rmSync(base, { recursive: true, force: true });
});

test("failed replacement restores the previous working skill", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  installOwned(dest);
  // Drop a marker into the installed copy to prove it is restored, not re-copied.
  const marker = path.join(dest, "OLD-MARKER.txt");
  execFileSync("sh", ["-c", `printf old > '${marker}'`]);
  const before = readFileSync(path.join(dest, "SKILL.md"), "utf8");

  // Inject an fs wrapper whose second rename (staging -> dest) fails once.
  let renames = 0;
  const fsOps = {
    ...installer.fsOperations,
    renameSync: (...args) => {
      renames += 1;
      // rename #1 moves the existing skill aside; rename #2 installs the staged copy.
      if (renames === 2) {
        const err = new Error("injected rename failure");
        err.code = "EIO";
        throw err;
      }
      return installer.fsOperations.renameSync(...args);
    },
  };

  assert.throws(
    () => installer.install({ destination: dest, replace: true, bin: null, config: null }, fsOps),
    /injected rename failure/,
  );

  // The old install must be back in place, with the marker intact.
  assert.ok(existsSync(path.join(dest, "SKILL.md")), "old skill restored");
  assert.equal(readFileSync(path.join(dest, "SKILL.md"), "utf8"), before);
  assert.ok(existsSync(marker), "old install restored byte-for-byte");
  rmSync(base, { recursive: true, force: true });
});

test("when restore also fails, the previous skill is preserved (never deleted)", () => {
  const base = makeTmp();
  const dest = path.join(base, "pi-durable");
  installOwned(dest);
  const marker = path.join(dest, "OLD-MARKER.txt");
  execFileSync("sh", ["-c", `printf old > '${marker}'`]);

  // Fail the staging->dest rename AND the backup->dest restore.
  let renames = 0;
  const fsOps = {
    ...installer.fsOperations,
    renameSync: (...args) => {
      renames += 1;
      const err = new Error("injected rename failure");
      err.code = "EIO";
      // first two renames: move old aside, then install staged copy. third = restore.
      if (renames >= 2) throw err;
      return installer.fsOperations.renameSync(...args);
    },
  };

  assert.throws(
    () => installer.install({ destination: dest, replace: true, bin: null, config: null }, fsOps),
    /preserved at/,
  );

  // The user's old skill must still exist somewhere (as the backup), never deleted.
  const leftovers = readdirSync(base).filter((n) => n.startsWith("pi-durable.bak-"));
  assert.equal(leftovers.length, 1, "exactly one backup preserved");
  const backupDir = path.join(base, leftovers[0]);
  assert.ok(existsSync(path.join(backupDir, "OLD-MARKER.txt")), "old contents preserved in backup");
  rmSync(base, { recursive: true, force: true });
});
