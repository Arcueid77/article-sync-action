import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyRegistry, validateRegistry, effectiveConfig, FileRegistry, GitHubRegistry } from '../src/registry.mjs';

const config = { blogUrl: 'https://blog.example', authorUrlToken: 'author', columns: { series: { id: 'c_12345', title: '系列' } }, articles: { old: { id: '12345678901234567890', enabled: false, published: true } }, newArticles: { enabled: true, stateBranch: 'dev/zhihu-sync-state', seriesColumns: { series: 'series' }, declaration: '无声明' } };
const entry = (stage = 'draft') => ({ id: stage === 'allocating' ? null : '23456789012345678901', stage, sourceUrl: 'https://blog.example/blog/new' });

test('registry validates owner, canonical source, exact IDs and configured collisions', () => {
  const value = { ...emptyRegistry(config), articles: { new: entry() } };
  assert.equal(validateRegistry(value, config), value);
  for (const invalid of [
    { ...value, authorUrlToken: 'other' }, { ...value, blogUrl: 'https://other.example' },
    { ...value, articles: { new: { ...entry(), id: Number(entry().id) } } },
    { ...value, articles: { new: { ...entry(), sourceUrl: 'https://other.example/blog/new' } } },
    { ...value, articles: { new: { ...entry(), stage: 'unknown' } } },
    { ...value, articles: { new: { ...entry(), id: config.articles.old.id } } },
  ]) assert.throws(() => validateRegistry(invalid, config));
  assert.doesNotThrow(() => validateRegistry({ ...value, articles: { new: entry('allocating') } }, config));
});

test('new non-draft articles are discovered without enabling disabled existing articles', () => {
  const articles = new Map([['old', { data: {} }], ['new', { data: {} }], ['draft', { data: { draft: true } }], ['optout', { data: { zhihu: false } }], ['episode', { data: { series: 'series' } }]]);
  const effective = effectiveConfig(config, emptyRegistry(config), articles);
  assert.equal(effective.articles.old.enabled, false);
  assert.equal(effective.articles.new.published, false);
  assert.equal(effective.articles.new.id, undefined);
  assert.equal(effective.articles.episode.column, 'series');
  assert.equal(effective.articles.draft, undefined);
  assert.equal(effective.articles.optout, undefined);
  const registry = { ...emptyRegistry(config), articles: { new: entry('published') } };
  assert.equal(effectiveConfig(config, registry, articles).articles.new.id, entry().id);
  assert.throws(() => effectiveConfig(config, emptyRegistry(config), new Map([['unknown', { data: { series: 'unknown' } }]])), { code: 'COLUMN_MAPPING_REQUIRED' });
});

test('registry image recovery leaves explicit existing article mappings unchanged', () => {
  const value = { ...emptyRegistry(config), articles: { old: { id: config.articles.old.id, stage: 'published', sourceUrl: 'https://blog.example/blog/old', images: { ['a'.repeat(64)]: { imageHash: 'v2-abcd' } } } } };
  validateRegistry(value, config);
  assert.deepEqual(effectiveConfig(config, value, new Map([['old', { data: {} }]])).articles.old, config.articles.old);
});

test('local registry survives each creation transition and never resets malformed state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-registry-'));
  const file = path.join(directory, 'state.json');
  const store = new FileRegistry(file, config);
  const registry = await store.load();
  for (const stage of ['allocating', 'draft', 'published']) {
    registry.articles.new = entry(stage); await store.save(registry);
    assert.equal((await new FileRegistry(file, config).load()).articles.new.stage, stage);
  }
  await fs.writeFile(file, 'invalid json');
  await assert.rejects(store.load(), { code: 'REGISTRY_INVALID' });
  await assert.rejects(new FileRegistry(undefined, config).save(emptyRegistry(config)), { code: 'REGISTRY_REQUIRED' });
});

test('GitHub registry creates a separate branch and uses compare-and-swap for every write', async () => {
  const calls = []; let fileSha;
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method, body });
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.ok(!JSON.stringify(body ?? {}).includes('test-secret'));
    if (url.endsWith('/git/ref/heads/dev/zhihu-sync-state')) return new Response('{}', { status: 404 });
    if (url.endsWith('/repos/owner/repo')) return Response.json({ default_branch: 'trunk' });
    if (url.endsWith('/git/ref/heads/trunk')) return Response.json({ object: { sha: 'a'.repeat(40) } });
    if (url.endsWith('/git/refs')) return Response.json({ ref: body.ref });
    if (options.method === 'PUT') {
      assert.equal(body.branch, 'dev/zhihu-sync-state'); assert.equal(body.sha, fileSha);
      fileSha = (fileSha ? 'c' : 'b').repeat(40);
      return Response.json({ content: { sha: fileSha } });
    }
    throw new Error('Unexpected request');
  };
  const store = new GitHubRegistry(config, { repository: 'owner/repo', token: 'test-secret', fetchImpl });
  const registry = await store.load(); assert.equal(calls.length, 1);
  registry.articles.new = entry('allocating'); await store.save(registry);
  registry.articles.new = entry(); await store.save(registry);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.at(-1).body.sha, 'b'.repeat(40));
});

test('registry conflicts or transport errors stop without exposing credentials or raw diagnostics', async () => {
  for (const fetchImpl of [async () => new Response('sensitive diagnostics', { status: 409 }), async () => { throw new Error('test-secret sensitive diagnostics'); }]) {
    const store = new GitHubRegistry(config, { repository: 'owner/repo', token: 'test-secret', fetchImpl });
    await assert.rejects(store.load(), error => ['REGISTRY_CONFLICT', 'REGISTRY_UNAVAILABLE'].includes(error.code) && !/test-secret|sensitive/.test(error.message));
  }
});
