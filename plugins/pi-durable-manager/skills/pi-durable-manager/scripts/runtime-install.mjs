import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdir, lstat, open, rename, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_HOME = join(process.env.HOME || "", "Library", "Application Support", "Pi Durable");
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) {
    throw new Error("Setup directory must be a private, non-symlink directory.");
  }
}

export async function privateWrite(path, value, exclusive = false) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW |
    (exclusive ? constants.O_EXCL : constants.O_TRUNC), 0o600);
  try { await handle.writeFile(value); } finally { await handle.close(); }
}

// Capture output without exposing child messages (which may contain provider responses).
export async function run(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}` },
      ...options, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { if (output.length < 2_000_000) output += chunk; });
    child.stderr.resume();
    child.once("error", () => reject(new Error("A required setup command could not start.")));
    child.once("close", code => {
      if (code !== 0) reject(new Error("Setup command failed. Check prerequisites and network access, then retry."));
      else resolvePromise(output);
    });
  });
}

export async function readInstallation(dataHome) {
  try {
    const value = JSON.parse(await readFile(join(dataHome, "installation.json"), "utf8"));
    if (typeof value.bin !== "string" || typeof value.configPath !== "string" || typeof value.node !== "string") return null;
    await access(value.bin); await access(value.node); await access(value.configPath);
    return value;
  } catch { return null; }
}

export async function installRuntime({ dataHome, pluginRoot = PLUGIN_ROOT, progress = () => {} }) {
  dataHome = resolve(dataHome);
  await privateDir(dataHome);
  const service = join(pluginRoot, "service");
  let manifest;
  try { manifest = JSON.parse(await readFile(join(service, "runtime.json"), "utf8")); }
  catch { throw new Error("This plugin has no service payload. Install the complete plugin ZIP, not the source skill alone."); }
  if (!/^pi-durable-manager-[0-9A-Za-z.-]+\.tgz$/.test(manifest.file) ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || !/^[0-9A-Za-z.-]+$/.test(manifest.version)) {
    throw new Error("Invalid bundled service manifest.");
  }
  const payload = join(service, manifest.file);
  const actual = createHash("sha256").update(await readFile(payload)).digest("hex");
  if (actual !== manifest.sha256) throw new Error("Bundled service checksum mismatch; installation stopped.");
  await privateDir(join(dataHome, "runtimes"));
  const target = join(dataHome, "runtimes", `${manifest.version}-${actual.slice(0, 16)}`);
  const bin = join(target, "node_modules/pi-durable-manager/bin/pi-durable.js");
  try {
    await access(bin);
    const result = JSON.parse(await run(process.execPath, [bin, "--version", "--json"]));
    if (!result.ok || result.result.version !== manifest.version) throw new Error("Installed runtime version mismatch.");
    return { bin, version: manifest.version, sha256: actual, reused: true };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const lock = join(dataHome, "runtime-install.lock");
  await privateWrite(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), true)
    .catch(() => { throw new Error("Another runtime installer may be active. Review runtime-install.lock before retrying."); });
  const stage = join(dataHome, "runtimes", `.stage-${randomUUID()}`);
  try {
    await privateDir(stage);
    progress("Installing the bundled service and its dependencies…");
    const npm = join(dirname(process.execPath), "npm");
    await run(npm, ["install", "--prefix", stage, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", payload], {
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}` },
    });
    const stagedBin = join(stage, "node_modules/pi-durable-manager/bin/pi-durable.js");
    const result = JSON.parse(await run(process.execPath, [stagedBin, "--version", "--json"]));
    if (!result.ok || result.result.version !== manifest.version) throw new Error("Installed runtime version mismatch.");
    await rename(stage, target);
    return { bin, version: manifest.version, sha256: actual, reused: false };
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(lock, { force: true });
  }
}
