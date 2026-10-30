#!/usr/bin/env node
// Portable Pi Durable CLI launcher.
//
// Resolves a CLI executable and a config path, then forwards argv safely to the CLI
// and mirrors its stdout/stderr/exit code/signals. It never reads credentials; it only
// forwards a config path. No personal absolute paths are baked in.
//
// Resolution order:
//   CLI:    PI_DURABLE_BIN  ->  local-settings.json (installed skill only)  ->  "pi-durable" on PATH
//   Config: PI_DURABLE_CONFIG -> local-settings.json configPath -> default private config path
//
// Usage: node pi.mjs <cli-args...>

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// local-settings.json lives next to this script's parent skill root when installed.
const SKILL_ROOT = path.resolve(HERE, "..");
const LOCAL_SETTINGS = path.join(SKILL_ROOT, "local-settings.json");
const DEFAULT_CONFIG = path.join(
  homedir(),
  ".config",
  "pi-durable-manager",
  "config.json",
);
// A depth sentinel travels with the environment so that a launcher reached through a
// PATH or symlink alias still stops re-entering itself, even when its path differs.
const DEPTH_ENV = "PI_DURABLE_LAUNCH_DEPTH";
const MAX_DEPTH = 5;

function readLocalSettings() {
  try {
    const raw = readFileSync(LOCAL_SETTINGS, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Missing or malformed settings are non-fatal; fall through to defaults.
  }
  return {};
}

function resolveBin(settings) {
  const fromEnv = process.env.PI_DURABLE_BIN;
  if (fromEnv) return fromEnv;
  if (typeof settings.bin === "string" && settings.bin) return settings.bin;
  return "pi-durable";
}

function resolveConfig(settings) {
  const fromEnv = process.env.PI_DURABLE_CONFIG;
  if (fromEnv) return fromEnv;
  if (typeof settings.configPath === "string" && settings.configPath) {
    return settings.configPath;
  }
  return DEFAULT_CONFIG;
}

// Refuse to re-enter ourselves, which would recurse forever. Paths can alias ourselves
// lexically, through a symlink, or through PATH resolution, so compare canonical paths.
function assertNotSelf(bin) {
  let self;
  try {
    self = fileURLToPath(import.meta.url);
  } catch {
    return; // Cannot resolve self; let the spawn step surface any error.
  }
  const canon = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  if (canon(bin) === canon(self)) {
    throw new Error("pi.mjs resolved its own path as the CLI; aborting to avoid recursion");
  }
}

// A depth sentinel bounds recursion even when the launcher is reached by a path we cannot
// canonicalize (for example an alias that shadows this file after PATH manipulation).
function currentDepth() {
  return Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;
}

function assertDepthOk(depth) {
  if (depth >= MAX_DEPTH) {
    throw new Error(
      `pi.mjs exceeded the recursion limit (${MAX_DEPTH}); refusing to launch again`,
    );
  }
}

function main() {
  const settings = readLocalSettings();
  const bin = resolveBin(settings);
  const configPath = resolveConfig(settings);
  const depth = currentDepth();
  assertDepthOk(depth);
  assertNotSelf(bin);

  const forwarded = process.argv.slice(2);

  // Build the child invocation without any shell interpolation.
  let command;
  let args;
  if (/\.m?js$/i.test(bin)) {
    // A JS entry file: run it with the current Node executable.
    command = process.execPath;
    args = [bin, ...forwarded];
  } else {
    command = bin;
    args = forwarded;
  }

  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      PI_DURABLE_CONFIG: configPath,
      [DEPTH_ENV]: String(depth + 1),
    },
  });

  child.on("error", (err) => {
    process.stderr.write(`pi.mjs: failed to launch CLI (${bin}): ${err.message}\n`);
    process.exit(err.code === "ENOENT" ? 127 : 126);
  });

  // Forward termination signals to the child so Ctrl-C and friends behave.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (!child.killed) child.kill(sig);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      // Re-raise the child's signal on ourselves; fall through to a code if ignored.
      process.kill(process.pid, signal);
      process.exit(128);
    }
    process.exit(code ?? 0);
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`pi.mjs: ${err.message}\n`);
  process.exit(1);
}
