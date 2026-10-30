#!/usr/bin/env node
// Verify our locally built sharing archive in a private disposable installation.
// No inference, worker, manager binding, publication, or production-state access.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const artifacts = join(root, 'artifacts');
const archiveName = `pi-durable-manager-repository-${version}.zip`;
const reportPath = join(artifacts, 'release-verification.json');
const report = { version, at: new Date().toISOString(), ok: false, checks: {},
  scope: 'Clean archive installation on the current Mac; no model or GUI wake claim.' };
let temp, installation, dataHome, runtimeRun;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  assert.equal(process.platform, 'darwin', 'Clean install acceptance requires macOS');
  const sums = new Map((await readFile(join(artifacts, 'SHA256SUMS'), 'utf8')).trim().split('\n').map(line => {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(line);
    assert.ok(match, 'Invalid checksum entry'); return [match[2], match[1]];
  }));
  for (const [name, sha] of sums) assert.equal(hash(await readFile(join(artifacts, name))), sha, `Hash mismatch: ${name}`);
  assert.ok(sums.has(archiveName)); report.checks.archiveHashes = true;
  temp = await mkdtemp(join(tmpdir(), 'pi-share-'));
  const repo = join(temp, 'repo'); await mkdir(repo);
  const archive = join(artifacts, archiveName);
  // Only extract this builder's allowlisted archive, after checking entry paths.
  const entries = execFileSync('unzip', ['-Z', '-1', archive], { encoding: 'utf8', maxBuffer: 8_000_000 }).trim().split('\n');
  for (const name of entries) {
    assert.ok(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'), 'Unsafe archive path');
    assert.ok(!/(^|\/)(node_modules|\.runtime|\.git|\.secrets)(\/|$)|local-settings\.json$/.test(name), 'Private/generated state in repository');
  }
  execFileSync('unzip', ['-q', archive, '-d', repo]);
  const catalog = JSON.parse(await readFile(join(repo, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(catalog.name, 'pi-durable-beta'); assert.equal(catalog.plugins.length, 1);
  const entry = catalog.plugins[0]; assert.equal(entry.source.path, './plugins/pi-durable-manager');
  const pluginRoot = join(repo, entry.source.path);
  const plugin = JSON.parse(await readFile(join(pluginRoot, 'plugin.json'), 'utf8'));
  assert.equal(plugin.version, version);
  assert.equal(plugin.extensions['com.openai'].onboardingSkill, './skills/setup/SKILL.md');
  await access(join(pluginRoot, 'skills/setup/SKILL.md'));
  const payload = JSON.parse(await readFile(join(pluginRoot, 'service/runtime.json'), 'utf8'));
  assert.equal(payload.version, version);
  assert.equal(payload.file, `pi-durable-manager-${version}.tgz`);
  const bytes = await readFile(join(pluginRoot, 'service', payload.file));
  assert.equal(hash(bytes), payload.sha256);
  assert.equal(payload.sha256, sums.get(payload.file));
  report.checks.catalogAndPayload = true;
  const readme = await readFile(join(repo, 'README.md'), 'utf8');
  assert.ok(readme.includes('INSTALL.md')); await access(join(repo, 'INSTALL.md'));
  const uiSource = await readFile(join(repo, 'src/model-settings-page.ts'), 'utf8');
  const ui = await import(pathToFileURL(join(repo, 'dist/model-settings-page.js')).href);
  assert.ok(uiSource.includes('Add a model') && ui.SETTINGS_PANEL.includes('Add a model'));
  report.checks.currentSettingsIncluded = true;
  const runtimeModule = await import(pathToFileURL(join(pluginRoot, 'skills/pi-durable-manager/scripts/runtime-install.mjs')).href);
  runtimeRun = runtimeModule.run;
  const { configureService } = await import(pathToFileURL(join(pluginRoot, 'skills/pi-durable-manager/scripts/onboard.mjs')).href);
  dataHome = join(temp, 'private-data');
  installation = await configureService({ endpoint: 'http://127.0.0.1:1/v1', model: 'packaging-test-no-inference',
    contextWindow: 32768, maxTokens: 4096, noAuth: true, allowNetwork: false },
    { dataHome, pluginRoot, progress: text => process.stdout.write(text + '\n') });
  assert.equal(installation.version, version); assert.equal(installation.payloadSha256, payload.sha256);
  report.checks.guidedSetup = true;
  const service = JSON.parse(await runtimeRun(process.execPath, [installation.bin, 'service', 'status', '--config', installation.configPath, '--json']));
  assert.equal(service.result.running, true); assert.equal(service.result.status.packageVersion, version);
  report.checks.serviceHealthy = true;
  const { PiClient } = await import(pathToFileURL(join(dirname(installation.bin), '../dist/client.js')).href);
  const client = await PiClient.connect({ stateDir: join(dataHome, 'state') });
  try {
    const settings = await client.call('models.settings', {});
    assert.equal(settings.defaultProfileId, 'existing');
    assert.equal(settings.profiles[0].model, 'packaging-test-no-inference');
    assert.equal(settings.connections[0].endpoint, 'http://127.0.0.1:1/v1');
    assert.equal((await client.call('assignments.list', {})).assignments.length, 0);
    assert.equal((await client.call('manager.status', {})).boundProjects, 0);
    report.checks.noWorkerOrBinding = true;
  } finally { client.close(); }
  const reused = await runtimeModule.installRuntime({ dataHome, pluginRoot });
  assert.equal(reused.reused, true); assert.equal(reused.bin, installation.bin);
  report.checks.idempotentRuntime = true;
  await assert.rejects(configureService({ endpoint: 'http://127.0.0.1:2/v1', model: 'must-not-replace',
    contextWindow: 32768, maxTokens: 4096, noAuth: true, allowNetwork: false },
    { dataHome, pluginRoot, progress() {} }), /already exists/);
  report.checks.existingSetupPreserved = true;
  report.ok = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  // Preserve a possibly-live failed setup for diagnosis, never delete its state.
  let stopped = !dataHome;
  if (installation) {
    try {
      const result = JSON.parse(await runtimeRun(process.execPath, [installation.bin, 'service', 'stop', '--config', installation.configPath, '--json']));
      assert.equal(result.ok, true); assert.equal(result.result.ok, true);
      stopped = true; report.checks.serviceStopped = true;
    } catch { report.ok = false; report.cleanup = 'Service stop needs review; disposable installation retained.'; process.exitCode = 1; }
  } else if (dataHome) {
    try { await access(join(dataHome, 'config.json')); }
    catch { stopped = true; }
  }
  if (temp && stopped) await rm(temp, { recursive: true, force: true });
  else if (temp) report.retainedTemporaryDirectory = temp;
  await mkdir(artifacts, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
