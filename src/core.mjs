import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { load } from 'cheerio';
import { parse } from 'yaml';
import { fail } from './errors.mjs';
import { sourceSettings, checkedDirectory, inside } from './source.mjs';

export { SyncError, fail } from './errors.mjs';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const articleUrl = id => `https://zhuanlan.zhihu.com/p/${id}`;
export const columnUrl = id => `https://www.zhihu.com/column/${id}`;
export const normalizeText = value => String(value).normalize('NFC').replace(/[\s\u200B-\u200D\uFEFF]/gu, '');
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const displayTitle = (data, config = {}) => data.seriesOrder === undefined || sourceSettings(config).seriesTitle === 'plain' ? data.title : `${sourceSettings(config).seriesTitle === 'hex' ? '0x' + data.seriesOrder.toString(16).toUpperCase().padStart(2, '0') : data.seriesOrder}：${data.title}`;

export function validateConfig(config) {
  sourceSettings(config);
  if (config.version !== 1 || !config.articles || !config.columns) fail('CONFIG_INVALID', 'Invalid synchronization configuration.');
  if (!/^[a-zA-Z0-9_-]+$/.test(config.authorUrlToken ?? '')) fail('CONFIG_INVALID', 'Expected author URL token is required.');
  const base = new URL(config.blogUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/') fail('CONFIG_INVALID', 'blogUrl must be an HTTPS origin.');
  const ids = new Set();
  for (const [slug, entry] of Object.entries(config.articles)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || typeof entry.id !== 'string' || !/^\d{5,30}$/.test(entry.id)) fail('CONFIG_INVALID', 'Article IDs must be decimal strings and slugs must be safe filenames.');
    if (ids.has(entry.id)) fail('CONFIG_INVALID', 'Two source articles cannot target the same Zhihu article.');
    ids.add(entry.id);
    if (typeof entry.enabled !== 'boolean' || typeof entry.published !== 'boolean') fail('CONFIG_INVALID', 'Article status flags must be explicit.');
    if (entry.column && !config.columns[entry.column]) fail('CONFIG_INVALID', 'Article references an unknown column.');
  }
  for (const column of Object.values(config.columns)) {
    if (!/^c_\d+$/.test(column.id) || !column.title) fail('CONFIG_INVALID', 'Invalid Zhihu column mapping.');
  }
  if (config.richTableMode !== undefined && !['rows', 'notes'].includes(config.richTableMode)) fail('CONFIG_INVALID', 'Unsupported rich table conversion mode.');
  if (config.newArticles) {
    if (typeof config.newArticles.enabled !== 'boolean' || !/^dev\/[a-z0-9-]+$/.test(config.newArticles.stateBranch ?? '')) fail('CONFIG_INVALID', 'New articles require an explicit setting and dedicated state branch.');
    if (config.newArticles.stateFile !== undefined && !/^[a-z][a-z0-9-]*\.json$/.test(config.newArticles.stateFile)) fail('CONFIG_INVALID', 'The state filename must be a plain JSON basename.');
    for (const [series, column] of Object.entries(config.newArticles.seriesColumns ?? {})) if (!/^[a-z0-9-]+$/.test(series) || !config.columns[column]) fail('CONFIG_INVALID', 'New article series needs a configured column.');
    if (!['无声明', '包含 AI 辅助创作 作者对内容负责'].includes(config.newArticles.declaration)) fail('CONFIG_INVALID', 'New article creation statement must be explicit.');
  }
  return config;
}

