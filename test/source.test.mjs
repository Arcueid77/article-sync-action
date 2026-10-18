import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceSettings, publicSourceUrl } from '../src/source.mjs';
import { displayTitle, loadArticles, rewriteLink } from '../src/core.mjs';
import { resolveLocalImage } from '../src/assets.mjs';

test('source layout, URL prefixes and title formatting are independent of Astro', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-layout-'));
  await fs.mkdir(path.join(root, 'content/notes/nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'content/notes/nested/hello.md'), '---\ntitle: Hello\n---\nBody');
  const config = { blogUrl: 'https://example.org', source: { articlesDir: 'content/notes', publicDir: 'static', articlePath: '/notes/', seriesPath: '/collections/' }, articles: { hello: { id: '123456789', published: true } } };
  const articles = await loadArticles(root, config);
  assert.equal(articles.get('hello').data.description, '');
  assert.equal(publicSourceUrl(config, 'hello'), 'https://example.org/notes/hello');
  assert.equal(rewriteLink('/notes/hello', config, articles), 'https://zhuanlan.zhihu.com/p/123456789');
  assert.equal(displayTitle({ title: 'Hello', seriesOrder: 3 }), 'Hello');
  assert.equal(displayTitle({ title: 'Hello', seriesOrder: 3 }, { source: { seriesTitle: 'decimal' } }), '3：Hello');
  await fs.writeFile(path.join(root, 'content/notes/hello.md'), '---\ntitle: Duplicate\n---\nBody');
  await assert.rejects(loadArticles(root, config), { code: 'SOURCE_INVALID' });
});

test('source configuration rejects unsafe paths and unknown title conventions', () => {
  for (const source of [{ articlesDir: '../private' }, { publicDir: 'C:/private' }, { assetDirs: 'public' }, { articlePath: '//example.org/' }, { seriesTitle: 'guess' }]) assert.throws(() => sourceSettings({ source }), { code: 'CONFIG_INVALID' });
});

test('configured asset directories cannot escape through directory symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-symlink-'));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-assets-'));
  await fs.writeFile(path.join(external, 'image.png'), 'private image');
  await fs.symlink(external, path.join(root, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveLocalImage(root, path.join(root, 'posts/a.md'), '/image.png'), { code: 'ASSET_PATH_ESCAPE' });
});
