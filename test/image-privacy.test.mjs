import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isZhihuImage, imageIdentity, compareArticle, redactImageUrls, writeJson } from '../src/core.mjs';
import { readImageCache, saveImageCache } from '../src/assets.mjs';
import { emptyRegistry, validateRegistry } from '../src/registry.mjs';

const signed = 'https://pic-private.zhihu.com/v2-aabbccdd~resize:0.png?expiration=123&auth_key=private-test-value&draft_token=draft-test-value';

test('only the exact private-image host is allowed, and signatures do not change image identity', () => {
  assert.ok(isZhihuImage(signed));
  assert.equal(imageIdentity(signed), 'v2-aabbccdd');
  for (const url of [signed.replace('https:', 'http:'), signed.replace('.com/', '.com.evil/'), signed.replace('pic-private', 'untrusted'), signed.replace('.com/', '.com:8443/'), signed.replace('https://', 'https://user:password@')]) assert.equal(isZhihuImage(url), false);
  const expected = { title: '图文', html: `<img src="${signed}">`, imageAliases: { 'v2-11223344': 'v2-aabbccdd' } };
  assert.ok(compareArticle(expected, { title: '图文', html: '<img src="https://pic1.zhimg.com/v2-11223344_r.png">', imagesLoaded: true }).ok);
  assert.equal(compareArticle(expected, { title: '图文', html: '<img src="https://pic1.zhimg.com/v2-deadbeef_r.png">' }).ok, false);
});

test('JSON and HTML snapshots remove signed query parameters recursively', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-private-test-'));
  const file = path.join(directory, 'snapshot.json');
  await writeJson(file, { html: `<img src="${signed.replaceAll('&', '&amp;')}">`, nested: [signed] });
  const text = await fs.readFile(file, 'utf8');
  assert.ok(!/expiration|auth_key|draft_token|private-test-value|draft-test-value/.test(text));
  assert.ok(text.includes('v2-aabbccdd'));
  assert.equal(redactImageUrls(`<img src='${signed}'>`), "<img src='https://pic-private.zhihu.com/v2-aabbccdd~resize:0.png'>");
});

test('editor caption prompts are excluded while authored captions remain part of the content', () => {
  const expected = { title: '图片', html: `<img src="${signed}">` };
  assert.ok(compareArticle(expected, { title: '图片', html: `<figure><img src="${signed}"><figcaption class="Image-caption is-placeholder">添加图片注释，不超过 140 字（可选）</figcaption></figure>` }).ok);
  assert.equal(compareArticle(expected, { title: '图片', html: `<figure><img src="${signed}"><figcaption>真实图注</figcaption></figure>` }).ok, false);
});

test('cache and registry persist identifiers, never signed addresses', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-cache-test-'));
  const file = path.join(directory, 'cache.json');
  const hash = 'a'.repeat(64);
  const reference = { imageId: '2095147453758563294', imageHash: 'v2-aabbccdd' };
  await saveImageCache(file, { images: { [hash]: signed }, references: { [hash]: reference } });
  const text = await fs.readFile(file, 'utf8');
  assert.ok(!text.includes('https:')); assert.ok(!text.includes('private-test-value'));
  const cache = await readImageCache(file);
  assert.deepEqual(cache.images, {}); assert.deepEqual(cache.references[hash], reference);
  const config = { blogUrl: 'https://blog.example', authorUrlToken: 'owner', articles: {}, columns: {} };
  const registry = { ...emptyRegistry(config), articles: { new: { id: '2095143590267708363', stage: 'draft', sourceUrl: 'https://blog.example/blog/new', images: { [hash]: reference } } } };
  assert.doesNotThrow(() => validateRegistry(registry, config));
  registry.articles.new.images[hash] = signed;
  assert.throws(() => validateRegistry(registry, config), { code: 'REGISTRY_INVALID' });
});