export async function loadArticles(sourceRoot, config = {}) {
  const directory = await checkedDirectory(sourceRoot, sourceSettings(config).articlesDir);
  const articles = new Map();
  for (const name of (await fs.readdir(directory, { recursive: true })).filter(name => name.endsWith('.md')).sort()) {
    const sourcePath = path.join(directory, name);
    if (!inside(await fs.realpath(sourcePath), directory)) fail('SOURCE_PATH_ESCAPE', 'An article resolves outside the article directory.');
    const raw = await fs.readFile(sourcePath, 'utf8');
    const match = raw.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) fail('SOURCE_INVALID', `${name}: YAML frontmatter is missing.`);
    const data = parse(match[1], { maxAliasCount: 10 });
    if (typeof data?.title !== 'string' || !data.title.trim() || (data.description !== undefined && typeof data.description !== 'string')) fail('SOURCE_INVALID', `${name}: title must be nonempty; description must be a string when provided.`);
    data.description ??= '';
    if (data.seriesOrder !== undefined && (!Number.isInteger(data.seriesOrder) || data.seriesOrder < 0)) fail('SOURCE_INVALID', `${name}: invalid series order.`);
    if ((data.series === undefined) !== (data.seriesOrder === undefined)) fail('SOURCE_INVALID', `${name}: series and seriesOrder must be set together.`);
    if (data.draft !== undefined && typeof data.draft !== 'boolean') fail('SOURCE_INVALID', `${name}: draft must be boolean.`);
    if (data.zhihu !== undefined && typeof data.zhihu !== 'boolean') fail('SOURCE_INVALID', `${name}: zhihu must be boolean.`);
    const slug = path.basename(name, '.md');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || articles.has(slug)) fail('SOURCE_INVALID', 'Markdown filenames must have unique lowercase slugs across all directories.');
    articles.set(slug, { slug, data, body: match[2], raw, sourcePath, sourceHash: sha256(raw) });
  }
  return articles;
}

export function rewriteLink(href, config, articles, { allowPendingLinks = false } = {}) {
  if (!href || href.startsWith('#')) fail('UNSUPPORTED_ANCHOR', 'Local heading anchors cannot be mapped reliably to Zhihu.');
  const url = new URL(href, config.blogUrl);
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) fail('UNSAFE_LINK', 'Unsupported or credential-bearing article link.');
  if (url.origin === new URL(config.blogUrl).origin) {
    const settings = sourceSettings(config);
    const suffix = url.pathname.startsWith(settings.articlePath) ? url.pathname.slice(settings.articlePath.length).replace(/\/$/, '') : '';
    const matched = suffix && !suffix.includes('/') ? [null, suffix] : null;
    if (matched) {
      const slug = decodeURIComponent(matched[1]);
      const target = config.articles[slug];
      if (!articles.has(slug) || articles.get(slug).data.draft) fail('MAPPING_REQUIRED', `A published Zhihu mapping is required for ${slug}.`);
      if (url.hash) fail('UNSUPPORTED_ANCHOR', `Article anchor requires manual mapping: ${slug}.`);
      if (!target?.published) {
        if (allowPendingLinks) return url.href;
        fail('MAPPING_REQUIRED', `A published Zhihu mapping is required for ${slug}.`);
      }
      return articleUrl(target.id);
    }
    const seriesSuffix = url.pathname.startsWith(settings.seriesPath) ? url.pathname.slice(settings.seriesPath.length).replace(/\/$/, '') : '';
    const series = seriesSuffix && !seriesSuffix.includes('/') ? [null, seriesSuffix] : null;
    if (series) {
      const column = config.columns[decodeURIComponent(series[1])];
      if (!column) fail('MAPPING_REQUIRED', 'A Zhihu column mapping is required.');
      return columnUrl(column.id);
    }
  }
  return url.href;
}

function appendNavigation($, article, config, articles) {
  const binding = config.articles[article.slug];
  if (!binding.column) return;
  const series = [...articles.values()].filter(item => !item.data.draft && item.data.series === article.data.series && (item.slug === article.slug || config.articles[item.slug]?.published) && config.articles[item.slug].column === binding.column).sort((a, b) => a.data.seriesOrder - b.data.seriesOrder);
  if (new Set(series.map(item => item.data.seriesOrder)).size !== series.length) fail('SOURCE_INVALID', 'Duplicate series order in a Zhihu column.');
  const index = series.findIndex(item => item.slug === article.slug);
  if (index < 0) fail('CONFIG_INVALID', 'The article is not in its configured series.');
  const column = config.columns[binding.column];
  const links = [];
  if (index > 0) links.push(`<a href="${articleUrl(config.articles[series[index - 1].slug].id)}">上一篇：${escapeHtml(displayTitle(series[index - 1].data, config))}</a>`);
  links.push(`<a href="${columnUrl(column.id)}">专栏目录：${escapeHtml(column.title)}</a>`);
  if (index + 1 < series.length) links.push(`<a href="${articleUrl(config.articles[series[index + 1].slug].id)}">下一篇：${escapeHtml(displayTitle(series[index + 1].data, config))}</a>`);
  $.root().append(`<hr><p>${links.join('<br>')}</p>`);
}

