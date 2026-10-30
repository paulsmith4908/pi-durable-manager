// Tests for scripts/install-plugin.mjs — the portable skills-only Codex plugin
// installer. Temporary destinations only; no global config is modified; no
// secrets; no network.

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
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.join(HERE, "..", "scripts", "install-plugin.mjs");
const SOURCE_PLUGIN = path.join(HERE, "..", "plugin");

const installer = await import(INSTALLER);

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
  return realpathSync(mkdtempSync(path.join(tmpdir(), "pi-plugin-test-")));
}

test("installs the plugin into a fresh destination with the official layout", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  const res = run(["--destination", dest, "--no-marketplace"]);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(existsSync(path.join(dest, "plugin.json")), "root plugin.json present");
  assert.ok(
    existsSync(path.join(dest, "skills", "pi-durable-manager", "SKILL.md")),
    "skills/<name>/SKILL.md present",
  );
  const manifest = JSON.parse(readFileSync(path.join(dest, "plugin.json"), "utf8"));
  assert.equal(manifest.name, "pi-durable-manager");
  assert.equal(manifest.version, "0.7.0-beta.1");
  rmSync(base, { recursive: true, force: true });
});

test("portable root plugin.json matches the official minimum schema", () => {
  const manifest = JSON.parse(readFileSync(path.join(SOURCE_PLUGIN, "plugin.json"), "utf8"));
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, "pi-durable-manager");
  assert.equal(manifest.version, "0.7.0-beta.1");
  assert.equal(typeof manifest.description, "string");
  // No MCP server declaration — the plugin is skills-only.
  assert.equal(manifest.mcpServers, undefined);
  assert.equal(manifest.mcp_servers, undefined);
});

test("skill frontmatter declares the expected name and describes onboarding", () => {
  const skill = readFileSync(
    path.join(SOURCE_PLUGIN, "skills", "pi-durable-manager", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\n/, "has YAML frontmatter");
  assert.match(skill, /name:\s*pi-durable-manager/);
  assert.match(skill, /description:/);
  assert.match(skill, /setup|onboarding/i, "documents first-run setup");
});

test("refuses to overwrite a non-owned existing destination", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, "plugin.json"), JSON.stringify({ name: "something-else" }));
  const res = run(["--destination", dest, "--replace", "--no-marketplace"]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /not the "pi-durable-manager" plugin/);
  rmSync(base, { recursive: true, force: true });
});

test("requires --replace to update an existing owned plugin", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  assert.equal(run(["--destination", dest, "--no-marketplace"]).code, 0);
  const second = run(["--destination", dest, "--no-marketplace"]);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /--replace/);
  assert.equal(run(["--destination", dest, "--replace", "--no-marketplace"]).code, 0);
  rmSync(base, { recursive: true, force: true });
});

test("dry-run writes nothing", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  const res = run(["--destination", dest, "--dry-run", "--no-marketplace"]);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!existsSync(dest), "destination not created on dry-run");
  assert.match(res.stdout, /dry-run/);
  rmSync(base, { recursive: true, force: true });
});

test("writes local-settings.json with 0600 mode inside the skill, never in the source", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  const res = run([
    "--destination",
    dest,
    "--bin",
    "/opt/bin/pi-durable",
    "--config",
    "/etc/pi/config.json",
    "--no-marketplace",
  ]);
  assert.equal(res.code, 0, res.stderr);
  const settings = path.join(dest, "skills", "pi-durable-manager", "local-settings.json");
  assert.ok(existsSync(settings), "local-settings written in installed skill");
  const mode = statSync(settings).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  const parsed = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(parsed.bin, "/opt/bin/pi-durable");
  assert.equal(parsed.configPath, "/etc/pi/config.json");
  // Source tree stays clean.
  assert.ok(
    !existsSync(path.join(SOURCE_PLUGIN, "skills", "pi-durable-manager", "local-settings.json")),
    "source must never contain local-settings.json",
  );
  rmSync(base, { recursive: true, force: true });
});

test("registers in a marketplace with source.path relative to the marketplace root", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  const marketplace = path.join(base, "marketplace.json");
  const res = run(["--destination", dest, "--marketplace", marketplace]);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(existsSync(marketplace), "marketplace written");
  const mode = statSync(marketplace).mode & 0o777;
  assert.equal(mode, 0o600, `marketplace mode ${mode.toString(8)} should be 0600`);
  const catalog = JSON.parse(readFileSync(marketplace, "utf8"));
  assert.equal(catalog.name, "pi-durable-local");
  assert.equal(catalog.plugins.length, 1);
  const entry = catalog.plugins[0];
  assert.equal(entry.name, "pi-durable-manager");
  assert.equal(entry.source.source, "local");
  assert.equal(entry.source.path, "./plugins/pi-durable-manager");
  rmSync(base, { recursive: true, force: true });
});

