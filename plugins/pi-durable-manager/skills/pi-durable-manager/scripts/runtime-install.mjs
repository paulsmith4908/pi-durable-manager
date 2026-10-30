import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdir, lstat, open, rename, rm, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_HOME = join(process.env.HOME || "", "Library", "Application Support", "Pi Durable");
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Only these fixed messages/labels may leave the installer. Never serialize a child
// exception, its command arguments, stderr, endpoint or provider response body.
const PHASES = new Set(['setup', 'payload', 'dependencies', 'runtime_check', 'configure', 'service_start', 'service_check', 'maintenance']);
const ERRORS = {
  COMMAND_MISSING: 'A required setup command is missing. Check Node and npm installation.',
  COMMAND_DENIED: 'A required setup command could not start because access was denied.',
  COMMAND_START_FAILED: 'A required setup command could not start.',
  COMMAND_FAILED: 'Setup command failed. Check prerequisites and network access, then retry.',
  PRIVATE_DIRECTORY: 'Setup directory must be a private, non-symlink directory.',
  PAYLOAD_MISSING: 'This plugin has no service payload. Install the complete plugin ZIP, not the source skill alone.',
  PAYLOAD_INVALID: 'Invalid bundled service manifest.',
  PAYLOAD_CHECKSUM: 'Bundled service checksum mismatch; installation stopped.',
  LOCK_MISSING: 'Runtime requires a complete, locked release package.',
  LOCK_CHECKSUM: 'Runtime dependency graph checksum mismatch.',
  LOCK_INVALID: 'Runtime dependency graph does not match payload.',
  VERSION_MISMATCH: 'Installed runtime version mismatch.',
  INSTALLED_LOCK_CHANGED: 'Installed dependency graph differs; maintenance repair is required.',
  INSTALL_LOCK_CHANGED: 'npm changed the locked dependency graph.',
  RUNTIME_INCOMPLETE: 'An incomplete runtime exists; use maintenance repair.',
  MAINTENANCE_BUSY: 'Stop the idle service explicitly before maintenance. Running work is never stopped by this command.',
  MAINTENANCE_LEASES: 'Resolve active leases and in-doubt commands before maintenance. No work was cancelled or replayed.',
  MAINTENANCE_CONFIG_MISSING: 'No configuration exists. Use guided first-use setup.',
  MAINTENANCE_POINTER_MISSING: 'Installation pointer is missing; use maintenance repair.',
  MAINTENANCE_PENDING: 'A prior maintenance operation is incomplete; inspect then run repair.',
  MAINTENANCE_NO_ROLLBACK: 'No previous runtime is recorded for rollback.',
  MAINTENANCE_SCHEMA: 'Schema-changing upgrades/rollbacks require a reviewed migration; current state was preserved.',
  MAINTENANCE_SYMLINK: 'State contains a symlink; inspect before maintenance.',
  MAINTENANCE_POINTER_INVALID: 'Installation metadata is not an owned standard setup; manual review required.',
  MAINTENANCE_RUNTIME_ESCAPE: 'Runtime pointer escapes the private runtime directory.',
  MAINTENANCE_RUNTIME_MISSING: 'Runtime is missing; use maintenance repair.',
  LOCK_BUSY: 'Another installer may be active. Run maintenance inspect/repair before retrying.',
  LOCK_UNSAFE: 'Unsafe installation lock.',
  LOCK_UNRECOGNIZED: 'Unrecognized installation lock; manual review required.',
  LOCK_LIVE: 'Installation lock owner is still live; no lock reclaimed.',
  SETUP_FAILED: 'Setup failed. Inspect the reported phase and prerequisites before retrying.',
};
class SetupError extends Error {
  constructor(code, phase = 'setup', exitCode) {
    super(ERRORS[code] ?? ERRORS.SETUP_FAILED);
    this.name = 'SetupError'; this.code = Object.hasOwn(ERRORS, code) ? code : 'SETUP_FAILED';
    this.phase = PHASES.has(phase) ? phase : 'setup';
    if (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) this.exitCode = exitCode;
  }
}
export function setupFailure(code, phase = "setup") { return new SetupError(code, phase); }
export function safeSetupError(error, phase = 'setup') {
  return error instanceof SetupError ? error : new SetupError('SETUP_FAILED', phase);
}
export function setupDiagnostic(error, phase = 'setup') {
  const safe = safeSetupError(error, phase);
  return { code: safe.code, phase: safe.phase, message: safe.message,
    ...(safe.exitCode === undefined ? {} : { exitCode: safe.exitCode }),
    ...(safe.configPreserved === true ? { configPreserved: true } : {}) };
}

export async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) {
    throw new SetupError("PRIVATE_DIRECTORY");
  }
}

export async function privateWrite(path, value, exclusive = false) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW |
    (exclusive ? constants.O_EXCL : constants.O_TRUNC), 0o600);
  try { await handle.writeFile(value); } finally { await handle.close(); }
}

