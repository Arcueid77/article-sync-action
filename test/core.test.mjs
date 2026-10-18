import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { compareArticle, describeHtml, displayTitle, loadArticles, materializeImages, renderArticle, rewriteLink, validateConfig } from '../src/core.mjs';

const root = fileURLToPath(new URL('./fixtures/site/', import.meta.url));
const config = validateConfig(JSON.parse(await fs.readFile(path.join(root, 'article-sync.json'), 'utf8')));
const articles = await loadArticles(root, config);

test('existing long IDs remain strings and duplicate targets are rejected', () => {
  assert.equal(config.articles['series-00'].id, '10000000000000000001');
  assert.throws(() => validateConfig({ ...config, articles: { one: { id: 10000000000000000001, enabled: true, published: true } } }), /decimal strings/);
  assert.throws(() => validateConfig({ ...config, articles: { one: config.articles['series-00'], two: config.articles['series-00'] } }), /same Zhihu article/);
});

test('0x00 subtitle, order, code indentation and same-column navigation survive conversion', () => {
  const source = articles.get('series-00');
  const rendered = renderArticle(source, config, articles);
  const structure = describeHtml(rendered.html);
  assert.equal(rendered.title, displayTitle(source.data, config));
  assert.equal(structure.subtitles.length, 1);
  assert.equal(structure.headings.length, 2);
  assert.equal(structure.code.length, 2);
  assert.match(structure.code[0], /\n          │\n/);
  assert.match(rendered.html, /https:\/\/zhuanlan.zhihu.com\/p\/10000000000000000002/);
  assert.match(rendered.html, /https:\/\/zhuanlan.zhihu.com\/p\/10000000000000000003/);
  assert.match(rendered.html, /下一篇：0x01/);
  assert.doesNotMatch(rendered.html, /上一篇：/);
  assert.doesNotMatch(rendered.html, /href="\/blog\//);
});

test('middle and last article navigation uses mapped published neighbors even when writes are disabled', () => {
  const middle = renderArticle(articles.get('series-01'), config, articles);
  assert.match(middle.html, /上一篇：0x00/);
  assert.match(middle.html, /下一篇：0x02/);
  const last = renderArticle(articles.get('series-03'), config, articles);
  assert.match(last.html, /上一篇：0x02/);
  assert.doesNotMatch(last.html, /下一篇：/);
});

test('missing mappings, drafts, unsupported anchors and active links fail instead of publishing broken URLs', () => {
  assert.throws(() => rewriteLink('/blog/not-bound', config, articles), error => error.code === 'MAPPING_REQUIRED');
  assert.throws(() => rewriteLink('/blog/series-01#section', config, articles), error => error.code === 'UNSUPPORTED_ANCHOR');
  assert.throws(() => rewriteLink('javascript:alert(1)', config, articles), error => error.code === 'UNSAFE_LINK');
  const draft = { ...articles.get('series-00'), data: { ...articles.get('series-00').data, draft: true } };
  assert.throws(() => renderArticle(draft, config, articles), error => error.code === 'SOURCE_DRAFT');
});

test('Responsive figures choose compact diagrams and retain tables, captions and expanded details', () => {
  const rendered = renderArticle(articles.get('diagrams'), config, articles);
  assert.equal(rendered.assets.length, 4);
  assert.ok(rendered.assets.every(asset => asset.source.endsWith('-mobile.svg')));
  assert.doesNotMatch(rendered.html, /<(style|picture|details|summary)\b/);
  assert.match(rendered.html, /<figcaption>/);
  assert.ok(describeHtml(rendered.html).tables.length > 0);
  assert.equal((rendered.html.match(/>查看原图<\/a>/g) ?? []).length, 4);
  assert.doesNotMatch(rendered.html, /<a[^>]*>\s*<img/);
  assert.ok(describeHtml(rendered.html).links.includes('https://blog.example/img/diagrams/architecture.svg'));
});

test('Markdown image links become visible text links outside the atomic image', () => {
  const source = { ...articles.get('series-00'), body: '[![配图](/img/example.png)](/img/full.png)' };
  const rendered = renderArticle(source, config, articles);
  assert.match(rendered.html, /<figure><img[^>]+><\/figure><p><a href="https:\/\/blog.example\/img\/full.png">查看原图<\/a><\/p>/);
  assert.equal(rendered.assets.length, 1);
});

test('native data-caption preserves authored text and does not duplicate explicit captions', () => {
  const image = 'https://pic1.zhimg.com/v2-abcd_r.png';
  const expected = { title: '图注', html: `<figure><img src="${image}"><figcaption>A &amp; B 图注</figcaption></figure>` };
  const serialized = `<p><img src="${image}" data-caption="A &amp; B 图注"></p>`;
  assert.equal(compareArticle(expected, { title: '图注', html: serialized }).ok, true);
  const both = `<figure><img src="${image}" data-caption="A &amp; B 图注"><figcaption>A &amp; B 图注</figcaption></figure>`;
  assert.equal(compareArticle(expected, { title: '图注', html: both }).ok, true);
  assert.equal(compareArticle(expected, { title: '图注', html: serialized.replace('B 图注', 'C 图注') }).checks.text, false);
});

test('malicious or unrepresentable HTML cannot silently disappear', () => {
  const base = articles.get('series-00');
  for (const body of ['<script>alert(1)</script>', '<iframe src="https://example.com"></iframe>', '#### unsupported']) {
    assert.throws(() => renderArticle({ ...base, body }, config, articles), error => error.code === 'UNSUPPORTED_FORMAT');
  }
});

test('rich table conversion preserves authored links and code while plain tables remain native', () => {
  const base = articles.get('series-00');
  const source = { ...base, body: '| 名称 | 地址 |\n| --- | --- |\n| [工具](https://example.org/tool) | `http://localhost:1234/v1` |\n\n| 数字 | 值 |\n| --- | --- |\n| A | 1 |' };
  const rows = renderArticle(source, { ...config, richTableMode: 'rows' }, articles);
  const described = describeHtml(rows.html);
  assert.ok(described.links.includes('https://example.org/tool'));
  assert.ok(described.formats.inlineCode.includes('http://localhost:1234/v1'));
  assert.equal(described.tables.length, 1);
  assert.ok(rows.notices.some(notice => notice.includes('expanded')));
  const notes = renderArticle(source, { ...config, richTableMode: 'notes' }, articles);
  assert.equal(describeHtml(notes.html).tables.length, 2);
  assert.ok(describeHtml(notes.html).links.includes('https://example.org/tool'));
  assert.ok(describeHtml(notes.html).formats.inlineCode.includes('http://localhost:1234/v1'));
});

test('article comparison detects code whitespace, heading levels, table cells and remote image changes', () => {
  const expected = { title: 'title', html: '<blockquote>subtitle</blockquote><h2>heading</h2><pre><code>a\n  b</code></pre><table><tr><td>cell</td></tr></table><img src="https://pic1.zhimg.com/v2-abc123_r.jpg">' };
  assert.equal(compareArticle(expected, expected).ok, true);
  assert.equal(compareArticle(expected, { ...expected, html: expected.html.replace('  b', 'b') }).checks.code, false);
  assert.equal(compareArticle(expected, { ...expected, html: expected.html.replaceAll('h2', 'h3') }).checks.headings, false);
  assert.equal(compareArticle(expected, { ...expected, html: expected.html.replace('cell', 'different') }).checks.tables, false);
  assert.equal(compareArticle(expected, { ...expected, html: expected.html.replace('abc123', 'def456') }).checks.images, false);
  assert.equal(compareArticle(expected, { ...expected, html: expected.html.replace('pic1', 'pic4').replace('_r.jpg', '_720w.webp') }).checks.images, true);
  assert.equal(compareArticle(expected, { ...expected, imagesLoaded: false }).checks.images, false);
});

test('Zhihu link wrappers and automatic entity annotations are normalized without dropping authored links', () => {
  const expected = { title: 'title', html: '<p>text <a href="https://github.com/example/project">repository</a></p>' };
  const actual = { title: 'title', html: '<p><a href="https://zhida.zhihu.com/search?q=text">text</a> <a href="https://link.zhihu.com/?target=https%3A%2F%2Fgithub.com%2Fexample%2Fproject">repository</a></p>' };
  assert.equal(compareArticle(expected, actual).ok, true);
});

test('every source image must be mapped to a Zhihu CDN asset', () => {
  const html = '<p><img src="https://asset.invalid/asset-0" alt="caption"></p>';
  assert.throws(() => materializeImages(html, {}), error => error.code === 'ASSET_NOT_UPLOADED');
  assert.throws(() => materializeImages(html, { 'asset-0': 'https://example.com/a.png' }), error => error.code === 'ASSET_NOT_UPLOADED');
  assert.match(materializeImages(html, { 'asset-0': 'https://pic1.zhimg.com/v2-a.png' }), /alt="caption"/);
});

test('format checks recognize native editor spans and catch lost inline formatting', () => {
  const expected = { title: 'title', html: '<p><strong>bold</strong><em>italic</em><code>inline()</code><s>removed</s></p>' };
  const actual = { title: 'title', html: '<p><span style="font-weight:700">bold</span><span style="font-style:italic">italic</span><span style="font-family:Consolas,monospace">inline()</span><span style="text-decoration:line-through">removed</span></p>' };
  assert.equal(compareArticle(expected, actual).ok, true);
  assert.equal(compareArticle(expected, { title: 'title', html: '<p>bolditalicinline()removed</p>' }).checks.formats, false);
});

test('frontmatter requires real booleans and compatible series fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-source-test-'));
  await fs.mkdir(path.join(directory, 'posts'), { recursive: true });
  await fs.writeFile(path.join(directory, 'posts/a.md'), '---\ntitle: title\ndescription: subtitle\ndraft: "false"\n---\nbody');
  await assert.rejects(() => loadArticles(directory), error => error.code === 'SOURCE_INVALID');
});
