// Unit tests for src/setup.ts — the guided setup core.
//
// Everything runs inside a temporary directory with injected deps: no real
// service, no network, no secrets. A "credential" here is only ever a NAME or a
// path; the tests assert that no raw key is ever persisted or accepted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BETA_VERSION,
  buildSetupConfig,
  configMatches,
  looksLikeRawKey,
  runPreflight,
  runSetup,
  validateCredentialReference,
  type SetupDeps,
  type SetupRequest,
} from "../src/setup.js";

/** Make a canonical temp dir under the OS temp root. */
function makeTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "pdm-setup-"));
}

/** A fully-capable fake dependency set rooted in a temp dir. */
function fakeDeps(home: string, overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    platform: "darwin",
    nodeVersion: "22.19.0",
    env: {},
    home,
    checkPath: () => false,
    probeCommand: async (cmd) => ({ found: cmd === "git" || cmd === "codex", version: "fake 1.0" }),
    sandboxExecAvailable: true,
    ...overrides,
  };
}

function baseRequest(home: string, overrides: Partial<SetupRequest> = {}): SetupRequest {
  return {
    configPath: path.join(home, ".config", "pi-durable-manager", "config.json"),
    endpoint: "https://example.invalid/v1",
    model: "fixture-model",
    credentialEnv: "DEEPSEEK_API_KEY",
    ...overrides,
  };
}

test("BETA_VERSION is the release version", () => {
  assert.equal(BETA_VERSION, "0.7.0-beta.3");
});

test("validateCredentialReference accepts an env NAME and rejects a raw key shape", () => {
  const ref = validateCredentialReference({ env: "MY_API_KEY", home: "/h" });
  assert.deepEqual(ref, { kind: "env", name: "MY_API_KEY" });

  // A pasted raw key is not a valid env name.
  assert.throws(
    () => validateCredentialReference({ env: "sk-abcdefghijklmnop", home: "/h" }),
    /valid env name/,
  );
});

test("validateCredentialReference rejects both env and file at once", () => {
  assert.throws(
    () => validateCredentialReference({ env: "A", file: "/tmp/k", home: "/h" }),
    /exactly one credential reference/,
  );
});

test("looksLikeRawKey flags sk-/ds- shapes only", () => {
  assert.equal(looksLikeRawKey("sk-abcdefghijklmnop"), true);
  assert.equal(looksLikeRawKey("DEEPSEEK_API_KEY"), false);
  assert.equal(looksLikeRawKey("/Users/x/.keys/deepseek"), false);
});

