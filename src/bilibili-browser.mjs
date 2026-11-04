import path from 'node:path';
import { describeHtml, escapeHtml, fail, normalizeText, writeJson } from './core.mjs';
import { bilibiliClipboardHtml, bilibiliImageUrl, compareBilibiliArticle, decimalId, materializeBilibiliImages, publicBilibiliUrl } from './bilibili.mjs';

export function exactJson(text) {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token));
}
export function allocatedId(data) {
  const value = data?.data?.article_id ?? data?.data?.aid ?? data?.data?.id;
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return data?.code === 0 && decimalId(id) ? id : null;
}

const bodySelector = '.ql-editor[contenteditable="true"],.ProseMirror[contenteditable="true"],[contenteditable="true"][data-placeholder*="正文"]';
const savePaths = new Set(['/x/article/creative/draft/addupdate', '/x/dynamic/feed/article/draft/add', '/draft-save']);

export function bilibiliInventory(data, kind) {
  if (data?.code !== 0) fail('ARTICLE_LIST_UNCONFIRMED', 'The article inventory request failed.');
  if (kind === 'draft' && Object.hasOwn(data, 'artlist') && data.artlist === null) return { articles: [], total: 0 };
  const list = data.artlist ?? data.data;
  const articles = kind === 'draft' ? list?.drafts : list?.articles;
  const total = list?.page?.total ?? list?.page?.count;
  if (!Array.isArray(articles) || !Number.isSafeInteger(total) || total < 0) fail('ARTICLE_LIST_UNCONFIRMED', 'The owned article inventory is incomplete.');
  return { articles, total };
}

