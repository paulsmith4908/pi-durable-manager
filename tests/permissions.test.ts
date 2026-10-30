import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { PiDurableService } from '../src/service.js';
import { startTerminalBrowser } from '../src/native-terminal-browser.js';
import { parsePermissions } from '../src/permissions.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pdm-permissions-'));
  await mkdir(join(dir, 'projects'));
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'test' }] });
  const models = createModels(); models.setProvider(faux.provider);
  const config: any = { configVersion: 1, endpoint: 'https://fixture.invalid/v1', model: 'test', limits: { contextWindow: 65536, maxTokens: 8192, maxSteps: null, timeoutMs: null }, paths: { stateDir: join(dir, 'state'), projectHome: join(dir, 'projects'), allowedRoots: [join(dir, 'projects')] }, credential: { env: 'FIXTURE_ONLY' }, manager: { enabled: false }, tools: { allowNetwork: true } };
  const start = () => PiDurableService.start({ transport: 'none', host: { config, createModels: () => models, providerId: 'faux', resolveCredential: async () => ({ apiKey: 'fake-test-key', source: 'test' }) } });
  let service = await start();
  const call = async (method: string, params: any = {}, requestId: string = randomUUID()): Promise<any> => {
    const r = await service.handle({ v: 1, id: requestId, method, params: { ...params, requestId } });
    if (r.error) throw new Error(r.error.message); return r.result;
  };
  const project = (await call('projects.create', { name: 'policy', path: join(dir, 'projects', 'policy') })).project;
  const workflow = (await call('workflow.open', { projectId: project.id, threadId: randomUUID(), objective: 'Permission tests', roadmap: 'Verify boundaries' })).workflow;
  return { dir, faux, project, workflow, call, restart: async () => { await service.stop(); service = await start(); }, close: async () => { await service.stop(); await rm(dir, { recursive: true, force: true }); } };
}
const locked = { writeFiles: false, shell: false, network: false, hostValidation: false, excludedPaths: ['private'] };

test('permission policies are strict and cannot promise read-only shell execution', () => {
  assert.throws(() => parsePermissions({ ...locked, shell: true }), /requires file writes/);
  for (const path of ['../outside', '/tmp/private', 'a/../b', 'a/*', 'a\\b', '.']) assert.throws(() => parsePermissions({ ...locked, excludedPaths: [path] }));
  assert.throws(() => parsePermissions({ ...locked, allowPublishing: true }), /Unknown permission/);
});

test('project creation leaves instructions alone; operator defaults/overrides are durable and version checked', async () => {
  const f = await fixture(); try {
    await assert.rejects(readFile(join(f.project.path, 'AGENTS.md')), { code: 'ENOENT' });
    const initial = await f.call('permissions.read', { projectId: f.project.id });
    assert.equal(initial.policy.network, true, 'legacy networking consent is preserved');
    const params = { projectId: f.project.id, policy: locked, expectedRevision: initial.revision };
    const result = await f.call('permissions.set', params, 'policy-save');
    assert.deepEqual(await f.call('permissions.set', params, 'policy-save'), result);
    await assert.rejects(f.call('permissions.set', { ...params, policy: { ...locked, network: true } }, 'policy-save'), /different|changed|conflict/i);
    await assert.rejects(f.call('permissions.set', params), /refresh/i);
    await f.restart();
    assert.deepEqual((await f.call('permissions.read', { projectId: f.project.id })).policy, locked);
    assert.equal((await f.call('permissions.read')).policy.network, true, 'project override leaves default unchanged');
    const events = await f.call('activity.list', { projectId: f.project.id });
    assert.equal(events.entries.filter((e: any) => e.kind === 'permissions.changed').length, 1);
  } finally { await f.close(); }
});

