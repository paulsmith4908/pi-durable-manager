import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildContentRules } from '../scripts/build-release.mjs';

function workspaceRules(root) {
  return buildContentRules(root).filter(rule => rule.what === 'personal workspace path fragment');
}

test('hosted runner checkout does not classify ordinary runner code as private', () => {
  const root = path.join('/', 'Users', 'runner', 'work', 'pi-durable-manager', 'pi-durable-manager');
  const code = 'this.runner.run(); // worker runner';
  assert.equal(workspaceRules(root).some(rule => rule.re.test(code)), false);
});

test('real workspace identifiers remain protected on a hosted runner', () => {
  const folder = ['Private', 'Client', 'Workspace'].join('');
  const root = path.join('/', 'Users', 'runner', 'work', folder, 'pi-durable-manager');
  assert.equal(workspaceRules(root).some(rule => rule.re.test(`checkout ${folder}`)), true);
});

test('generic runner allowance does not allow another personal home path', () => {
  const root = path.join('/', 'Users', 'runner', 'work', 'pi-durable-manager');
  const privatePath = path.join('/', 'Users', ['private', 'account'].join(''), 'Documents');
  const rule = buildContentRules(root).find(rule => rule.what === 'personal /Users/ path');
  const match = rule.re.exec(privatePath);
  assert.ok(match);
  assert.equal(rule.allow(match, privatePath), false);
});
