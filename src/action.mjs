import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { fail } from './errors.mjs';

export function actionInputs(env = process.env) {
  const mode = env.SYNC_MODE || 'plan';
  if (!['plan', 'verify', 'apply'].includes(mode)) fail('ARGUMENT_INVALID', 'Unsupported synchronization mode.');
  const article = env.SYNC_ARTICLE || 'all';
  if (article !== 'all' && !/^[a-z0-9][a-z0-9-]*$/.test(article)) fail('ARGUMENT_INVALID', 'Invalid article selection.');
  const sourceRoot = path.resolve(env.GITHUB_WORKSPACE || process.cwd(), env.SYNC_SOURCE_ROOT || '.');
  const config = path.resolve(sourceRoot, env.SYNC_CONFIG || 'article-sync.json');
  if ([sourceRoot, config].some(value => /[\r\n\0]/.test(value))) fail('ARGUMENT_INVALID', 'Invalid path.');
  const expectedSha = env.SYNC_EXPECTED_SHA || '';
  if (expectedSha && !/^[a-f0-9]{40}$/.test(expectedSha)) fail('ARGUMENT_INVALID', 'expected-sha must be a full commit SHA.');
  return { mode, article, sourceRoot, config, expectedSha };
}

export function assertTrustedEvent(env, event, mode) {
  if (mode === 'plan' || env.GITHUB_ACTIONS !== 'true') return;
  const branch = event.repository?.default_branch;
  if (!branch || event.repository?.full_name !== env.GITHUB_REPOSITORY || env.GITHUB_REF !== `refs/heads/${branch}` || !['push', 'workflow_dispatch', 'workflow_run', 'schedule'].includes(env.GITHUB_EVENT_NAME)) fail('UNTRUSTED_EVENT', 'Online synchronization only runs from the owning repository default branch.');
  if (env.GITHUB_EVENT_NAME === 'workflow_run' && (event.workflow_run?.conclusion !== 'success' || event.workflow_run?.head_branch !== branch || event.workflow_run?.head_repository?.full_name !== env.GITHUB_REPOSITORY)) fail('UNTRUSTED_EVENT', 'The upstream workflow must be a successful default-branch run in this repository.');
}

export async function isLatestDeployment(env, event, fetchImpl = fetch) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_run') return true;
  if (!env.GITHUB_TOKEN || !Number.isSafeInteger(event.workflow_run?.workflow_id)) fail('DEPLOYMENT_STATE_UNAVAILABLE', 'A token with actions read permission is required to verify the deployment.');
  const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${event.workflow_run.workflow_id}/runs?branch=${encodeURIComponent(event.repository.default_branch)}&status=success&per_page=1`;
  let data;
  try {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) fail('DEPLOYMENT_STATE_UNAVAILABLE', 'Cannot verify the newest successful deployment.');
    data = await response.json();
  } catch { fail('DEPLOYMENT_STATE_UNAVAILABLE', 'Cannot verify the newest successful deployment.'); }
  if (!Array.isArray(data.workflow_runs) || !data.workflow_runs.length) fail('DEPLOYMENT_STATE_UNAVAILABLE', 'No successful deployment was returned.');
  return data.workflow_runs[0].id === event.workflow_run.id;
}

export async function runAction(env = process.env) {
  const inputs = actionInputs(env);
  const event = env.GITHUB_ACTIONS === 'true' ? JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  assertTrustedEvent(env, event, inputs.mode);
  const directory = await fs.mkdtemp(path.join(env.RUNNER_TEMP || os.tmpdir(), 'article-sync-'));
  const output = path.join(directory, 'output');
  const stateFile = path.join(directory, 'private', 'state.json');
  if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, `output-directory=${output}\nreport=${path.join(output, 'report.json')}\n`);
  try {
    if (inputs.mode !== 'plan' && !await isLatestDeployment(env, event)) {
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ version: 1, status: 'skipped', code: 'STALE_DEPLOYMENT', articles: [] }, null, 2) + '\n');
      console.log('A newer deployment succeeded during setup; the old source was skipped.');
      return 0;
    }
    if (inputs.mode !== 'plan') {
      if (!env.ZHIHU_STORAGE_STATE) fail('AUTH_REQUIRED', 'ZHIHU_STORAGE_STATE is required for verify and apply.');
      await fs.mkdir(path.dirname(stateFile), { mode: 0o700 });
      await fs.writeFile(stateFile, env.ZHIHU_STORAGE_STATE, { mode: 0o600 });
    }
    const args = [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--mode', inputs.mode, '--article', inputs.article, '--source-root', inputs.sourceRoot, '--config', inputs.config, '--output', output, '--cache', path.join(directory, 'images.json')];
    if (inputs.expectedSha) args.push('--expected-sha', inputs.expectedSha);
    if (inputs.mode !== 'plan') args.push('--state-file', stateFile);
    const childEnv = { ...env };
    delete childEnv.ZHIHU_STORAGE_STATE;
    // plan must never use an inherited publication token or session.
    if (inputs.mode === 'plan') { delete childEnv.GITHUB_TOKEN; delete childEnv.ZHIHU_STORAGE_STATE_FILE; }
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { env: childEnv, stdio: 'inherit', shell: false });
      child.on('error', reject);
      child.on('exit', code => resolve(code ?? 1));
    });
  } finally {
    await fs.rm(stateFile, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runAction(); }
  catch (error) { console.error(error.code ?? 'ACTION_FAILED'); process.exitCode = 1; }
}
