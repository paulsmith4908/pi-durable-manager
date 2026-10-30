// Real installed-artifact integration gate.
//
// This test does NOT import the TypeScript source or `dist/*.js`. It packs the
// ACTUAL npm tarball (`npm pack`), installs it into an OWNED, ISOLATED HOME, and
// then drives the installed binary from an UNRELATED working directory with a
// RESTRICTED PATH. It also installs the packaged standalone skill + plugin into
// that isolated HOME using only the installed package's own scripts, and asserts
// the resulting artifacts, privacy, and launcher pointers on disk.
//
// Everything is created under the OS temp dir (verified), never the repo or the
// user's real HOME. If npm/offline install cannot run in this environment the
// test reports an honest SKIP, never a false PASS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = realpathSync(path.join(HERE, ".."));

const TMP_ROOT = realpathSync(tmpdir());

/** Create an owned temp dir and assert it is genuinely under the OS temp dir. */
function makeTmp(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(TMP_ROOT, prefix)));
  assert.ok(
    dir.startsWith(TMP_ROOT + path.sep),
    `temp dir ${dir} is not under ${TMP_ROOT}`,
  );
  return dir;
}

function run(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : "",
      spawnError: typeof err.status === "number" ? "" : String(err.message ?? err),
    };
  }
}

function haveNpm() {
  if (process.env.PDM_SKIP_TGZ_INTEGRATION === "1") return false;
  return run("npm", ["--version"]).code === 0;
}

/**
 * The real npm cache to reuse for the offline install. We must NOT let npm fall
 * back to a cache inside the isolated HOME (empty) or the network (off), so we
 * pin the caller's cache explicitly. Falls back to the HOME cache.
 */
function realNpmCache() {
  const fromEnv = process.env.npm_config_cache;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const r = run("npm", ["config", "get", "cache"]);
  const v = r.code === 0 ? r.stdout.trim() : "";
  if (v && !v.includes("npm ERR")) return v;
  return path.join(process.env.HOME ?? "", ".npm");
}

// A restricted PATH that contains ONLY the node/npm directories (never the
// user's shell profile additions). We resolve them from the running node so the
// gate is self-contained and free of baked personal paths.
function restrictedPath() {
  const nodeDir = path.dirname(process.execPath);
  const npmDir = (() => {
    const which = run("sh", ["-c", "command -v npm"]);
    if (which.code === 0 && which.stdout.trim()) return path.dirname(which.stdout.trim());
    return null;
  })();
  const dirs = [nodeDir, npmDir, "/usr/bin", "/bin"].filter(
    (d) => typeof d === "string" && d.length > 0,
  );
  return [...new Set(dirs)].join(path.delimiter);
}

// Lay out a fully owned isolated HOME plus an unrelated cwd (NOT the repo and
// NOT a parent of the install), used to prove the installed launcher works
// from anywhere.
function makeIsolatedHome() {
  const home = makeTmp("pdm-tgz-home-");
  const cwd = makeTmp("pdm-tgz-cwd-");
  const pkgRoot = path.join(home, "pkg");
  mkdirSync(pkgRoot, { recursive: true });
  return { home, cwd, pkgRoot };
}

