import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { load } from 'cheerio';
import { loadArticles, renderArticle, validateConfig, writeJson, redactImageUrls, fail } from './core.mjs';
import { prepareAsset, readImageCache, saveImageCache } from './assets.mjs';
import { launchSession, ZhihuEditor } from './browser.mjs';
import { FileRegistry, GitHubRegistry, effectiveConfig } from './registry.mjs';
import { synchronize } from './synchronize.mjs';
import { sourceSettings } from './source.mjs';

const repository = process.cwd();
const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'plan' }, article: { type: 'string', default: 'all' },
  'source-root': { type: 'string', default: repository }, config: { type: 'string' },
  output: { type: 'string' }, cache: { type: 'string' }, 'state-file': { type: 'string' },
  'expected-sha': { type: 'string' }, headed: { type: 'boolean', default: false },
  registry: { type: 'string' },
} });
if (!['plan', 'verify', 'apply'].includes(values.mode)) fail('ARGUMENT_INVALID', 'mode must be plan, verify, or apply.');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-sync-'));
const output = path.resolve(values.output ?? path.join(work, 'output'));
const cacheFile = path.resolve(values.cache ?? path.join(work, 'cache/images.json'));
const sourceRoot = path.resolve(values['source-root']);
const report = { version: 1, mode: values.mode, policy: 'blog_wins_on_every_trigger', reader: 'website-article', status: 'running', articles: [] };
let session;
let registry;
try {
  const config = validateConfig(JSON.parse(await fs.readFile(path.resolve(sourceRoot, values.config ?? 'article-sync.json'), 'utf8')));
  const articles = await loadArticles(sourceRoot, config);
  let sourceSha;
  try { sourceSha = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { if (values.mode !== 'plan') fail('SOURCE_REVISION_REQUIRED', 'Online synchronization requires a Git source checkout.'); }
  report.sourceCommit = sourceSha;
  if (values['expected-sha'] && sourceSha !== values['expected-sha']) fail('SOURCE_REVISION_MISMATCH', 'The source checkout is not the successful deployment revision.');
  if (values.mode === 'apply') {
    const dirty = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=all', '--', sourceSettings(config).articlesDir, ...sourceSettings(config).assetDirs, path.resolve(sourceRoot, values.config ?? 'article-sync.json')], { encoding: 'utf8' }).trim();
    if (dirty) fail('SOURCE_DIRTY', 'Apply mode accepts only committed article and asset content. Use plan mode for local drafts.');
  }
  const store = values.mode !== 'plan' && config.newArticles && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY
    ? new GitHubRegistry(config, { repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN })
    : new FileRegistry(values.registry, config);
  registry = await store.load();
  const effective = effectiveConfig(config, registry, articles);
  let slugs = values.article === 'all'
    ? Object.keys(effective.articles).filter(slug => articles.has(slug) && (values.mode === 'plan' || effective.articles[slug].enabled))
    : [values.article];
  if (!slugs.length) fail('CONFIG_INVALID', 'No enabled articles selected.');
  const items = [];
  // Render and resolve all inputs before opening an authenticated browser.
  for (const slug of slugs) {
    const binding = effective.articles[slug];
    if (!binding || !articles.has(slug)) fail('MAPPING_REQUIRED', 'Selected article does not have both source content and a target mapping.');
    if (values.mode !== 'plan' && !binding.enabled) fail('ARTICLE_DISABLED', 'This article is not enabled for synchronization.');
    if (articles.get(slug).data.draft) { report.articles.push({ slug, status: 'skipped_draft' }); continue; }
    if (articles.get(slug).data.zhihu === false) { report.articles.push({ slug, status: 'skipped_opt_out' }); continue; }
    const prepared = renderArticle(articles.get(slug), effective, articles, { allowNew: !binding.published, allowPendingLinks: Boolean(config.newArticles?.enabled) });
    const assets = [];
    for (const asset of prepared.assets) assets.push(await prepareAsset(asset, prepared, sourceRoot, config, path.join(work, 'assets')));
    await fs.mkdir(path.join(output, slug), { recursive: true });
    await fs.writeFile(path.join(output, slug, 'source-rendered.html'), redactImageUrls(prepared.html));
    const preview = load(prepared.html, null, false);
    for (const asset of assets) {
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(asset.file)];
      preview(`img[src="https://asset.invalid/${asset.key}"]`).attr('src', `data:${mime};base64,${(await fs.readFile(asset.file)).toString('base64')}`);
    }
    await fs.writeFile(path.join(output, slug, 'preview.html'), '<!doctype html><meta charset="utf-8"><style>body{max-width:760px;margin:40px auto;padding:0 20px;font:16px/1.8 sans-serif}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#f4f4f4}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px}figcaption{color:#555}</style>' + redactImageUrls(preview.html()));
    await writeJson(path.join(output, slug, 'plan.json'), { slug, id: prepared.id, title: prepared.title, newArticle: !binding.published, sourceHash: prepared.sourceHash, notices: prepared.notices, assets: assets.map(({ key, hash, inputHash, width, height, convertedSvg, convertedBmp }) => ({ key, hash, inputHash, width, height, convertedSvg, convertedBmp })) });
    items.push({ prepared, assets });
  }
  if (values.mode === 'plan') {
    report.articles.push(...items.map(({ prepared, assets }) => ({ slug: prepared.slug, id: prepared.id, status: effective.articles[prepared.slug].published ? 'planned' : 'planned_new', images: assets.length, notices: prepared.notices })));
  } else {
    const stateFile = values['state-file'] ?? process.env.ZHIHU_STORAGE_STATE_FILE;
    if (!stateFile) fail('AUTH_REQUIRED', 'A dedicated Zhihu storage-state file is required.');
    session = await launchSession(stateFile, { headed: values.headed });
    const editor = new ZhihuEditor(session.context);
    const cache = await readImageCache(cacheFile);
    await synchronize({ config, registry, store, articles, items, mode: values.mode, editor, cache, saveCache: () => saveImageCache(cacheFile, cache), output, sourceCommit: sourceSha, report });
    for (const result of report.articles) console.log(`${result.slug}: ${result.status}${result.code ? ' (' + result.code + ')' : ''}`);
    await saveImageCache(cacheFile, cache);
  }
  report.status = report.articles.some(item => item.status === 'failed') ? 'failed' : 'success';
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) {
  report.status = 'failed';
  report.code = error.code ?? 'SYNC_FAILED';
  console.error(report.code);
  process.exitCode = 1;
} finally {
  if (session) await session.browser.close();
  if (registry) await writeJson(path.join(output, 'registry.json'), registry);
  await writeJson(path.join(output, 'report.json'), report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['## Article Sync Action — Zhihu', `- Mode: ${report.mode}`, `- Reader: ${report.reader}`, `- Result: ${report.status}`, `- Source: ${report.sourceCommit ?? 'unavailable'}`, ...report.articles.map(item => `- ${item.slug}: ${item.status}${item.code ? ' / ' + item.code : ''}`)];
    if (report.code) lines.push(`- Error: ${report.code}`);
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  console.log(`Report: ${path.join(output, 'report.json')}`);
}
