#!/usr/bin/env node
/** Explicit runtime maintenance. Never reads credential values or rewrites config. */
import { access, readFile, lstat, realpath, cp, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_HOME, PLUGIN_ROOT, privateDir, privateWrite, installRuntime, acquireInstallLock, run, setupDiagnostic, setupFailure } from './runtime-install.mjs';

const json = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const exists = async path => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const within = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith('../') && !r.startsWith('/'); };
async function atomicJson(path, value) { const stage = path + '.next-' + randomUUID(); await privateWrite(stage, JSON.stringify(value, null, 2) + '\n', true); await rename(stage, path); }

/** Only metadata/schema/lease fields are inspected, never source/transcripts/credentials. */
export function stateFacts(stateDir) {
  const db = new DatabaseSync(join(stateDir, 'metadata.sqlite'), { readOnly: true });
  try {
    const schemaVersion = Number(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value);
    if (!Number.isSafeInteger(schemaVersion)) throw Error('State schema cannot be identified.');
    const active = Number(db.prepare("SELECT count(*) AS n FROM assignments WHERE lease_path IS NOT NULL OR state IN ('running','queued','blocked','cancelling')").get().n);
    const uncertain = Number(db.prepare("SELECT count(*) AS n FROM process_receipts WHERE state <> 'stopped'").get().n);
    return { schemaVersion, activeAssignmentsOrLeases: active, unresolvedProcessReceipts: uncertain };
  } finally { db.close(); }
}

async function runtimeIdentity(bin) {
  const version = JSON.parse(await run(process.execPath, [bin, '--version', '--json'], { phase: 'runtime_check' }));
  if (!version.ok || typeof version.result?.version !== 'string') throw Error('Runtime does not identify itself.');
  const { SCHEMA_VERSION } = await import(pathToFileURL(join(dirname(bin), '../dist/store.js')).href);
  if (!Number.isSafeInteger(SCHEMA_VERSION)) throw Error('Runtime schema support cannot be identified.');
  return { version: version.result.version, schemaVersion: SCHEMA_VERSION };
}
async function validatePointer(dataHome, installation, allowMissing = false) {
  if (!installation || installation.configPath !== join(dataHome, 'config.json') || typeof installation.bin !== 'string' || !within(join(dataHome, 'runtimes'), resolve(installation.bin))) throw setupFailure('MAINTENANCE_POINTER_INVALID', 'maintenance');
  if (await exists(installation.bin)) {
    if (!within(await realpath(join(dataHome, 'runtimes')), await realpath(installation.bin))) throw setupFailure('MAINTENANCE_RUNTIME_ESCAPE', 'maintenance');
  } else if (!allowMissing) throw setupFailure('MAINTENANCE_RUNTIME_MISSING', 'maintenance');
  return installation;
}
export async function inspectInstallation(dataHome = DEFAULT_HOME) {
  dataHome = resolve(dataHome);
  const installation = await json(join(dataHome, 'installation.json'));
  const owner = await json(join(dataHome, 'state/service.lock'));
  const database = join(dataHome, 'state/metadata.sqlite');
  const facts = await exists(database) ? stateFacts(join(dataHome, 'state')) : null;
  return { dataHome, installed: Boolean(installation), version: installation?.version ?? null,
    runtimePresent: Boolean(installation && await exists(installation.bin)),
    configPresent: await exists(join(dataHome, 'config.json')),
    serviceOwner: owner ? (alive(owner.pid) ? 'live_or_unknown' : 'dead') : 'absent',
    state: facts, pending: await json(join(dataHome, 'maintenance-pending.json')),
    history: (await json(join(dataHome, 'runtime-history.json')) ?? []).map(({ id, from, to, at }) => ({ id, from, to, at })) };
}

