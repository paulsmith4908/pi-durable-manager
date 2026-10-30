#!/usr/bin/env node
// Packaged installer for the pi-durable skill.
//
// Copies the bundled skill into a destination directory with an atomic, staged swap,
// optionally writing a private local-settings.json (mode 0600) referencing the CLI binary
// and config path.
//
// Usage:
//   node scripts/install-skill.mjs [--destination DIR] [--config PATH] [--bin PATH]
//                                  [--replace] [--dry-run] [--json]
//
// Defaults:
//   --destination  ~/.codex/skills/pi-durable
//
// Safety:
//   * The installed local-settings.json is written ONLY inside the installed folder,
//     never into the distributable source skill.
//   * Refuses to overwrite an existing destination unless it is the same owned skill
//     AND --replace is passed.
//   * Rejects a destination that canonically resolves to the source (including via a
//     symlinked ancestor), or that is itself a symlink.
//   * On replacement, the previous skill is moved aside first and restored if the swap
//     fails, so a failed update never destroys a working install.
//   * Does not edit any global agent/config files.
//   * User-invoked only; never runs as part of an automatic process.

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
const SOURCE_SKILL = path.join(ASSETS_ROOT, "skill", "pi-durable");
const SKILL_NAME = "pi-durable";

// The filesystem operations the installer depends on. Tests may inject a wrapper to
// exercise failure/restore paths; production always uses the real node:fs functions.
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

// Thrown for command-line misuse; main() maps this to exit code 2.
class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    destination: path.join(homedir(), ".codex", "skills", SKILL_NAME),
    config: null,
    bin: null,
    replace: false,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        throw new UsageError(`missing value for ${a}`);
      }
      return v;
    };
    if (a === "--destination") opts.destination = value();
    else if (a === "--config") opts.config = value();
    else if (a === "--bin") opts.bin = value();
    else if (a === "--replace") opts.replace = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: install-skill.mjs [--destination DIR] [--config PATH] [--bin PATH] " +
          "[--replace] [--dry-run] [--json]\n",
      );
      process.exit(0);
    } else {
      throw new UsageError(`unknown argument: ${a}`);
    }
  }
  if (opts.destination) opts.destination = path.resolve(opts.destination);
  // Normalize file references to absolute paths at install time so the launcher is not
  // sensitive to the caller's working directory.
  if (opts.bin) opts.bin = path.resolve(opts.bin);
  if (opts.config) opts.config = path.resolve(opts.config);
  return opts;
}

function readFrontmatterName(skillDir, fsOps = defaultFs) {
  try {
    const md = fsOps.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return null;
    const nameLine = m[1].match(/^name:\s*(.+)\s*$/m);
    return nameLine ? nameLine[1].trim() : null;
  } catch {
    return null;
  }
}

