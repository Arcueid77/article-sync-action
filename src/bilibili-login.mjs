import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { fail, writeJson } from './core.mjs';
import { decimalId } from './bilibili.mjs';

const isBilibili = host => host === 'bilibili.com' || host.endsWith('.bilibili.com');

export function capturedBilibiliState(raw, mid) {
  if (!Array.isArray(raw?.cookies) || !Array.isArray(raw?.origins)) fail('AUTH_STATE_INVALID', 'Missing browser storage state.');
  const state = {
    cookies: raw.cookies.filter(cookie => typeof cookie.domain === 'string' && isBilibili(cookie.domain.replace(/^\./, '').toLowerCase())),
    origins: raw.origins.filter(item => { try { const u = new URL(item.origin); return u.protocol === 'https:' && u.origin === item.origin && isBilibili(u.hostname); } catch { return false; } }),
  };
  if (!state.cookies.some(cookie => cookie.name === 'SESSDATA' && cookie.value) || !state.cookies.some(cookie => cookie.name === 'DedeUserID' && cookie.value === mid)) fail('AUTH_STATE_INVALID', 'The captured session does not match the confirmed account.');
  return state;
}

export async function saveBilibiliLogin(raw, account, directory, expectedAuthor) {
  const mid = Number.isSafeInteger(account?.mid) ? String(account.mid) : account?.mid;
  if (!account?.isLogin || !decimalId(mid)) fail('AUTH_REQUIRED', 'The selected account has not logged in.');
  if (expectedAuthor && mid !== expectedAuthor) fail('AUTHOR_MISMATCH', 'The selected account differs from the expected UID.');
  const state = capturedBilibiliState(raw, mid);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const real = await fs.realpath(directory);
  let insideGit = false;
  try { insideGit = Boolean(execFileSync('git', ['-C', real, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { /* A private directory outside Git is expected. */ }
  if (insideGit) fail('AUTH_PATH_INVALID', 'Save authentication state outside every Git working tree.');
  const stateFile = path.join(real, 'storage-state.json');
  // A capture gets its own directory. Never overwrite another saved session.
  await fs.writeFile(stateFile, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  const identity = { mid, username: String(account.uname ?? ''), capturedAt: new Date().toISOString(), stateFile };
  await fs.writeFile(path.join(real, 'identity.json'), JSON.stringify(identity, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return identity;
}

export async function captureBilibiliLogin({ directory, author, timeout = 600_000, headed = false }) {
  directory = path.resolve(directory);
  if (author && !decimalId(author)) fail('ARGUMENT_INVALID', 'author must be an exact UID.');
  if (!Number.isSafeInteger(timeout) || timeout < 30_000 || timeout > 1_800_000) fail('ARGUMENT_INVALID', 'Login capture timeout must be between 30 seconds and 30 minutes.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let gitRoot;
  try { gitRoot = execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Private directory. */ }
  if (gitRoot) fail('AUTH_PATH_INVALID', 'Login artifacts must be outside Git.');
  const statusFile = path.join(directory, 'status.json');
  const refreshFile = path.join(directory, 'refresh-request.json');
  let browser, qrFile, lastQr;
  const status = (value, extra = {}) => writeJson(statusFile, { status: value, pid: process.pid, updatedAt: new Date().toISOString(), ...(qrFile ? { qrFile } : {}), ...extra });
  try {
    await status('starting');
    browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto('https://passport.bilibili.com/login?gourl=https%3A%2F%2Fmember.bilibili.com%2F', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const deadline = Date.now() + timeout;
    let failures = 0;
    while (Date.now() < deadline) {
      try {
        const response = await context.request.get('https://api.bilibili.com/x/web-interface/nav', { timeout: 10_000 });
        if ([403, 412, 429].includes(response.status())) fail('WEBSITE_ACCESS_RESTRICTED', 'Bilibili refused the login check.');
        const user = await response.json();
        failures = 0;
        if (response.ok() && user.code === 0 && user.data?.isLogin) {
          const identity = await saveBilibiliLogin(await context.storageState(), user.data, directory, author);
          await status('authenticated', identity);
          console.log(`Bilibili login saved for UID ${identity.mid}.`);
          return identity;
        }
      } catch (error) {
        if (['WEBSITE_ACCESS_RESTRICTED', 'AUTHOR_MISMATCH', 'AUTH_STATE_INVALID', 'AUTH_PATH_INVALID', 'EEXIST'].includes(error.code)) throw error;
        if (++failures >= 3) fail('AUTH_CHECK_UNAVAILABLE', 'The account check failed three times.');
      }
      if (page.url().startsWith('https://passport.bilibili.com/')) {
        let requested = false;
        try { await fs.access(refreshFile); requested = true; await fs.unlink(refreshFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const refresh = page.getByText('点击刷新', { exact: true });
        if (await refresh.isVisible()) await refresh.click();
        else if (requested) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        const image = page.locator('img[src^="data:image"]').first();
        if (await image.count() && await image.isVisible()) {
          const source = await image.getAttribute('src');
          if (source !== lastQr && await image.evaluate(image => image.complete && image.naturalWidth >= 100)) {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const box = await image.boundingBox();
            qrFile = path.join(directory, `qr-${Date.now()}.png`);
            await page.screenshot({ path: qrFile, clip: { x: box.x - 14, y: box.y - 14, width: box.width + 28, height: box.height + 28 }, scale: 'device' });
            lastQr = source;
            await status('waiting_for_scan');
            console.log(`QR image: ${qrFile}`);
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    fail('AUTH_TIMEOUT', 'The login capture timed out.');
  } catch (error) {
    const code = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'AUTH_CAPTURE_FAILED';
    await status('failed', { code });
    throw Object.assign(new Error('Bilibili login capture failed.'), { code });
  } finally { if (browser) await browser.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { directory: { type: 'string' }, author: { type: 'string' }, timeout: { type: 'string', default: '600000' }, headed: { type: 'boolean', default: false } } });
    const root = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local/state');
    const directory = values.directory ?? path.join(root, 'ArticleSyncAction/bilibili/private', `capture-${Date.now()}`);
    await captureBilibiliLogin({ directory, author: values.author, timeout: Number(values.timeout), headed: values.headed });
  } catch (error) { console.error(error.code ?? 'AUTH_CAPTURE_FAILED'); process.exitCode = 1; }
}