const allowedTags = new Set('p a img figure figcaption blockquote h2 h3 strong b em i del s ul ol li pre code hr br table thead tbody tfoot tr th td sup sub'.split(' '));
const permittedAttributes = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start']);

export function renderArticle(article, config, articles, { allowNew = false, allowPendingLinks = false } = {}) {
  const binding = config.articles[article.slug];
  if (!binding || (!binding.published && !allowNew)) fail('MAPPING_REQUIRED', 'A published mapping or an explicit new-article plan is required.');
  if (article.data.draft) fail('SOURCE_DRAFT', 'Draft articles are not synchronized.');
  const title = displayTitle(article.data, config);
  if ([...title].length > 100) fail('TITLE_TOO_LONG', 'Zhihu titles must fit in 100 characters; automatic truncation is disabled.');
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false });
  const $ = load(md.render(article.body), null, false);
  const notices = [];
  if ($('script,iframe,video,audio,object,embed,form,input,textarea,button,svg,math').length) fail('UNSUPPORTED_FORMAT', 'Embedded applications, scripts, media players or inline SVG/Math require an explicit conversion.');
  if ($('h1,h4,h5,h6').length) fail('UNSUPPORTED_FORMAT', 'Only body heading levels ## and ### are supported; no silent heading flattening.');
  if ($('style').length) { $('style').remove(); notices.push('Website-only CSS omitted.'); }
  $('details').each((_, details) => {
    const summary = $(details).children('summary').first();
    if (summary.length) summary.replaceWith(`<p><strong>${escapeHtml(summary.text())}</strong></p>`);
    $(details).replaceWith($(details).contents());
    notices.push('Collapsible section expanded for Zhihu.');
  });
  $('picture').each((_, picture) => {
    const image = $(picture).find('img').first();
    if (!image.length) fail('ASSET_INVALID', 'A picture element has no fallback image.');
    const compact = $(picture).find('source[media*="max-width"]').first().attr('srcset');
    if (compact) { image.attr('src', compact.split(',')[0].trim().split(/\s+/)[0]); notices.push('Responsive image uses its compact variant for Zhihu.'); }
    $(picture).replaceWith(image);
  });
  $('div,section,span').each((_, element) => $(element).replaceWith($(element).contents()));
  $('a').has('img').each((_, element) => {
    const anchor = $(element), images = anchor.find('img');
    if (images.length !== 1 || normalizeText(anchor.text()) || anchor.children().length !== 1 || !anchor.children().first().is('img')) fail('UNSUPPORTED_FORMAT', 'A linked image must have a separate text link.');
    const image = images.first();
    const link = `<p><a href="${escapeHtml(anchor.attr('href') ?? '')}">查看原图</a></p>`;
    const figure = anchor.closest('figure');
    if (figure.length) { anchor.replaceWith(image); figure.after(link); }
    else if (anchor.parent().is('p') && !normalizeText(anchor.parent().text()) && anchor.parent().find('img').length === 1) anchor.parent().replaceWith(`<figure>${image.toString()}</figure>${link}`);
    else if (anchor.parent()[0]?.type === 'root') anchor.replaceWith(`<figure>${image.toString()}</figure>${link}`);
    else fail('UNSUPPORTED_FORMAT', 'Mixed inline image links need an explicit conversion.');
    notices.push('Linked image retains its target as a separate original-image text link.');
  });
  if (config.richTableMode) $('table').each((_, table) => {
    const rich = 'a,code,strong,b,em,i,del,s,img';
    if (!$(table).find(rich).length) return;
    if ($(table).find('table,[colspan]:not([colspan="1"]),[rowspan]:not([rowspan="1"])').length) fail('UNSUPPORTED_FORMAT', 'Rich nested or merged tables need an explicit conversion.');
    const rows = $(table).find('tr').toArray();
    const first = $(rows[0]).children('th,td').toArray();
    const hasHeader = first.length > 0 && first.every(cell => cell.tagName === 'th');
    const headers = hasHeader ? first.map(cell => $(cell).html()) : [];
    const dataRows = hasHeader ? rows.slice(1) : rows;
    if (config.richTableMode === 'rows') {
      const items = dataRows.map(row => '<li>' + $(row).children('th,td').toArray().map((cell, index) => {
        if ($(cell).find('p,pre,ul,ol').length) fail('UNSUPPORTED_FORMAT', 'Block content inside a rich table cell needs manual conversion.');
        return `<p>${headers[index] ? `<strong>${headers[index]}</strong>：` : ''}${$(cell).html()}</p>`;
      }).join('') + '</li>');
      $(table).replaceWith(`<ul>${items.join('')}</ul>`);
      notices.push('Rich table expanded into row items to preserve links and inline formatting.');
    } else {
      const notes = [];
      dataRows.forEach((row, rowIndex) => $(row).children('th,td').each((index, cell) => {
        if ($(cell).find(rich).length) notes.push(`<p>第 ${rowIndex + 1} 行${headers[index] ? ` · ${headers[index]}` : ''}：${$(cell).html()}</p>`);
      }));
      $(table).after(notes.join(''));
      $(table).find(rich).each((_, element) => $(element).replaceWith(element.tagName === 'img' ? escapeHtml($(element).attr('alt') ?? '') : $(element).contents()));
      notices.push('Rich table retained as plain cells with linked and formatted details after the table.');
    }
  });
  $('*').each((_, element) => {
    if (!allowedTags.has(element.tagName)) fail('UNSUPPORTED_FORMAT', `Unsupported HTML element: ${element.tagName}.`);
    for (const key of Object.keys(element.attribs ?? {})) {
      if (key === 'class' && element.tagName === 'code' && /^language-[a-z0-9+-]+$/i.test(element.attribs[key])) continue;
      if (!permittedAttributes.has(key)) $(element).removeAttr(key);
    }
  });
  // Keep description as a single, separate subtitle instead of duplicating it in the title.
  const first = $.root().children().first();
  if (article.data.description && !(first.is('blockquote') && normalizeText(first.text()) === normalizeText(article.data.description))) {
    $.root().prepend(`<blockquote><p>${escapeHtml(article.data.description)}</p></blockquote>`);
  }
  $('a').each((_, element) => $(element).attr('href', rewriteLink($(element).attr('href'), config, articles, { allowPendingLinks })));
  const assets = [];
  $('img').each((index, element) => {
    const source = $(element).attr('src');
    if (!source) fail('ASSET_INVALID', 'An image has no source.');
    const key = `asset-${index}`;
    assets.push({ key, source, alt: $(element).attr('alt') ?? '' });
    $(element).attr('src', `https://asset.invalid/${key}`);
  });
  appendNavigation($, article, config, articles);
  if (binding.sourceUrl) $.root().append(`<hr><p>原文：<a href="${escapeHtml(binding.sourceUrl)}">博客原文</a></p>`);
  return { slug: article.slug, id: binding.id, url: binding.id ? articleUrl(binding.id) : undefined, column: binding.column ? config.columns[binding.column] : undefined, authorUrlToken: config.authorUrlToken, title, html: $.html(), assets, notices, sourcePath: article.sourcePath, sourceHash: article.sourceHash };
}

