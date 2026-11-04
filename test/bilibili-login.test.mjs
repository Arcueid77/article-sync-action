import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { capturedBilibiliState, saveBilibiliLogin } from '../src/bilibili-login.mjs';

const state = () => ({ cookies: [
  { domain: '.bilibili.com', name: 'DedeUserID', value: '12345' },
  { domain: '.bilibili.com', name: 'SESSDATA', value: 'fixture-bili-session' },
  { domain: '.zhihu.com', name: 'other', value: 'fixture-foreign-session' },
], origins: [{ origin: 'https://member.bilibili.com', localStorage: [] }, { origin: 'https://evil.example', localStorage: [{ name: 'secret', value: 'foreign' }] }] });
const account = { mid: 12345, uname: 'fixture-author', isLogin: true };

test('login capture only persists the manually selected Bilibili account and strips foreign state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-capture-test-'));
  const identity = await saveBilibiliLogin(state(), account, directory);
  const saved = JSON.parse(await fs.readFile(identity.stateFile, 'utf8'));
  assert.equal(saved.cookies.length, 2); assert.equal(saved.origins.length, 1);
  assert.equal(identity.mid, '12345'); assert.equal(JSON.stringify(identity).includes('fixture-bili-session'), false);
  await assert.rejects(saveBilibiliLogin(state(), account, directory), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(await fs.readFile(identity.stateFile, 'utf8')), saved);
});

test('wrong author or mismatched browser session cannot create a saved login', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-capture-wrong-'));
  await assert.rejects(saveBilibiliLogin(state(), account, directory, '54321'), { code: 'AUTHOR_MISMATCH' });
  assert.throws(() => capturedBilibiliState(state(), '54321'), { code: 'AUTH_STATE_INVALID' });
  assert.throws(() => capturedBilibiliState({ cookies: [], origins: [] }, '12345'), { code: 'AUTH_STATE_INVALID' });
  await assert.rejects(fs.access(path.join(directory, 'storage-state.json')), { code: 'ENOENT' });
});

test('login credentials cannot be written into a Git working tree', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-capture-git-'));
  execFileSync('git', ['init', directory], { stdio: 'ignore' });
  await assert.rejects(saveBilibiliLogin(state(), account, directory), { code: 'AUTH_PATH_INVALID' });
  await assert.rejects(fs.access(path.join(directory, 'storage-state.json')), { code: 'ENOENT' });
});
