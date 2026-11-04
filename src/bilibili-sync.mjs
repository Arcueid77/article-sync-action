import path from 'node:path';
import { describeHtml, sha256, writeJson, fail } from './core.mjs';
import { publicSourceUrl } from './source.mjs';
import { effectiveBilibiliConfig, renderBilibiliArticle, materializeBilibiliImages, compareBilibiliArticle, bilibiliImageUrl, normalizeBilibiliHtml } from './bilibili.mjs';

export function bilibiliContentHash(article) {
  const description = describeHtml(normalizeBilibiliHtml(article.html));
  description.images = description.images.map(bilibiliImageUrl);
  return sha256(JSON.stringify({ title: article.title, ...description }));
}

export async function synchronizeBilibili({ config, registry, store, articles, items, mode, editor, output, sourceCommit, report }) {
  await editor.assertAuthor(config.authorMid);
  for (const item of items) {
    const slug = item.prepared.slug;
    const directory = path.join(output, slug);
    let entry = registry.articles[slug];
    try {
      const effective = effectiveBilibiliConfig(config, registry, articles);
      const prepared = renderBilibiliArticle(articles.get(slug), effective, articles);
      if (entry?.stage === 'allocating') fail('CREATE_OUTCOME_UNKNOWN', 'An earlier allocation has no confirmed ID. Reconcile it before creating another draft.');
      const binding = config.articles[slug];
      entry ??= binding?.id ? { id: binding.id, stage: binding.published ? 'published' : 'draft', sourceUrl: publicSourceUrl(config, slug), ...(binding.publicUrl ? { publicUrl: binding.publicUrl } : {}), images: {} } : undefined;
      let expected;
      try { expected = { ...prepared, html: materializeBilibiliImages(prepared.html, Object.fromEntries(item.assets.map(asset => [asset.key, entry?.images?.[asset.hash]]))) }; }
      catch (error) { if (error.code !== 'ASSET_NOT_UPLOADED') throw error; }
      let published;
      if (entry && (entry.publicUrl || ['submitting', 'review_pending', 'published'].includes(entry.stage))) published = await editor.readPublished(entry, config.authorMid);
      if (entry && ['submitting', 'review_pending'].includes(entry.stage)) {
        if (!published || bilibiliContentHash(published) !== entry.renderHash) { report.articles.push({ slug, id: entry.id, status: 'review_pending' }); continue; }
        if (mode !== 'verify') { entry.stage = 'published'; entry.publicUrl = published.publicUrl; await store.save(registry); }
      }
      if (published && expected && compareBilibiliArticle(expected, published).ok) {
        if (mode !== 'verify') {
          registry.articles[slug] = { ...entry, stage: 'published', publicUrl: published.publicUrl, sourceHash: prepared.sourceHash, renderHash: bilibiliContentHash(expected), sourceCommit };
          await store.save(registry);
        }
        report.articles.push({ slug, id: entry.id, status: 'already_current', publicUrl: published.publicUrl }); continue;
      }
      if (mode === 'verify') {
        if (!entry) { report.articles.push({ slug, status: 'new_article' }); continue; }
        const actual = published ?? await editor.readDraft(entry.id);
        const validation = expected ? compareBilibiliArticle(expected, actual) : { ok: false, checks: { uploadedImages: false } };
        await writeJson(path.join(directory, 'verification.json'), validation);
        report.articles.push({ slug, id: entry.id, status: validation.ok ? 'draft_current' : 'different', validation }); continue;
      }
      if (!entry) {
        await editor.assertNoDuplicate(prepared.title);
        entry = registry.articles[slug] = { id: null, stage: 'allocating', sourceUrl: publicSourceUrl(config, slug), sourceHash: prepared.sourceHash, sourceCommit, images: {} };
        await store.save(registry);
        await editor.createDraft(prepared, async id => { entry.id = id; entry.stage = 'draft'; await store.save(registry); });
        if (!entry.id) fail('CREATE_OUTCOME_UNKNOWN', 'The draft ID was not persisted.');
      } else { registry.articles[slug] = entry; await store.save(registry); }
      // Before any editor mutation, persist the stage so a failed run resumes the same ID.
      entry.stage = 'draft'; await store.save(registry);
      expected = await editor.writeDraft(prepared, item.assets, entry, async (hash, url) => { entry.images ??= {}; entry.images[hash] = url; await store.save(registry); }, directory);
      Object.assign(entry, { stage: 'draft', sourceHash: prepared.sourceHash, sourceCommit, renderHash: bilibiliContentHash(expected) });
      await store.save(registry);
      if (mode === 'draft') { report.articles.push({ slug, id: entry.id, status: 'draft_saved' }); continue; }
      await editor.submit(entry, expected, async () => { entry.stage = 'submitting'; await store.save(registry); });
      // A submit click is never treated as publication evidence. A later run reads the public body.
      entry.stage = 'review_pending'; await store.save(registry);
      report.articles.push({ slug, id: entry.id, status: 'review_pending' });
    } catch (error) {
      report.articles.push({ slug, id: entry?.id, status: 'failed', code: error.code ?? 'BILIBILI_SYNC_FAILED' });
      if (/^REGISTRY_/.test(error.code ?? '') || ['AUTH_REQUIRED', 'AUTHOR_MISMATCH', 'WEBSITE_ACCESS_RESTRICTED', 'ARTICLE_LIST_UNCONFIRMED'].includes(error.code)) break;
    }
  }
}
