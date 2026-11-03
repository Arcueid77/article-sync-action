import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { load } from 'cheerio';
import { renderArticle, describeHtml, displayTitle, escapeHtml, sha256, fail } from './core.mjs';
import { sourceSettings, publicSourceUrl } from './source.mjs';
import { prepareAsset } from './assets.mjs';

export const decimalId = value => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value);
export function publicBilibiliUrl(value) {
  try { const u = new URL(value); return u.origin === 'https://www.bilibili.com' && /^\/(?:read\/cv[1-9]\d*|opus\/[1-9]\d*)\/?$/.test(u.pathname) && !u.search && !u.hash; } catch { return false; }
}
export function bilibiliImageUrl(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port || !['hdslb.com', 'biliimg.com'].some(host => u.hostname.endsWith('.' + host))) return null;
    const pathname = u.pathname.split('@')[0];
    if (!/^\/bfs\/(article|new_dyn|archive)\/[a-zA-Z0-9/_-]+\.(png|jpe?g|webp|gif)$/i.test(pathname)) return null;
    return `https://${u.hostname}${pathname}`;
  } catch { return null; }
}

export function validateBilibiliConfig(config) {
  sourceSettings(config);
  if (config.version !== 1 || config.platform !== 'bilibili' || !decimalId(config.authorMid) || !config.articles || Array.isArray(config.articles)) fail('CONFIG_INVALID', 'Bilibili requires a platform, expected authorMid and article mappings.');
  let base;
  try { base = new URL(config.blogUrl); } catch { fail('CONFIG_INVALID', 'blogUrl is invalid.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) fail('CONFIG_INVALID', 'blogUrl must be an HTTPS origin.');
  if (!Array.isArray(config.assetHosts) || config.assetHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host))) fail('CONFIG_INVALID', 'assetHosts must be an explicit hostname allowlist.');
  if (config.allowPublish !== undefined && typeof config.allowPublish !== 'boolean') fail('CONFIG_INVALID', 'allowPublish must be a boolean.');
  const ids = new Set();
  for (const [slug, entry] of Object.entries(config.articles)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || typeof entry.enabled !== 'boolean' || typeof entry.published !== 'boolean') fail('CONFIG_INVALID', 'Article enablement and publication flags must be explicit.');
    if (entry.id !== undefined && !decimalId(entry.id)) fail('CONFIG_INVALID', 'Article IDs must be exact decimal strings.');
    if (entry.id && ids.has(entry.id)) fail('CONFIG_INVALID', 'Two articles cannot share a Bilibili ID.');
    if (entry.id) ids.add(entry.id);
    if (entry.published && (!entry.id || !publicBilibiliUrl(entry.publicUrl))) fail('CONFIG_INVALID', 'Published articles need their verified Bilibili ID and public URL.');
    if (entry.publicUrl !== undefined && !publicBilibiliUrl(entry.publicUrl)) fail('CONFIG_INVALID', 'Invalid Bilibili public URL.');
    if (entry.title !== undefined && (typeof entry.title !== 'string' || !entry.title.trim())) fail('CONFIG_INVALID', 'A title override must be nonempty.');
  }
  if (!config.newArticles || typeof config.newArticles.enabled !== 'boolean' || !/^dev\/[a-z0-9-]+$/.test(config.newArticles.stateBranch ?? '') || !/^[a-z][a-z0-9-]*\.json$/.test(config.newArticles.stateFile ?? '')) fail('CONFIG_INVALID', 'A dedicated Bilibili state branch and JSON filename are required.');
  return config;
}