test("preserves other marketplace entries and does not duplicate our name", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  const marketplace = path.join(base, "marketplace.json");
  writeFileSync(
    marketplace,
    JSON.stringify(
      {
        name: "pi-durable-local",
        plugins: [
          { name: "other-plugin", source: { source: "local", path: "./plugins/other" } },
        ],
      },
      null,
      2,
    ),
  );
  const res = run(["--destination", dest, "--marketplace", marketplace]);
  assert.equal(res.code, 0, res.stderr);
  const catalog = JSON.parse(readFileSync(marketplace, "utf8"));
  assert.equal(catalog.plugins.length, 2, "other entry preserved, ours added");
  assert.ok(catalog.plugins.some((p) => p.name === "other-plugin"), "other entry intact");
  assert.ok(catalog.plugins.some((p) => p.name === "pi-durable-manager"), "our entry added");
  rmSync(base, { recursive: true, force: true });
});

test("refuses a marketplace name conflict without --replace", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  const marketplace = path.join(base, "marketplace.json");
  writeFileSync(
    marketplace,
    JSON.stringify({
      name: "pi-durable-local",
      plugins: [{ name: "pi-durable-manager", source: { source: "local", path: "./old" } }],
    }),
  );
  const res = run(["--destination", dest, "--marketplace", marketplace]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /already has an entry named/);
  rmSync(base, { recursive: true, force: true });
});

test("replaces only the matching marketplace entry with --replace, keeping others", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  const marketplace = path.join(base, "marketplace.json");
  writeFileSync(
    marketplace,
    JSON.stringify(
      {
        name: "pi-durable-local",
        plugins: [
          { name: "other", source: { source: "local", path: "./plugins/other" } },
          { name: "pi-durable-manager", source: { source: "local", path: "./stale" } },
        ],
      },
      null,
      2,
    ),
  );
  const res = run(["--destination", dest, "--marketplace", marketplace, "--replace"]);
  assert.equal(res.code, 0, res.stderr);
  const catalog = JSON.parse(readFileSync(marketplace, "utf8"));
  assert.equal(catalog.plugins.length, 2);
  const ours = catalog.plugins.find((p) => p.name === "pi-durable-manager");
  assert.equal(ours.source.path, "./plugins/pi-durable-manager", "our entry updated");
  assert.ok(catalog.plugins.some((p) => p.name === "other"), "other entry untouched");
  rmSync(base, { recursive: true, force: true });
});

test("refuses to modify a malformed marketplace file", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  const marketplace = path.join(base, "marketplace.json");
  writeFileSync(marketplace, "{ not json");
  const res = run(["--destination", dest, "--marketplace", marketplace]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /not valid JSON/);
  rmSync(base, { recursive: true, force: true });
});

test("rejects a symlinked destination", () => {
  const base = makeTmp();
  const real = path.join(base, "real");
  const dest = path.join(base, "link");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, dest);
  const res = run(["--destination", dest, "--no-marketplace"]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /symlink/);
  rmSync(base, { recursive: true, force: true });
});

test("rejects installing onto the source plugin directory", () => {
  const res = run(["--destination", SOURCE_PLUGIN, "--no-marketplace"]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /source plugin/);
});

test("unknown argument and missing value fail with usage exit code 2", () => {
  assert.equal(run(["--nope"]).code, 2);
  assert.match(run(["--nope"]).stderr, /unknown argument/);
  assert.equal(run(["--destination"]).code, 2);
  assert.match(run(["--destination"]).stderr, /missing value/);
});

test("--help exits 0 with usage text", () => {
  const res = run(["--help"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Usage: install-plugin\.mjs/);
});

test("re-running is idempotent with --replace and preserves existing pointers", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  assert.equal(
    run(["--destination", dest, "--bin", "/keep/bin", "--config", "/keep/cfg.json", "--no-marketplace"]).code,
    0,
  );
  const res = run(["--destination", dest, "--replace", "--bin", "/new/bin", "--no-marketplace"]);
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(
    readFileSync(path.join(dest, "skills", "pi-durable-manager", "local-settings.json"), "utf8"),
  );
  assert.equal(parsed.bin, "/new/bin");
  assert.equal(parsed.configPath, "/keep/cfg.json", "existing pointer preserved");
  rmSync(base, { recursive: true, force: true });
});

