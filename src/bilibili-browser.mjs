import path from 'node:path';
import { fail, writeJson } from './core.mjs';
import { bilibiliImageUrl, compareBilibiliArticle, decimalId, materializeBilibiliImages, publicBilibiliUrl } from './bilibili.mjs';

export function exactJson(text) {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token));
}
export function allocatedId(data) {
  const value = data?.data?.aid ?? data?.data?.id;
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return data?.code === 0 && decimalId(id) ? id : null;
}

export class BilibiliEditor {
  constructor(context, { writerUrl = 'https://member.bilibili.com/platform/upload/text', accountUrl = 'https://api.bilibili.com/x/web-interface/nav', publicFor = id => `https://www.bilibili.com/read/cv${id}` } = {}) {
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
      const articles = kind === 'draft' ? data.data?.drafts : data.data?.articles;
      const total = data.data?.page?.count;
      if (!response.ok() || data.code !== 0 || !Array.isArray(articles) || !Number.isSafeInteger(total) || total < 0) fail('ARTICLE_LIST_UNCONFIRMED', 'The owned-article inventory format needs verification before allocating a draft.');
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
    const title = page.locator('textarea[placeholder*="标题"],input[placeholder*="标题"]');
    const body = page.locator('.ql-editor[contenteditable="true"],.ProseMirror[contenteditable="true"],[contenteditable="true"][data-placeholder*="正文"]');
    await title.first().waitFor({ state: 'visible', timeout: 30_000 });
    await body.first().waitFor({ state: 'visible', timeout: 30_000 });
    if (await title.count() !== 1 || await body.count() !== 1) fail('EDITOR_UNSUPPORTED', 'The Bilibili editor layout is ambiguous.');
    return { title, body };
  }
  async open(id) {
    const page = await this.context.newPage();
    try {
      const u = new URL(this.writerUrl);
      if (id) { u.pathname = u.pathname.replace(/\/$/, '') + '/edit'; u.searchParams.set('aid', id); }
      await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return { page, ...await this.controls(page) };
    } catch (error) { await page.close(); throw error; }
  }
  async save(page, expectedId) {
    const response = page.waitForResponse(value => {
      const u = new URL(value.url());
      return value.request().method() === 'POST' && ['/x/article/creative/draft/addupdate', '/draft-save'].includes(u.pathname);
    }, { timeout: 45_000 }).then(async value => ({ ok: value.ok(), data: exactJson(await value.text()) }));
    // Attach the rejection handler before clicking; an uncertain save is never retried.
    const completion = response.catch(() => null);
    const save = page.getByText(/^(?:存草稿|保存草稿)$/, { exact: true });
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
      if (new URL(response.url()).pathname !== '/x/article/creative/draft/addupdate') return;
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
    const imagesLoaded = await controls.body.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0));
    return { title: await controls.title.inputValue(), html, imagesLoaded };
  }
  async readDraft(id) {
    const controls = await this.open(id);
    try { return await this.snapshot(controls); } finally { await controls.page.close(); }
  }
  async upload(controls, asset) {
    const images = controls.body.locator('img');
    const before = new Set(await images.evaluateAll(values => values.map(value => value.src)));
    let input = controls.page.locator('input[type="file"][accept*="image"]');
    if (await input.count() !== 1) {
      const imageButton = controls.page.getByRole('button', { name: /图片|上传图片/ });
      if (await imageButton.count() !== 1) fail('IMAGE_UPLOAD_UNSUPPORTED', 'Cannot identify the native Bilibili image control.');
      await imageButton.click();
      input = controls.page.locator('input[type="file"][accept*="image"]');
    }
    if (await input.count() !== 1) fail('IMAGE_UPLOAD_UNSUPPORTED', 'Cannot identify a unique image file input.');
    await input.setInputFiles(asset.file);
    await controls.page.waitForFunction(({ previous, selector }) => [...(document.querySelector(selector)?.querySelectorAll('img') ?? [])].some(image => image.complete && image.naturalWidth > 0 && !previous.includes(image.src)), { previous: [...before], selector: '.ql-editor,.ProseMirror,[contenteditable][data-placeholder*="正文"]' }, { timeout: 60_000 });
    const urls = await images.evaluateAll(values => values.map(value => value.src));
    const url = urls.filter(value => !before.has(value)).map(bilibiliImageUrl).find(Boolean);
    if (!url) fail('ASSET_NOT_UPLOADED', 'Native upload did not produce a Bilibili CDN image.');
    return url;
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
          const loaded = await controls.page.evaluate(url => new Promise(resolve => { const image = new Image(); const timer = setTimeout(() => resolve(false), 15_000); image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth > 0); }; image.onerror = () => { clearTimeout(timer); resolve(false); }; image.src = url; }), url);
          if (!loaded) url = null;
        }
        if (!url) { url = await this.upload(controls, asset); await onImage(asset.hash, url); }
        uploaded[asset.key] = url;
      }
      const expected = { ...prepared, html: materializeBilibiliImages(prepared.html, uploaded) };
      await controls.title.fill(prepared.title);
      await controls.body.click();
      await controls.body.press('ControlOrMeta+A');
      await controls.body.press('Backspace');
      await controls.body.click();
      for (let quotes = await controls.body.locator('blockquote').count(); quotes; quotes = await controls.body.locator('blockquote').count()) {
        await controls.body.press('ControlOrMeta+Home');
        await controls.body.press('Backspace');
        await controls.page.waitForFunction(previous => {
          const body = document.querySelector('.ql-editor,.ProseMirror,[contenteditable][data-placeholder*="正文"]');
          return body && body.querySelectorAll('blockquote').length < previous && !body.querySelector('img') && !body.textContent.trim();
        }, quotes, { timeout: 5000 });
        await controls.body.click();
      }
      await controls.body.evaluate((element, html) => {
        const data = new DataTransfer(); data.setData('text/html', html);
        const doc = new DOMParser().parseFromString(html, 'text/html'); data.setData('text/plain', doc.body.innerText);
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, expected.html);
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
    const page = await this.context.newPage();
    try {
      const response = await page.goto(entry.publicUrl ?? this.publicFor(entry.id), { waitUntil: 'domcontentloaded', timeout: 45_000 });
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
