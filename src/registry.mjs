import fs from 'node:fs/promises';
import { fail, validImageReference, writeJson } from './core.mjs';
import { publicSourceUrl } from './source.mjs';

export const sourceUrl = publicSourceUrl;
export const emptyRegistry = config => ({ version: 1, blogUrl: config.blogUrl, authorUrlToken: config.authorUrlToken, articles: {} });

export function validateRegistry(value, config) {
  if (value?.version !== 1 || value.blogUrl !== config.blogUrl || value.authorUrlToken !== config.authorUrlToken || !value.articles || Array.isArray(value.articles)) fail('REGISTRY_INVALID', 'The article registry has a different owner or schema.');
  const ids = new Set();
  for (const [slug, entry] of Object.entries(value.articles)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !['allocating', 'draft', 'publishing', 'published'].includes(entry?.stage) || entry.sourceUrl !== sourceUrl(config, slug)) fail('REGISTRY_INVALID', 'An article registry entry is invalid.');
    if (entry.stage === 'allocating' ? entry.id !== null : typeof entry.id !== 'string' || !/^\d{5,30}$/.test(entry.id)) fail('REGISTRY_INVALID', 'Registry article IDs must be exact decimal strings.');
    if (entry.id && ids.has(entry.id)) fail('REGISTRY_INVALID', 'Two source articles cannot share an allocated article.');
    if (entry.id) ids.add(entry.id);
    if (entry.column && !config.columns[entry.column]) fail('REGISTRY_INVALID', 'Registry column is not configured.');
    if (Object.keys(entry).some(key => !['id', 'stage', 'sourceUrl', 'sourceHash', 'sourceCommit', 'column', 'images'].includes(key))) fail('REGISTRY_INVALID', 'Registry contains unexpected fields.');
    if (entry.images && (typeof entry.images !== 'object' || Array.isArray(entry.images) || Object.entries(entry.images).some(([hash, reference]) => !/^[a-f0-9]{64}$/.test(hash) || !validImageReference(reference)))) fail('REGISTRY_INVALID', 'Registry images must contain identifiers, never temporary addresses.');
    if (Object.hasOwn(config.articles, slug) && entry.id !== config.articles[slug].id) fail('REGISTRY_CONFLICT', 'A configured article has a different registry ID.');
    if (entry.id && Object.entries(config.articles).some(([other, binding]) => other !== slug && binding.id === entry.id)) fail('REGISTRY_CONFLICT', 'An allocated ID already belongs to another configured article.');
  }
  return value;
}

export function effectiveConfig(config, registry, articles) {
  const effective = structuredClone(config);
  for (const [slug, entry] of Object.entries(registry.articles)) {
    if (!entry.id) continue;
    // Explicit mappings remain authoritative; registry images may supplement
    // their cache without adding a new-article footer or changing enablement.
    if (Object.hasOwn(config.articles, slug)) continue;
    effective.articles[slug] = { id: entry.id, column: entry.column, enabled: true, published: entry.stage === 'published', ...effective.articles[slug], sourceUrl: entry.sourceUrl };
  }
  if (config.newArticles?.enabled) for (const [slug, article] of articles) {
    if (Object.hasOwn(effective.articles, slug) || article.data.draft || article.data.zhihu === false) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail('SOURCE_INVALID', 'New article filenames must use the configured lowercase slug convention.');
    const column = article.data.series ? config.newArticles.seriesColumns?.[article.data.series] : undefined;
    if (article.data.series && !column) fail('COLUMN_MAPPING_REQUIRED', 'A new series needs an explicit Zhihu column mapping.');
    effective.articles[slug] = { enabled: true, published: false, column, sourceUrl: sourceUrl(config, slug) };
  }
  return effective;
}

export class FileRegistry {
  constructor(file, config) { this.file = file; this.config = config; }
  async load() {
    if (!this.file) return emptyRegistry(this.config);
    let raw;
    try { raw = await fs.readFile(this.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return emptyRegistry(this.config); throw error; }
    try { return validateRegistry(JSON.parse(raw), this.config); } catch (error) { if (error.code) throw error; fail('REGISTRY_INVALID', 'The local registry is invalid.'); }
  }
  async save(registry) {
    if (!this.file) fail('REGISTRY_REQUIRED', 'New article creation needs persistent registry storage.');
    await writeJson(this.file, validateRegistry(registry, this.config));
  }
}

export class GitHubRegistry {
  constructor(config, { repository, token, branch = config.newArticles?.stateBranch, fetchImpl = fetch } = {}) {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? '') || !token || !/^dev\/[a-z0-9-]+$/.test(branch ?? '')) fail('REGISTRY_REQUIRED', 'The trusted repository, token and dedicated state branch are required.');
    this.config = config; this.repository = repository; this.token = token; this.branch = branch; this.fetch = fetchImpl;
    this.file = 'article-sync-state.json'; this.sha = null; this.branchExists = false;
  }
  async request(method, endpoint, body, allowMissing = false) {
    let response;
    try {
      response = await this.fetch(`https://api.github.com/repos/${this.repository}${endpoint}`, {
        method, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
    } catch { fail('REGISTRY_UNAVAILABLE', 'The registry request did not complete; do not create or publish another article.'); }
    if (allowMissing && response.status === 404) return null;
    if ([409, 422].includes(response.status)) fail('REGISTRY_CONFLICT', 'Registry state changed; no force update is allowed.');
    if (!response.ok) fail('REGISTRY_UNAVAILABLE', `Registry request returned HTTP ${response.status}.`);
    try { return await response.json(); } catch { fail('REGISTRY_INVALID', 'The registry returned invalid JSON.'); }
  }
  async load() {
    const ref = await this.request('GET', `/git/ref/heads/${this.branch}`, undefined, true);
    this.branchExists = Boolean(ref);
    if (!ref) return emptyRegistry(this.config);
    const file = await this.request('GET', `/contents/${this.file}?ref=${encodeURIComponent(this.branch)}`);
    if (file.type !== 'file' || file.encoding !== 'base64' || !/^[a-f0-9]{40}$/.test(file.sha) || typeof file.content !== 'string') fail('REGISTRY_INVALID', 'Registry file metadata is invalid.');
    this.sha = file.sha;
    let registry;
    try { registry = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); } catch { fail('REGISTRY_INVALID', 'Registry content is invalid.'); }
    return validateRegistry(registry, this.config);
  }
  async save(registry) {
    validateRegistry(registry, this.config);
    if (!this.branchExists) {
      const repository = await this.request('GET', '');
      if (typeof repository.default_branch !== 'string' || !repository.default_branch) fail('REGISTRY_INVALID', 'The repository default branch is unavailable.');
      const main = await this.request('GET', `/git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
      if (!/^[a-f0-9]{40}$/.test(main.object?.sha ?? '')) fail('REGISTRY_INVALID', 'The default branch revision is invalid.');
      await this.request('POST', '/git/refs', { ref: `refs/heads/${this.branch}`, sha: main.object.sha });
      this.branchExists = true;
    }
    const body = { message: 'chore(zhihu): persist article publication state', branch: this.branch, content: Buffer.from(JSON.stringify(registry, null, 2) + '\n').toString('base64') };
    if (this.sha) body.sha = this.sha;
    const result = await this.request('PUT', `/contents/${this.file}`, body);
    if (!/^[a-f0-9]{40}$/.test(result.content?.sha ?? '')) fail('REGISTRY_INVALID', 'Registry write was not acknowledged.');
    this.sha = result.content.sha;
  }
}
