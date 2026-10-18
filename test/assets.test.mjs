import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { downloadImage, prepareAsset, resolveLocalImage, decodeBmp } from '../src/assets.mjs';
import { readStorageState } from '../src/browser.mjs';

const root = fileURLToPath(new URL('./fixtures/site/', import.meta.url));
const sourcePath = path.join(root, 'posts/diagrams.md');
const config = { blogUrl: 'https://blog.example', assetHosts: ['blog.example', 'raw.githubusercontent.com'] };

test('BMP conversion preserves pixel order and rejects truncated or unsupported data', () => {
  const bytes = Buffer.alloc(70);
  bytes.write('BM'); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(2, 18); bytes.writeInt32LE(2, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  bytes[54] = 255; bytes[62 + 2] = 255;
  const image = decodeBmp(bytes);
  assert.deepEqual([...image.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...image.rgba.subarray(8, 12)], [0, 0, 255, 255]);
  assert.throws(() => decodeBmp(bytes.subarray(0, 69)), { code: 'ASSET_FORMAT' });
  const compressed = Buffer.from(bytes); compressed.writeUInt32LE(1, 30);
  assert.throws(() => decodeBmp(compressed), { code: 'ASSET_FORMAT' });
});

test('a synthetic BMP image is converted to a native PNG upload without changing dimensions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-bmp-test-'));
  const asset = await prepareAsset({ key: 'asset-0', source: '/img/bitmap/sample.bmp' }, { sourcePath: path.join(root, 'posts/bitmap.md') }, root, config, directory);
  assert.equal(asset.convertedBmp, true); assert.equal(asset.width, 2); assert.equal(asset.height, 2);
  assert.ok(asset.file.endsWith('.png'));
  assert.equal((await fs.readFile(asset.file)).subarray(1, 4).toString(), 'PNG');
});

test('root-relative and first-party absolute assets use the checked-out source revision', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-images-test-'));
  const asset = { key: 'asset-0', source: 'https://blog.example/img/diagrams/architecture-mobile.svg' };
  const result = await prepareAsset(asset, { sourcePath }, root, config, directory);
  assert.equal(result.convertedSvg, true);
  assert.equal(result.width, 1600);
  assert.ok(result.file.endsWith('.png'));
  assert.ok((await fs.stat(result.file)).size > 1000);
});

test('file traversal and non-image files cannot enter uploads', async () => {
  await assert.rejects(() => resolveLocalImage(root, sourcePath, '../../../../AGENTS.md'), error => error.code === 'ASSET_FORMAT');
  await assert.rejects(() => resolveLocalImage(root, sourcePath, '..\\private.png'), error => error.code === 'ASSET_PATH_INVALID');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-path-test-'));
  await fs.mkdir(path.join(directory, 'posts'), { recursive: true });
  await fs.writeFile(path.join(directory, 'private.png'), 'not actually an image');
  await assert.rejects(() => resolveLocalImage(directory, path.join(directory, 'posts/a.md'), '../private.png'), error => error.code === 'ASSET_PATH_ESCAPE');
});

test('remote image redirects are rechecked against the explicit allowlist', async () => {
  let requests = 0;
  const fakeFetch = async () => { requests++; return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }); };
  await assert.rejects(() => downloadImage('https://raw.githubusercontent.com/owner/repo/main/a.png', config, fakeFetch), error => error.code === 'ASSET_HOST_DENIED');
  assert.equal(requests, 1);
});

test('SVG external references are rejected before rasterization', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-svg-test-'));
  await fs.mkdir(path.join(directory, 'public'), { recursive: true });
  await fs.writeFile(path.join(directory, 'public/bad.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/private.png"/></svg>');
  await assert.rejects(() => prepareAsset({ source: '/bad.svg' }, { sourcePath: path.join(directory, 'posts/a.md') }, directory, config, path.join(directory, 'out')), error => error.code === 'SVG_EXTERNAL_RESOURCE');
});

test('authentication parser rejects foreign domains without printing credential material', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-auth-test-'));
  const file = path.join(directory, 'state.json');
  await fs.writeFile(file, JSON.stringify({ cookies: [{ domain: '.example.com', name: 'session', value: 'DO_NOT_PRINT' }], origins: [] }));
  await assert.rejects(() => readStorageState(file), error => error.code === 'AUTH_STATE_INVALID' && !error.message.includes('DO_NOT_PRINT'));
  await fs.writeFile(file, 'DO_NOT_PRINT invalid JSON');
  await assert.rejects(() => readStorageState(file), error => error.code === 'AUTH_STATE_INVALID' && !error.message.includes('DO_NOT_PRINT'));
});
