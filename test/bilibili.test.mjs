import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateBilibiliConfig, emptyBilibiliRegistry, validateBilibiliRegistry, effectiveBilibiliConfig, renderBilibiliArticle, bilibiliImageUrl, compareBilibiliArticle } from '../src/bilibili.mjs';
import { synchronizeBilibili, bilibiliContentHash } from '../src/bilibili-sync.mjs';
import { exactJson, allocatedId } from '../src/bilibili-browser.mjs';
import { readStorageState } from '../src/browser.mjs';
import { redactImageUrls } from '../src/core.mjs';
import { actionInputs } from '../src/action.mjs';

const config = () => ({ version: 1, platform: 'bilibili', blogUrl: 'https://blog.example', authorMid: '12345', assetHosts: [], columns: {}, articles: { intro: { enabled: true, published: false } }, newArticles: { enabled: false, stateBranch: 'dev/bilibili-state', stateFile: 'bilibili-state.json' } });
const article = (slug = 'intro') => ({ slug, data: { title: '测试文章', description: '副标题', series: 'test', seriesOrder: 0 }, body: '## 章节\n\n代码 `call()` 和 [链接](https://example.com/)\n\n```js\nconst x = 1;\n```\n\n| 名称 | 内容 |\n|---|---|\n| A | [B](https://example.com/b) |', sourceHash: 'a'.repeat(64), sourcePath: '/fixture/posts/intro.md' });

test('Bilibili configuration, owner and stable URL boundaries are explicit', () => {
  assert.doesNotThrow(() => validateBilibiliConfig(config()));
  for (const bad of [{ authorMid: 12345 }, { platform: 'zhihu' }, { articles: { intro: { enabled: true, published: true, id: '42', publicUrl: 'https://evil.example/opus/42' } } }]) assert.throws(() => validateBilibiliConfig({ ...config(), ...bad }));
  const value = emptyBilibiliRegistry(config());
  assert.throws(() => validateBilibiliRegistry({ ...value, platform: 'zhihu' }, config()));
  value.articles.intro = { id: '42', stage: 'review_pending', sourceUrl: 'https://blog.example/blog/intro', images: { ['b'.repeat(64)]: 'https://article.biliimg.com/bfs/article/abcd.png?token=secret' } };
  assert.throws(() => validateBilibiliRegistry(value, config()), { code: 'REGISTRY_INVALID' });
  assert.equal(bilibiliImageUrl('http://article.biliimg.com/bfs/article/abcd.png?token=secret'), 'https://article.biliimg.com/bfs/article/abcd.png');
  assert.equal(bilibiliImageUrl('https://hdslb.com.evil.example/bfs/article/abcd.png'), null);
});

test('Bilibili renderer preserves subtitles, code, links, table values and same-platform navigation', () => {
  const c = config(), first = article(), next = { ...article('next'), data: { ...article().data, title: '下一篇', seriesOrder: 1 } };
  c.articles.next = { id: '43', enabled: false, published: true, publicUrl: 'https://www.bilibili.com/read/cv43' };
  const result = renderBilibiliArticle(first, c, new Map([['intro', first], ['next', next]]));
  assert.match(result.html, /<blockquote><p>副标题/); assert.match(result.html, /<pre><code class="language-js">const x = 1;/);
  assert.match(result.html, /https:\/\/example.com\/b/); assert.doesNotMatch(result.html, /<table/);
  assert.match(result.html, /https:\/\/www.bilibili.com\/read\/cv43/); assert.doesNotMatch(result.html, /zhihu\.com/);
  assert.equal(compareBilibiliArticle(result, result).ok, true);
  assert.equal(compareBilibiliArticle(result, { ...result, html: result.html.replace('call()', 'lost()') }).ok, false);
  assert.throws(() => renderBilibiliArticle({ ...first, data: { ...first.data, title: '长'.repeat(41) } }, c, new Map()), { code: 'TITLE_TOO_LONG' });
});

test('discovery respects Bilibili opt-out and disabled bindings independently of Zhihu', () => {
  const c = config(); c.newArticles.enabled = true;
  c.articles.intro.enabled = false;
  const effective = effectiveBilibiliConfig(c, emptyBilibiliRegistry(c), new Map([['intro', article()], ['no', { data: { bilibili: false } }], ['yes', { data: { zhihu: false } }]]));
  assert.equal(effective.articles.intro.enabled, false); assert.equal(effective.articles.no, undefined); assert.equal(effective.articles.yes.enabled, true);
});

test('large IDs never pass through imprecise JSON numbers', () => {
  const data = exactJson('{"code":0,"data":{"id":1234567890123456789},"note":"1234567890123456789"}');
  assert.equal(allocatedId(data), '1234567890123456789'); assert.equal(data.note, '1234567890123456789');
  assert.equal(allocatedId({ code: 0, data: { id: 1234567890123456789 } }), null);
});