// Capture output without exposing child messages (which may contain provider responses).
export async function run(command, args, options = {}) {
  const { phase = "setup", ...spawnOptions } = options;
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}` },
      ...spawnOptions, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { if (output.length < 2_000_000) output += chunk; });
    child.stderr.resume();
    child.once("error", error => reject(new SetupError(error.code === "ENOENT" ? "COMMAND_MISSING" : error.code === "EACCES" ? "COMMAND_DENIED" : "COMMAND_START_FAILED", phase)));
    child.once("close", code => {
      if (code !== 0) reject(new SetupError("COMMAND_FAILED", phase, code));
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

export async function acquireInstallLock(path, repair = false) {
  const token = randomUUID();
  const claim = () => privateWrite(path, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }), true);
  try { await claim(); } catch (error) {
    if (error.code !== 'EEXIST' || !repair) throw new SetupError("LOCK_BUSY");
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new SetupError("LOCK_UNSAFE");
    const owner = JSON.parse(await readFile(path, 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new SetupError("LOCK_UNRECOGNIZED");
    try { process.kill(owner.pid, 0); throw new SetupError("LOCK_LIVE"); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    await rm(path); await claim();
  }
  return async () => { const current = JSON.parse(await readFile(path, 'utf8')); if (current.pid === process.pid && current.token === token) await rm(path); };
}

export async function installRuntime(options) {
  try { return await installRuntimeUnchecked(options); }
  catch (error) { throw safeSetupError(error, "payload"); }
}

async function installRuntimeUnchecked({ dataHome, pluginRoot = PLUGIN_ROOT, progress = () => {}, repair = false }) {
  dataHome = resolve(dataHome);
  await privateDir(dataHome);
  const service = join(pluginRoot, "service");
  let manifest;
  try { manifest = JSON.parse(await readFile(join(service, "runtime.json"), "utf8")); }
  catch { throw new SetupError("PAYLOAD_MISSING", "payload"); }
  if (!/^pi-durable-manager-[0-9A-Za-z.-]+\.tgz$/.test(manifest.file) ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || !/^[0-9A-Za-z.-]+$/.test(manifest.version)) {
    throw new SetupError("PAYLOAD_INVALID", "payload");
  }
  const payload = join(service, manifest.file);
  const actual = createHash("sha256").update(await readFile(payload)).digest("hex");
  if (actual !== manifest.sha256) throw new SetupError("PAYLOAD_CHECKSUM", "payload");
  if (manifest.schemaVersion !== 2 || manifest.packageFile !== 'runtime-package.json' || manifest.lockFile !== 'runtime-lock.json') throw new SetupError("LOCK_MISSING", "payload");
  const packageBytes = await readFile(join(service, manifest.packageFile)), lockBytes = await readFile(join(service, manifest.lockFile));
  const hash = value => createHash('sha256').update(value).digest('hex');
  if (hash(packageBytes) !== manifest.packageSha256 || hash(lockBytes) !== manifest.lockSha256) throw new SetupError("LOCK_CHECKSUM", "payload");
  const pkg = JSON.parse(packageBytes), graph = JSON.parse(lockBytes);
  if (graph.lockfileVersion !== 3 || pkg.dependencies?.['pi-durable-manager'] !== `file:${manifest.file}` || graph.packages?.['node_modules/pi-durable-manager']?.version !== manifest.version) throw new SetupError("LOCK_INVALID", "payload");
  await privateDir(join(dataHome, "runtimes"));
  const target = join(dataHome, "runtimes", `${manifest.version}-${actual.slice(0, 16)}-${manifest.lockSha256.slice(0, 16)}`);
  const bin = join(target, "node_modules/pi-durable-manager/bin/pi-durable.js");
  try {
    await access(bin);
    const result = JSON.parse(await run(process.execPath, [bin, "--version", "--json"], { phase: "runtime_check" }));
    if (!result.ok || result.result.version !== manifest.version) throw new SetupError("VERSION_MISMATCH", "runtime_check");
    if (hash(await readFile(join(target, 'package-lock.json'))) !== manifest.lockSha256) throw new SetupError("INSTALLED_LOCK_CHANGED", "runtime_check");
    if (!repair) return { bin, version: manifest.version, sha256: actual, lockSha256: manifest.lockSha256, reused: true };
  } catch (error) { if (error.code !== "ENOENT" && !repair) throw error; }
  const releaseLock = await acquireInstallLock(join(dataHome, 'runtime-install.lock'), repair);
  const stage = join(dataHome, "runtimes", `.stage-${randomUUID()}`);
  try {
    await privateDir(stage);
    progress("Installing the bundled service and its dependencies…");
    const npm = join(dirname(process.execPath), "npm");
    await copyFile(payload, join(stage, manifest.file));
    await privateWrite(join(stage, 'package.json'), packageBytes, true);
    await privateWrite(join(stage, 'package-lock.json'), lockBytes, true);
    await run(npm, ["ci", "--prefix", stage, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], {
      phase: "dependencies",
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}` },
    });
    const stagedBin = join(stage, "node_modules/pi-durable-manager/bin/pi-durable.js");
    const result = JSON.parse(await run(process.execPath, [stagedBin, "--version", "--json"], { phase: "runtime_check" }));
    if (!result.ok || result.result.version !== manifest.version) throw new SetupError("VERSION_MISMATCH", "runtime_check");
    if (hash(await readFile(join(stage, 'package-lock.json'))) !== manifest.lockSha256) throw new SetupError("INSTALL_LOCK_CHANGED", "dependencies");
    try { await access(target); if (!repair) throw new SetupError("RUNTIME_INCOMPLETE", "runtime_check"); await rename(target, join(dataHome, 'runtimes', `.damaged-${randomUUID()}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(stage, target);
    return { bin, version: manifest.version, sha256: actual, lockSha256: manifest.lockSha256, reused: false };
  } finally {
    await rm(stage, { recursive: true, force: true });
    await releaseLock();
  }
}
