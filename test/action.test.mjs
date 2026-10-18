import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { actionInputs, assertTrustedEvent, isLatestDeployment, runAction } from '../src/action.mjs';

const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/blog', GITHUB_REF: 'refs/heads/trunk', GITHUB_EVENT_NAME: 'push' };
const event = { repository: { full_name: 'owner/blog', default_branch: 'trunk' } };

test('Action removes its temporary session when source validation fails', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'action-cleanup-'));
  const outputFile = path.join(directory, 'outputs');
  await fs.writeFile(path.join(directory, 'invalid.json'), '{}');
  const code = await runAction({ ...process.env, GITHUB_ACTIONS: 'false', GITHUB_OUTPUT: outputFile, RUNNER_TEMP: directory, SYNC_MODE: 'verify', SYNC_SOURCE_ROOT: directory, SYNC_CONFIG: 'invalid.json', ZHIHU_STORAGE_STATE: 'fixture-session-that-must-not-be-retained' });
  assert.equal(code, 1);
  const output = (await fs.readFile(outputFile, 'utf8')).match(/^output-directory=(.+)$/m)[1];
  await assert.rejects(fs.access(path.join(path.dirname(output), 'private/state.json')), { code: 'ENOENT' });
  const report = await fs.readFile(path.join(output, 'report.json'), 'utf8');
  assert.ok(!report.includes('fixture-session'));
  assert.equal(JSON.parse(report).status, 'failed');
});

test('Action defaults to offline plan and validates arguments before using credentials', () => {
  assert.equal(actionInputs({}).mode, 'plan');
  for (const values of [{ SYNC_MODE: 'publish-anything' }, { SYNC_ARTICLE: 'a; echo secret' }, { SYNC_EXPECTED_SHA: 'main' }, { SYNC_CONFIG: 'bad\npath' }]) assert.throws(() => actionInputs(values), { code: 'ARGUMENT_INVALID' });
});

test('deployment freshness is rechecked after setup without leaking transport errors', async () => {
  const workflowEnv = { ...env, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_TOKEN: 'test-token' };
  const workflowEvent = { ...event, workflow_run: { id: 7, workflow_id: 42 } };
  assert.equal(await isLatestDeployment(workflowEnv, workflowEvent, async () => Response.json({ workflow_runs: [{ id: 7 }] })), true);
  assert.equal(await isLatestDeployment(workflowEnv, workflowEvent, async () => Response.json({ workflow_runs: [{ id: 8 }] })), false);
  await assert.rejects(isLatestDeployment(workflowEnv, workflowEvent, async () => { throw new Error('test-token'); }), error => error.code === 'DEPLOYMENT_STATE_UNAVAILABLE' && !error.message.includes('test-token'));
});

test('online modes require a trusted default-branch event, including upstream workflows', () => {
  assert.doesNotThrow(() => assertTrustedEvent(env, event, 'apply'));
  for (const overrides of [{ GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/dev/test' }, { GITHUB_REPOSITORY: 'fork/blog' }]) assert.throws(() => assertTrustedEvent({ ...env, ...overrides }, event, 'apply'), { code: 'UNTRUSTED_EVENT' });
  const workflowEnv = { ...env, GITHUB_EVENT_NAME: 'workflow_run' };
  assert.throws(() => assertTrustedEvent(workflowEnv, event, 'verify'), { code: 'UNTRUSTED_EVENT' });
  assert.doesNotThrow(() => assertTrustedEvent(workflowEnv, { ...event, workflow_run: { conclusion: 'success', head_branch: 'trunk', head_repository: { full_name: 'owner/blog' } } }, 'apply'));
  assert.doesNotThrow(() => assertTrustedEvent({ ...env, GITHUB_EVENT_NAME: 'pull_request' }, {}, 'plan'));
});
