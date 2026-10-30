import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectTools } from '../dist/tools.js';
import { resolvePolicy, resolveWithinRoot, runSandboxedCommand } from '../dist/sandbox.js';
import { isProtectedRelativePath } from '../dist/path-protection.js';
import { captureSnapshot } from '../dist/evidence.js';
import { createCheckpoint, inspectCheckpoint } from '../dist/checkpoints.js';

const denied = ['.env', '.env.local', 'nested/.env.production', 'nested/.ENV.secret',
  'nested/.secrets/fake.txt', 'nested/.git/config', '.env.private/.env.example',
  'nested/.npmrc', 'nested/id_ed25519', 'nested/private.pem', 'nested/.aws/credentials'];
const allowed = ['.env.example', 'nested/.env.sample', 'nested/.env.template', 'nested/id_ed25519.pub', 'source.txt'];
const secret = 'FAKE_AUDIT_SENTINEL';
const api = { diagnostic() {}, output() {}, details: async () => undefined };
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pdm-secret-policy-')));
  // Ancestor .runtime is allowed; regexp metacharacters/spaces in the project
  // name must not weaken or overextend the actual kernel path rules.
  const root = join(base, '.runtime', 'project (spaces) [x]');
  const scratch = join(base, 'scratch'), privateDir = join(base, 'checkpoints');
  await mkdir(root, { recursive: true }); await mkdir(privateDir);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const p of [...denied, ...allowed]) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), denied.includes(p) ? secret : 'SAFE_TEMPLATE');
  }
  return { base, root, scratch, privateDir };
}

test('common secret paths are denied by direct read/write tools; explicit templates remain usable', async () => {
  const f = await fixture();
  try {
    const tools = await createProjectTools(f.root);
    for (const path of denied) {
      const r = await tools.read.execute({ path }, api, {});
      assert.equal(r.isError, true, path); assert.ok(!JSON.stringify(r).includes(secret));
      const w = await tools.write.execute({ path, content: 'OVERWRITE' }, api, {});
      assert.equal(w.isError, true, path); assert.equal(await readFile(join(f.root, path), 'utf8'), secret);
    }
    for (const path of allowed) {
      assert.equal(isProtectedRelativePath(path), false, path);
      const r = await tools.read.execute({ path }, api, {});
      assert.ok(!r.isError, path); assert.ok(JSON.stringify(r).includes('SAFE_TEMPLATE'));
    }
    const policy = resolvePolicy({ root: f.root, protectedPaths: [join(f.root, 'source.txt')] });
    await assert.rejects(resolveWithinRoot(policy, 'source.txt', 'read'), /protected/);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('checkpoint and evidence use the same secret exclusions and retain safe templates', async () => {
  const f = await fixture();
  try {
    const snapshot = await captureSnapshot(f.root);
    assert.equal(snapshot.complete, true, JSON.stringify(snapshot.reasons));
    for (const path of denied) assert.equal(snapshot.files[path], undefined, path);
    for (const path of allowed) assert.ok(snapshot.files[path], path);
    await createCheckpoint(f.root, f.privateDir, 'policy-proof');
    const inspection = await inspectCheckpoint(f.privateDir, 'policy-proof');
    assert.equal(inspection.verified, true);
    const paths = inspection.manifest.files.map(f => f.path);
    for (const path of denied) assert.ok(!paths.includes(path), path);
    for (const path of allowed) assert.ok(paths.includes(path), path);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('actual macOS sandbox blocks root/nested secrets and write/alias attempts, permits templates', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const policy = resolvePolicy({ root: f.root, scratchDir: f.scratch, timeoutMs: 10000 });
    const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    for (const path of denied) {
      const r = await runSandboxedCommand(policy, '/bin/cat ' + quote(path));
      assert.notEqual(r.exitCode, 0, path); assert.ok(!r.stdout.includes(secret), path);
    }
    for (const path of allowed) {
      const r = await runSandboxedCommand(policy, '/bin/cat ' + quote(path));
      assert.equal(r.exitCode, 0, path + ': ' + r.stderr); assert.equal(r.stdout, 'SAFE_TEMPLATE');
    }
    for (const command of ["print overwrite > nested/.secrets/fake.txt", "mkdir -p later/.secrets && print private > later/.secrets/new.txt", "ln .env alias.txt && cat alias.txt", "ln -s .env alias-sym.txt && cat alias-sym.txt", "mv .env moved.txt && cat moved.txt"]) {
      const r = await runSandboxedCommand(policy, command);
      assert.notEqual(r.exitCode, 0, command); assert.ok(!r.stdout.includes(secret), command);
    }
    assert.equal(await readFile(join(f.root, '.env'), 'utf8'), secret);
    assert.equal(await readFile(join(f.root, 'nested/.secrets/fake.txt'), 'utf8'), secret);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});


test('custom exclusions protect lexical symlinks and target aliases in tools, evidence and checkpoints', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'vault'));
    await writeFile(join(f.root, 'vault', 'private.txt'), secret);
    await symlink('vault', join(f.root, 'excluded-alias'));
    const protectedPaths = [join(f.root, 'excluded-alias')];
    const policy = resolvePolicy({ root: f.root, protectedPaths });
    for (const path of ['excluded-alias/private.txt', 'vault/private.txt']) {
      await assert.rejects(resolveWithinRoot(policy, path, 'read'), /protected/, path);
    }
    const snapshot = await captureSnapshot(f.root, { protectedPaths });
    assert.equal(snapshot.files['excluded-alias'], undefined);
    assert.equal(snapshot.files['vault/private.txt'], undefined);
    await createCheckpoint(f.root, f.privateDir, 'custom-policy', { protectedPaths });
    const inspection = await inspectCheckpoint(f.privateDir, 'custom-policy');
    assert.equal(inspection.verified, true);
    assert.ok(!inspection.manifest.files.some(f => ['excluded-alias', 'vault/private.txt'].includes(f.path)));
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('actual macOS custom exclusions resist symlink replacement and ancestor moves without locking sibling edits', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    for (const path of ['parent/private', 'vault', 'replacement']) {
      await mkdir(join(f.root, path), { recursive: true });
      await writeFile(join(f.root, path, 'private.txt'), secret);
    }
    await symlink('vault', join(f.root, 'excluded-alias'));
    const policy = resolvePolicy({ root: f.root, scratchDir: f.scratch, timeoutMs: 10000,
      protectedPaths: [join(f.root, 'parent/private'), join(f.root, 'excluded-alias')] });
    for (const command of [
      'mv parent moved && cat moved/private/private.txt',
      'rm excluded-alias && ln -s replacement excluded-alias && cat excluded-alias/private.txt',
      'mv excluded-alias renamed-alias && cat renamed-alias/private.txt',
      'mv vault moved-vault && cat moved-vault/private.txt',
    ]) {
      const r = await runSandboxedCommand(policy, command);
      assert.notEqual(r.exitCode, 0, command); assert.ok(!r.stdout.includes(secret), command);
    }
    const normal = await runSandboxedCommand(policy, 'print neighbor > parent/normal.txt && mv parent/normal.txt parent/renamed.txt && cat parent/renamed.txt');
    assert.equal(normal.exitCode, 0, normal.stderr); assert.equal(normal.stdout, 'neighbor\n');
    for (const path of ['excluded-alias/private.txt', 'parent/private/private.txt']) {
      await assert.rejects(resolveWithinRoot(policy, path, 'read'), /protected/, path);
    }
  } finally { await rm(f.base, { recursive: true, force: true }); }
});