export async function maintainRuntime({ action, dataHome = DEFAULT_HOME, pluginRoot = PLUGIN_ROOT, progress = () => {}, installer = installRuntime }) {
  dataHome = resolve(dataHome);
  if (action === 'inspect') return inspectInstallation(dataHome);
  if (!['upgrade', 'repair', 'rollback'].includes(action)) throw Error('Use inspect, upgrade, repair or rollback.');
  await privateDir(dataHome);
  const release = await acquireInstallLock(join(dataHome, 'maintenance.lock'), action === 'repair');
  let releaseService, releaseSetup;
  try {
    const stateDir = join(dataHome, 'state');
    const owner = await json(join(stateDir, 'service.lock'));
    if (owner && alive(owner.pid)) throw setupFailure('MAINTENANCE_BUSY', 'maintenance');
    await privateDir(stateDir);
    releaseService = await acquireInstallLock(join(stateDir, 'service.lock'), true);
    if (action === 'repair') releaseSetup = await acquireInstallLock(join(dataHome, 'setup.lock'), true);
    const facts = await exists(join(stateDir, 'metadata.sqlite')) ? stateFacts(stateDir) : null;
    if (facts && (facts.activeAssignmentsOrLeases || facts.unresolvedProcessReceipts)) throw setupFailure('MAINTENANCE_LEASES', 'maintenance');
    if (!(await exists(join(dataHome, 'config.json')))) throw setupFailure('MAINTENANCE_CONFIG_MISSING', 'maintenance');
    let current = await json(join(dataHome, 'installation.json'));
    if (current) await validatePointer(dataHome, current, action === 'repair');
    else if (action !== 'repair') throw setupFailure('MAINTENANCE_POINTER_MISSING', 'maintenance');
    const history = await json(join(dataHome, 'runtime-history.json')) ?? [];
    const pending = await json(join(dataHome, 'maintenance-pending.json'));
    if (pending && action !== 'repair') throw setupFailure('MAINTENANCE_PENDING', 'maintenance');
    if (pending && !history.some(row => row.id === pending.id)) history.push(pending);
    let runtime;
    if (action === 'rollback') {
      const last = history.at(-1); if (!last?.before) throw setupFailure('MAINTENANCE_NO_ROLLBACK', 'maintenance');
      await validatePointer(dataHome, last.before);
      runtime = { bin: last.before.bin, version: last.before.version, sha256: last.before.payloadSha256, lockSha256: last.before.dependencyLockSha256 };
    } else {
      // Installation has no service/config side effects. Never change selected models here.
      runtime = await installer({ dataHome, pluginRoot, progress, repair: action === 'repair' });
    }
    const identity = await runtimeIdentity(runtime.bin);
    if (identity.version !== runtime.version) throw Error('Candidate version mismatch.');
    if (facts && facts.schemaVersion !== identity.schemaVersion) throw setupFailure('MAINTENANCE_SCHEMA', 'maintenance');
    const id = randomUUID(), backup = join(dataHome, 'maintenance', id);
    await privateDir(backup);
    await copyFile(join(dataHome, 'config.json'), join(backup, 'config.json'));
    if (current) await privateWrite(join(backup, 'installation.json'), JSON.stringify(current, null, 2) + '\n', true);
    await cp(stateDir, join(backup, 'state'), { recursive: true, dereference: false, filter: async path => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (['service.lock', 'runtime-guard.lock', 'terminal-view.lock'].includes(name)) return false;
      const info = await lstat(path); if (info.isSymbolicLink()) throw setupFailure('MAINTENANCE_SYMLINK', 'maintenance');
      return !info.isSocket();
    } });
    const next = { ...(current ?? { schemaVersion: 1, node: process.execPath, configPath: join(dataHome, 'config.json'), dataHome, installedAt: new Date().toISOString(), providerCodingVerified: false }),
      version: runtime.version, bin: runtime.bin, payloadSha256: runtime.sha256, dependencyLockSha256: runtime.lockSha256,
      serviceHealthy: false, updatedAt: new Date().toISOString() };
    const record = { id, action, at: new Date().toISOString(), from: current?.version ?? null, to: next.version, schemaVersion: identity.schemaVersion, backup, before: current, after: next };
    await atomicJson(join(dataHome, 'maintenance-pending.json'), record);
    // Keep the external guard paused until Codex deliberately starts the selected runtime.
    await atomicJson(join(stateDir, 'guard-pause.json'), { at: Date.now(), reason: 'Explicit service.shutdown' });
    await atomicJson(join(dataHome, 'installation.json'), next);
    await atomicJson(join(dataHome, 'runtime-history.json'), [...history, record]);
    await rm(join(dataHome, 'maintenance-pending.json'));
    return { ok: true, action, version: next.version, schemaVersion: identity.schemaVersion, backup, configPreserved: true, stateRestored: false, restartRequired: true,
      next: 'Reconnect Pi using the updated installed pointer; verify service identity and selected model before delegating. Rollback changes runtime only, never overwrites newer project/state data.' };
  } finally { await releaseSetup?.(); await releaseService?.(); await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), action = args.shift() ?? 'inspect'; let dataHome = process.env.PI_DURABLE_HOME || DEFAULT_HOME;
  try {
    if (args.length) { if (args.length !== 2 || args[0] !== '--data-home') throw Error('Usage: maintenance.mjs inspect|upgrade|repair|rollback [--data-home PATH]'); dataHome = args[1]; }
    console.log(JSON.stringify(await maintainRuntime({ action, dataHome })));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: setupDiagnostic(error, 'maintenance') })); process.exitCode = 1; }
}
