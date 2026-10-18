import path from 'node:path';
import { fail, renderArticle, validImageReference } from './core.mjs';
import { effectiveConfig, sourceUrl } from './registry.mjs';

export async function synchronize({ config, registry, store, articles, items, mode, editor, cache, saveCache, output, sourceCommit, report }) {
  const initial = effectiveConfig(config, registry, articles);
  const pending = items.filter(item => !initial.articles[item.prepared.slug].published);
  const outcomes = new Map();
  const createdHtml = new Map();
  const stopsBatch = code => /^REGISTRY_/.test(code ?? '') || ['AUTH_REQUIRED', 'AUTH_STATE_INVALID', 'AUTHOR_MISMATCH', 'WEBSITE_RATE_LIMITED', 'ARTICLE_ACCESS_RESTRICTED'].includes(code);
  const prepare = slug => renderArticle(articles.get(slug), effectiveConfig(config, registry, articles), articles, { allowNew: true, allowPendingLinks: true });
  const record = (slug, result) => {
    const entry = { slug, ...result };
    outcomes.set(slug, entry);
    const index = report.articles.findIndex(item => item.slug === slug);
    if (index < 0) report.articles.push(entry); else report.articles[index] = entry;
  };
  const persistImages = async (slug, assets) => {
    await saveCache();
    const entry = registry.articles[slug];
    if (!entry) return;
    const images = { ...entry.images };
    for (const asset of assets) if (validImageReference(cache.references?.[asset.hash])) images[asset.hash] = cache.references[asset.hash];
    if (JSON.stringify(images) !== JSON.stringify(entry.images ?? {})) { entry.images = images; await store.save(registry); }
  };
  const markPublished = async prepared => {
    const entry = registry.articles[prepared.slug];
    if (!entry) return;
    if (entry.stage !== 'published' || entry.sourceHash !== prepared.sourceHash) {
      Object.assign(entry, { stage: 'published', sourceHash: prepared.sourceHash, sourceCommit });
      await store.save(registry);
    }
  };
  cache.references ??= {};
  for (const entry of Object.values(registry.articles)) for (const [hash, reference] of Object.entries(entry.images ?? {})) if (/^[a-f0-9]{64}$/.test(hash) && validImageReference(reference)) cache.references[hash] = reference;
  let owned;
  for (const item of pending) {
    const slug = item.prepared.slug;
    try {
      if (!config.newArticles?.enabled) { record(slug, { status: 'new_article_disabled' }); continue; }
      let prepared = prepare(slug);
      let entry = registry.articles[slug];
      if (entry?.stage === 'allocating') fail('CREATE_OUTCOME_UNKNOWN', 'An earlier allocation has no confirmed ID; reconcile it before creating anything.');
      owned ??= await editor.ownArticles(config.authorUrlToken);
      if (owned.some(article => article.title === prepared.title && article.id !== entry?.id)) fail('UNMAPPED_EXISTING_ARTICLE', 'An existing article has this title; bind its ID before proceeding.');
      if (!entry?.id && mode === 'verify') { record(slug, { status: 'new_article', title: prepared.title, sourceHash: prepared.sourceHash }); continue; }
      if (!entry?.id) {
        entry = registry.articles[slug] = { id: null, stage: 'allocating', sourceUrl: sourceUrl(config, slug), sourceHash: prepared.sourceHash, sourceCommit, ...(initial.articles[slug].column ? { column: initial.articles[slug].column } : {}) };
        await store.save(registry);
        await editor.createDraft(prepared, async id => {
          Object.assign(entry, { id, stage: 'draft' });
          await store.save(registry);
        });
        if (!entry.id) fail('CREATE_OUTCOME_UNKNOWN', 'The allocated ID was not persisted.');
      }
      prepared = prepare(slug);
      const result = await editor.runNew(prepared, item.assets, cache, {
        mode, outputDirectory: path.join(output, slug), declaration: config.newArticles.declaration,
        allowSubmit: entry.stage !== 'publishing', saveCache: () => persistImages(slug, item.assets),
        onBeforeSubmit: async () => { entry.stage = 'publishing'; await store.save(registry); },
      });
      record(slug, result);
      if (result.status === 'failed') { if (stopsBatch(result.code)) return; continue; }
      if (mode === 'apply' && ['created', 'updated', 'already_current'].includes(result.status)) {
        await markPublished(prepared); createdHtml.set(slug, prepared.html);
      }
    } catch (error) {
      record(slug, { ...outcomes.get(slug), status: 'failed', code: error.code ?? 'NEW_ARTICLE_FAILED', id: registry.articles[slug]?.id });
      if (stopsBatch(error.code)) return;
    }
  }
  // Render again after allocation/publication so cross-article links and navigation
  // use final published IDs. Disabled existing articles remain excluded by the caller.
  for (const item of items) {
    const slug = item.prepared.slug;
    if (outcomes.get(slug)?.status === 'failed') continue;
    if (pending.includes(item) && !createdHtml.has(slug)) continue;
    try {
      const prepared = prepare(slug);
      if (createdHtml.get(slug) === prepared.html) continue;
      const result = await editor.run(prepared, item.assets, cache, { mode, outputDirectory: path.join(output, slug), saveCache: () => persistImages(slug, item.assets) });
      const wasCreated = outcomes.get(slug)?.status === 'created';
      record(slug, wasCreated && result.status !== 'failed' ? { ...result, status: 'created', navigationRefreshed: true } : result);
      if (result.status === 'failed') { if (stopsBatch(result.code)) return; continue; }
      if (mode === 'apply') await markPublished(prepared);
    } catch (error) { record(slug, { ...outcomes.get(slug), status: 'failed', code: error.code ?? 'SYNC_FAILED' }); if (stopsBatch(error.code)) return; }
  }
}