test('Bilibili image signatures never survive JSON or HTML report redaction', () => {
  const value = { html: '<img src="https://article.biliimg.com/bfs/article/abcd.png?token=private-secret&amp;expires=1">' };
  const result = JSON.stringify(redactImageUrls(value));
  assert.ok(!result.includes('private-secret')); assert.ok(!result.includes('expires='));
});

test('platform selection never accepts another platform session', async () => {
  assert.equal(actionInputs({ SYNC_PLATFORM: 'bilibili', SYNC_MODE: 'draft' }).platform, 'bilibili');
  assert.throws(() => actionInputs({ SYNC_MODE: 'draft' }), { code: 'ARGUMENT_INVALID' });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-auth-test-'));
  const file = path.join(root, 'state.json');
  await fs.writeFile(file, JSON.stringify({ cookies: [{ domain: '.zhihu.com' }], origins: [] }));
  await assert.rejects(readStorageState(file, 'bilibili'), { code: 'AUTH_STATE_INVALID' });
});

async function fixture(mode = 'draft') {
  const c = config(), source = article();
  const articles = new Map([['intro', source]]), registry = emptyBilibiliRegistry(c), saved = [];
  const prepared = renderBilibiliArticle(source, c, articles);
  const state = { allocations: 0, submissions: 0, writes: 0, published: null };
  const editor = {
    async assertAuthor() {}, async assertNoDuplicate() {},
    async createDraft(prepared, persist) { state.allocations++; await persist('42'); },
    async writeDraft(prepared) { state.writes++; return prepared; }, async readDraft() { return prepared; },
    async readPublished() { return state.published; },
    async submit(entry, prepared, persist) { await persist(); state.submissions++; },
  };
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-flow-test-'));
  const inputs = { config: c, registry, store: { async save(value) { validateBilibiliRegistry(value, c); saved.push(structuredClone(value)); } }, articles, items: [{ prepared, assets: [] }], mode, editor, output, sourceCommit: 'b'.repeat(40), report: { articles: [] } };
  return { inputs, state, saved, prepared };
}

test('draft reruns reuse one ID and do not publish', async () => {
  const f = await fixture(); await synchronizeBilibili(f.inputs); f.inputs.report.articles = []; await synchronizeBilibili(f.inputs);
  assert.equal(f.state.allocations, 1); assert.equal(f.state.submissions, 0); assert.equal(f.inputs.registry.articles.intro.id, '42');
  assert.equal(f.saved[0].articles.intro.stage, 'allocating'); assert.equal(f.inputs.report.articles[0].status, 'draft_saved');
});

test('pending review does not resubmit, and public-body readback confirms completion', async () => {
  const f = await fixture('apply'); await synchronizeBilibili(f.inputs);
  assert.equal(f.inputs.registry.articles.intro.stage, 'review_pending'); assert.equal(f.state.submissions, 1);
  f.inputs.report.articles = []; await synchronizeBilibili(f.inputs); assert.equal(f.state.submissions, 1);
  f.state.published = { ...f.prepared, publicUrl: 'https://www.bilibili.com/read/cv42' };
  f.inputs.report.articles = []; await synchronizeBilibili(f.inputs);
  assert.equal(f.inputs.registry.articles.intro.stage, 'published'); assert.equal(f.inputs.report.articles[0].status, 'already_current');
  assert.equal(f.state.submissions, 1); assert.equal(f.inputs.registry.articles.intro.renderHash, bilibiliContentHash(f.prepared));
});

test('uncertain allocation and submit outcomes never create or submit twice', async () => {
  const f = await fixture('apply');
  f.inputs.editor.submit = async (entry, prepared, persist) => { await persist(); throw new Error('connection lost'); };
  await synchronizeBilibili(f.inputs); assert.equal(f.inputs.registry.articles.intro.stage, 'submitting');
  f.inputs.report.articles = []; await synchronizeBilibili(f.inputs); assert.equal(f.state.allocations, 1); assert.equal(f.state.writes, 1);
  f.inputs.registry.articles.intro = { id: null, stage: 'allocating', sourceUrl: 'https://blog.example/blog/intro' };
  f.inputs.report.articles = []; await synchronizeBilibili(f.inputs); assert.equal(f.state.allocations, 1); assert.equal(f.inputs.report.articles[0].code, 'CREATE_OUTCOME_UNKNOWN');
});

test('verify never allocates, writes, submits or persists state', async () => {
  const f = await fixture('verify'); await synchronizeBilibili(f.inputs);
  assert.equal(f.state.allocations + f.state.writes + f.state.submissions, 0); assert.equal(f.saved.length, 0);
});