test("failed replacement restores the previous plugin (injected rename failure)", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  assert.equal(run(["--destination", dest, "--no-marketplace"]).code, 0);
  const marker = path.join(dest, "OLD-MARKER.txt");
  writeFileSync(marker, "old");

  let renames = 0;
  const fsOps = {
    ...installer.fsOperations,
    renameSync: (...args) => {
      renames += 1;
      if (renames === 2) {
        const err = new Error("injected rename failure");
        err.code = "EIO";
        throw err;
      }
      return installer.fsOperations.renameSync(...args);
    },
  };

  assert.throws(
    () =>
      installer.install(
        {
          destination: dest,
          marketplace: path.join(base, "marketplace.json"),
          bin: null,
          config: null,
          pluginName: "pi-durable-manager",
          skillName: "pi-durable-manager",
          replace: true,
          noMarketplace: true,
          dryRun: false,
          json: false,
        },
        fsOps,
      ),
    /injected rename failure/,
  );
  assert.ok(existsSync(marker), "old plugin restored after a failed swap");
  rmSync(base, { recursive: true, force: true });
});

test("installed tree never contains node_modules, .git, or *.bak leftovers", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  assert.equal(run(["--destination", dest, "--no-marketplace"]).code, 0);
  const entries = readdirSync(dest);
  assert.ok(!entries.includes("node_modules"));
  assert.ok(!entries.includes(".git"));
  assert.ok(!entries.some((e) => e.includes(".bak-")));
  rmSync(base, { recursive: true, force: true });
});

test("default destination is under the user's ~/.agents/plugins (no personal paths baked in)", () => {
  const opts = installer.parseArgs([]);
  assert.match(opts.destination, /\.agents[/\\]plugins[/\\]pi-durable-manager$/);
  // The marketplace default sits beside the destination.
  assert.equal(path.dirname(opts.marketplace), path.dirname(opts.destination));
});

test("marketplace ROOT is the directory containing plugins/, so source.path resolves at the real root", () => {
  // Official layout: <root>/plugins/marketplace.json + <root>/plugins/pi-durable-manager.
  const root = makeTmp();
  const plugDir = path.join(root, "plugins");
  const dest = path.join(plugDir, "pi-durable-manager");
  const marketplace = path.join(plugDir, "marketplace.json");
  const res = run(["--destination", dest, "--marketplace", marketplace]);
  assert.equal(res.code, 0, res.stderr);
  const catalog = JSON.parse(readFileSync(marketplace, "utf8"));
  const entry = catalog.plugins.find((p) => p.name === "pi-durable-manager");
  assert.equal(entry.source.path, "./plugins/pi-durable-manager");
  // The recorded path MUST resolve to the exact installed plugin dir.
  const resolved = path.resolve(path.dirname(marketplace), "..", entry.source.path);
  assert.equal(realpathSync(resolved), realpathSync(dest));
  rmSync(root, { recursive: true, force: true });
});

test("official .agents/plugins layout: ROOT strips BOTH .agents and plugins (independent expectation)", () => {
  // Catalog: /tmp/Friend/.agents/plugins/marketplace.json
  // Expected ROOT (official docs: source.path is relative to the marketplace
  // ROOT, not .agents nor the catalog dirname): /tmp/Friend
  const Friends = makeTmp();
  const MKT = path.join(Friends, ".agents", "plugins");
  const marketplace = path.join(MKT, "marketplace.json");
  // Case A: destination under .codex/plugins -> './.codex/plugins/pi-durable-manager'
  const destA = path.join(Friends, ".codex", "plugins", "pi-durable-manager");
  const resA = run(["--destination", destA, "--marketplace", marketplace]);
  assert.equal(resA.code, 0, resA.stderr);
  const catA = JSON.parse(readFileSync(marketplace, "utf8"));
  const entryA = catA.plugins.find((p) => p.name === "pi-durable-manager");
  assert.equal(entryA.source.path, "./.codex/plugins/pi-durable-manager");
  assert.equal(realpathSync(path.resolve(Friends, entryA.source.path)), realpathSync(destA));
  rmSync(Friends, { recursive: true, force: true });

  // Case B: destination inside .agents/plugins -> './.agents/plugins/pi-durable-manager'
  const Friends2 = makeTmp();
  const MKT2 = path.join(Friends2, ".agents", "plugins");
  const marketplace2 = path.join(MKT2, "marketplace.json");
  const destB = path.join(MKT2, "pi-durable-manager");
  const resB = run(["--destination", destB, "--marketplace", marketplace2]);
  assert.equal(resB.code, 0, resB.stderr);
  const catB = JSON.parse(readFileSync(marketplace2, "utf8"));
  const entryB = catB.plugins.find((p) => p.name === "pi-durable-manager");
  assert.equal(entryB.source.path, "./.agents/plugins/pi-durable-manager");
  assert.equal(realpathSync(path.resolve(Friends2, entryB.source.path)), realpathSync(destB));
  rmSync(Friends2, { recursive: true, force: true });
});