test('actual worker tools obey disabled writes/shell/validation and excluded paths, and record policy before admission', async () => {
  const f = await fixture(); try {
    await mkdir(join(f.project.path, 'private')); await writeFile(join(f.project.path, 'private', 'fake.txt'), 'FAKE_POLICY_SENTINEL');
    const prior = await f.call('permissions.read', { projectId: f.project.id });
    await f.call('permissions.set', { projectId: f.project.id, policy: locked, expectedRevision: prior.revision });
    f.faux.appendResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: 'forbidden.txt', content: 'no' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'touch shell-forbidden.txt' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('read', { path: 'private/fake.txt' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('host_validate', { profile: 'missing' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Restrictions observed.'),
    ]);
    const a = (await f.call('workflow.submit', { id: f.workflow.id, task: 'Exercise restrictions', criteria: 'No writes' })).assignment;
    await f.call('assignments.wait', { id: a.id, timeoutMs: 10000 });
    for (const name of ['forbidden.txt', 'shell-forbidden.txt']) await assert.rejects(readFile(join(f.project.path, name)), { code: 'ENOENT' });
    const transcript = JSON.stringify(await f.call('sessions.transcript', { id: a.sessionId }));
    assert.doesNotMatch(transcript, /FAKE_POLICY_SENTINEL/);
    assert.match(transcript, /disabled by the operator/);
    const state = await f.call('permissions.read', { projectId: f.project.id, assignmentId: a.id });
    assert.deepEqual(state.assignment.policy, locked);
    assert.equal((await f.call('assignments.show', { id: a.id })).state, 'needs_review');
  } finally { await f.close(); }
});

test('permission expansion requires releasing the current writer, including safely paused questions', async () => {
  const f = await fixture(); try {
    f.faux.appendResponses([fauxAssistantMessage(fauxToolCall('request_manager', { question: 'May I use networking?', context: null }), { stopReason: 'toolUse' })]);
    const a = (await f.call('workflow.submit', { id: f.workflow.id, task: 'Ask then pause', criteria: 'Pause' })).assignment;
    await f.call('assignments.wait', { id: a.id, timeoutMs: 10000 });
    for (const params of [{ projectId: f.project.id }, {}]) {
      const current = await f.call('permissions.read', params);
      await assert.rejects(f.call('permissions.set', { ...params, policy: locked, expectedRevision: current.revision }), /Stop and join/);
    }
    await f.call('workflow.stop', { id: f.workflow.id, note: 'Finish permission test' });
    const current = await f.call('permissions.read', { projectId: f.project.id });
    await f.call('permissions.set', { projectId: f.project.id, policy: locked, expectedRevision: current.revision });
  } finally { await f.close(); }
});

test('authenticated Chrome Settings saves user permissions and survives reload', { skip: !process.env.PDM_HOST_BROWSER_TEST }, async () => {
  const { chromium } = await import('playwright-core');
  const f = await fixture(); const viewer = await startTerminalBrowser({ stateDir: f.dir, rpc: { call: f.call } });
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage(); const url = new URL(viewer.operatorUrl); url.searchParams.set('workflowId', f.workflow.id);
    await page.goto(url.href); await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('#worker-permissions summary').click(); await page.locator('#permission-write').uncheck();
    await page.locator('#permission-network').uncheck(); await page.locator('#permission-exclusions').fill('private');
    await page.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await page.getByText('Permissions saved. The service records this policy on new assignments.').waitFor();
    const saved = await f.call('permissions.read', { projectId: f.project.id });
    assert.equal(saved.policy.writeFiles, false); assert.equal(saved.policy.shell, false); assert.equal(saved.policy.network, false); assert.deepEqual(saved.policy.excludedPaths, ['private']);
    await page.reload(); await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator("#permission-source").filter({hasText:"project"}).waitFor({state:"attached"});
    assert.equal(await page.locator('#permission-write').isChecked(), false);
  } finally { await browser.close(); await viewer.close(); await f.close(); }
});


test('policy changes refresh the next assignment without restart and preserve the prior snapshot',async()=>{
 const f=await fixture();try{
  const prior=await f.call('permissions.read',{projectId:f.project.id});
  await f.call('permissions.set',{projectId:f.project.id,expectedRevision:prior.revision,policy:locked});
  f.faux.appendResponses([fauxAssistantMessage('First policy recorded.')]);
  const first=(await f.call('workflow.submit',{id:f.workflow.id,task:'Observe only',criteria:'No edits'})).assignment;
  await f.call('assignments.wait',{id:first.id,timeoutMs:10000});
  await f.call('assignments.review',{id:first.id,decision:'accept',note:'Observed no edits in first policy test'});
  const before=await f.call('permissions.read',{projectId:f.project.id,assignmentId:first.id});
  await f.call('permissions.set',{projectId:f.project.id,expectedRevision:before.revision,policy:{...locked,writeFiles:true}});
  f.faux.appendResponses([fauxAssistantMessage(fauxToolCall('write',{path:'now-allowed.txt',content:'allowed'}),{stopReason:'toolUse'}),fauxAssistantMessage('Written under the new policy.')]);
  const second=(await f.call('workflow.submit',{id:f.workflow.id,task:'Write now-allowed.txt',criteria:'Exact allowed text'})).assignment;
  await f.call('assignments.wait',{id:second.id,timeoutMs:10000});assert.equal(await readFile(join(f.project.path,'now-allowed.txt'),'utf8'),'allowed');
  const after=await f.call('permissions.read',{projectId:f.project.id,assignmentId:first.id});assert.deepEqual(after.assignment,before.assignment);assert.equal(after.policy.writeFiles,true);
 }finally{await f.close();}
});