export const emptyBilibiliRegistry = config => ({ version: 1, platform: 'bilibili', blogUrl: config.blogUrl, authorMid: config.authorMid, articles: {} });
export function validateBilibiliRegistry(registry, config) {
  if (registry?.version !== 1 || registry.platform !== 'bilibili' || registry.blogUrl !== config.blogUrl || registry.authorMid !== config.authorMid || !registry.articles || Array.isArray(registry.articles)) fail('REGISTRY_INVALID', 'Bilibili registry owner, platform or schema does not match.');
  const ids = new Set();
  for (const [slug, entry] of Object.entries(registry.articles)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !['allocating', 'draft', 'submitting', 'review_pending', 'published'].includes(entry.stage) || entry.sourceUrl !== publicSourceUrl(config, slug)) fail('REGISTRY_INVALID', 'Invalid Bilibili article record.');
    if (entry.stage === 'allocating' ? entry.id !== null : !decimalId(entry.id)) fail('REGISTRY_INVALID', 'Invalid Bilibili article ID.');
    if (entry.id && ids.has(entry.id)) fail('REGISTRY_CONFLICT', 'Duplicate article ID.');
    if (entry.id) ids.add(entry.id);
    if (entry.publicUrl !== undefined && !publicBilibiliUrl(entry.publicUrl)) fail('REGISTRY_INVALID', 'Invalid public URL.');
    if (entry.stage === 'published' && !entry.publicUrl) fail('REGISTRY_INVALID', 'Published state requires a verified public URL.');
    if (['sourceHash', 'sourceCommit', 'renderHash'].some(key => entry[key] !== undefined && !new RegExp(key === 'sourceCommit' ? '^[a-f0-9]{40}$' : '^[a-f0-9]{64}$').test(entry[key]))) fail('REGISTRY_INVALID', 'Invalid revision or content hash.');
    if (Object.keys(entry).some(key => !['id', 'stage', 'sourceUrl', 'sourceHash', 'sourceCommit', 'renderHash', 'publicUrl', 'images'].includes(key))) fail('REGISTRY_INVALID', 'Unexpected registry field.');
    if (entry.images && (typeof entry.images !== 'object' || Array.isArray(entry.images) || Object.entries(entry.images).some(([hash, url]) => !/^[a-f0-9]{64}$/.test(hash) || bilibiliImageUrl(url) !== url))) fail('REGISTRY_INVALID', 'Image records must contain stable Bilibili CDN URLs only.');
    if (config.articles[slug]?.id && config.articles[slug].id !== entry.id) fail('REGISTRY_CONFLICT', 'Configured article ID conflicts with the registry.');
    if (entry.id && Object.entries(config.articles).some(([other, binding]) => other !== slug && binding.id === entry.id)) fail('REGISTRY_CONFLICT', 'An ID is assigned to another source article.');
  }
  return registry;
}

export function effectiveBilibiliConfig(config, registry, articles) {
  const result = structuredClone(config);
  for (const [slug, entry] of Object.entries(registry.articles)) {
    if (config.articles[slug]?.enabled === false) continue;
    result.articles[slug] = { ...result.articles[slug], id: entry.id ?? undefined, enabled: true, published: entry.stage === 'published', ...(entry.publicUrl ? { publicUrl: entry.publicUrl } : {}) };
  }
  if (config.newArticles.enabled) for (const [slug, article] of articles) {
    if (!result.articles[slug] && !article.data.draft && article.data.bilibili !== false) result.articles[slug] = { enabled: true, published: false };
  }
  return result;
}

function rewriteBilibiliLink(href, config, articles) {
  if (!href || href.startsWith('#')) fail('UNSUPPORTED_ANCHOR', 'Heading anchors require an explicit Bilibili conversion.');
  const u = new URL(href, config.blogUrl);
  if (!['https:', 'http:', 'mailto:'].includes(u.protocol) || u.username || u.password) fail('UNSAFE_LINK', 'Unsupported article link.');
  const settings = sourceSettings(config);
  if (u.origin === new URL(config.blogUrl).origin && u.pathname.startsWith(settings.articlePath)) {
    const slug = decodeURIComponent(u.pathname.slice(settings.articlePath.length).replace(/\/$/, ''));
    if (articles.get(slug)?.data.draft) fail('MAPPING_REQUIRED', 'A link points to an unpublished blog draft.');
    if (u.hash) fail('UNSUPPORTED_ANCHOR', 'An article anchor needs an explicit conversion.');
    const binding = config.articles[slug];
    if (binding?.published && binding.publicUrl) return binding.publicUrl;
  }
  return u.href;
}

