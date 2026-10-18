import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { articleUrl, compareArticle, describeHtml, fail, isZhihuImage, materializeImages, normalizeText, redactImageUrls, validImageReference, writeJson } from './core.mjs';
import { editorMetadata, publishedArticle } from './web.mjs';
const imageIdentity = value => {
  if (!value) return null;
  const url = new URL(value);
  return url.pathname.match(/v2-[a-z0-9]+/i)?.[0] ?? url.pathname;
};
const sameMetadata = (a, b) => JSON.stringify(a.topics) === JSON.stringify(b.topics) && JSON.stringify(a.columns) === JSON.stringify(b.columns) && a.declaration === b.declaration && imageIdentity(a.cover) === imageIdentity(b.cover);

async function loadImages(page, rootSelector) {
  for (const image of await page.locator(`${rootSelector} img`).all()) await image.scrollIntoViewIfNeeded();
  try {
    await page.waitForFunction(selector => [...document.querySelectorAll(`${selector} img`)].every(image => image.complete), rootSelector, { timeout: 20_000 });
  } catch { /* A missing image is reported by verification instead of hanging the job. */ }
  return page.locator(`${rootSelector} img`).evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0));
}

export async function readStorageState(file) {
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch { fail('AUTH_STATE_INVALID', 'The authentication state file is missing or invalid.'); }
  if (!Array.isArray(state.cookies) || !state.cookies.length || !Array.isArray(state.origins)) fail('AUTH_STATE_INVALID', 'The authentication state has no cookies.');
  if (state.cookies.some(cookie => !/^\.?([a-z0-9-]+\.)*zhihu\.com$/i.test(cookie.domain ?? ''))) fail('AUTH_STATE_INVALID', 'Authentication state must contain only Zhihu cookies.');
  if (state.origins.some(entry => { try { const u = new URL(entry.origin); return u.protocol !== 'https:' || !(u.hostname === 'zhihu.com' || u.hostname.endsWith('.zhihu.com')); } catch { return true; } })) fail('AUTH_STATE_INVALID', 'Authentication state must contain only Zhihu origins.');
  return state;
}

export async function launchSession(stateFile, { headed = false } = {}) {
  const storageState = await readStorageState(stateFile);
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ storageState, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(15_000);
  return { browser, context };
}

export class ZhihuEditor {
  constructor(context, { urlFor = articleUrl, writerUrl = 'https://zhuanlan.zhihu.com/write', profileFor = author => `https://www.zhihu.com/people/${author}/posts`, anonymousContextFactory } = {}) {
    this.context = context;
    this.urlFor = urlFor;
    this.writerUrl = writerUrl;
    this.profileFor = profileFor;
    this.uploadReferences = new Map();
    this.anonymousContextFactory = anonymousContextFactory ?? (options => this.context.browser().newContext(options));
  }