export class BilibiliEditor {
  constructor(context, { writerUrl = 'https://member.bilibili.com/platform/upload/text', accountUrl = 'https://api.bilibili.com/x/web-interface/nav', publicFor } = {}) {
    this.context = context; this.writerUrl = writerUrl; this.accountUrl = accountUrl; this.publicFor = publicFor;
  }
  async assertAuthor(mid) {
    let response, data;
    try { response = await this.context.request.get(this.accountUrl, { timeout: 30_000 }); data = exactJson(await response.text()); } catch { fail('AUTH_REQUIRED', 'Cannot confirm the Bilibili account.'); }
    if ([403, 412, 429].includes(response.status())) fail('WEBSITE_ACCESS_RESTRICTED', 'Bilibili refused this browser session; no bypass is attempted.');
    if (!response.ok() || data.code !== 0 || !data.data?.isLogin) fail('AUTH_REQUIRED', 'Log in to the dedicated Bilibili browser first.');
    if (String(data.data.mid) !== mid) fail('AUTHOR_MISMATCH', 'The Bilibili account does not match authorMid.');
  }
  async assertNoDuplicate(title) {
    for (const kind of ['article', 'draft']) {
    const found = [];
    let complete = false;
    for (let pn = 1; pn <= 100; pn++) {
      const url = new URL(`/x/article/creative/${kind}/list`, this.accountUrl);
      url.search = new URLSearchParams({ pn: String(pn), ps: '50', group: '0', sort: 'publish_time' }).toString();
      let response, data;
      try { response = await this.context.request.get(url.href, { timeout: 30_000 }); data = exactJson(await response.text()); } catch { fail('ARTICLE_LIST_UNCONFIRMED', 'Cannot confirm the owned article inventory.'); }
      if ([403, 412, 429].includes(response.status())) fail('WEBSITE_ACCESS_RESTRICTED', 'Bilibili refused the inventory request.');
      if (!response.ok()) fail('ARTICLE_LIST_UNCONFIRMED', 'The owned-article inventory request failed.');
      const { articles, total } = bilibiliInventory(data, kind);
      if (articles.some(article => article.title === title)) fail('UNMAPPED_EXISTING_ARTICLE', 'An owned article already has this title. Bind its ID first.');
      found.push(...articles);
      if (found.length >= total) { complete = true; break; }
      if (!articles.length) break;
    }
    if (!complete) fail('ARTICLE_LIST_UNCONFIRMED', 'The complete owned article inventory could not be checked.');
    }
  }
  async controls(page) {
    if (/passport\.bilibili\.com/.test(page.url())) fail('AUTH_REQUIRED', 'Bilibili redirected to login.');
    let scope = page;
    const modern = /\/platform\/upload\/text\/new-edit/.test(new URL(page.url()).pathname);
    if (modern) {
      const iframe = page.locator('iframe[src*="/york/read-editor"]');
      await iframe.waitFor({ state: 'attached', timeout: 30_000 });
      scope = await (await iframe.elementHandle()).contentFrame();
      if (!scope) fail('EDITOR_UNSUPPORTED', 'The native editor frame is unavailable.');
      await scope.waitForURL(/\/york\/read-editor/, { timeout: 30_000 });
    }
    const title = scope.locator('textarea[placeholder*="标题"],input[placeholder*="标题"]');
    const body = scope.locator(bodySelector);
    await title.first().waitFor({ state: 'visible', timeout: 30_000 });
    await body.first().waitFor({ state: 'visible', timeout: 30_000 });
    if (await title.count() !== 1 || await body.count() !== 1) fail('EDITOR_UNSUPPORTED', 'The Bilibili editor layout is ambiguous.');
    return { title, body, scope, modern };
  }
  async open(id) {
    const page = await this.context.newPage();
    try {
      const u = new URL(this.writerUrl);
      const modern = u.hostname === 'member.bilibili.com';
      let read;
      if (modern) {
        u.pathname = '/platform/upload/text/new-edit';
        if (id) u.searchParams.set('aid', id);
        if (id) read = page.waitForResponse(response => new URL(response.url()).pathname === '/x/dynamic/feed/article/draft/view', { timeout: 30_000 }).then(async response => ({ ok: response.ok(), data: exactJson(await response.text()) })).catch(() => null);
      } else if (id) { u.pathname = u.pathname.replace(/\/$/, '') + '/edit'; u.searchParams.set('aid', id); }
      await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const controls = { page, ...await this.controls(page) };
      if (read) {
        const saved = await read;
        const draft = saved?.data?.data?.draft;
        if (!saved?.ok || saved.data.code !== 0 || String(draft?.article_id) !== id || typeof draft.title !== 'string' || typeof draft.content !== 'string' || !draft.opus) fail('SAVED_DRAFT_UNCONFIRMED', 'Cannot confirm the requested server draft and rich content.');
        await controls.scope.waitForFunction(({ title, prefix, selector }) => {
          const field = document.querySelector('textarea[placeholder*="标题"]');
          const body = document.querySelector(selector);
          return field?.value === title && body && (!prefix || body.textContent.normalize('NFC').replace(/[\s\u200B-\u200D\uFEFF]/gu, '').includes(prefix));
        }, { title: draft.title, prefix: normalizeText(draft.content).slice(0, 30), selector: bodySelector }, { timeout: 20_000 });
        controls.nativeRead = { id, reader: 'bilibili-draft-view' };
      }
      return controls;
    } catch (error) { await page.close(); throw error; }
  }
  async save(page, expectedId) {
    const response = page.waitForResponse(value => {
      const u = new URL(value.url());
      return value.request().method() === 'POST' && savePaths.has(u.pathname);
    }, { timeout: 45_000 }).then(async value => ({ ok: value.ok(), data: exactJson(await value.text()) }));
    // Attach the rejection handler before clicking; an uncertain save is never retried.
    const completion = response.catch(() => null);
    const { scope } = await this.controls(page);
    const save = scope.getByText(/^(?:存草稿|保存草稿|保存为草稿)$/, { exact: true });
    if (await save.count() !== 1) fail('EDITOR_UNSUPPORTED', 'A unique native draft-save control is required.');
    await save.click();
    const result = await completion;
    const id = result?.ok && allocatedId(result.data);
    if (!id) fail('DRAFT_SAVE_UNKNOWN', 'The save result is unconfirmed. Preserve the current record and reconcile it.');
    if (expectedId && id !== expectedId) fail('REGISTRY_CONFLICT', 'The editor saved another article ID.');
    return id;
  }
  async createDraft(prepared, onAllocated) {
    const controls = await this.open();
    let observed;
    let pending = Promise.resolve();
    const capture = response => {
      if (!savePaths.has(new URL(response.url()).pathname)) return;
      pending = pending.then(async () => {
        let id;
        try { id = allocatedId(exactJson(await response.text())); } catch { return; }
        if (!id) return;
        if (observed && observed !== id) fail('CREATE_OUTCOME_UNKNOWN', 'The native editor returned more than one allocation ID.');
        if (!observed) { observed = id; await onAllocated(id); }
      });
      pending.catch(() => {});
    };
    controls.page.on('response', capture);
    try {
      // Native save allocates once. The caller has already persisted allocating.
      await controls.title.fill(prepared.title);
      // The modern editor refuses an empty body, and may autosave as soon as
      // text is inserted. Capture every allocation response before this step.
      await this.replaceBody(controls, `<p>${escapeHtml(prepared.title)}</p>`);
      const id = await this.save(controls.page);
      await pending;
      if (observed && observed !== id) fail('CREATE_OUTCOME_UNKNOWN', 'The native save returned a different allocation ID.');
      if (!observed) await onAllocated(id);
      return id;
    } finally { controls.page.off('response', capture); await controls.page.close(); }
  }
  async snapshot(controls) {
    await controls.body.locator('img').evaluateAll(images => Promise.all(images.map(image => new Promise(resolve => {
      if (image.complete) return resolve();
      const timer = setTimeout(resolve, 20_000);
      const done = () => { clearTimeout(timer); resolve(); };
      image.addEventListener('load', done, { once: true }); image.addEventListener('error', done, { once: true });
    }))));
    const html = await controls.body.innerHTML();
    const imagesLoaded = await controls.body.locator('img[src]').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0));
    return { title: await controls.title.inputValue(), html, imagesLoaded, ...(controls.nativeRead ? { id: controls.nativeRead.id, readSource: controls.nativeRead.reader } : { readSource: 'editor-dom' }) };
  }
  async readDraft(id) {
    const controls = await this.open(id);
    try { return await this.snapshot(controls); } finally { await controls.page.close(); }
  }
  async upload(controls, asset) {
    const acknowledgement = controls.page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && /upload|upcover/i.test(url.pathname) && [new URL(this.writerUrl).origin, 'https://api.bilibili.com', 'https://member.bilibili.com'].includes(url.origin) && response.headers()['content-type']?.includes('json');
    }, { timeout: 60_000 }).then(async response => ({ ok: response.ok(), data: exactJson(await response.text()) })).catch(() => null);
    const imageInput = 'input[type="file"][accept*="image"],input[type="file"][accept*=".png"],input[type="file"][accept*=".jpg"]';
    let input = controls.scope.locator(imageInput);
    const nativeImage = controls.scope.locator('eva3-toolbar-image');
    if (await input.count() !== 1 && await nativeImage.count() === 1) {
      const selected = controls.page.waitForEvent('filechooser', { timeout: 15_000 }).catch(() => null);
      await nativeImage.click();
      const chooser = await selected;
      if (!chooser) fail('IMAGE_UPLOAD_UNSUPPORTED', 'The native image toolbar did not open a file picker.');
      await chooser.setFiles(asset.file);
    } else {
      if (await input.count() !== 1) {
        const imageButton = controls.scope.getByRole('button', { name: /图片|上传图片/ });
        if (await imageButton.count() !== 1) fail('IMAGE_UPLOAD_UNSUPPORTED', 'Cannot identify the native Bilibili image control.');
        await imageButton.click();
        input = controls.scope.locator(imageInput);
      }
      if (await input.count() !== 1) fail('IMAGE_UPLOAD_UNSUPPORTED', 'Cannot identify a unique image file input.');
      await input.setInputFiles(asset.file);
    }
    const receipt = await acknowledgement;
    const url = receipt?.ok && receipt.data?.code === 0 ? bilibiliImageUrl(receipt.data.data?.image_url ?? receipt.data.data?.url) : null;
    if (!url) fail('ASSET_NOT_UPLOADED', 'Native upload did not produce a Bilibili CDN image.');
    const loaded = await controls.scope.evaluate(url => new Promise(resolve => {
      const image = new Image(); const timer = setTimeout(() => resolve(false), 20_000);
      image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth > 0); };
      image.onerror = () => { clearTimeout(timer); resolve(false); }; image.src = url;
    }), url);
    if (!loaded) fail('ASSET_NOT_UPLOADED', 'The uploaded Bilibili image is not publicly loadable.');
    return url;
  }
  async replaceBody(controls, html) {
    await controls.page.bringToFront();
    await this.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(controls.scope.url()).origin });
    await controls.scope.evaluate(async html => {
      const text = new DOMParser().parseFromString(html, 'text/html').body.textContent;
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
    }, html);
    try {
      await controls.body.click();
      await controls.body.press('ControlOrMeta+A');
      await controls.body.press('Backspace');
      await controls.body.click();
      for (let quotes = await controls.body.locator('blockquote').count(); quotes; quotes = await controls.body.locator('blockquote').count()) {
        await controls.body.press('ControlOrMeta+Home');
        await controls.body.press('Backspace');
        await controls.scope.waitForFunction(({ previous, selector }) => {
          const body = document.querySelector(selector);
          return body && body.querySelectorAll('blockquote').length < previous && !body.querySelector('img[src]') && !body.textContent.trim();
        }, { previous: quotes, selector: bodySelector }, { timeout: 5000 });
        await controls.body.click();
      }
      await controls.body.press('ControlOrMeta+V');
      await controls.scope.waitForFunction(({ expected, selector }) => document.querySelector(selector)?.textContent.normalize('NFC').replace(/[\s\u200B-\u200D\uFEFF]/gu, '').includes(expected), { expected: describeHtml(html).text.slice(0, 30), selector: bodySelector }, { timeout: 15_000 });
    } finally { await controls.scope.evaluate(() => navigator.clipboard.writeText('')).catch(() => {}); }
  }
  async writeDraft(prepared, assets, entry, onImage, outputDirectory) {
    const controls = await this.open(entry.id);
    try {
      const before = await this.snapshot(controls);
      await writeJson(path.join(outputDirectory, 'before-draft.json'), before);
      const uploaded = {};
      for (const asset of assets) {
        let url = entry.images?.[asset.hash];
        if (url) {
          const loaded = await controls.scope.evaluate(url => new Promise(resolve => { const image = new Image(); const timer = setTimeout(() => resolve(false), 15_000); image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth > 0); }; image.onerror = () => { clearTimeout(timer); resolve(false); }; image.src = url; }), url);
          if (!loaded) url = null;
        }
        if (!url) { url = await this.upload(controls, asset); await onImage(asset.hash, url); }
        uploaded[asset.key] = url;
      }
      const expected = { ...prepared, html: materializeBilibiliImages(prepared.html, uploaded) };
      await controls.title.fill(prepared.title);
      await this.replaceBody(controls, controls.modern ? bilibiliClipboardHtml(expected.html) : expected.html);
      const actualEditor = await this.snapshot(controls);
      await writeJson(path.join(outputDirectory, 'after-editor.json'), actualEditor);
      const validation = compareBilibiliArticle(expected, actualEditor);
      await writeJson(path.join(outputDirectory, 'editor-validation.json'), validation);
      if (!validation.ok) fail('FORMAT_MISMATCH', 'The native Bilibili editor changed article content or formatting.');
      await this.save(controls.page, entry.id);
      const actual = await this.readDraft(entry.id);
      const saved = compareBilibiliArticle(expected, actual);
      await writeJson(path.join(outputDirectory, 'saved-draft.json'), actual);
      await writeJson(path.join(outputDirectory, 'saved-draft-validation.json'), saved);
      if (!saved.ok) fail('SAVED_DRAFT_MISMATCH', 'The independently reopened draft does not match the source.');
      return expected;
    } finally { await controls.page.close(); }
  }
  async readPublished(entry, authorMid) {
    // A modern draft article_id is not a public cv/opus identifier.
    // Without an explicit website URL, retain pending state instead of guessing.
    const target = entry.publicUrl ?? this.publicFor?.(entry.id);
    if (!target) return null;
    const page = await this.context.newPage();
    try {
      const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (response?.status() === 404) return null;
      if (!response?.ok() || [403, 412, 429].includes(response.status())) fail('WEBSITE_ACCESS_RESTRICTED', 'Bilibili public article access was refused.');
      const url = page.url().split('?')[0];
      if (!publicBilibiliUrl(url)) fail('PUBLISHED_READ_UNCONFIRMED', 'The public article redirected to an unrecognized URL.');
      const holder = page.locator('.article-holder,.opus-module-content');
      await holder.first().waitFor({ state: 'visible', timeout: 30_000 });
      if (await holder.count() !== 1) fail('PUBLISHED_READ_UNCONFIRMED', 'The public article body is ambiguous.');
      const owner = await page.evaluate(() => String(window.__INITIAL_STATE__?.readInfo?.author?.mid ?? window.__INITIAL_STATE__?.readInfo?.mid ?? window.__INITIAL_STATE__?.detail?.basic?.uid ?? ''));
      if (owner !== authorMid) fail('AUTHOR_MISMATCH', 'Cannot confirm the published article author.');
      const title = page.locator('h1.title,.opus-module-title');
      if (await title.count() !== 1) fail('PUBLISHED_READ_UNCONFIRMED', 'Cannot confirm the public title.');
      await holder.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
      return { title: (await title.innerText()).trim(), html: await holder.innerHTML(), publicUrl: url, imagesLoaded: await holder.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)) };
    } finally { await page.close(); }
  }
  async submit(entry, prepared, onBeforeSubmit) {
    const controls = await this.open(entry.id);
    try {
      if (!compareBilibiliArticle(prepared, await this.snapshot(controls)).ok) fail('SAVED_DRAFT_MISMATCH', 'Draft content changed before publication.');
      const submit = controls.page.getByText(/^(?:提交文章|更新文章)$/, { exact: true });
      if (await submit.count() !== 1) fail('PUBLISH_FORM_UNSUPPORTED', 'The publication form needs validation before submission.');
      const completion = controls.page.waitForResponse(response => response.request().method() === 'POST' && /^\/x\/article\/creative\/article\/(?:add|addupdate|submit)$/.test(new URL(response.url()).pathname), { timeout: 45_000 }).then(async response => ({ ok: response.ok(), data: exactJson(await response.text()) })).catch(() => null);
      // Persist the uncertainty boundary before the single native submit click.
      await onBeforeSubmit();
      await submit.click();
      const response = await completion;
      if (!response?.ok || response.data?.code !== 0) fail('PUBLISH_OUTCOME_UNKNOWN', 'No confirmed native submission response was observed. Reconcile this ID before another submission.');
      const id = allocatedId(response.data);
      if (id && id !== entry.id) fail('REGISTRY_CONFLICT', 'The publication response targets another ID.');
    } finally { await controls.page.close(); }
  }
}
