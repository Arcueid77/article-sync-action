import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { fail } from './core.mjs';

const { values } = parseArgs({ options: { author: { type: 'string' }, output: { type: 'string' }, 'github-repo': { type: 'string' } } });
if (!/^[a-zA-Z0-9_-]+$/.test(values.author ?? '')) fail('CONFIG_INVALID', '--author must be your Zhihu profile URL token.');
const stateRoot = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local/state');
const output = path.resolve(values.output ?? path.join(stateRoot, 'ArticleSyncAction/zhihu/private/storage-state.json'));
let gitRoot;
try { gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* A project-independent capture is also supported. */ }
const normalizedOutput = output.toLowerCase();
const roots = [process.cwd(), gitRoot].filter(Boolean).map(root => path.resolve(root).toLowerCase());
if (normalizedOutput.includes(path.sep + '.git' + path.sep) || roots.some(root => normalizedOutput === root || normalizedOutput.startsWith(root + path.sep))) fail('AUTH_PATH_INVALID', 'Save authentication state outside the Git repository and working directory.');
await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto('https://www.zhihu.com/signin', { waitUntil: 'domcontentloaded' });
  console.log('请在打开的专用浏览器中手动登录知乎。程序会等待指定账号登录成功，最长 10 分钟；不会自动输入账号、密码或验证码。');
  await page.waitForFunction(async author => {
    try { const response = await fetch('/api/v4/me', { credentials: 'include' }); const user = await response.json(); return response.ok && user.url_token === author; } catch { return false; }
  }, values.author, { polling: 3000, timeout: 600_000 });
  const raw = await context.storageState();
  const state = {
    cookies: raw.cookies.filter(cookie => /^\.?([a-z0-9-]+\.)*zhihu\.com$/i.test(cookie.domain)),
    origins: raw.origins.filter(item => { const host = new URL(item.origin).hostname; return host === 'zhihu.com' || host.endsWith('.zhihu.com'); }),
  };
  if (!state.cookies.length) fail('AUTH_STATE_INVALID', 'No Zhihu session was captured.');
  const serialized = JSON.stringify(state);
  await fs.writeFile(output, serialized, { mode: 0o600 });
  if (values['github-repo']) {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(values['github-repo'])) fail('CONFIG_INVALID', 'Invalid GitHub repository.');
    await new Promise((resolve, reject) => {
      const child = spawn('gh', ['secret', 'set', 'ZHIHU_STORAGE_STATE', '--repo', values['github-repo']], { shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
      child.stdin.end(serialized);
      child.stderr.resume();
      child.on('error', () => reject(new Error('GitHub secret upload failed. The local state remains available.')));
      child.on('exit', code => code === 0 ? resolve() : reject(new Error('GitHub secret upload failed. The local state remains available.')));
    });
    console.log('已安全保存 GitHub Actions Secret：ZHIHU_STORAGE_STATE。');
  }
  console.log(`登录态已保存到：${output}（内容不会打印）。`);
} catch (error) {
  console.error(error.code ?? 'AUTH_CAPTURE_FAILED');
  process.exitCode = 1;
} finally { await browser.close(); }