test("catalog at <repo>/.agents/plugins/marketplace.json resolves ROOT to <repo>", () => {
  const repo = makeTmp();
  const marketplace = path.join(repo, ".agents", "plugins", "marketplace.json");
  const dest = path.join(repo, "dist-install", "pi-durable-manager");
  const res = run([
    "--destination",
    dest,
    "--marketplace",
    marketplace,
    "--marketplace-root",
    repo,
  ]);
  assert.equal(res.code, 0, res.stderr);
  const catalog = JSON.parse(readFileSync(marketplace, "utf8"));
  const entry = catalog.plugins.find((p) => p.name === "pi-durable-manager");
  assert.equal(entry.source.path, "./dist-install/pi-durable-manager");
  assert.equal(realpathSync(path.resolve(repo, entry.source.path)), realpathSync(dest));
  rmSync(repo, { recursive: true, force: true });
});

test("resolveMarketplaceRoot unit cases (independent expected roots)", () => {
  const { resolveMarketplaceRoot } = installer;
  assert.equal(
    resolveMarketplaceRoot("/tmp/Friend/.agents/plugins/marketplace.json"),
    "/tmp/Friend",
  );
  assert.equal(
    resolveMarketplaceRoot("/friend/.agents/plugins/marketplace.json"),
    "/friend",
  );
  // Bare plugins/ layout (no .agents) resolves to the dir holding plugins/.
  assert.equal(resolveMarketplaceRoot("/srv/app/plugins/marketplace.json"), "/srv/app");
  // A catalog with no plugins/ or .agents/ segment falls back to its own dir.
  assert.equal(resolveMarketplaceRoot("/srv/app/catalog.json"), "/srv/app");
  // Explicit root wins outright.
  assert.equal(
    resolveMarketplaceRoot("/tmp/Friend/.agents/plugins/marketplace.json", "/custom/root"),
    path.resolve("/custom/root"),
  );
});

test("source.path always starts with './' and stays within the marketplace root", () => {
  const repo = makeTmp();
  const marketplace = path.join(repo, ".agents", "plugins", "marketplace.json");
  const dest = path.join(repo, ".codex", "plugins", "pi-durable-manager");
  const res = run(["--destination", dest, "--marketplace", marketplace]);
  assert.equal(res.code, 0, res.stderr);
  const catalog = JSON.parse(readFileSync(marketplace, "utf8"));
  const entry = catalog.plugins.find((p) => p.name === "pi-durable-manager");
  assert.ok(entry.source.path.startsWith("./"), "source.path is root-relative");
  const resolved = path.resolve(repo, entry.source.path);
  const rel = path.relative(repo, resolved);
  assert.ok(!rel.startsWith("..") && !path.isAbsolute(rel), "stays within root");
  rmSync(repo, { recursive: true, force: true });
});

test("explicit --marketplace-root overrides ROOT resolution for custom layouts", () => {
  const base = makeTmp();
  const dest = path.join(base, "custom", "nested", "pi-durable-manager");
  const marketplace = path.join(base, "custom", "nested", "catalog.json");
  const res = run([
    "--destination",
    dest,
    "--marketplace",
    marketplace,
    "--marketplace-root",
    base,
  ]);
  assert.equal(res.code, 0, res.stderr);
  const catalog = JSON.parse(readFileSync(marketplace, "utf8"));
  const entry = catalog.plugins.find((p) => p.name === "pi-durable-manager");
  assert.equal(entry.source.path, "./custom/nested/pi-durable-manager");
  const resolved = path.resolve(base, entry.source.path);
  assert.equal(realpathSync(resolved), realpathSync(dest));
  rmSync(base, { recursive: true, force: true });
});

