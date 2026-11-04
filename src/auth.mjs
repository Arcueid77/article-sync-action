import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { fail } from './core.mjs';

const { values } = parseArgs({ options: { platform: { type: 'string', default: 'zhihu' }, author: { type: 'string' }, output: { type: 'string' }, 'github-repo': { type: 'string' } } });
const platform = values.platform;
if (!['zhihu', 'bilibili'].includes(platform)) fail('CONFIG_INVALID', '--platform must be zhihu or bilibili.');
if (!(platform === 'bilibili' ? /^[1-9]\d{0,29}$/ : /^[a-zA-Z0-9_-]+$/).test(values.author ?? '')) fail('CONFIG_INVALID', '--author must match the selected platform account identifier.');
const domain = platform === 'bilibili' ? 'bilibili.com' : 'zhihu.com';
const onlyPlatform = host => host === domain || host.endsWith('.' + domain);
const secretName = platform === 'bilibili' ? 'BILIBILI_STORAGE_STATE' : 'ZHIHU_STORAGE_STATE';
const stateRoot = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local/state');
const output = path.resolve(values.output ?? path.join(stateRoot, `ArticleSyncAction/${platform}/private/storage-state.json`));
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
  await page.goto(platform === 'bilibili' ? 'https://member.bilibili.com/platform/upload/text' : 'https://www.zhihu.com/signin', { waitUntil: 'domcontentloaded' });
  console.log(`请在打开的专用浏览器中手动登录${platform === 'bilibili' ? 'B站' : '知乎'}。程序等待指定账号，最长 10 分钟；不会自动输入账号、密码或验证码。`);
  if (platform === 'bilibili') {
    let confirmed = false;
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      try {
        const response = await context.request.get('https://api.bilibili.com/x/web-interface/nav', { timeout: 10_000 });
        const user = await response.json();
        if (response.ok() && user.code === 0 && user.data?.isLogin && String(user.data.mid) === values.author) { confirmed = true; break; }
      } catch { /* Manual login remains pending. */ }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    if (!confirmed) fail('AUTH_REQUIRED', 'The expected Bilibili account did not log in before the timeout.');
  } else await page.waitForFunction(async author => {
    try { const response = await fetch('/api/v4/me', { credentials: 'include' }); const user = await response.json(); return response.ok && user.url_token === author; } catch { return false; }
  }, values.author, { polling: 3000, timeout: 600_000 });
  const raw = await context.storageState();
  const state = {
    cookies: raw.cookies.filter(cookie => onlyPlatform(cookie.domain.replace(/^\./, '').toLowerCase())),
    origins: raw.origins.filter(item => { const url = new URL(item.origin); return url.protocol === 'https:' && onlyPlatform(url.hostname); }),
  };
  if (!state.cookies.length) fail('AUTH_STATE_INVALID', 'No selected-platform session was captured.');
  const serialized = JSON.stringify(state);
  await fs.writeFile(output, serialized, { mode: 0o600 });
  if (values['github-repo']) {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(values['github-repo'])) fail('CONFIG_INVALID', 'Invalid GitHub repository.');
    await new Promise((resolve, reject) => {
      const child = spawn('gh', ['secret', 'set', secretName, '--repo', values['github-repo']], { shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
      child.stdin.end(serialized);
      child.stderr.resume();
      child.on('error', () => reject(new Error('GitHub secret upload failed. The local state remains available.')));
      child.on('exit', code => code === 0 ? resolve() : reject(new Error('GitHub secret upload failed. The local state remains available.')));
    });
    console.log(`已安全保存 GitHub Actions Secret：${secretName}。`);
  }
  console.log(`登录态已保存到：${output}（内容不会打印）。`);
} catch (error) {
  console.error(error.code ?? 'AUTH_CAPTURE_FAILED');
  process.exitCode = 1;
} finally { await browser.close(); }