  async ownArticles(authorUrlToken) {
    const page = await this.context.newPage();
    try {
      await page.goto(this.profileFor(authorUrlToken), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const me = await page.evaluate(async () => {
        const response = await fetch('/api/v4/me', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
        if (!response.ok) return null;
        try { return { urlToken: (await response.json()).url_token }; } catch { return null; }
      });
      if (me?.urlToken !== authorUrlToken) fail('AUTHOR_MISMATCH', 'The authenticated account is not the configured author.');
      const articles = [];
      const seen = new Set();
      for (let offset = 0; offset < 1000; offset += 20) {
        const result = await page.evaluate(async ({ author, offset }) => {
          const response = await fetch(`/api/v4/members/${author}/articles?offset=${offset}&limit=20`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
          let data; try { data = await response.json(); } catch { /* Validate without upstream diagnostic text. */ }
          return { status: response.status, data };
        }, { author: authorUrlToken, offset });
        if (result.status !== 200 || !Array.isArray(result.data?.data) || typeof result.data.paging?.is_end !== 'boolean') fail('AUTHOR_LIST_UNAVAILABLE', 'The owned article list could not be verified.');
        for (const article of result.data.data) {
          if (typeof article.id !== 'string' || !/^\d{5,30}$/.test(article.id) || typeof article.title !== 'string' || article.author?.url_token !== authorUrlToken || seen.has(article.id)) fail('AUTHOR_LIST_UNAVAILABLE', 'The owned article list contains ambiguous identities.');
          seen.add(article.id); articles.push({ id: article.id, title: article.title });
        }
        if (result.data.paging.is_end) { this.verifiedAuthor = authorUrlToken; return articles; }
        if (!result.data.data.length) break;
      }
      fail('AUTHOR_LIST_UNAVAILABLE', 'The complete owned article list could not be confirmed.');
    } finally { await page.close(); }
  }

  async createDraft(prepared, onAllocated) {
    if (this.verifiedAuthor !== prepared.authorUrlToken) fail('AUTH_REQUIRED', 'Verify the logged-in author before allocating an article.');
    const page = await this.context.newPage();
    try {
      await page.goto(this.writerUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const title = page.getByPlaceholder('请输入标题（最多 100 个字）');
      await title.waitFor({ state: 'visible', timeout: 25_000 });
      const allocation = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === new URL(this.writerUrl).origin && url.pathname === '/api/articles/drafts' && response.request().method() === 'POST';
      }, { timeout: 45_000 }).catch(() => null);
      await title.fill(prepared.title);
      const response = await allocation;
      if (!response?.ok()) fail('CREATE_OUTCOME_UNKNOWN', 'The draft allocation was not acknowledged; do not allocate another article.');
      let data; try { data = await response.json(); } catch { fail('CREATE_OUTCOME_UNKNOWN', 'The draft allocation returned invalid JSON.'); }
      if (typeof data.id !== 'string' || !/^\d{5,30}$/.test(data.id)) fail('CREATE_OUTCOME_UNKNOWN', 'The allocated article ID could not be confirmed.');
      await onAllocated(data.id);
      return data.id;
    } finally { await page.close(); }
  }

  async publishedData(page, prepared) {
    const result = await page.evaluate(async id => {
      try {
        const response = await fetch(`/api/articles/${id}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000) });
        let data;
        try { data = await response.json(); } catch { /* Return a safe validation error, never raw upstream text. */ }
        return { status: response.status, data };
      } catch { return { status: 0 }; }
    }, prepared.id);
    if (result.status === 401) fail('AUTH_REQUIRED', 'Zhihu requires a renewed login session.');
    if (result.status === 403) fail('ARTICLE_ACCESS_RESTRICTED', 'Zhihu refused the website article read.');
    if (result.status === 429) fail('WEBSITE_RATE_LIMITED', 'Zhihu rate-limited the website article read.');
    if (result.status !== 200) fail('WEBSITE_READ_FAILED', 'The website article read did not succeed.');
    return result.data;
  }

  async publicArticle(page, prepared, controls) {
    controls ??= await this.openEditor(page, prepared);
    const article = publishedArticle(await this.publishedData(page, prepared), prepared, { legacyNoDeclaration: controls.legacyNoDeclaration });
    if (article.declarationReadSource && article.declaration !== controls.metadata.declaration) fail('EDITOR_METADATA_INVALID', 'The editor and published creation statement disagree.');
    const imageUrls = describeHtml(article.html).images;
    if (!imageUrls.every(isZhihuImage)) fail('PUBLISHED_IMAGE_INVALID', 'Published body images must use Zhihu CDN URLs.');
    const imagesLoaded = await page.evaluate(async urls => (await Promise.all(urls.map(url => new Promise(resolve => {
      const image = new Image();
      const timer = setTimeout(() => resolve(false), 20_000);
      image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth > 0); };
      image.onerror = () => { clearTimeout(timer); resolve(false); };
      image.src = url;
    })))).every(Boolean), imageUrls);
    return { ...article, imageUrls, imagesLoaded };
  }

  async openEditor(page, prepared, { allowDraft = false } = {}) {
    const expectedOrigin = new URL(this.urlFor(prepared.id)).origin;
    const metadataResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === expectedOrigin && url.pathname === `/api/articles/${prepared.id}/draft` && response.request().method() === 'GET';
    }, { timeout: 45_000 }).catch(() => null);
    await page.goto(this.urlFor(prepared.id) + '/edit', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const title = page.getByPlaceholder('请输入标题（最多 100 个字）');
    try {
      await title.waitFor({ state: 'visible', timeout: 25_000 });
    } catch { fail('AUTH_REQUIRED', 'The existing-article editor is unavailable. Refresh the dedicated Zhihu login session; no new article was created.'); }
    const body = page.locator('[contenteditable="true"][role="textbox"]');
    if (await body.count() !== 1) fail('EDITOR_CHANGED', 'The article body editor is ambiguous.');
    const response = await metadataResponse;
    if (!response?.ok()) fail('EDITOR_METADATA_INVALID', 'The editor did not return its article settings.');
    let data;
    try { data = await response.json(); } catch { fail('EDITOR_METADATA_INVALID', 'The editor settings response is invalid.'); }
    await page.getByRole('button', { name: data.state === 'draft' ? '发布' : '更新', exact: true }).waitFor({ state: 'visible' });
    if (typeof data.title !== 'string' || typeof data.content !== 'string') fail('EDITOR_METADATA_INVALID', 'The server did not return the saved draft content.');
    const savedArticle = { title: data.title, html: data.content };
    try {
      await page.waitForFunction(expected => {
        const body = document.querySelector('[contenteditable="true"][role="textbox"]')?.cloneNode(true);
        body?.querySelectorAll('figcaption.is-placeholder,.public-DraftEditorPlaceholder-root').forEach(element => element.remove());
        return document.querySelector('textarea[placeholder="请输入标题（最多 100 个字）"]')?.value === expected.title && body?.textContent.normalize('NFC').replace(/[\s\u200B-\u200D\uFEFF]/gu, '') === expected.text;
      }, { title: savedArticle.title, text: describeHtml(savedArticle.html).text }, { timeout: 15_000 });
    } catch { fail('EDITOR_CONTENT_UNAVAILABLE', 'The editor has not loaded its server-saved draft.'); }
    const statementControl = page.getByRole('combobox').filter({ hasText: /无声明|包含剧透|包含医疗建议|虚构创作|包含理财内容|包含 AI 辅助创作/ });
    const noDeclarationSelected = await statementControl.count() === 1 && normalizeText(await statementControl.innerText()) === '无声明';
    let legacyPublished;
    if (data.state === 'published' && !Object.hasOwn(data, 'creationStatement')) {
      if (!noDeclarationSelected) fail('EDITOR_METADATA_INVALID', 'The omitted creation statement is not confirmed by the editor.');
      const publishedData = await this.publishedData(page, prepared);
      legacyPublished = publishedArticle(publishedData, prepared, { legacyNoDeclaration: true });
      if (legacyPublished.declaration !== '无声明') fail('EDITOR_METADATA_INVALID', 'The omitted editor statement conflicts with the published statement.');
      data.creationStatement = null;
    }
    if (data.state === 'published' && !Object.hasOwn(data, 'column')) {
      // Ordinary published articles omit column in /draft. Confirm its absence
      // against the independently published response before completing metadata.
      const publishedData = await this.publishedData(page, prepared);
      const published = publishedArticle(publishedData, prepared, { legacyNoDeclaration: noDeclarationSelected && (data.creationStatement === null || data.creationStatement?.disclaimer_status === 'close') });
      if (publishedData.has_column !== false || published.columns.length) fail('EDITOR_METADATA_INVALID', 'The missing editor column could not be confirmed as empty.');
      data.column = [];
    }
    const metadata = editorMetadata(data, prepared, { allowDraft });
    if (legacyPublished && !sameMetadata(metadata, legacyPublished)) fail('EDITOR_METADATA_INVALID', 'Legacy editor settings disagree with the published article.');
    return { title, body, metadata, savedArticle, articleState: data.state, legacyNoDeclaration: noDeclarationSelected && metadata.declaration === '无声明' };
  }

  async confirmSavedDraft(prepared, original, outputDirectory, options = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await this.context.newPage();
      try {
        const controls = await this.openEditor(page, prepared, options);
        const validation = compareArticle(prepared, controls.savedArticle);
        validation.checks.metadata = sameMetadata(original, controls.metadata);
        validation.ok = Object.values(validation.checks).every(Boolean);
        await writeJson(path.join(outputDirectory, `saved-draft-read-${attempt + 1}.json`), { ...controls.savedArticle, ...controls.metadata });
        await writeJson(path.join(outputDirectory, 'saved-draft-validation.json'), validation);
        if (validation.ok) {
          await writeJson(path.join(outputDirectory, 'saved-draft.json'), { ...controls.savedArticle, ...controls.metadata });
          return;
        }
      } finally { await page.close(); }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    fail('DRAFT_NOT_SAVED', 'The server has not saved the intended draft and settings; Update was not clicked.');
  }

  async uploadImage(page, body, asset) {
    const original = await body.locator('img').evaluateAll(images => images.map(img => img.src));
    await body.click();
    await body.press('ControlOrMeta+End');
    const input = page.locator('input[type="file"][accept="image/*"]');
    if (!await input.count()) {
      await page.getByRole('button', { name: '图片', exact: true }).click();
      try { await input.waitFor({ state: 'attached', timeout: 5000 }); }
      catch { fail('IMAGE_UPLOAD_UI_CHANGED', 'The body-image upload input is unavailable.'); }
    }
    if (await input.count() !== 1) fail('IMAGE_UPLOAD_UI_CHANGED', 'The body-image upload input is ambiguous.');
    const completion = page.waitForResponse(async response => {
      const url = new URL(response.url());
      if (url.hostname !== 'api.zhihu.com' || !/^\/images\/\d+$/.test(url.pathname) || response.request().method() !== 'GET' || !response.ok()) return false;
      try { const data = await response.json(); return isZhihuImage(data.original_src) || isZhihuImage(data.src); } catch { return false; }
    }, { timeout: 90_000 }).then(async response => {
      const data = await response.json();
      const url = isZhihuImage(data.original_src) ? data.original_src : data.src;
      const variants = [...new Set([data.src, data.original_src, data.watermark_src].filter(isZhihuImage).map(imageIdentity))];
      this.uploadReferences.set(url, { imageId: new URL(response.url()).pathname.split('/').at(-1), imageHash: imageIdentity(url), variants });
      return url;
    }).catch(() => null);
    await input.setInputFiles(asset.file);
    try {
      const inserted = page.waitForFunction(({ original }) => {
        const root = document.querySelector('[contenteditable="true"][role="textbox"]');
        const images = [...root.querySelectorAll('img')];
        return images.some(img => /https:\/\/[^/]+\.zhimg\.com\//.test(img.src) && (!original.includes(img.src) || images.length > original.length) && img.complete && img.naturalWidth > 0);
      }, { original }, { timeout: 90_000 }).then(async () => {
        const urls = await body.locator('img').evaluateAll(images => images.map(img => img.src));
        return urls.find(value => !original.includes(value) && isZhihuImage(value)) ?? (urls.length > original.length ? urls.filter(isZhihuImage).at(-1) : null);
      }).catch(() => null);
      const url = await Promise.race([completion, inserted]);
      if (!isZhihuImage(url)) fail('IMAGE_UPLOAD_FAILED', 'The native upload did not return an acknowledged image.');
      await page.keyboard.press('Escape');
      return url;
    } catch { fail('IMAGE_UPLOAD_FAILED', 'The editor did not confirm a completed image upload.'); }
  }

  rememberImage(cache, asset, url, reference = this.uploadReferences.get(url)) {
    const stored = reference ?? cache.references?.[asset.hash] ?? { imageHash: imageIdentity(url) };
    if (!validImageReference(stored)) fail('IMAGE_ID_UNKNOWN', 'The uploaded image has no stable identity.');
    cache.images[asset.hash] = url;
    cache.references ??= {};
    cache.references[asset.hash] = stored;
  }

  async cachedImage(page, cache, asset, article) {
    const reference = cache.references?.[asset.hash];
    const hashes = reference ? [reference.imageHash, ...(reference.variants ?? [])] : [imageIdentity(cache.images[asset.hash])];
    const existing = (article?.imageUrls ?? describeHtml(article?.html ?? '').images).find(url => isZhihuImage(url) && hashes.includes(imageIdentity(url)));
    if (existing && article?.imagesLoaded) { this.rememberImage(cache, asset, existing, reference); return existing; }
    if (reference?.imageId) {
      try {
        const response = await this.context.request.get(`https://api.zhihu.com/images/${reference.imageId}`, { timeout: 20_000 });
        if (response.ok()) {
          const data = await response.json();
          const url = [data.original_src, data.src].find(url => isZhihuImage(url) && hashes.includes(imageIdentity(url)));
          if (url) { this.rememberImage(cache, asset, url, reference); return url; }
        }
      } catch { /* Reuse only a freshly acknowledged address. */ }
    }
    if (existing) { this.rememberImage(cache, asset, existing, reference); return existing; }
    const cached = cache.images[asset.hash];
    if (isZhihuImage(cached)) {
      try {
        const response = await this.context.request.get(cached, { timeout: 15_000 });
        const valid = response.ok() && response.headers()['content-type']?.startsWith('image/');
        await response.dispose();
        if (valid) { this.rememberImage(cache, asset, cached, reference); return cached; }
      } catch { /* A stale runtime address is not persisted or reused. */ }
    }
    return null;
  }

  withImages(prepared, uploaded, cache, assets) {
    const imageAliases = {};
    for (const asset of assets) {
      const reference = cache.references?.[asset.hash];
      if (reference) for (const variant of reference.variants ?? []) imageAliases[variant] = reference.imageHash;
    }
    return { ...prepared, html: materializeImages(prepared.html, uploaded), imageAliases };
  }

  async publicImagesLoad(urls) {
    if (!urls.length) return true;
    const context = await this.anonymousContextFactory({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await context.newPage();
      return await page.evaluate(async urls => (await Promise.all(urls.map(url => new Promise(resolve => {
        const image = new Image();
        const timer = setTimeout(() => resolve(false), 20_000);
        image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth > 0); };
        image.onerror = () => { clearTimeout(timer); resolve(false); };
        image.src = url;
      })))).every(Boolean), urls);
    } finally { await context.close(); }
  }

  async setBody(page, controls, prepared) {
    await controls.title.fill(prepared.title);
    await page.bringToFront();
    await this.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await page.evaluate(async html => {
      const text = new DOMParser().parseFromString(html, 'text/html').body.textContent;
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
    }, prepared.html);
    try {
    await controls.body.click();
    if (await controls.body.locator('img').count()) {
      // Draft.js cannot select a document consisting only of an atomic image.
      // A trailing editable paragraph gives Select All a valid text boundary.
      await controls.body.focus();
      await controls.body.press('ControlOrMeta+End');
      await controls.body.press('Enter');
    }
    await controls.body.press('ControlOrMeta+A');
    // Replacing a selection that contains an existing image can leave Chromium's
    // contenteditable empty. Collapse the old selection in a separate input step.
    await controls.body.press('Backspace');
    await page.waitForFunction(() => {
      const editor = document.querySelector('[contenteditable="true"][role="textbox"]');
      return editor && !editor.textContent.replace(/[\s\u200B-\u200D\uFEFF]/gu, '') && !editor.querySelector('img');
    }, null, { timeout: 10_000 });
    // Deleting an image selection may detach the selection's anchor while the
    // editing host stays focused. Establish a fresh insertion point before paste.
    await controls.body.click();
    await controls.body.press('ControlOrMeta+V');
    } finally {
      // The paste event has captured its HTML; do not retain signed image URLs.
      await page.evaluate(() => navigator.clipboard.writeText('')).catch(() => {});
    }
    // Chromium and rich-text editors import HTML containing images asynchronously.
    // Wait on the intended text, not an arbitrary sleep or the keypress completing.
    try {
      await page.waitForFunction(expected => {
        const editor = document.querySelector('[contenteditable="true"][role="textbox"]')?.cloneNode(true);
        editor?.querySelectorAll('figcaption.is-placeholder,.public-DraftEditorPlaceholder-root').forEach(element => element.remove());
        return editor?.textContent.normalize('NFC').replace(/[\s\u200B-\u200D\uFEFF]/gu, '') === expected;
      }, describeHtml(prepared.html).text, { timeout: 15_000 });
    } catch { /* Capture the actual editor contents and fail the format check below. */ }
    const imagesLoaded = await loadImages(page, '[contenteditable="true"][role="textbox"]');
    const actual = { title: await controls.title.inputValue(), html: await controls.body.innerHTML(), imagesLoaded };
    const validation = compareArticle(prepared, actual);
    if (!validation.ok) {
      const error = new Error('Editor content did not preserve the prepared format.');
      error.code = 'EDITOR_FORMAT_MISMATCH';
      error.validation = validation;
      error.editorSnapshot = actual;
      throw error;
    }
    return validation;
  }

  async preserveDeclaration(page, original) {
    const choices = page.getByRole('combobox').filter({ hasText: /无声明|包含剧透|包含医疗建议|虚构创作|包含理财内容|包含 AI 辅助创作/ });
    if (await choices.count() !== 1) fail('EDITOR_CHANGED', 'The creation statement control is ambiguous.');
    if (!normalizeText(await choices.innerText()).includes(normalizeText(original.declaration))) {
      await choices.click();
      await page.getByRole('option', { name: original.declaration, exact: true }).click();
    }
  }

  async confirmPublished(prepared, original, outputDirectory) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await this.context.newPage();
      try {
        const published = await this.publicArticle(page, prepared);
        const validation = compareArticle(prepared, published);
        validation.checks.metadata = sameMetadata(original, published);
        validation.ok = Object.values(validation.checks).every(Boolean);
        if (validation.ok) { validation.checks.publicImages = await this.publicImagesLoad(published.imageUrls); validation.ok = Object.values(validation.checks).every(Boolean); }
        await writeJson(path.join(outputDirectory, 'after.json'), published);
        await writeJson(path.join(outputDirectory, 'validation.json'), validation);
        if (validation.ok) {
          await page.screenshot({ path: path.join(outputDirectory, 'after.png') });
          return validation;
        }
      } catch (error) {
        if (['ARTICLE_ACCESS_RESTRICTED', 'AUTH_REQUIRED', 'AUTHOR_MISMATCH', 'COLUMN_MISMATCH', 'EDITOR_METADATA_INVALID', 'WEBSITE_ARTICLE_INVALID', 'WEBSITE_RATE_LIMITED'].includes(error.code) || attempt === 2) throw error;
      } finally { await page.close(); }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    fail('PUBLIC_VERIFY_FAILED', 'The published article did not match the blog; publication was not repeated.');
  }

  async runNew(prepared, assets, cache, { mode, outputDirectory, declaration, allowSubmit = true, prepareOnly = false, saveCache = async () => {}, onBeforeSubmit }) {
    const page = await this.context.newPage();
    let submitted = !allowSubmit;
    let draftChanged = false;
    let phase = 'open-editor';
    const writes = [];
    page.on('response', response => {
      const url = new URL(response.url());
      const method = response.request().method();
      if (['zhuanlan.zhihu.com', 'www.zhihu.com'].includes(url.hostname) && ['POST', 'PUT', 'PATCH'].includes(method) && /articles|\/content\/publish/.test(url.pathname)) writes.push({ method, path: url.pathname, status: response.status() });
    });
    await fs.mkdir(outputDirectory, { recursive: true });
    try {
      const controls = await this.openEditor(page, prepared, { allowDraft: true });
      if (controls.articleState === 'published') return await this.run(prepared, assets, cache, { mode, outputDirectory, saveCache });
      await writeJson(path.join(outputDirectory, 'before-draft.json'), { ...controls.savedArticle, ...controls.metadata });
      if (mode === 'verify') return { status: 'draft_pending', id: prepared.id, editorAccessible: true, sourceHash: prepared.sourceHash };
      if (!allowSubmit) fail('WRITE_OUTCOME_UNKNOWN', 'An earlier publication is unconfirmed; only read-only reconciliation is allowed.');
      const uploaded = {};
      phase = 'resolve-images';
      for (const asset of assets) {
        uploaded[asset.key] = await this.cachedImage(page, cache, asset, controls.savedArticle);
        if (!uploaded[asset.key]) {
          draftChanged = true;
          uploaded[asset.key] = await this.uploadImage(page, controls.body, asset);
          this.rememberImage(cache, asset, uploaded[asset.key]);
          await saveCache();
        }
      }
      const expected = this.withImages(prepared, uploaded, cache, assets);
      await fs.writeFile(path.join(outputDirectory, 'rendered.html'), redactImageUrls(expected.html));
      phase = 'replace-body';
      let draftValidation = compareArticle(expected, { ...controls.savedArticle, imagesLoaded: await loadImages(page, '[contenteditable="true"][role="textbox"]') });
      if (!draftValidation.ok) { draftChanged = true; draftValidation = await this.setBody(page, controls, expected); }
      phase = 'creation-statement';
      await this.preserveDeclaration(page, { declaration });
      const statement = page.getByRole('combobox').filter({ hasText: /无声明|包含剧透|包含医疗建议|虚构创作|包含理财内容|包含 AI 辅助创作/ });
      if (await statement.count() !== 1 || normalizeText(await statement.innerText()) !== normalizeText(declaration)) fail('DECLARATION_NOT_SET', 'The publication form did not keep the intended creation statement.');
      draftValidation.checks.declarationForm = true;
      if (prepared.column) {
        await page.getByText('发布到专栏', { exact: true }).click();
        const selected = page.getByRole('combobox').filter({ hasText: prepared.column.title });
        if (await selected.count() !== 1) {
          const selector = page.getByRole('combobox').filter({ hasText: /选择专栏/ });
          if (await selector.count() !== 1) fail('COLUMN_SELECTOR_CHANGED', 'The column selection control is ambiguous.');
          await selector.click();
          await page.getByRole('option', { name: prepared.column.title, exact: true }).click();
        }
      } else {
        const ordinary = page.getByText('不发布到专栏', { exact: true });
        if (await ordinary.count() === 1) await ordinary.click();
      }
      const expectedMetadata = { ...controls.metadata, declaration, columns: prepared.column ? [prepared.column.id] : [] };
      await writeJson(path.join(outputDirectory, 'draft-validation.json'), draftValidation);
      await writeJson(path.join(outputDirectory, 'publish-settings.json'), expectedMetadata);
      phase = 'confirm-saved-draft';
      // New-article declaration/column choices belong to the publication form;
      // the draft endpoint retains its original settings until publication.
      await this.confirmSavedDraft(expected, controls.metadata, outputDirectory, { allowDraft: true });
      if (prepareOnly) return { status: 'draft_ready', id: prepared.id, validation: draftValidation, sourceHash: prepared.sourceHash };
      await onBeforeSubmit();
      submitted = true;
      phase = 'publish';
      try { await page.getByRole('button', { name: '发布', exact: true }).click(); } catch { /* Reconcile the persisted ID without allocating or clicking again. */ }
      try { await page.waitForURL(this.urlFor(prepared.id), { timeout: 30_000, waitUntil: 'domcontentloaded' }); } catch { /* Published-body verification determines the result. */ }
      const validation = await this.confirmPublished(expected, expectedMetadata, outputDirectory);
      return { status: 'created', id: prepared.id, url: this.urlFor(prepared.id), submitted: true, validation, sourceHash: prepared.sourceHash };
    } catch (error) {
      const failure = { status: 'failed', code: error.code ?? (submitted ? 'WRITE_OUTCOME_UNKNOWN' : 'BROWSER_FAILED'), phase, errorType: error.name, id: prepared.id, submitted, draftChanged, sourceHash: prepared.sourceHash };
      if (error.validation) failure.validation = error.validation;
      if (error.editorSnapshot) await writeJson(path.join(outputDirectory, 'editor-format-failure.json'), error.editorSnapshot);
      await writeJson(path.join(outputDirectory, 'failure.json'), failure);
      return failure;
    } finally { await writeJson(path.join(outputDirectory, 'new-editor-write-results.json'), writes); await page.close(); }
  }

  async run(prepared, assets, cache, { mode, outputDirectory, saveCache = async () => {} }) {
    const page = await this.context.newPage();
    let submitted = false;
    let draftChanged = false;
    let editorAccessible = false;
    let expected = prepared;
    const writes = [];
    page.on('response', response => {
      const url = new URL(response.url());
      const request = response.request();
      if (url.origin !== new URL(this.urlFor(prepared.id)).origin || !url.pathname.startsWith(`/api/articles/${prepared.id}`) || !['POST', 'PUT', 'PATCH'].includes(request.method())) return;
      let bodyMatchesExpected = null;
      try {
        const payload = request.postDataJSON();
        if (typeof payload?.content === 'string') bodyMatchesExpected = compareArticle(expected, { title: payload.title ?? expected.title, html: payload.content }).ok;
      } catch { /* Keep only status and a semantic match flag, never raw request data. */ }
      writes.push({ method: request.method(), path: url.pathname, status: response.status(), bodyMatchesExpected });
    });
    await fs.mkdir(outputDirectory, { recursive: true });
    try {
      const initialControls = await this.openEditor(page, prepared);
      editorAccessible = true;
      const original = await this.publicArticle(page, prepared, initialControls);
      await writeJson(path.join(outputDirectory, 'before.json'), original);
      await fs.writeFile(path.join(outputDirectory, 'before.html'), redactImageUrls(original.html));
      await page.screenshot({ path: path.join(outputDirectory, 'before.png') });
      const uploaded = {};
      for (const asset of assets) {
        uploaded[asset.key] = await this.cachedImage(page, cache, asset, original);
        if (!uploaded[asset.key]) uploaded[asset.key] = await this.cachedImage(page, cache, asset, initialControls.savedArticle);
      }
      const allCached = assets.every(asset => uploaded[asset.key]);
      if (allCached) {
        expected = this.withImages(prepared, uploaded, cache, assets);
        const current = compareArticle(expected, original);
        if (current.ok) {
          current.checks.publicImages = await this.publicImagesLoad(original.imageUrls);
          current.ok = Object.values(current.checks).every(Boolean);
          if (!current.ok) fail('PUBLIC_IMAGE_UNAVAILABLE', 'Published images did not load without the owner session.');
          return { status: 'already_current', id: prepared.id, url: this.urlFor(prepared.id), validation: current, sourceHash: prepared.sourceHash, editorAccessible };
        }
      }
      if (mode === 'verify') return { status: allCached ? 'different' : 'assets_pending', id: prepared.id, url: this.urlFor(prepared.id), validation: allCached ? compareArticle(expected, original) : undefined, sourceHash: prepared.sourceHash, editorAccessible };
      const controls = initialControls;
      editorAccessible = true;
      await writeJson(path.join(outputDirectory, 'before-editor.json'), { title: await controls.title.inputValue(), html: await controls.body.innerHTML() });
      for (const asset of assets) {
        if (uploaded[asset.key]) continue;
        draftChanged = true;
        const url = await this.uploadImage(page, controls.body, asset);
        uploaded[asset.key] = url;
        this.rememberImage(cache, asset, url);
        await saveCache();
      }
      expected = this.withImages(prepared, uploaded, cache, assets);
      await fs.writeFile(path.join(outputDirectory, 'rendered.html'), redactImageUrls(expected.html));
      let draftValidation = compareArticle(expected, { ...controls.savedArticle, imagesLoaded: await loadImages(page, '[contenteditable="true"][role="textbox"]') });
      if (!draftValidation.ok) { draftChanged = true; draftValidation = await this.setBody(page, controls, expected); }
      await this.preserveDeclaration(page, original);
      await writeJson(path.join(outputDirectory, 'draft-validation.json'), draftValidation);
      await this.confirmSavedDraft(expected, original, outputDirectory);
      // Publish exactly once. A timeout after this point is reconciled by reading the original URL.
      submitted = true;
      try { await page.getByRole('button', { name: '更新', exact: true }).click(); } catch { /* The click may already have submitted. Reconcile without clicking again. */ }
      try { await page.waitForURL(this.urlFor(prepared.id), { timeout: 30_000, waitUntil: 'domcontentloaded' }); } catch { /* Read-only reconciliation below. */ }
      let validation;
      for (let attempt = 0; attempt < 3; attempt++) {
        const verificationPage = await this.context.newPage();
        try {
          const published = await this.publicArticle(verificationPage, prepared);
          validation = compareArticle(expected, published);
          validation.checks.metadata = sameMetadata(original, published);
          validation.ok = Object.values(validation.checks).every(Boolean);
          await writeJson(path.join(outputDirectory, 'after.json'), published);
          await writeJson(path.join(outputDirectory, 'validation.json'), validation);
          if (validation.ok) {
            await verificationPage.screenshot({ path: path.join(outputDirectory, 'after.png') });
            return { status: 'updated', id: prepared.id, url: this.urlFor(prepared.id), validation, sourceHash: prepared.sourceHash };
          }
        } catch (error) {
          if (['ARTICLE_ACCESS_RESTRICTED', 'AUTH_REQUIRED', 'AUTHOR_MISMATCH', 'COLUMN_MISMATCH', 'EDITOR_METADATA_INVALID', 'WEBSITE_ARTICLE_INVALID', 'WEBSITE_RATE_LIMITED'].includes(error.code)) throw error;
          if (attempt === 2) throw error;
        } finally { await verificationPage.close(); }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      fail('PUBLIC_VERIFY_FAILED', 'Published content or metadata did not match the source; the update was not submitted again.');
    } catch (error) {
      const failure = { status: 'failed', code: error.code ?? (submitted ? 'WRITE_OUTCOME_UNKNOWN' : 'BROWSER_FAILED'), submitted, draftChanged, editorAccessible, id: prepared.id, sourceHash: prepared.sourceHash };
      if (error.validation) failure.validation = error.validation;
      if (error.editorSnapshot) await writeJson(path.join(outputDirectory, 'editor-format-failure.json'), error.editorSnapshot);
      await writeJson(path.join(outputDirectory, 'failure.json'), failure);
      // Do not persist arbitrary error messages, browser traces, login pages, cookies, or authentication screenshots.
      return failure;
    } finally {
      await writeJson(path.join(outputDirectory, 'editor-write-results.json'), writes);
      await page.close();
    }
  }
}