test("a failed catalog commit rolls back BOTH the plugin swap and the catalog", () => {
  const base = makeTmp();
  const plugDir = path.join(base, "plugins");
  const dest = path.join(plugDir, "pi-durable-manager");
  const marketplace = path.join(plugDir, "marketplace.json");
  // First install succeeds and registers the plugin.
  assert.equal(run(["--destination", dest, "--marketplace", marketplace]).code, 0);
  const before = readFileSync(marketplace, "utf8");
  const marker = path.join(dest, "OLD-MARKER.txt");
  writeFileSync(marker, "old");

  // Simulate a FAILURE committing the catalog: fail the rename that moves the
  // staged catalog into place (the 3rd rename: dest->backup, staging->dest,
  // catalogStage->marketplace).
  let renames = 0;
  const fsOps = {
    ...installer.fsOperations,
    renameSync: (...args) => {
      renames += 1;
      if (renames === 3) {
        const err = new Error("injected catalog commit failure");
        err.code = "EIO";
        throw err;
      }
      return installer.fsOperations.renameSync(...args);
    },
  };
  assert.throws(
    () =>
      installer.install(
        {
          destination: dest,
          marketplace,
          marketplaceRoot: null,
          bin: null,
          config: null,
          pluginName: "pi-durable-manager",
          skillName: "pi-durable-manager",
          replace: true,
          noMarketplace: false,
          dryRun: false,
          json: false,
        },
        fsOps,
      ),
    /injected catalog commit failure/,
  );
  // Plugin rolled back to the previous install.
  assert.ok(existsSync(marker), "old plugin restored after a failed catalog commit");
  // Catalog is byte-identical to what it was before the failed transaction.
  assert.equal(readFileSync(marketplace, "utf8"), before, "catalog restored intact");
  // No staging/backup leftovers beside the marketplace or the destination.
  const leftovers = readdirSync(plugDir).filter((e) => /\.(bak|stage)-/.test(e));
  assert.deepEqual(leftovers, [], `no transaction leftovers: ${leftovers.join(",")}`);
  rmSync(base, { recursive: true, force: true });
});

test("rejects a symlinked marketplace catalog", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  const realCatalog = path.join(base, "real-catalog.json");
  writeFileSync(realCatalog, JSON.stringify({ name: "pi-durable-local", plugins: [] }));
  const marketplace = path.join(base, "marketplace.json");
  symlinkSync(realCatalog, marketplace);
  const res = run(["--destination", dest, "--marketplace", marketplace]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /symlink/);
  rmSync(base, { recursive: true, force: true });
});

test("defaults the launcher bin pointer to the package CLI and config to the default path", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  // No --bin/--config: the installer must still record a working bin pointer.
  const res = run(["--destination", dest, "--no-marketplace"]);
  assert.equal(res.code, 0, res.stderr);
  const settings = path.join(dest, "skills", "pi-durable-manager", "local-settings.json");
  assert.ok(existsSync(settings), "local-settings.json written by default");
  const parsed = JSON.parse(readFileSync(settings, "utf8"));
  assert.ok(path.isAbsolute(parsed.bin), `bin must be absolute: ${parsed.bin}`);
  assert.match(parsed.bin, /bin[/\\]pi-durable\.js$/);
  assert.ok(existsSync(parsed.bin), `default bin pointer must exist: ${parsed.bin}`);
  assert.ok(path.isAbsolute(parsed.configPath), `config must be absolute: ${parsed.configPath}`);
  assert.match(parsed.configPath, /pi-durable-manager[/\\]config\.json$/);
  rmSync(base, { recursive: true, force: true });
});

test("update preserves an existing custom pointer unless the flag is re-supplied", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  assert.equal(
    run(["--destination", dest, "--bin", "/custom/cli.mjs", "--config", "/custom/cfg.json", "--no-marketplace"]).code,
    0,
  );
  // Update with NO pointer flags: the custom pointers must survive the default.
  const res = run(["--destination", dest, "--replace", "--no-marketplace"]);
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(
    readFileSync(path.join(dest, "skills", "pi-durable-manager", "local-settings.json"), "utf8"),
  );
  assert.equal(parsed.bin, "/custom/cli.mjs", "custom bin pointer preserved on update");
  assert.equal(parsed.configPath, "/custom/cfg.json", "custom config pointer preserved on update");
  rmSync(base, { recursive: true, force: true });
});

test("default install is pointer-free in the distributable source tree", () => {
  const base = makeTmp();
  const dest = path.join(base, "plugins", "pi-durable-manager");
  assert.equal(run(["--destination", dest, "--no-marketplace"]).code, 0);
  assert.ok(
    !existsSync(path.join(SOURCE_PLUGIN, "skills", "pi-durable-manager", "local-settings.json")),
    "source plugin tree must never contain local-settings.json",
  );
  rmSync(base, { recursive: true, force: true });
});