// Resolve a path that may not exist yet by canonicalizing the longest existing ancestor.
// This catches aliases (e.g. a symlinked parent) that a lexical compare would miss.
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
  const canonSource = canonicalize(SOURCE_SKILL, fsOps);
  if (canonDest === canonSource) {
    throw new Error("destination resolves to the source skill; refusing to install onto itself");
  }
  // Reject a symlinked destination to avoid writing through a link.
  try {
    const st = fsOps.lstatSync(destination);
    if (st.isSymbolicLink()) {
      throw new Error(`destination is a symlink; refusing: ${destination}`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function checkExisting(destination, replace, fsOps = defaultFs) {
  if (!fsOps.existsSync(destination)) return false;
  // Existing directory: only replace if it is the same owned skill name.
  const name = readFrontmatterName(destination, fsOps);
  if (name !== SKILL_NAME) {
    throw new Error(
      `destination exists and is not the "${SKILL_NAME}" skill; refusing to overwrite: ${destination}`,
    );
  }
  if (!replace) {
    throw new Error(
      `destination already contains "${SKILL_NAME}"; pass --replace to update it`,
    );
  }
  return true;
}

// Read the private pointer values already recorded inside an installed skill, so a
// --replace does not silently drop them.
function readExistingSettings(destination, fsOps = defaultFs) {
  try {
    const raw = fsOps.readFileSync(path.join(destination, "local-settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Missing or malformed settings are non-fatal; treat as empty.
  }
  return {};
}

function buildSettings(opts, existing) {
  const settings = {
    $schema: "pi-durable/local-settings.v1",
  };
  const bin = opts.bin || existing.bin;
  const configPath = opts.config || existing.configPath;
  if (bin) settings.bin = bin;
  if (configPath) settings.configPath = configPath;
  return settings;
}

function install(opts, fsOps = defaultFs) {
  guardDestination(opts.destination, fsOps);
  const existed = checkExisting(opts.destination, opts.replace, fsOps);

  const existing = existed ? readExistingSettings(opts.destination, fsOps) : {};
  const settings = buildSettings(opts, existing);
  const writesSettings = Boolean(settings.bin || settings.configPath);

  const plan = {
    destination: opts.destination,
    source: SOURCE_SKILL,
    bin: settings.bin || null,
    config: settings.configPath || null,
    writesLocalSettings: writesSettings,
    replace: opts.replace,
  };

  if (opts.dryRun) return plan;

  const parent = path.dirname(opts.destination);
  fsOps.mkdirSync(parent, { recursive: true });

  // Stage the new copy as a sibling of the destination (same filesystem => atomic rename).
  const staging = fsOps.mkdtempSync(path.join(parent, `.${SKILL_NAME}-install-`));
  // Backup path for the existing install; kept for the whole swap so we can restore.
  const backup = fsOps.existsSync(opts.destination)
    ? `${opts.destination}.bak-${process.pid}-${Date.now().toString(36)}`
    : null;

  try {
    fsOps.cpSync(SOURCE_SKILL, staging, { recursive: true });
    if (writesSettings) {
      const settingsPath = path.join(staging, "local-settings.json");
      fsOps.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
        mode: 0o600,
      });
    }

    // Swap: move the existing owned skill aside, then move the staged copy into place.
    if (backup) fsOps.renameSync(opts.destination, backup);
    try {
      fsOps.renameSync(staging, opts.destination);
    } catch (err) {
      // Put the old install back before surfacing the failure.
      if (backup && fsOps.existsSync(backup)) {
        try {
          fsOps.renameSync(backup, opts.destination);
        } catch (restoreErr) {
          // Do NOT delete the user's directory. Leave the backup in place and say where.
          throw new Error(
            `failed to install and could not restore previous skill; ` +
              `your previous install is preserved at ${backup} (${restoreErr.message})`,
          );
        }
      }
      throw err;
    }

    // Success: the new skill is in place; the backup is no longer needed.
    if (backup) fsOps.rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    fsOps.rmSync(staging, { recursive: true, force: true });
    // If the swap failed before the backup was consumed, restore it (best effort).
    if (backup && fsOps.existsSync(backup) && !fsOps.existsSync(opts.destination)) {
      try {
        fsOps.renameSync(backup, opts.destination);
      } catch {
        // Leave the backup in place rather than destroying the user's files.
      }
    }
    throw err;
  }

  return plan;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`install-skill: ${err.message}\n`);
    process.exit(2);
  }

  if (!defaultFs.existsSync(SOURCE_SKILL)) {
    process.stderr.write(`install-skill: bundled skill not found at ${SOURCE_SKILL}\n`);
    process.exit(2);
  }

  try {
    const plan = install(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, ...plan }, null, 2) + "\n");
    } else if (opts.dryRun) {
      process.stdout.write(`dry-run: would install ${SOURCE_SKILL} -> ${plan.destination}\n`);
    } else {
      process.stdout.write(`installed ${SKILL_NAME} -> ${plan.destination}\n`);
    }
  } catch (err) {
    process.stderr.write(`install-skill: ${err.message}\n`);
    process.exit(1);
  }
}

export {
  install,
  parseArgs,
  canonicalize,
  SOURCE_SKILL,
  SKILL_NAME,
  UsageError,
  defaultFs as fsOperations,
};

// Run the CLI only when executed directly, so tests can import the module.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
