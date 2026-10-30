#!/usr/bin/env node
// Packaged installer for the pi-durable-manager Codex plugin (portable, skills-only).
//
// Copies this package's bundled plugin tree (plugin.json + skills/<name>/SKILL.md)
// into a user-owned destination with an atomic, staged swap, and can optionally
// register the plugin in a local Agent/Codex marketplace file.
//
// Usage:
//   node scripts/install-plugin.mjs [--destination DIR] [--marketplace PATH]
//                                   [--bin PATH] [--config PATH] [--skill-name NAME]
//                                   [--replace] [--no-marketplace] [--dry-run] [--json]
//
// Defaults:
//   --destination  ~/.agents/plugins/pi-durable-manager
//   --marketplace  <destination parent>/marketplace.json
//
// Safety:
//   * Only the plugin directory and (optionally) the marketplace file are touched.
//     Global Codex config / instructions files are NEVER modified.
//   * Refuses to overwrite a destination unless it is the same owned plugin AND
//     --replace is passed. Rejects a symlinked destination, and a destination that
//     canonically resolves to the source.
//   * When updating an existing marketplace, ALL other entries are preserved. A
//     conflicting plugin name is refused unless --replace, in which case only the
//     matching entry is replaced (with a backup) and other entries are untouched.
//   * The private local-settings.json is written ONLY inside the installed plugin's
//     skill folder, never into the distributable source tree.
//   * Never enables unknown hooks or insecure permissions; the manifest schema is
//     validated before install so a malformed source is rejected, not published.
//   * User-invoked only; never runs automatically.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = path.resolve(__dirname, "..");
const SOURCE_PLUGIN = path.join(ASSETS_ROOT, "plugin");
const PLUGIN_NAME = "pi-durable-manager";
const PLUGIN_VERSION = "0.7.0-beta.2";
const SKILL_NAME = "pi-durable-manager";

class UsageError extends Error {}

const defaultFs = {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
};

/**
 * Resolve the marketplace ROOT directory that `source.path` is relative to.
 *
 * The official Codex docs state that a catalog entry's `source.path` is
 * relative to the marketplace ROOT — the directory that CONTAINS the catalog's
 * `.agents/plugins/` chain — NOT the catalog file's own directory and NOT the
 * `.agents` directory.
 *
 * For the canonical layout `<root>/.agents/plugins/marketplace.json` the ROOT
 * is `<root>` (i.e. BOTH `/.agents/plugins` are removed). Examples:
 *   * `/tmp/Friend/.agents/plugins/marketplace.json`      -> `/tmp/Friend`
 *   * `/friend/.agents/plugins/marketplace.json`          -> `/friend`
 *   * `<repo>/.agents/plugins/marketplace.json`           -> `<repo>`
 *
 * A bare `<dir>/plugins/marketplace.json` (no `.agents/`) likewise resolves to
 * `<dir>` so `source.path` stays relative to the directory that holds `plugins/`.
 *
 * Rule (unless an explicit `--marketplace-root` is supplied):
 *   * strip a trailing `plugins` segment, then a trailing `.agents` segment;
 *   * if neither matched, ROOT = the catalog's own directory.
 */
function resolveMarketplaceRoot(marketplacePath, explicitRoot) {
  if (typeof explicitRoot === "string" && explicitRoot.length > 0) {
    return path.resolve(explicitRoot);
  }
  let dir = path.dirname(path.resolve(marketplacePath));
  if (path.basename(dir) === "plugins") dir = path.dirname(dir);
  if (path.basename(dir) === ".agents") dir = path.dirname(dir);
  return dir;
}