test("buildSetupConfig sets unlimited budgets and reports the credential REFERENCE only", () => {
  const home = makeTmp();
  try {
    const cfg = buildSetupConfig(baseRequest(home), fakeDeps(home));
    assert.equal(cfg.limits.maxSteps, null, "maxSteps unlimited");
    assert.equal(cfg.limits.timeoutMs, null, "timeoutMs unlimited");
    assert.equal(cfg.tools?.commandTimeoutMs, null, "command timeout unlimited");
    assert.equal(cfg.tools?.allowNetwork, false, "network disabled by default");
    assert.equal(cfg.manager?.enabled, true);
    assert.deepEqual(cfg.manager?.cliBaseArgs, ["queue"]);
    // The credential is stored as a reference (env NAME), never a value.
    assert.deepEqual(cfg.credential, { env: "DEEPSEEK_API_KEY" });
    const serialized = JSON.stringify(cfg);
    assert.ok(!serialized.includes("sk-"), "no raw key in config");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildSetupConfig records a credential FILE path without reading it", () => {
  const home = makeTmp();
  try {
    const keyPath = path.join(home, "keys", "deepseek.key");
    const cfg = buildSetupConfig(
      baseRequest(home, { credentialEnv: undefined, credentialFile: keyPath }),
      fakeDeps(home),
    );
    assert.deepEqual(cfg.credential, { apiKeyFile: keyPath });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preflight fails on non-macOS, old Node, and missing git; warns on missing codex", async () => {
  const home = makeTmp();
  try {
    const { checks } = await runPreflight(
      baseRequest(home),
      fakeDeps(home, {
        platform: "linux",
        nodeVersion: "20.0.0",
        probeCommand: async () => ({ found: false }),
      }),
    );
    const byId = new Map(checks.map((c) => [c.id, c]));
    assert.equal(byId.get("platform")?.level, "fail");
    assert.equal(byId.get("node")?.level, "fail");
    // Git is REQUIRED (projects create + worker diffs depend on it) → hard fail.
    assert.equal(byId.get("git")?.level, "fail");
    // Missing/incompatible Codex is an actionable warning (incomplete wake), not fatal.
    assert.equal(byId.get("codex")?.level, "warn");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preflight PASSes a Codex CLI whose queue supports --thread/--message and never trusts --version", async () => {
  const home = makeTmp();
  try {
    // Compatible CLI: advertises the real supported flags.
    const { checks } = await runPreflight(
      baseRequest(home),
      fakeDeps(home, {
        probeCommand: async (cmd) =>
          cmd === "codex"
            ? {
                found: true,
                path: "/opt/homebrew/bin/codex",
                version: "codex 1.2.3",
                queueHelpOk: true,
                missingQueueFlags: [],
              }
            : { found: true, version: "git 2.44" },
      }),
    );
    const codex = checks.find((c) => c.id === "codex");
    assert.equal(codex?.level, "pass", "compatible queue flags → PASS");

    // A CLI that only answers `--version` (no queue support) must WARN, not PASS.
    const warn = await runPreflight(
      baseRequest(home),
      fakeDeps(home, {
        probeCommand: async (cmd) =>
          cmd === "codex"
            ? {
                found: true,
                path: "/usr/local/bin/codex",
                version: "codex 1.2.3",
                queueHelpOk: false,
                missingQueueFlags: ["thread", "message"],
              }
            : { found: true, version: "git 2.44" },
      }),
    );
    const codexWarn = warn.checks.find((c) => c.id === "codex");
    assert.equal(codexWarn?.level, "warn", "version-only CLI → WARN");
    assert.match(codexWarn?.detail ?? "", /--thread/);
    assert.match(codexWarn?.detail ?? "", /--message/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup writes a 0600 config and reports references + next actions", async () => {
  const home = makeTmp();
  try {
    const request = baseRequest(home);
    const report = await runSetup(request, fakeDeps(home));
    assert.equal(report.ok, true);
    assert.equal(report.configWritten, true);
    assert.equal(report.version, BETA_VERSION);
    assert.equal(report.credentialRef, "env:DEEPSEEK_API_KEY");
    assert.ok(report.nextActions.length >= 4);

    const mode = statSync(request.configPath).mode & 0o777;
    assert.equal(mode, 0o600, "config is private (0600)");

    const parsed = JSON.parse(readFileSync(request.configPath, "utf8"));
    assert.equal(parsed.endpoint, "https://example.invalid/v1");
    assert.ok(!JSON.stringify(parsed).includes("sk-"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup dry-run writes nothing but returns a truthful report", async () => {
  const home = makeTmp();
  try {
    const request = baseRequest(home, { dryRun: true });
    const report = await runSetup(request, fakeDeps(home));
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.equal(report.configWritten, false);
    assert.throws(() => statSync(request.configPath), /ENOENT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup is idempotent: an identical rerun exits ok with no rewrite or backup", async () => {
  const home = makeTmp();
  try {
    const request = baseRequest(home);
    const first = await runSetup(request, fakeDeps(home));
    assert.equal(first.configWritten, true);
    const before = readFileSync(request.configPath, "utf8");
    const beforeMtime = statSync(request.configPath).mtimeMs;

    // Same args again → ok, configWritten:false, no backup file, file untouched.
    const second = await runSetup(request, fakeDeps(home));
    assert.equal(second.ok, true);
    assert.equal(second.configWritten, false);
    assert.equal(second.configBackup, undefined);
    assert.equal(readFileSync(request.configPath, "utf8"), before);
    assert.equal(statSync(request.configPath).mtimeMs, beforeMtime, "file was not rewritten");
    // No .bak-* siblings were created.
    const siblings = readdirSync(home, { recursive: true }) as string[];
    assert.ok(!siblings.some((p) => String(p).includes(".bak-")), "no backup created on idempotent rerun");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup refuses to overwrite a DIFFERENT existing config unless --replace", async () => {
  const home = makeTmp();
  try {
    const request = baseRequest(home);
    await runSetup(request, fakeDeps(home));
    // Different settings + no --replace → preflight failure.
    await assert.rejects(
      () => runSetup(baseRequest(home, { model: "other-model" }), fakeDeps(home)),
      (err: unknown) => (err as { code?: string }).code === "preflight_failed",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup --replace takes a backup and preserves the previous config on rerun failure", async () => {
  const home = makeTmp();
  try {
    const request = baseRequest(home);
    await runSetup(request, fakeDeps(home));
    const original = readFileSync(request.configPath, "utf8");

    // A second run with a changed endpoint + replace should back up the original.
    const report = await runSetup(
      baseRequest(home, { replace: true, model: "fixture-model-2" }),
      fakeDeps(home),
    );
    assert.equal(report.ok, true);
    assert.ok(report.configBackup !== undefined, "a backup path is reported");
    const backup = readFileSync(report.configBackup!, "utf8");
    assert.equal(backup, original, "backup holds the previous config");

    const updated = JSON.parse(readFileSync(request.configPath, "utf8"));
    assert.equal(updated.model, "fixture-model-2");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup --replace preserves unknown/forward-compat config fields", async () => {
  const home = makeTmp();
  try {
    const request = baseRequest(home);
    // Seed an existing config that carries an extra top-level key AND an extra
    // nested key under a known object — both must survive a --replace.
    const seeded = {
      configVersion: 1,
      endpoint: request.endpoint,
      model: "old-model",
      futureField: { hello: "world" },
      limits: { contextWindow: 65536, maxTokens: 16384, maxSteps: null, timeoutMs: null, extraLimit: 7 },
    };
    mkdirSync(path.dirname(request.configPath), { recursive: true });
    writeFileSync(request.configPath, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 });

    const report = await runSetup(baseRequest(home, { replace: true, model: "new-model" }), fakeDeps(home));
    assert.equal(report.ok, true);
    const updated = JSON.parse(readFileSync(request.configPath, "utf8"));
    assert.equal(updated.model, "new-model", "known field is updated by the request");
    assert.deepEqual(updated.futureField, { hello: "world" }, "unknown top-level field preserved");
    assert.equal(updated.limits.extraLimit, 7, "unknown nested field preserved");
    assert.equal(updated.limits.maxSteps, null, "known nested field is authoritative");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("configMatches is true only after setup wrote exactly that config", async () => {
  const home = makeTmp();
  try {
    const request = baseRequest(home);
    const deps = fakeDeps(home);
    assert.equal(await configMatches(request.configPath, request, deps), false);
    await runSetup(request, deps);
    assert.equal(await configMatches(request.configPath, request, deps), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup refuses a symlinked config path", async () => {
  const home = makeTmp();
  try {
    // Point the config at an existing real file and pretend it is a symlink.
    const real = path.join(home, "real.json");
    writeFileSync(real, "{}\n");
    const request = baseRequest(home, { configPath: real });
    const deps: SetupDeps = {
      ...fakeDeps(home),
      fs: { lstatIsSymlink: () => true },
    };
    await assert.rejects(
      () => runSetup(request, deps),
      (err: unknown) => {
        const e = err as { code?: string; report?: { checks: { id: string; level: string; detail: string }[] } };
        assert.equal(e.code, "preflight_failed");
        const configCheck = e.report?.checks.find((c) => c.id === "config_path_file");
        assert.equal(configCheck?.level, "fail");
        assert.match(configCheck?.detail ?? "", /symlink/);
        return true;
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup fails (and rolls back the config write) when a requested skill install cannot run", async () => {
  const home = makeTmp();
  try {
    const request = baseRequest(home, { installSkill: true });
    await assert.rejects(
      () => runSetup(request, fakeDeps(home)),
      (err: unknown) => (err as { code?: string }).code === "skill_install_failed",
    );
    // The config write was rolled back: nothing half-applied remains.
    assert.throws(() => statSync(request.configPath), /ENOENT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup delegates skill install to an injected installer and reports its real result", async () => {
  const home = makeTmp();
  try {
    let called: { destination: string; configPath: string; replace: boolean } | undefined;
    const deps = fakeDeps(home, {
      installSkill: async (options) => {
        called = {
          destination: options.destination,
          configPath: options.configPath,
          replace: options.replace,
        };
        return true;
      },
    });
    const request = baseRequest(home, {
      installSkill: true,
      skillDestination: path.join(home, "skills", "pi-durable"),
      replaceSkill: true,
    });
    const report = await runSetup(request, deps);
    assert.equal(report.skillInstalled, true);
    assert.ok(called !== undefined);
    assert.equal(called!.destination, path.join(home, "skills", "pi-durable"));
    assert.equal(called!.replace, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup handles a home/config path containing spaces", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "pdm setup spaces-"));
  try {
    const deps = fakeDeps(home);
    const request = baseRequest(home, {
      configPath: path.join(home, "my configs", "pi-durable-manager", "config.json"),
      projectHome: path.join(home, "my projects"),
    });
    const report = await runSetup(request, deps);
    assert.equal(report.configWritten, true);
    assert.ok(report.configPath.includes("my configs"));
    const parsed = JSON.parse(readFileSync(report.configPath, "utf8")) as {
      paths: { projectHome: string };
    };
    assert.equal(parsed.paths.projectHome, path.join(home, "my projects"));
    assert.equal(statSync(report.configPath).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup delegates a plugin install to an injected installer and reports its real result", async () => {
  const home = makeTmp();
  try {
    let called: { destination: string; configPath: string; marketplace: string | undefined; replace: boolean } | undefined;
    const deps = fakeDeps(home, {
      installPlugin: async (options) => {
        called = {
          destination: options.destination,
          configPath: options.configPath,
          marketplace: options.marketplace,
          replace: options.replace,
        };
        return true;
      },
    });
    const request = baseRequest(home, {
      installTarget: "plugin",
      pluginDestination: path.join(home, "plugins", "pi-durable-manager"),
      pluginMarketplace: path.join(home, "plugins", "marketplace.json"),
    });
    const report = await runSetup(request, deps);
    assert.equal(report.pluginInstalled, true);
    assert.equal(report.skillInstalled, false);
    assert.equal(report.pluginDestination, path.join(home, "plugins", "pi-durable-manager"));
    assert.ok(called !== undefined);
    assert.equal(called!.configPath, request.configPath);
    assert.equal(called!.marketplace, path.join(home, "plugins", "marketplace.json"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup fails (and rolls back the config write) when a requested plugin install cannot run", async () => {
  const home = makeTmp();
  try {
    // No installPlugin dep supplied, but the request asked for one.
    const request = baseRequest(home, { installTarget: "plugin" });
    await assert.rejects(
      () => runSetup(request, fakeDeps(home)),
      (err: unknown) => (err as { code?: string }).code === "plugin_install_failed",
    );
    assert.throws(() => statSync(request.configPath), /ENOENT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup rolls back a plugin install failure even when it returns false", async () => {
  const home = makeTmp();
  try {
    const deps = fakeDeps(home, {
      installPlugin: async () => false,
    });
    const request = baseRequest(home, { installTarget: "plugin" });
    await assert.rejects(
      () => runSetup(request, deps),
      (err: unknown) => (err as { code?: string }).code === "plugin_install_failed",
    );
    assert.throws(() => statSync(request.configPath), /ENOENT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup rolls back an EARLIER skill install when the later plugin install fails", async () => {
  const home = makeTmp();
  try {
    let uninstalled: string | undefined;
    const deps = fakeDeps(home, {
      installSkill: async () => true,
      installPlugin: async () => false,
      uninstallSkill: async ({ destination }) => {
        uninstalled = destination;
      },
    });
    const request = baseRequest(home, { installSkill: true, installTarget: "plugin" });
    await assert.rejects(
      () => runSetup(request, deps),
      (err: unknown) => (err as { code?: string }).code === "plugin_install_failed",
    );
    assert.ok(uninstalled !== undefined, "the earlier skill install was rolled back");
    assert.throws(() => statSync(request.configPath), /ENOENT/, "config was rolled back too");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSetup rolls back the earlier skill install when the plugin installer THROWS", async () => {
  const home = makeTmp();
  try {
    let uninstalled: string | undefined;
    const deps = fakeDeps(home, {
      installSkill: async () => true,
      installPlugin: async () => {
        throw new Error("plugin transport exploded");
      },
      uninstallSkill: async ({ destination }) => {
        uninstalled = destination;
      },
    });
    const request = baseRequest(home, { installSkill: true, installTarget: "plugin" });
    await assert.rejects(() => runSetup(request, deps), /plugin transport exploded/);
    assert.ok(uninstalled !== undefined, "skill rolled back even when plugin install threw");
    assert.throws(() => statSync(request.configPath), /ENOENT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("nextActions tells the user uninstall PRESERVES config/projects/state by default", async () => {
  const home = makeTmp();
  try {
    const request = baseRequest(home);
    const report = await runSetup(request, fakeDeps(home));
    const joined = report.nextActions.join("\n");
    assert.match(joined, /Uninstalling keeps your config/);
    assert.match(joined, /projects/);
    // The old destructive wording must be gone.
    assert.doesNotMatch(joined, /Uninstall = delete your config/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- Block 5: stat-only credential-FILE validation ----
//
// Preflight must validate a credential FILE by STAT ONLY (regular file, not a
// symlink, private mode) and never read its bytes — so a raw key pasted into the
// wrong argument is never echoed back. A missing file is a WARN (it may be
// provisioned privately later); a directory / symlink / world-readable file is a
// FAIL with truthful guidance.

test("preflight credential-file: a DIRECTORY path is a FAIL (not a PASS via existsSync)", async () => {
  const home = makeTmp();
  try {
    const dirPath = path.join(home, "not-a-file");
    mkdirSync(dirPath, { recursive: true });
    const { checks } = await runPreflight(
      baseRequest(home, { credentialEnv: undefined, credentialFile: dirPath }),
      fakeDeps(home),
    );
    const cred = checks.find((c) => c.id === "credential");
    assert.ok(cred, "credential check present");
    assert.equal(cred!.level, "fail", "a directory is NOT a valid credential file");
    assert.match(cred!.detail, /not a regular file/i);
    // The detail must name the path but never any file bytes.
    assert.match(cred!.detail, new RegExp(dirPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preflight credential-file: a world-readable dummy file is a FAIL and its bytes are never shown", async () => {
  const home = makeTmp();
  try {
    const keyPath = path.join(home, "open.key");
    // A DUMMY value shaped nothing like a real key, but the point is mode 0644.
    const dummy = "not-a-real-secret-DUMMYVALUE";
    writeFileSync(keyPath, dummy, { mode: 0o644 });
    // mkdir/file mode is subject to umask; force exactly 0644.
    chmodSync(keyPath, 0o644);

    const { checks } = await runPreflight(
      baseRequest(home, { credentialEnv: undefined, credentialFile: keyPath }),
      fakeDeps(home),
    );
    const cred = checks.find((c) => c.id === "credential");
    assert.ok(cred, "credential check present");
    assert.equal(cred!.level, "fail", "world-readable file is rejected");
    assert.match(cred!.detail, /too open|0600|600/i);
    // CRITICAL: never echo the file contents.
    assert.ok(!cred!.detail.includes(dummy), "raw file bytes are NEVER shown");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preflight credential-file: a private 0600 regular file PASSes without reading bytes", async () => {
  const home = makeTmp();
  try {
    const keyPath = path.join(home, "private.key");
    writeFileSync(keyPath, "DUMMY-PRIVATE", { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const { checks } = await runPreflight(
      baseRequest(home, { credentialEnv: undefined, credentialFile: keyPath }),
      fakeDeps(home),
    );
    const cred = checks.find((c) => c.id === "credential");
    assert.equal(cred?.level, "pass", "0600 regular file passes");
    assert.match(cred!.detail, /contents never read/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preflight credential-file: a missing file is a WARN (provisioned privately later)", async () => {
  const home = makeTmp();
  try {
    const keyPath = path.join(home, "not-yet", "deepseek.key");
    const { checks } = await runPreflight(
      baseRequest(home, { credentialEnv: undefined, credentialFile: keyPath }),
      fakeDeps(home),
    );
    const cred = checks.find((c) => c.id === "credential");
    assert.equal(cred?.level, "warn", "missing file is a warning, not a failure");
    assert.match(cred!.detail, /not found/i);
    assert.match(cred!.detail, /nothing is read here/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preflight credential-file: a SYMLINK is rejected without following it", async () => {
  const home = makeTmp();
  try {
    const real = path.join(home, "real.key");
    writeFileSync(real, "DUMMY", { mode: 0o600 });
    const link = path.join(home, "link.key");
    symlinkSync(real, link);
    const { checks } = await runPreflight(
      baseRequest(home, { credentialEnv: undefined, credentialFile: link }),
      fakeDeps(home),
    );
    const cred = checks.find((c) => c.id === "credential");
    assert.equal(cred?.level, "fail", "symlink rejected");
    assert.match(cred!.detail, /symlink/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
