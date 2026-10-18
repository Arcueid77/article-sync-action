import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.mjs';

export const inside = (file, root) => file === root || file.startsWith(root + path.sep);

export function sourceSettings(config = {}) {
  const source = config.source ?? {};
  const value = {
    articlesDir: source.articlesDir ?? 'posts',
    publicDir: source.publicDir ?? 'public',
    articlePath: source.articlePath ?? '/blog/',
    seriesPath: source.seriesPath ?? '/series/',
    seriesTitle: source.seriesTitle ?? 'plain',
  };
  value.assetDirs = source.assetDirs ?? [value.publicDir, value.articlesDir];
  if (!Array.isArray(value.assetDirs) || !value.assetDirs.length) fail('CONFIG_INVALID', 'At least one asset directory is required.');
  for (const directory of [value.articlesDir, value.publicDir, ...value.assetDirs]) {
    if (typeof directory !== 'string' || !directory || path.isAbsolute(directory) || /[\\\x00:]/.test(directory) || directory.split('/').some(part => part === '..' || !part)) fail('CONFIG_INVALID', 'Source directories must be relative paths within the source checkout.');
  }
  for (const prefix of [value.articlePath, value.seriesPath]) {
    if (typeof prefix !== 'string' || !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(prefix)) fail('CONFIG_INVALID', 'URL prefixes must start and end with / and use plain path segments.');
  }
  if (value.articlePath === value.seriesPath) fail('CONFIG_INVALID', 'Article and series URL prefixes must be distinct.');
  if (!['plain', 'hex', 'decimal'].includes(value.seriesTitle)) fail('CONFIG_INVALID', 'seriesTitle must be plain, hex, or decimal.');
  return value;
}

export const publicSourceUrl = (config, slug) => new URL(`${sourceSettings(config).articlePath}${encodeURIComponent(slug)}`, config.blogUrl).href;

export async function checkedDirectory(sourceRoot, relative) {
  const root = await fs.realpath(sourceRoot);
  const directory = await fs.realpath(path.resolve(sourceRoot, relative));
  if (!inside(directory, root)) fail('SOURCE_PATH_ESCAPE', 'A source directory resolves outside the checkout.');
  return directory;
}
