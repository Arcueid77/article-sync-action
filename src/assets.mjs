import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fail, isZhihuImage, imageIdentity, validImageReference, sha256, writeJson } from './core.mjs';
import { sourceSettings } from './source.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const supportedExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const inside = (file, root) => file === root || file.startsWith(root + path.sep);

export function decodeBmp(bytes) {
  if (bytes.length < 54 || bytes.toString('ascii', 0, 2) !== 'BM') fail('ASSET_FORMAT', 'Invalid BMP image.');
  const dib = bytes.readUInt32LE(14), offset = bytes.readUInt32LE(10);
  const width = bytes.readInt32LE(18), signedHeight = bytes.readInt32LE(22), height = Math.abs(signedHeight);
  const bits = bytes.readUInt16LE(28);
  if (dib < 40 || offset < 14 + dib || width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > 20_000_000 || bytes.readUInt16LE(26) !== 1 || ![24, 32].includes(bits) || bytes.readUInt32LE(30) !== 0) fail('ASSET_FORMAT', 'Only bounded uncompressed 24/32-bit BMP images are supported.');
  const stride = Math.ceil(width * bits / 32) * 4;
  if (offset + stride * height > bytes.length) fail('ASSET_FORMAT', 'BMP pixel data is truncated.');
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const input = offset + (signedHeight < 0 ? y : height - 1 - y) * stride + x * bits / 8;
    const output = (y * width + x) * 4;
    rgba[output] = bytes[input + 2]; rgba[output + 1] = bytes[input + 1]; rgba[output + 2] = bytes[input]; rgba[output + 3] = 255;
  }
  return { rgba, width, height };
}

export async function resolveLocalImage(sourceRoot, sourcePath, reference, config = {}) {
  const settings = sourceSettings(config);
  const pathname = decodeURIComponent(reference.split(/[?#]/)[0]);
  if (pathname.includes('\\') || pathname.includes('\0')) fail('ASSET_PATH_INVALID', 'Invalid image path.');
  const candidate = pathname.startsWith('/')
    ? path.resolve(sourceRoot, settings.publicDir, '.' + pathname)
    : path.resolve(path.dirname(sourcePath), pathname);
  if (!supportedExtensions.has(path.extname(candidate).toLowerCase())) fail('ASSET_FORMAT', 'Only supported image files can be read.');
  let real;
  try { real = await fs.realpath(candidate); } catch { fail('ASSET_MISSING', 'A referenced local image does not exist.'); }
  const checkout = await fs.realpath(sourceRoot);
  const roots = [];
  for (const part of settings.assetDirs) {
    let root;
    try { root = await fs.realpath(path.resolve(sourceRoot, part)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!inside(root, checkout)) fail('ASSET_PATH_ESCAPE', 'An asset directory resolves outside the checkout.');
    roots.push(root);
  }
  if (!roots.some(root => inside(real, root))) fail('ASSET_PATH_ESCAPE', 'Image resolves outside the permitted blog asset directories.');
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > MAX_BYTES) fail('ASSET_SIZE', 'Image is not a regular file or exceeds the 20 MiB synchronization limit.');
  return { bytes: await fs.readFile(real), extension: path.extname(real).toLowerCase() };
}

export async function downloadImage(reference, config, fetchImpl = fetch) {
  let url = new URL(reference);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !config.assetHosts.includes(url.hostname)) fail('ASSET_HOST_DENIED', 'Remote image host is not in the explicit asset allowlist.');
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) fail('ASSET_DOWNLOAD', 'Image redirect has no target.');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) fail('ASSET_DOWNLOAD', `Image download returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > MAX_BYTES) fail('ASSET_SIZE', 'Remote image exceeds the 20 MiB synchronization limit.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) fail('ASSET_SIZE', 'Remote image exceeds the 20 MiB synchronization limit.');
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), extension: path.extname(url.pathname).toLowerCase() };
  }
  fail('ASSET_DOWNLOAD', 'Too many image redirects.');
}

export async function prepareAsset(asset, article, sourceRoot, config, directory) {
  let loaded;
  if (/^https?:\/\//i.test(asset.source)) {
    const url = new URL(asset.source);
    // First-party asset URLs resolve against the deployed commit, not mutable live content.
    if (url.origin === new URL(config.blogUrl).origin) loaded = await resolveLocalImage(sourceRoot, article.sourcePath, url.pathname, config);
    else loaded = await downloadImage(asset.source, config);
  } else {
    if (/^[a-z]+:|^\/\//i.test(asset.source)) fail('ASSET_SCHEME', 'Unsupported image scheme.');
    loaded = await resolveLocalImage(sourceRoot, article.sourcePath, asset.source, config);
  }
  const inputHash = sha256(loaded.bytes);
  let bytes = loaded.bytes;
  let extension = loaded.extension;
  const isBmp = extension === '.bmp' || bytes.toString('ascii', 0, 2) === 'BM';
  if (isBmp) {
    const decoded = decodeBmp(bytes);
    bytes = await sharp(decoded.rgba, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).png().toBuffer();
    extension = '.png';
  }
  const isSvg = extension === '.svg' || /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(bytes.toString('utf8', 0, 1024));
  if (isSvg) {
    const svg = bytes.toString('utf8');
    if (/<!DOCTYPE|<!ENTITY|<script|<foreignObject|(?:href|src)\s*=\s*["'](?!#|data:)|url\(\s*["']?(?!#)/i.test(svg)) fail('SVG_EXTERNAL_RESOURCE', 'SVG must be self-contained and contain no executable or external resources.');
    bytes = await sharp(bytes, { density: 192 }).resize({ width: 1600, withoutEnlargement: false }).png().toBuffer();
    extension = '.png';
  }
  let metadata;
  try { metadata = await sharp(bytes, { animated: true }).metadata(); } catch { fail('ASSET_FORMAT', 'Downloaded content is not a valid image.'); }
  const formats = { png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif' };
  if (!formats[metadata.format]) fail('ASSET_FORMAT', 'Image format requires an explicit conversion.');
  extension = formats[metadata.format];
  const hash = sha256(bytes);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, hash + extension);
  await fs.writeFile(file, bytes);
  return { ...asset, file, hash, inputHash, width: metadata.width, height: metadata.height, convertedSvg: isSvg, convertedBmp: isBmp };
}

export async function readImageCache(file) {
  const empty = () => ({ version: 2, images: {}, references: {} });
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    const cache = empty();
    if (value.version === 2) cache.references = Object.fromEntries(Object.entries(value.references ?? {}).filter(([hash, reference]) => /^[a-f0-9]{64}$/.test(hash) && validImageReference(reference)));
    if (value.version === 1) for (const [hash, url] of Object.entries(value.images ?? {})) if (/^[a-f0-9]{64}$/.test(hash) && isZhihuImage(url) && imageIdentity(url)?.startsWith('v2-')) cache.references[hash] = { imageHash: imageIdentity(url) };
    return cache;
  } catch { return empty(); }
}
export async function saveImageCache(file, cache) {
  const references = { ...cache.references };
  for (const [hash, url] of Object.entries(cache.images ?? {})) if (/^[a-f0-9]{64}$/.test(hash) && isZhihuImage(url) && imageIdentity(url)?.startsWith('v2-')) references[hash] ??= { imageHash: imageIdentity(url) };
  await writeJson(file, { version: 2, references: Object.fromEntries(Object.entries(references).filter(([hash, reference]) => /^[a-f0-9]{64}$/.test(hash) && validImageReference(reference))) });
}