function parseArgs(argv) {
  const opts = {
    destination: path.join(homedir(), ".agents", "plugins", PLUGIN_NAME),
    marketplace: null,
    marketplaceRoot: null,
    bin: null,
    config: null,
    binExplicit: false,
    configExplicit: false,
    pluginName: PLUGIN_NAME,
    skillName: SKILL_NAME,
    replace: false,
    noMarketplace: false,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`missing value for ${a}`);
      return v;
    };
    if (a === "--destination") opts.destination = value();
    else if (a === "--marketplace") opts.marketplace = value();
    else if (a === "--marketplace-root") opts.marketplaceRoot = value();
    else if (a === "--bin") {
      opts.bin = value();
      opts.binExplicit = true;
    } else if (a === "--config") {
      opts.config = value();
      opts.configExplicit = true;
    } else if (a === "--plugin-name") opts.pluginName = value();
    else if (a === "--skill-name") opts.skillName = value();
    else if (a === "--replace") opts.replace = true;
    else if (a === "--no-marketplace") opts.noMarketplace = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: install-plugin.mjs [--destination DIR] [--marketplace PATH] [--marketplace-root DIR] " +
          "[--bin PATH] [--config PATH] [--plugin-name NAME] [--skill-name NAME] [--replace] " +
          "[--no-marketplace] [--dry-run] [--json]\n",
      );
      process.exit(0);
    } else {
      throw new UsageError(`unknown argument: ${a}`);
    }
  }
  opts.destination = path.resolve(opts.destination);
  if (opts.marketplace) opts.marketplace = path.resolve(opts.marketplace);
  if (opts.marketplaceRoot) opts.marketplaceRoot = path.resolve(opts.marketplaceRoot);

  // Default the launcher pointers to THIS package's real CLI entry point and the
  // canonical default private config path. Without a `bin` pointer the installed
  // skill can only launch a CLI already on PATH; recording the package's own
  // `bin/pi-durable.js` lets the launcher work from any cwd with a sanitized
  // PATH. Explicit `--bin`/`--config` (or an existing installed pointer) win.
  if (!opts.bin) opts.bin = defaultPackageBin();
  if (!opts.config) opts.config = defaultConfigPath();
  opts.bin = path.resolve(opts.bin);
  opts.config = path.resolve(opts.config);

  if (!opts.marketplace) {
    opts.marketplace = path.join(path.dirname(opts.destination), "marketplace.json");
  }
  return opts;
}

/** The bundled CLI entry point, resolved from this script's location. */
function defaultPackageBin() {
  return path.join(ASSETS_ROOT, "bin", "pi-durable.js");
}

/** The canonical default private config path (matches `pi-durable setup`). */
function defaultConfigPath() {
  return path.join(homedir(), ".config", "pi-durable-manager", "config.json");
}

// Validate the bundled manifest: a portable root plugin.json with the expected
// name/version. Rejects a malformed source rather than publishing it.
function readManifest(fsOps = defaultFs) {
  const manifestPath = path.join(SOURCE_PLUGIN, "plugin.json");
  const raw = fsOps.readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("plugin.json is not an object");
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new Error("plugin.json is missing a valid name");
  }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("plugin.json is missing a valid version");
  }
  return parsed;
}