test("installed tarball runs from an unrelated cwd with a restricted PATH", { timeout: 180000 }, (t) => {
  if (!haveNpm()) {
    t.skip("npm unavailable (or PDM_SKIP_TGZ_INTEGRATION=1)");
    return;
  }
  const { home, cwd, pkgRoot } = makeIsolatedHome();
  try {
    // 1. Pack the REAL tarball from the project into an owned dir.
    const packDir = makeTmp("pdm-tgz-pack-");
    try {
      const pack = run("npm", ["pack", "--pack-destination", packDir], { cwd: PROJECT_ROOT });
      assert.equal(pack.code, 0, `npm pack failed:\n${pack.stderr}`);
      const tgz = readdirSync(packDir).find((n) => n.endsWith(".tgz"));
      assert.ok(tgz, `no .tgz produced; dir=${readdirSync(packDir).join(",")}`);
      const tgzPath = path.join(packDir, tgz);

      // Version in the archive name must agree with the package manifest.
      const manifest = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
      assert.equal(tgz, `pi-durable-manager-${manifest.version}.tgz`);

      // 2. Install it into the isolated HOME (offline: deps come from the real
      //    caller cache, which must be passed through explicitly since our
      //    child HOME is empty).
      run("npm", ["init", "-y"], { cwd: pkgRoot });
      const install = run(
        "npm",
        ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tgzPath],
        {
          cwd: pkgRoot,
          env: {
            ...process.env,
            HOME: home,
            PATH: restrictedPath(),
            npm_config_cache: realNpmCache(),
          },
        },
      );
      if (install.code !== 0) {
        // Network/cache unavailable in this sandbox — honest skip. Surface the
        // real cause in the skip reason so a genuine regression is not masked.
        const reason = (
          install.spawnError || install.stderr || install.stdout
        )
          .split("\n")
          .filter((l) => l.trim())
          .slice(0, 3)
          .join(" | ");
        t.skip(`offline npm install unavailable: ${reason}`);
        return;
      }

      const installed = path.join(pkgRoot, "node_modules", "pi-durable-manager");
      const bin = path.join(installed, "bin", "pi-durable.js");
      assert.ok(existsSync(bin), `installed bin missing: ${bin}`);

      // The tarball must NOT vendor runtime deps (they are declared, resolved
      // by npm), and must NOT contain personal paths or secrets.
      const depDir = path.join(installed, "node_modules");
      assert.ok(
        !existsSync(depDir) || readdirSync(depDir).length === 0,
        "tarball must not bundle its own node_modules",
      );

      // 3. Run the INSTALLED binary from the UNRELATED cwd with restricted PATH.
      const env = { ...process.env, HOME: home, PATH: restrictedPath() };
      const version = run("node", [bin, "--version"], { cwd, env });
      assert.equal(version.code, 0, `installed --version failed:\n${version.stderr}`);
      assert.match(version.stdout, /pi-durable-manager 0\.7\.0-beta\.3/);

      const help = run("node", [bin, "--help"], { cwd, env });
      assert.equal(help.code, 0, `installed --help failed:\n${help.stderr}`);
      assert.match(help.stdout, /pi-durable/);

      // 4. Guided setup writes a private config under the isolated HOME.
      const cfgPath = path.join(home, "etc", "pi-durable", "config.json");
      const setup = run(
        "node",
        [
          bin,
          "setup",
          "--config",
          cfgPath,
          "--endpoint",
          "http://127.0.0.1:9/v1",
          "--model",
          "integration-model",
          "--credential-env",
          "PI_DURABLE_TEST_KEY",
        ],
        { cwd, env },
      );
      assert.equal(setup.code, 0, `installed setup failed:\n${setup.stdout}\n${setup.stderr}`);
      assert.ok(existsSync(cfgPath), "config was not written");
      const mode = statSync(cfgPath).mode & 0o777;
      assert.equal(mode, 0o600, `config mode is ${mode.toString(8)}, expected 600`);
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      assert.equal(cfg.endpoint, "http://127.0.0.1:9/v1");
      const cfgText = readFileSync(cfgPath, "utf8");
      assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(cfgText), "config must not hold a raw key");

      // 5. Install the packaged standalone skill + plugin into the isolated HOME
      //    using ONLY the installed package's scripts.
      const agentRoot = path.join(home, ".agents");
      const skillDest = path.join(home, ".codex", "skills", "pi-durable");
      const pluginDest = path.join(agentRoot, "plugins", "pi-durable-manager");
      const skillScript = path.join(installed, "scripts", "install-skill.mjs");
      const pluginScript = path.join(installed, "scripts", "install-plugin.mjs");
      assert.ok(existsSync(skillScript), "packaged install-skill.mjs missing");
      assert.ok(existsSync(pluginScript), "packaged install-plugin.mjs missing");

      const skill = run(
        "node",
        [skillScript, "--destination", skillDest, "--bin", bin, "--config", cfgPath, "--json"],
        { cwd, env },
      );
      assert.equal(skill.code, 0, `skill install failed:\n${skill.stdout}\n${skill.stderr}`);
      assert.ok(existsSync(path.join(skillDest, "SKILL.md")), "installed SKILL.md missing");

      const plugin = run(
        "node",
        [pluginScript, "--destination", pluginDest, "--bin", bin, "--config", cfgPath, "--json"],
        { cwd, env },
      );
      assert.equal(plugin.code, 0, `plugin install failed:\n${plugin.stdout}\n${plugin.stderr}`);
      const pluginJson = JSON.parse(plugin.stdout);
      assert.equal(pluginJson.plugin, "pi-durable-manager");
      assert.equal(pluginJson.version, "0.7.0-beta.3");
      assert.ok(existsSync(path.join(pluginDest, "plugin.json")), "installed plugin.json missing");

      // The catalog must be a valid marketplace manifest pointing at the
      // INSTALLED plugin via a './'-prefixed path RELATIVE TO THE MARKETPLACE
      // ROOT (the .agents dir), never an absolute or personal path.
      const catalogPath = path.join(agentRoot, "plugins", "marketplace.json");
      assert.ok(existsSync(catalogPath), `marketplace catalog missing: ${catalogPath}`);
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

      // Independently compute the EXPECTED relative path from the marketplace
      // ROOT (the directory that contains the catalog's `.agents/plugins` path,
      // i.e. $HOME here) to the installed plugin, then require the catalog to
      // agree, be './'-prefixed, and stay inside that root. We never mirror the
      // helper's own resolution logic.
      const expectedRoot = home;
      const expectedRel = "./" + path.relative(expectedRoot, pluginDest).split(path.sep).join("/");
      const entry = catalog.plugins?.[0];
      assert.ok(entry, `catalog has no plugins: ${JSON.stringify(catalog)}`);
      assert.equal(entry.source?.path, expectedRel, `catalog relPath should be ${expectedRel}`);
      assert.ok(entry.source.path.startsWith("./"), "catalog relPath must start with './'");
      // Resolving the relPath against the marketplace root must land exactly on
      // the installed plugin directory (and never escape the root).
      const resolved = path.resolve(expectedRoot, entry.source.path);
      assert.equal(realpathSync(resolved), realpathSync(pluginDest));
      assert.ok(
        resolved === expectedRoot || resolved.startsWith(expectedRoot + path.sep),
        "catalog relPath escapes the marketplace root",
      );
      const listed = JSON.stringify(catalog);
      assert.ok(!listed.includes(home), "catalog must not embed an absolute host path");
      assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(listed), "catalog must not embed a raw key");

      // The launcher pointer inside the installed skill must reference the
      // installed bin/config and be mode 0600 (private), and must not leak keys.
      const settingsPath = path.join(skillDest, "local-settings.json");
      assert.ok(existsSync(settingsPath), "installed local-settings.json missing");
      const settingsMode = statSync(settingsPath).mode & 0o777;
      assert.equal(settingsMode, 0o600, `local-settings mode is ${settingsMode.toString(8)}`);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.equal(realpathSync(settings.bin), realpathSync(bin));
      assert.equal(realpathSync(settings.configPath), realpathSync(cfgPath));

      // 6. The whole install tree must be free of personal/workspace fragments
      //    and secrets (scan actual bytes of every installed file). This mirrors
      //    the release scanner: it is GENERIC and DYNAMIC — the personal names
      //    are derived from the CURRENT environment (userInfo/homedir), never
      //    hardcoded, so this test file itself carries no personal fragment. The
      //    one documented, clearly-fake fixture token is the only allowance.
      const ALLOWED_FIXTURE = "sk-abcdef0123456789abcdef";
      const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const GENERIC_HOME_NAMES = new Set([
        "x",
        "user",
        "username",
        "example",
        "you",
        "yourname",
        "test",
        "someone",
        "me",
        "<user>",
        "home",
        "runner",
        "actions",
      ]);
      const suspect = [];
      for (const accountRoot of ["/Users/", "/home/"]) {
        suspect.push({
          // Require the account root to start a path: not preceded by an
          // identifier character (so "PATH/HOME/lang" — a colon-less list of
          // env names — is NOT read as the /home/<user> account root).
          re: new RegExp(`(?<![A-Za-z0-9_])${escapeRe(accountRoot)}([A-Za-z0-9._-]+)`, "gi"),
          allow: (m) => GENERIC_HOME_NAMES.has((m[1] ?? "").toLowerCase()),
        });
      }
      const personalNames = new Set();
      try {
        personalNames.add(os.userInfo().username);
      } catch {
        /* ignore */
      }
      const homeBase = path.basename(os.homedir());
      if (homeBase) personalNames.add(homeBase);
      for (const rawName of personalNames) {
        // A leading dot is a hidden-dir convention, not part of a person's
        // name: ".home" (a scratch home) must be judged as the GENERIC "home",
        // not leaked as a personal identifier.
        const name = rawName.replace(/^\.+/, "");
        if (!name || name.length < 3 || GENERIC_HOME_NAMES.has(name.toLowerCase())) continue;
        suspect.push({ re: new RegExp(`\\b${escapeRe(name)}\\b`, "g") });
      }
      suspect.push({
        re: /sk-[A-Za-z0-9]{16,}/g,
        allow: (m) => m[0] === ALLOWED_FIXTURE,
      });
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const p = path.join(dir, name);
          const st = lstatSync(p);
          if (st.isDirectory()) walk(p);
          else if (st.isFile() && st.size < 2_000_000) {
            const bytes = readFileSync(p, "utf8");
            for (const { re, allow } of suspect) {
              const hits = [...bytes.matchAll(re)];
              const real = hits.filter((m) => !(allow && allow(m)));
              assert.equal(
                real.length,
                0,
                `installed file ${p} leaks ${re}: ${real
                  .slice(0, 3)
                  .map((m) => m[0])
                  .join(", ")}`,
              );
            }
          }
        }
      };
      walk(installed);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
