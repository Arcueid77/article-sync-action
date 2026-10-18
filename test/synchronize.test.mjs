import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRegistry, effectiveConfig } from '../src/registry.mjs';
import { renderArticle } from '../src/core.mjs';
import { synchronize } from '../src/synchronize.mjs';

function fixture(source = [['new', {}]]) {
  const config = { version: 1, blogUrl: 'https://blog.example', authorUrlToken: 'author', columns: { series: { id: 'c_12345', title: '系列' } }, articles: {}, newArticles: { enabled: true, stateBranch: 'dev/zhihu-sync-state', seriesColumns: { series: 'series' }, declaration: '无声明' } };
  const articles = new Map(source.map(([slug, data]) => [slug, { slug, data: { title: slug, description: '副标题', ...data }, body: data.body ?? '<p>正文</p>', sourcePath: '/unused', sourceHash: `hash-${slug}` }]));
  const registry = emptyRegistry(config), checkpoints = [], calls = [];
  const store = { save: async value => { checkpoints.push(structuredClone(value)); } };
  const editor = {
    ownArticles: async () => [],
    createDraft: async (prepared, persist) => { calls.push(['allocate', prepared.slug]); await persist(String(23456789012345000000n + BigInt(calls.length))); },
    runNew: async (prepared, _assets, _cache, options) => { calls.push(['publish', prepared.slug, prepared.html]); await options.onBeforeSubmit(); return { status: 'created', submitted: true, id: prepared.id }; },
    run: async prepared => { calls.push(['refresh', prepared.slug, prepared.html]); return { status: 'updated', id: prepared.id }; },
  };
  const run = async (mode = 'apply') => {
    const effective = effectiveConfig(config, registry, articles);
    const items = [...articles.values()].map(article => ({ prepared: renderArticle(article, effective, articles, { allowNew: true, allowPendingLinks: true }), assets: [] }));
    const report = { articles: [] };
    await synchronize({ config, registry, store, articles, items, mode, editor, cache: { images: {} }, saveCache: async () => {}, output: '/unused', sourceCommit: 'source-commit', report });
    return report;
  };
  return { config, registry, articles, checkpoints, calls, store, editor, run };
}

test('new article verify discovers candidates without allocating, writing state or publishing', async () => {
  const f = fixture();
  const report = await f.run('verify');
  assert.equal(report.articles[0].status, 'new_article');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.checkpoints, []);
});

test('creation intent and exact ID are persisted before publication, with a separate publication checkpoint', async () => {
  const f = fixture();
  const report = await f.run();
  assert.equal(report.articles[0].status, 'created');
  assert.deepEqual(f.checkpoints.map(state => state.articles.new.stage), ['allocating', 'draft', 'publishing', 'published']);
  assert.equal(f.checkpoints[0].articles.new.id, null);
  assert.equal(typeof f.checkpoints[1].articles.new.id, 'string');
  assert.deepEqual(f.calls.map(call => call[0]), ['allocate', 'publish']);
});

test('state storage failure or an unmapped matching title stops before allocating a draft', async () => {
  const f = fixture();
  f.store.save = async () => { throw Object.assign(new Error('offline'), { code: 'REGISTRY_UNAVAILABLE' }); };
  assert.equal((await f.run()).articles[0].code, 'REGISTRY_UNAVAILABLE'); assert.deepEqual(f.calls, []);
  const g = fixture();
  g.editor.ownArticles = async () => [{ id: '34567890123456789012', title: 'new' }];
  assert.equal((await g.run()).articles[0].code, 'UNMAPPED_EXISTING_ARTICLE');
  assert.deepEqual(g.calls, []); assert.deepEqual(g.checkpoints, []);
});

test('interrupted allocation does not allocate another ID on a retry', async () => {
  const f = fixture();
  f.editor.createDraft = async () => { f.calls.push(['allocate']); throw Object.assign(new Error('unknown'), { code: 'CREATE_OUTCOME_UNKNOWN' }); };
  assert.equal((await f.run()).articles[0].code, 'CREATE_OUTCOME_UNKNOWN');
  assert.equal((await f.run()).articles[0].code, 'CREATE_OUTCOME_UNKNOWN');
  assert.equal(f.calls.length, 1);
});

test('publication uncertainty keeps the same ID and retries only read-only reconciliation', async () => {
  const f = fixture();
  f.editor.runNew = async (_prepared, _assets, _cache, options) => {
    if (options.allowSubmit) await options.onBeforeSubmit();
    return { status: 'failed', code: 'WRITE_OUTCOME_UNKNOWN', submitted: true };
  };
  await f.run();
  const id = f.registry.articles.new.id;
  assert.equal(f.registry.articles.new.stage, 'publishing');
  await f.run();
  assert.equal(f.registry.articles.new.id, id); assert.equal(f.calls.length, 1);
  f.editor.runNew = async (_prepared, _assets, _cache, options) => { assert.equal(options.allowSubmit, false); return { status: 'already_current', id }; };
  assert.equal((await f.run()).articles[0].status, 'already_current');
  assert.equal(f.registry.articles.new.stage, 'published');
});

test('multiple new articles finish with Zhihu cross-links and final series navigation', async () => {
  const f = fixture([['one', { series: 'series', seriesOrder: 1, body: '[two](/blog/two)' }], ['two', { series: 'series', seriesOrder: 2, body: '[one](/blog/one)' }]]);
  const report = await f.run();
  const refresh = f.calls.find(call => call[0] === 'refresh' && call[1] === 'one');
  assert.ok(refresh);
  assert.ok(refresh[2].includes(`https://zhuanlan.zhihu.com/p/${f.registry.articles.two.id}`));
  assert.ok(!refresh[2].includes('href="https://blog.example/blog/two"'));
  assert.ok(refresh[2].includes('href="https://blog.example/blog/one"'));
  assert.equal(report.articles.find(article => article.slug === 'one').navigationRefreshed, true);
});

test('an article-local failure does not repeat submission or block independent articles', async () => {
  const f = fixture([['bad', {}], ['good', {}]]);
  const publish = f.editor.runNew;
  f.editor.runNew = async (prepared, ...args) => prepared.slug === 'bad' ? { status: 'failed', code: 'FORMAT_MISMATCH' } : publish(prepared, ...args);
  const report = await f.run();
  assert.equal(report.articles.find(item => item.slug === 'bad').status, 'failed');
  assert.equal(report.articles.find(item => item.slug === 'good').status, 'created');
  assert.equal(f.calls.filter(call => call[0] === 'refresh' && call[1] === 'bad').length, 0);
});

test('a shared credential failure stops the batch before another allocation', async () => {
  const f = fixture([['one', {}], ['two', {}]]);
  f.editor.ownArticles = async () => { throw Object.assign(new Error('Expired session'), { code: 'AUTH_REQUIRED' }); };
  const report = await f.run();
  assert.equal(report.articles[0].code, 'AUTH_REQUIRED');
  assert.equal(f.calls.length, 0);
});