function canonicalize(target, fsOps = defaultFs) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = fsOps.realpathSync(current);
      return path.join(real, ...tail);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function guardDestination(destination, fsOps = defaultFs) {
  const canonDest = canonicalize(destination, fsOps);
  const canonSource = canonicalize(SOURCE_PLUGIN, fsOps);
  if (canonDest === canonSource) {
    throw new Error("destination resolves to the source plugin; refusing to install onto itself");
  }
  try {
    const st = fsOps.lstatSync(destination);
    if (st.isSymbolicLink()) {
      throw new Error(`destination is a symlink; refusing: ${destination}`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function readInstalledManifestName(destination, fsOps = defaultFs) {
  try {
    const raw = fsOps.readFileSync(path.join(destination, "plugin.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function checkExisting(destination, replace, fsOps = defaultFs) {
  if (!fsOps.existsSync(destination)) return false;
  const name = readInstalledManifestName(destination, fsOps);
  if (name !== PLUGIN_NAME) {
    throw new Error(
      `destination exists and is not the "${PLUGIN_NAME}" plugin; refusing to overwrite: ${destination}`,
    );
  }
  if (!replace) {
    throw new Error(`destination already contains "${PLUGIN_NAME}"; pass --replace to update it`);
  }
  return true;
}

function readExistingSettings(destination, skillName, fsOps = defaultFs) {
  try {
    const raw = fsOps.readFileSync(
      path.join(destination, "skills", skillName, "local-settings.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Missing or malformed settings are non-fatal.
  }
  return {};
}

function buildSettings(opts, existing) {
  const settings = { $schema: "pi-durable/local-settings.v1" };
  // An explicitly supplied flag wins; otherwise preserve an existing installed
  // pointer; otherwise fall back to the resolved default (package bin / default
  // config). `opts.bin`/`opts.config` are always populated after parseArgs, so
  // the "default" branch is what makes a plain install self-sufficient.
  const bin = opts.binExplicit ? opts.bin : existing.bin || opts.bin;
  const configPath = opts.configExplicit ? opts.config : existing.configPath || opts.config;
  if (bin) settings.bin = bin;
  if (configPath) settings.configPath = configPath;
  return settings;
}

// Build/merge a marketplace file. Preserves all other entries; only the entry for
// this plugin name is added or (with replace) replaced.
function mergeMarketplace(existingRaw, opts) {
  const plugins = [];
  let catalog = { name: "pi-durable-local", plugins };

  if (existingRaw !== null && existingRaw !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(existingRaw);
    } catch (err) {
      throw new Error(`marketplace file is not valid JSON; refusing to modify: ${err.message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("marketplace file is not a JSON object; refusing to modify");
    }
    catalog = parsed;
    if (!Array.isArray(catalog.plugins)) {
      if (catalog.plugins === undefined) catalog.plugins = [];
      else throw new Error("marketplace 'plugins' is not an array; refusing to modify");
    }
  }

  // source.path is relative to the marketplace ROOT (the directory that holds
  // the `plugins/` catalog dir), NOT the catalog file's own directory.
  const root = resolveMarketplaceRoot(opts.marketplace, opts.marketplaceRoot);
  const relPath = path.relative(root, opts.destination);
  // The catalog spec requires a root-relative POSIX path that begins with './'.
  // `path.relative` yields `.codex/...` (no leading `./`), so we prepend one
  // unless the path is already explicit (`./`). A path escaping the root (`../`)
  // is rejected rather than published.
  const posixRel = relPath.split(path.sep).join("/");
  if (posixRel === "" || posixRel === ".") {
    throw new Error("destination resolves to the marketplace root; refusing to register");
  }
  if (posixRel === ".." || posixRel.startsWith("../")) {
    throw new Error(
      `destination ${opts.destination} is outside the marketplace root ${root}; refusing to register`,
    );
  }
  const sourcePath = posixRel.startsWith("./") ? posixRel : `./${posixRel}`;
  const entry = {
    name: opts.pluginName,
    source: { source: "local", path: sourcePath },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  };

  const idx = catalog.plugins.findIndex((p) => p && p.name === opts.pluginName);
  if (idx >= 0) {
    if (!opts.replace) {
      throw new Error(
        `marketplace already has an entry named "${opts.pluginName}"; pass --replace to update it`,
      );
    }
    catalog.plugins[idx] = entry;
  } else {
    catalog.plugins.push(entry);
  }
  return catalog;
}

function install(opts, fsOps = defaultFs, manifestOverride) {
  guardDestination(opts.destination, fsOps);
  const manifest = manifestOverride ?? readManifest(fsOps);
  const existed = checkExisting(opts.destination, opts.replace, fsOps);

  const existing = existed
    ? readExistingSettings(opts.destination, opts.skillName, fsOps)
    : {};
  const settings = buildSettings(opts, existing);
  const writesSettings = Boolean(settings.bin || settings.configPath);

  // Market merge is computed BEFORE any write, so a conflict aborts cleanly.
  let marketplacePlan = null;
  if (!opts.noMarketplace) {
    // Refuse a symlinked catalog: we write next to it and must not be tricked
    // into writing through a link to an unrelated target.
    try {
      const st = fsOps.lstatSync(opts.marketplace);
      if (st.isSymbolicLink()) {
        throw new Error(`marketplace catalog is a symlink; refusing: ${opts.marketplace}`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const existingRaw = fsOps.existsSync(opts.marketplace)
      ? fsOps.readFileSync(opts.marketplace, "utf8")
      : null;
    const merged = mergeMarketplace(existingRaw, opts);
    marketplacePlan = { path: opts.marketplace, catalog: merged };
  }

  const plan = {
    plugin: manifest.name,
    version: manifest.version,
    destination: opts.destination,
    source: SOURCE_PLUGIN,
    bin: settings.bin || null,
    config: settings.configPath || null,
    writesLocalSettings: writesSettings,
    replace: opts.replace,
    marketplace: marketplacePlan ? marketplacePlan.path : null,
    registered: marketplacePlan !== null,
  };

  if (opts.dryRun) return plan;

  // --- Stage the plugin directory ---
  const parent = path.dirname(opts.destination);
  fsOps.mkdirSync(parent, { recursive: true });
  const staging = fsOps.mkdtempSync(path.join(parent, `.${opts.pluginName}-install-`));
  const backup = fsOps.existsSync(opts.destination)
    ? `${opts.destination}.bak-${process.pid}-${Date.now().toString(36)}`
    : null;

  // Prepare the catalog staging file up front so a catalog write failure can
  // roll back the plugin swap we are about to make.
  let catalogStage = null;
  let catalogBackup = null;
  if (marketplacePlan) {
    fsOps.mkdirSync(path.dirname(marketplacePlan.path), { recursive: true });
    catalogStage = `${marketplacePlan.path}.stage-${process.pid}-${Date.now().toString(36)}`;
    if (fsOps.existsSync(marketplacePlan.path)) {
      catalogBackup = `${marketplacePlan.path}.bak-${process.pid}-${Date.now().toString(36)}`;
      fsOps.cpSync(marketplacePlan.path, catalogBackup);
    }
  }

  let swapped = false;
  try {
    fsOps.cpSync(SOURCE_PLUGIN, staging, { recursive: true });
    if (writesSettings) {
      const settingsDir = path.join(staging, "skills", opts.skillName);
      fsOps.mkdirSync(settingsDir, { recursive: true });
      fsOps.writeFileSync(
        path.join(settingsDir, "local-settings.json"),
        JSON.stringify(settings, null, 2) + "\n",
        { mode: 0o600 },
      );
    }

    // Swap the plugin directory into place, holding the old backup until the
    // catalog is committed (plugin + catalog are one transaction).
    if (backup) fsOps.renameSync(opts.destination, backup);
    fsOps.renameSync(staging, opts.destination);
    swapped = true;

    // --- Commit the marketplace file atomically (stage + rename) ---
    if (marketplacePlan) {
      const json = JSON.stringify(marketplacePlan.catalog, null, 2) + "\n";
      fsOps.writeFileSync(catalogStage, json, { mode: 0o600 });
      fsOps.renameSync(catalogStage, marketplacePlan.path);
      catalogStage = null;
    }

    // Catalog committed — now it is safe to drop the plugin backup.
    if (backup) fsOps.rmSync(backup, { recursive: true, force: true });
    if (catalogBackup) fsOps.rmSync(catalogBackup, { force: true });
  } catch (err) {
    // Roll back BOTH the plugin swap and the catalog on any failure after the
    // swap (e.g. an injected catalog commit failure).
    if (catalogStage !== null) fsOps.rmSync(catalogStage, { force: true });
    if (swapped) {
      try {
        fsOps.rmSync(opts.destination, { recursive: true, force: true });
      } catch {
        // fall through to restore
      }
    }
    if (backup && fsOps.existsSync(backup) && !fsOps.existsSync(opts.destination)) {
      try {
        fsOps.renameSync(backup, opts.destination);
      } catch {
        // Leave the backup in place rather than destroying the user's files.
      }
    }
    if (swapped && catalogBackup && fsOps.existsSync(catalogBackup)) {
      // Restore the previous catalog contents.
      try {
        fsOps.rmSync(marketplacePlan.path, { force: true });
        fsOps.renameSync(catalogBackup, marketplacePlan.path);
      } catch {
        // Non-fatal: the catalog backup remains on disk.
      }
    }
    fsOps.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  return plan;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`install-plugin: ${err.message}\n`);
    process.exit(2);
  }

  if (!defaultFs.existsSync(SOURCE_PLUGIN)) {
    process.stderr.write(`install-plugin: bundled plugin not found at ${SOURCE_PLUGIN}\n`);
    process.exit(2);
  }

  try {
    const plan = install(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, ...plan }, null, 2) + "\n");
    } else if (opts.dryRun) {
      process.stdout.write(`dry-run: would install ${SOURCE_PLUGIN} -> ${plan.destination}\n`);
      if (plan.marketplace) process.stdout.write(`dry-run: would register in ${plan.marketplace}\n`);
    } else {
      process.stdout.write(`installed ${PLUGIN_NAME}@${plan.version} -> ${plan.destination}\n`);
      if (plan.marketplace) process.stdout.write(`registered in ${plan.marketplace}\n`);
      process.stdout.write(
        "Restart Codex and open the Plugins Directory, choose the local source, and install.\n",
      );
    }
  } catch (err) {
    process.stderr.write(`install-plugin: ${err.message}\n`);
    process.exit(1);
  }
}

export {
  install,
  parseArgs,
  canonicalize,
  resolveMarketplaceRoot,
  mergeMarketplace,
  readManifest,
  SOURCE_PLUGIN,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  SKILL_NAME,
  UsageError,
  defaultFs as fsOperations,
};

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