function appendBilibiliNavigation($, article, config, articles) {
  if (!article.data.series) return;
  const members = [...articles.values()].filter(item => item.data.series === article.data.series && !item.data.draft && (item.slug === article.slug || config.articles[item.slug]?.published)).sort((a, b) => a.data.seriesOrder - b.data.seriesOrder);
  if (new Set(members.map(item => item.data.seriesOrder)).size !== members.length) fail('SOURCE_INVALID', 'Duplicate series order.');
  const i = members.findIndex(item => item.slug === article.slug);
  const links = [[members[i - 1], '上一篇'], [members[i + 1], '下一篇']].filter(([item]) => item && config.articles[item.slug]?.publicUrl).map(([item, label]) => `<a href="${escapeHtml(config.articles[item.slug].publicUrl)}">${label}：${escapeHtml(displayTitle(item.data, config))}</a>`);
  if (links.length) $.root().append(`<hr><p>${links.join('<br>')}</p>`);
}

export function renderBilibiliArticle(article, config, articles) {
  const binding = config.articles[article.slug];
  const prepared = renderArticle(article, { ...config, columns: {}, richTableMode: 'rows' }, articles, { allowNew: true, allowPendingLinks: true, target: { title: binding?.title ?? displayTitle(article.data, config), titleLimit: 40, rewriteLink: rewriteBilibiliLink, appendNavigation: appendBilibiliNavigation } });
  const $ = load(prepared.html, null, false);
  $('table').each((_, table) => {
    const rows = $(table).find('tr').toArray();
    const header = $(rows[0]).children('th').toArray().map(cell => $(cell).html());
    const data = header.length ? rows.slice(1) : rows;
    $(table).replaceWith('<ul>' + data.map(row => '<li>' + $(row).children('td,th').toArray().map((cell, i) => `<p>${header[i] ? `<strong>${header[i]}</strong>：` : ''}${$(cell).html()}</p>`).join('') + '</li>').join('') + '</ul>');
    prepared.notices.push('Table expanded into row items for Bilibili.');
  });
  if (!binding?.sourceUrl) $.root().append(`<hr><p>原文：<a href="${escapeHtml(publicSourceUrl(config, article.slug))}">博客原文</a></p>`);
  return { ...prepared, html: $.html(), authorMid: config.authorMid, url: binding?.publicUrl, notices: prepared.notices.map(value => value.replaceAll('Zhihu', 'Bilibili')) };
}

export async function prepareBilibiliAsset(asset, prepared, sourceRoot, config, directory) {
  let result = await prepareAsset(asset, prepared, sourceRoot, config, directory);
  const metadata = await sharp(result.file, { animated: true }).metadata();
  if (metadata.pages > 1) fail('ASSET_FORMAT', 'Animated images need an explicit Bilibili conversion.');
  if (!['png', 'jpeg'].includes(metadata.format)) {
    const bytes = await sharp(result.file).png().toBuffer();
    result = { ...result, hash: sha256(bytes), file: path.join(directory, sha256(bytes) + '.png') };
    await fs.writeFile(result.file, bytes);
  }
  if ((await fs.stat(result.file)).size > 5 * 1024 * 1024) fail('ASSET_SIZE', 'Bilibili images must not exceed 5 MiB.');
  return result;
}

export function materializeBilibiliImages(html, images) {
  const $ = load(html, null, false);
  $('img').each((_, image) => {
    const key = new URL($(image).attr('src')).pathname.slice(1);
    const url = bilibiliImageUrl(images[key]);
    if (!url) fail('ASSET_NOT_UPLOADED', 'Every image must be uploaded to the Bilibili CDN before saving.');
    $(image).attr('src', url);
  });
  return $.html();
}

export function compareBilibiliArticle(expected, actual) {
  const a = describeHtml(expected.html), b = describeHtml(actual.html);
  const checks = { title: expected.title === actual.title };
  for (const key of ['text', 'headings', 'code', 'links', 'tables', 'subtitles', 'lists', 'formats']) checks[key] = JSON.stringify(a[key]) === JSON.stringify(b[key]);
  const images = value => value.map(bilibiliImageUrl);
  checks.images = b.images.every(value => bilibiliImageUrl(value)) && JSON.stringify(images(a.images)) === JSON.stringify(images(b.images)) && actual.imagesLoaded !== false;
  return { ok: Object.values(checks).every(Boolean), checks };
}
