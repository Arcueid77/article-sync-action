import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { load } from 'cheerio';
import { loadArticles, writeJson, fail } from './core.mjs';
import { sourceSettings } from './source.mjs';
import { FileRegistry, GitHubRegistry } from './registry.mjs';
import { launchSession } from './browser.mjs';
import { validateBilibiliConfig, emptyBilibiliRegistry, validateBilibiliRegistry, effectiveBilibiliConfig, renderBilibiliArticle, prepareBilibiliAsset } from './bilibili.mjs';
import { BilibiliEditor } from './bilibili-browser.mjs';
import { synchronizeBilibili } from './bilibili-sync.mjs';

const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'plan' }, article: { type: 'string', default: 'all' },
  'source-root': { type: 'string', default: process.cwd() }, config: { type: 'string', default: 'article-sync.json' },
  output: { type: 'string' }, cache: { type: 'string' }, 'state-file': { type: 'string' }, registry: { type: 'string' },
  'expected-sha': { type: 'string' }, headed: { type: 'boolean', default: false },
} });
if (!['plan', 'verify', 'draft', 'apply'].includes(values.mode) || values.article !== 'all' && !/^[a-z0-9][a-z0-9-]*$/.test(values.article)) fail('ARGUMENT_INVALID', 'Invalid Bilibili mode or article selection.');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-sync-'));
const output = path.resolve(values.output ?? path.join(work, 'output'));
const sourceRoot = path.resolve(values['source-root']);
const report = { version: 1, platform: 'bilibili', mode: values.mode, policy: 'blog_wins_on_every_trigger', status: 'running', articles: [] };
let session, registry;
try {
  const config = validateBilibiliConfig(JSON.parse(await fs.readFile(path.resolve(sourceRoot, values.config), 'utf8')));
  if (values.mode === 'apply' && config.allowPublish !== true) fail('PUBLISH_DISABLED', 'Bilibili publication requires allowPublish: true after validating the native editor and publication form. Use draft mode first.');
  const articles = await loadArticles(sourceRoot, config);
  let sourceCommit;
  try { sourceCommit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { if (values.mode !== 'plan') fail('SOURCE_REVISION_REQUIRED', 'Online modes require a committed source checkout.'); }
  report.sourceCommit = sourceCommit;
  if (values['expected-sha'] && sourceCommit !== values['expected-sha']) fail('SOURCE_REVISION_MISMATCH', 'Source revision does not match.');
  if (['draft', 'apply'].includes(values.mode)) {
    const dirty = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=all', '--', sourceSettings(config).articlesDir, ...sourceSettings(config).assetDirs, path.resolve(sourceRoot, values.config)], { encoding: 'utf8' }).trim();
    if (dirty) fail('SOURCE_DIRTY', 'Commit the source, assets and configuration before modifying Bilibili drafts.');
  }
  const validation = { validate: validateBilibiliRegistry, empty: emptyBilibiliRegistry };
  const store = values.mode !== 'plan' && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY ? new GitHubRegistry(config, { ...validation, repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN }) : new FileRegistry(values.registry, config, validation);
  registry = await store.load();
  const effective = effectiveBilibiliConfig(config, registry, articles);
  const slugs = values.article === 'all' ? Object.keys(effective.articles).filter(slug => effective.articles[slug].enabled && articles.has(slug)) : [values.article];
  if (!slugs.length) fail('MAPPING_REQUIRED', 'No Bilibili articles selected.');
  const items = [];
  for (const slug of slugs) {
    const article = articles.get(slug);
    if (!article || !effective.articles[slug]?.enabled) fail('ARTICLE_DISABLED', 'Selected article is missing or disabled.');
    if (article.data.draft || article.data.bilibili === false) { report.articles.push({ slug, status: 'skipped' }); continue; }
    const prepared = renderBilibiliArticle(article, effective, articles);
    const assets = [];
    for (const asset of prepared.assets) assets.push(await prepareBilibiliAsset(asset, prepared, sourceRoot, config, path.join(work, 'assets')));
    const directory = path.join(output, slug);
    await fs.mkdir(directory, { recursive: true });
    const preview = load(prepared.html, null, false);
    for (const asset of assets) preview(`img[src="https://asset.invalid/${asset.key}"]`).attr('src', `data:${path.extname(asset.file) === '.png' ? 'image/png' : 'image/jpeg'};base64,${(await fs.readFile(asset.file)).toString('base64')}`);
    await fs.writeFile(path.join(directory, 'preview.html'), '<!doctype html><meta charset="utf-8"><style>body{max-width:760px;margin:40px auto;font:16px/1.8 sans-serif;padding:0 20px}img{max-width:100%;height:auto}pre{white-space:pre-wrap;background:#eee;padding:16px}</style>' + preview.html());
    await writeJson(path.join(directory, 'plan.json'), { slug, title: prepared.title, sourceHash: prepared.sourceHash, notices: prepared.notices, images: assets.length });
    items.push({ prepared, assets });
  }
  if (values.mode === 'plan') report.articles.push(...items.map(({ prepared }) => ({ slug: prepared.slug, status: 'planned', id: prepared.id })));
  else {
    const stateFile = values['state-file'] ?? process.env.BILIBILI_STORAGE_STATE_FILE;
    if (!stateFile) fail('AUTH_REQUIRED', 'A dedicated Bilibili state file is required.');
    session = await launchSession(stateFile, { headed: values.headed, platform: 'bilibili' });
    await synchronizeBilibili({ config, registry, store, articles, items, mode: values.mode, editor: new BilibiliEditor(session.context), output, sourceCommit, report });
  }
  report.status = report.articles.some(article => article.status === 'failed') ? 'failed' : report.articles.some(article => article.status === 'different') ? 'different' : report.articles.some(article => ['review_pending', 'new_article'].includes(article.status)) ? 'pending' : 'success';
  if (['failed', 'different'].includes(report.status)) process.exitCode = 1;
} catch (error) { report.status = 'failed'; report.code = error.code ?? 'BILIBILI_SYNC_FAILED'; process.exitCode = 1; }
finally {
  if (session) await session.browser.close();
  if (registry) await writeJson(path.join(output, 'registry.json'), registry);
  await writeJson(path.join(output, 'report.json'), report);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, ['## Article Sync Action — Bilibili', `- Mode: ${report.mode}`, `- Result: ${report.status}`, ...report.articles.map(article => `- ${article.slug}: ${article.status}${article.code ? ' / ' + article.code : ''}`), report.code ? `- Error: ${report.code}` : ''].join('\n') + '\n');
  for (const article of report.articles) console.log(`${article.slug}: ${article.status}${article.code ? ' (' + article.code + ')' : ''}`);
  if (report.code) console.error(report.code);
  console.log(`Report: ${path.join(output, 'report.json')}`);
}