export function materializeImages(html, uploaded) {
  const $ = load(html, null, false);
  $('img').each((_, element) => {
    const key = new URL($(element).attr('src')).pathname.slice(1);
    const url = uploaded[key];
    if (!isZhihuImage(url)) fail('ASSET_NOT_UPLOADED', 'Every image must resolve to a validated Zhihu CDN URL.');
    $(element).attr('src', url);
  });
  return $.html();
}

export function isZhihuImage(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && (u.hostname === 'zhimg.com' || u.hostname.endsWith('.zhimg.com') || u.hostname === 'pic-private.zhihu.com'); } catch { return false; }
}

export function redactImageUrls(value) {
  if (typeof value === 'string') return value.replace(/https:\/\/pic-private\.zhihu\.com\/[^\s"'<>\\]*/gi, url => url.split('?')[0]);
  if (Array.isArray(value)) return value.map(redactImageUrls);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactImageUrls(item)]));
  return value;
}

export function validImageReference(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['imageId', 'imageHash', 'variants'].includes(key))
    && /^v2-[a-z0-9]+$/i.test(value.imageHash ?? '')
    && (value.imageId === undefined || (typeof value.imageId === 'string' && /^\d{5,30}$/.test(value.imageId)))
    && (value.variants === undefined || (Array.isArray(value.variants) && value.variants.length <= 10 && value.variants.every(hash => /^v2-[a-z0-9]+$/i.test(hash)))));
}

export function normalizeLink(value) {
  const url = new URL(value, 'https://zhuanlan.zhihu.com');
  if (url.hostname === 'zhida.zhihu.com') return null; // Zhihu's automatically added entity links do not change the author's text.
  if (url.hostname === 'link.zhihu.com' && url.searchParams.has('target')) return normalizeLink(url.searchParams.get('target'));
  return url.href.replace(/\/$/, '');
}

export function imageIdentity(value) {
  if (!isZhihuImage(value)) return null;
  const url = new URL(value);
  return url.pathname.match(/v2-[a-z0-9]+/i)?.[0] ?? url.pathname;
}

export function describeHtml(html) {
  const $ = load(html, null, false);
  $('figcaption.is-placeholder,.public-DraftEditorPlaceholder-root').remove();
  // Zhihu serializes authored captions on the image, then renders figcaption in
  // the editor. Compare the same visible caption without duplicating real nodes.
  const explicitCaptions = new Set($('figure').has('figcaption').toArray());
  $('img[data-caption]').each((_, image) => {
    const caption = $(image).attr('data-caption');
    const figure = $(image).closest('figure');
    if (!caption || !normalizeText(caption) || (figure.length && explicitCaptions.has(figure[0])) || $(image).next().is('figcaption')) return;
    const text = $('<figcaption>').text(caption);
    if (figure.length && figure.find('img').length === 1) figure.append(text); else $(image).after(text);
  });
  const all = selector => $(selector).toArray();
  const formats = { bold: '', italic: '', inlineCode: '', strike: '' };
  const walk = (node, flags = {}, inPre = false) => {
    const tag = node.tagName;
    const style = node.attribs?.style ?? '';
    const pre = inPre || tag === 'pre';
    const next = {
      bold: flags.bold || ['strong', 'b'].includes(tag) || /font-weight:\s*(bold|[6-9]00)/i.test(style),
      italic: flags.italic || ['em', 'i'].includes(tag) || /font-style:\s*italic/i.test(style),
      inlineCode: !pre && (flags.inlineCode || tag === 'code' || /font-family:[^;]*monospace/i.test(style)),
      strike: flags.strike || ['del', 's'].includes(tag) || /text-decoration[^;]*line-through/i.test(style),
    };
    if (node.type === 'text') for (const key of Object.keys(formats)) if (next[key]) formats[key] += normalizeText(node.data);
    for (const child of node.children ?? []) walk(child, next, pre);
  };
  walk($.root()[0]);
  return {
    text: normalizeText($.root().text()),
    headings: all('h1,h2,h3,h4,h5,h6').map(el => [el.tagName, normalizeText($(el).text())]),
    code: all('pre').filter(el => !$(el).find('pre').length).map(el => $(el).text().replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trimEnd()),
    links: all('a').map(el => normalizeLink($(el).attr('href') ?? '')).filter(Boolean),
    images: all('img').map(el => $(el).attr('src')),
    tables: all('table').map(table => $(table).find('tr').toArray().map(row => $(row).children('th,td').toArray().map(cell => [normalizeText($(cell).text()), $(cell).attr('colspan') ?? '1', $(cell).attr('rowspan') ?? '1']))),
    subtitles: all('blockquote').map(el => normalizeText($(el).text())),
    lists: all('ul,ol').map(el => [el.tagName, $(el).attr('start') ?? '1', $(el).children('li').length]),
    formats,
  };
}

export function compareArticle(expected, actual) {
  const a = describeHtml(expected.html);
  const b = describeHtml(actual.html);
  const checks = { title: expected.title === actual.title };
  for (const key of ['text', 'headings', 'code', 'links', 'tables', 'subtitles', 'lists', 'formats']) checks[key] = JSON.stringify(a[key]) === JSON.stringify(b[key]);
  // CDN derivatives can change suffix/size; exact asset bytes are checked before upload and every displayed image must load.
  const identity = value => expected.imageAliases?.[imageIdentity(value)] ?? imageIdentity(value);
  checks.images = a.images.length === b.images.length && b.images.every(isZhihuImage) && JSON.stringify(a.images.map(identity)) === JSON.stringify(b.images.map(identity)) && (actual.imagesLoaded ?? true);
  return { ok: Object.values(checks).every(Boolean), checks, counts: { headings: a.headings.length, code: a.code.length, links: a.links.length, images: a.images.length, tables: a.tables.length } };
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(redactImageUrls(value), null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
}
