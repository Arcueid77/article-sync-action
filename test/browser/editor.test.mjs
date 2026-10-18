import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { ZhihuEditor } from '../../src/browser.mjs';
import { escapeHtml, sha256 } from '../../src/core.mjs';
import { saveImageCache, readImageCache } from '../../src/assets.mjs';
import { load } from 'cheerio';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const cdn = 'https://pic1.zhimg.com/v2-aabbccdd_r.png';
const privateImage = 'https://pic-private.zhihu.com/v2-aabbccdd~resize:0.png?expiration=123&auth_key=test-private-auth&draft_token=test-private-draft';
const id = '10000000000000000001';
const body = '<blockquote><p>副标题</p></blockquote><h2>章节</h2><p><strong>加粗</strong> <em>斜体</em> <code>inline()</code> <a href="https://zhuanlan.zhihu.com/p/10000000000000000002">下一篇</a></p><pre><code>line one\n  indented line</code></pre><table><tbody><tr><th>列</th><th>值</th></tr><tr><td>A</td><td>B</td></tr></tbody></table><ul><li>列表一</li><li>列表二</li></ul>';

async function fixture(options = {}) {
  const savedHtml = html => {
    if (!options.captionAttribute) return html;
    const $ = load(html, null, false);
    $('figure').each((_, figure) => {
      const caption = $(figure).children('figcaption');
      if (caption.length === 1) { $(figure).find('img').first().attr('data-caption', caption.text()); caption.remove(); }
    });
    return $.html();
  };
  const state = { title: options.newDraft ? '' : '旧标题', html: options.newDraft ? '<p><br></p>' : '<p>旧正文</p>', articleState: options.newDraft ? 'draft' : 'published', draft: options.initialDraft ?? null, declaration: options.newDraft ? '无声明' : '包含 AI 辅助创作 作者对内容负责', columns: options.newDraft ? [] : ['c_12345'], updates: 0, uploads: 0, allocations: 0, publicReads: 0, websiteReads: 0, author: options.author ?? 'fixture-author' };
  if (options.legacyNoDeclaration) state.declaration = '无声明';
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/save') {
      let text = ''; for await (const chunk of request) text += chunk;
      const input = JSON.parse(text);
      Object.assign(state, options.publishSavedDraft ? state.draft ?? {} : input);
      state.declaration = input.declaration ?? state.declaration;
      state.draft = null; state.articleState = 'published'; state.updates++;
      response.end('{}'); return;
    }
    if (request.url === '/draft-save') {
      let text = ''; for await (const chunk of request) text += chunk;
      if (!options.discardDraftSaves) state.draft = JSON.parse(text);
      response.end('{}'); return;
    }
    if (request.url === '/upload') { state.uploads++; response.end('{}'); return; }
    if (request.url === '/statement') { for await (const _chunk of request) { /* Publication-form choices are not saved in the draft. */ } response.end('{}'); return; }
    if (request.url === '/column') { state.columns = ['c_12345']; response.end('{}'); return; }
    if (request.url === '/api/v4/me') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ url_token: state.author })); return; }
    if (request.url.startsWith('/api/v4/members/')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [], paging: { is_end: true } })); return; }
    if (request.url === '/api/articles/drafts') { let text = ''; for await (const chunk of request) text += chunk; state.title = JSON.parse(text).title; state.allocations++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id })); return; }
    if (request.url === `/api/articles/${id}`) {
      state.websiteReads++;
      response.setHeader('content-type', 'application/json');
      const status = options.publishedStatus ?? (state.updates ? options.statusAfterPublication : undefined) ?? 200;
      if (status !== 200) { response.writeHead(status); response.end('{"message":"sensitive upstream detail"}'); return; }
      response.end(JSON.stringify({ id, type: 'article', url: `https://zhuanlan.zhihu.com/p/${id}`, state: state.articleState, title: state.title, content: savedHtml(state.html), content_need_truncated: options.truncated ?? false, author: { url_token: state.author }, column: options.omitColumn ? undefined : state.columns.map(id => ({ id })), has_column: options.publishedHasColumn, topics: options.newDraft ? [] : [{ id: '21663433' }], image_url: options.newDraft ? '' : cdn, creation_disclaimer: options.legacyNoDeclaration ? undefined : state.declaration === '无声明' ? null : state.declaration }));
      return;
    }
    if (request.url === `/api/articles/${id}/draft`) {
      response.setHeader('content-type', 'application/json');
      if (options.missingMetadata) { response.writeHead(503); response.end('{}'); return; }
      response.end(JSON.stringify({ id, state: state.articleState, title: state.draft?.title ?? state.title, content: savedHtml(state.draft?.html ?? state.html), author: { url_token: state.author }, column: options.omitColumn ? undefined : state.columns, topics: options.newDraft ? [] : [{ id: '21663433' }], image_url: options.newDraft ? '' : cdn, creationStatement: options.legacyNoDeclaration || options.omitDraftStatement ? undefined : { disclaimer_status: state.declaration === '无声明' ? 'close' : 'open', disclaimer_desc: state.declaration } }));
      return;
    }
    if (request.url.endsWith('/edit') || request.url === '/write') {
      const editing = state.draft ?? state;
      response.end(`<!doctype html><meta charset="utf-8"><style>[contenteditable]{min-height:100px}</style><textarea placeholder="请输入标题（最多 100 个字）">${escapeHtml(editing.title)}</textarea><button id="picture">图片</button><input id="file" type="file" accept="${options.popupUpload ? 'image/png,image/jpeg' : 'image/*'}" hidden><input type="file" accept=".jpeg, .jpg, .png" hidden><div role="textbox" contenteditable="true">${editing.html}</div><button role="combobox" id="declaration">${escapeHtml(options.statementLabel ?? '无声明')}</button><div role="listbox" id="choices" hidden><button role="option">包含 AI 辅助创作 作者对内容负责</button><button role="option">无声明</button></div><button id="update">更新</button><script>
        const editor=document.querySelector('[contenteditable]');
        fetch('/api/articles/${id}/draft').catch(()=>{});
        let saveTimer;
        const saveDraft=()=>{clearTimeout(saveTimer);saveTimer=setTimeout(()=>fetch(location.pathname==='/write'?'/api/articles/drafts':'/draft-save',{method:'POST',body:JSON.stringify({title:document.querySelector('textarea').value,html:editor.innerHTML})}),${options.autosaveDelay ?? 0});};
        editor.addEventListener('input',saveDraft);
        document.querySelector('textarea').addEventListener('input',saveDraft);
        const input=document.querySelector('#file');
        picture.onclick=()=>{${options.popupUpload ? "const panel=document.createElement('div');panel.innerHTML='<p>上传图片</p><input type=\"file\" accept=\"image/*\" multiple hidden><button>插入图片</button>';panel.querySelector('input').onchange=async()=>{await fetch('/upload',{method:'POST'});await fetch('https://api.zhihu.com/images/123456');const status=document.createElement('p');status.textContent='已上传 1 张图片，拖拽可调整顺序';panel.append(status);};document.body.append(panel);" : 'input.click();'}};
        input.onchange=async()=>{await fetch('/upload',{method:'POST'});const image=document.createElement('img');image.src=${JSON.stringify(cdn)};editor.append(image);};
        declaration.onclick=()=>choices.hidden=false;
        document.querySelectorAll('[role=option]').forEach(option=>option.onclick=()=>{declaration.textContent=option.textContent;choices.hidden=true;fetch('/statement',{method:'POST',body:option.textContent});});
        update.textContent=${JSON.stringify(state.articleState === 'draft' ? '发布' : '更新')};
        ${options.breakFormatting ? "editor.addEventListener('paste',e=>{e.preventDefault();editor.textContent=e.clipboardData.getData('text/plain');});" : ''}
        update.onclick=async()=>{${options.skipPublication ? '' : "await fetch('/save',{method:'POST',body:JSON.stringify({title:document.querySelector('textarea').value,html:editor.innerHTML,declaration:declaration.textContent})});"}location.href='/p/${id}';};
        </script>`);
      return;
    }
    state.publicReads++;
    if (options.blockPublic) { response.writeHead(403); response.end('blocked'); return; }
    response.end(`<!doctype html><meta charset="utf-8"><main><img alt="${escapeHtml(state.title)}" src="${cdn}"><article><header class="Post-Header"><h1>${escapeHtml(state.title)}</h1><a href="https://www.zhihu.com/people/${state.author}">作者</a><a href="https://www.zhihu.com/column/c_12345">专栏</a></header><div class="Post-RichText">${state.html}</div><div class="ContentItem-time">编辑于 今天 · ${state.declaration}</div><div class="Post-topicsAndReviewer"><a href="https://www.zhihu.com/topic/21663433">游戏</a></div></article></main>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'api.zhihu.com') return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ status: 'success', src: options.privateImages ? privateImage : cdn, original_src: options.privateImages ? privateImage : cdn }) });
    if (url.hostname.endsWith('.zhimg.com') || url.hostname === 'pic-private.zhihu.com') return route.fulfill({ contentType: 'image/png', body: png });
    return route.abort();
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihu-browser-test-'));
  const prepared = { slug: 'test', id, title: '0x00：新标题', html: body, sourceHash: 'source-hash', authorUrlToken: 'fixture-author', column: { id: 'c_12345' } };
  const anonymousContextFactory = async settings => {
    assert.deepEqual(settings.storageState, { cookies: [], origins: [] });
    const anonymous = await browser.newContext(settings);
    await anonymous.route('**/*', route => route.fulfill(options.ownerOnlyImages ? { status: 403, body: 'owner only' } : { contentType: 'image/png', body: png }));
    return anonymous;
  };
  return { state, context, directory, prepared, adapter: new ZhihuEditor(context, { urlFor: target => base + '/p/' + target, writerUrl: base + '/write', profileFor: author => base + '/people/' + author + '/posts', anonymousContextFactory }), close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}

test('a new article persists its allocated ID, publishes signed images once, and redacts every artifact', async () => {
  const f = await fixture({ newDraft: true, popupUpload: true, privateImages: true, blockPublic: true, publishSavedDraft: true, omitColumn: true, publishedHasColumn: false });
  try {
    await f.adapter.ownArticles('fixture-author');
    let persisted;
    await f.adapter.createDraft(f.prepared, async id => { persisted = id; });
    assert.equal(persisted, id); assert.equal(f.state.allocations, 1);
    const file = path.join(f.directory, 'asset.png'); await fs.writeFile(file, png);
    const asset = { key: 'asset-0', hash: sha256(png), file };
    const prepared = { ...f.prepared, column: undefined, html: body + '<img src="https://asset.invalid/asset-0">' };
    const cache = { images: {}, references: {} };
    const cacheFile = path.join(f.directory, 'cache.json');
    let submitChecks = 0;
    const result = await f.adapter.runNew(prepared, [asset], cache, { mode: 'apply', outputDirectory: f.directory, declaration: '包含 AI 辅助创作 作者对内容负责', saveCache: () => saveImageCache(cacheFile, cache), onBeforeSubmit: async () => { assert.equal(persisted, id); submitChecks++; } });
    assert.equal(result.status, 'created', JSON.stringify(result));
    assert.equal(result.validation.checks.publicImages, true); assert.equal(f.state.updates, 1); assert.equal(submitChecks, 1);
    const restartedCache = await readImageCache(cacheFile);
    const again = await f.adapter.runNew(prepared, [asset], restartedCache, { mode: 'apply', outputDirectory: path.join(f.directory, 'again'), declaration: '包含 AI 辅助创作 作者对内容负责' });
    assert.equal(again.status, 'already_current', JSON.stringify(again)); assert.equal(f.state.updates, 1); assert.equal(f.state.uploads, 1);
    for (const file of await fs.readdir(f.directory)) if (/\.(json|html)$/.test(file)) assert.ok(!/test-private-auth|test-private-draft/.test(await fs.readFile(path.join(f.directory, file), 'utf8')), file);
  } finally { await f.close(); }
});

test('unconfirmed new publication is read-only, and wrong-account allocation is refused', async () => {
  const f = await fixture({ newDraft: true });
  try {
    const result = await f.adapter.runNew({ ...f.prepared, column: undefined }, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory, allowSubmit: false });
    assert.equal(result.code, 'WRITE_OUTCOME_UNKNOWN'); assert.equal(f.state.updates, 0); assert.equal(result.draftChanged, false);
  } finally { await f.close(); }
  const g = await fixture({ newDraft: true, author: 'another-account' });
  try { await assert.rejects(g.adapter.ownArticles('fixture-author'), { code: 'AUTHOR_MISMATCH' }); assert.equal(g.state.allocations, 0); }
  finally { await g.close(); }
});

test('an omitted editor column cannot enable a write without independent published evidence', async () => {
  for (const publishedHasColumn of [undefined, true]) {
    const f = await fixture({ omitColumn: true, publishedHasColumn });
    try {
      const result = await f.adapter.run({ ...f.prepared, column: undefined }, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
      assert.equal(result.code, 'EDITOR_METADATA_INVALID');
      assert.equal(result.submitted, false); assert.equal(result.draftChanged, false); assert.equal(f.state.updates, 0);
    } finally { await f.close(); }
  }
});

test('legacy articles with omitted empty declarations update once and preserve their settings', async () => {
  const f = await fixture({ legacyNoDeclaration: true });
  try {
    const first = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
    assert.equal(first.status, 'updated', JSON.stringify(first));
    assert.equal(first.validation.checks.metadata, true); assert.equal(f.state.declaration, '无声明');
    const before = JSON.parse(await fs.readFile(path.join(f.directory, 'before.json'), 'utf8'));
    assert.equal(before.declarationReadSource, 'editor-confirmed-absence');
    const again = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: path.join(f.directory, 'again') });
    assert.equal(again.status, 'already_current'); assert.equal(f.state.updates, 1);
  } finally { await f.close(); }
});

test('missing declarations with ambiguous editor or contradictory published evidence cannot enable a write', async () => {
  for (const options of [{ legacyNoDeclaration: true, statementLabel: '未知声明' }, { omitDraftStatement: true }]) {
    const f = await fixture(options);
    try {
      const result = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
      assert.equal(result.code, 'EDITOR_METADATA_INVALID');
      assert.equal(result.submitted, false); assert.equal(result.draftChanged, false); assert.equal(f.state.updates, 0);
    } finally { await f.close(); }
  }
});

test('an image visible only to the owner cannot count as a successful public article', async () => {
  const f = await fixture({ newDraft: true, popupUpload: true, privateImages: true, ownerOnlyImages: true, blockPublic: true, publishSavedDraft: true });
  try {
    const file = path.join(f.directory, 'asset.png'); await fs.writeFile(file, png);
    const prepared = { ...f.prepared, column: undefined, html: body + '<img src="https://asset.invalid/asset-0">' };
    const result = await f.adapter.runNew(prepared, [{ key: 'asset-0', hash: sha256(png), file }], { images: {}, references: {} }, { mode: 'apply', outputDirectory: f.directory, declaration: '包含 AI 辅助创作 作者对内容负责', onBeforeSubmit: async () => {} });
    assert.equal(result.code, 'PUBLIC_VERIFY_FAILED', JSON.stringify(result)); assert.equal(result.submitted, true); assert.equal(f.state.updates, 1);
  } finally { await f.close(); }
});

test('standalone browser script updates an existing article, preserves format and metadata, and does not duplicate on rerun', async () => {
  const f = await fixture();
  try {
    const cache = { version: 1, images: {} };
    const first = await f.adapter.run(f.prepared, [], cache, { mode: 'apply', outputDirectory: path.join(f.directory, 'first') });
    assert.equal(first.status, 'updated', JSON.stringify(first));
    assert.equal(first.validation.ok, true);
    assert.equal(f.state.updates, 1);
    assert.equal(f.state.declaration, '包含 AI 辅助创作 作者对内容负责');
    const again = await f.adapter.run(f.prepared, [], cache, { mode: 'apply', outputDirectory: path.join(f.directory, 'again') });
    assert.equal(again.status, 'already_current');
    assert.equal(f.state.updates, 1);
    f.state.html = '<p>知乎侧手工改动</p>';
    const overwrite = await f.adapter.run(f.prepared, [], cache, { mode: 'apply', outputDirectory: path.join(f.directory, 'overwrite') });
    assert.equal(overwrite.status, 'updated');
    assert.equal(f.state.updates, 2);
    assert.equal(overwrite.id, id);
  } finally { await f.close(); }
});

test('image upload returns a CDN URL, is published with the body, and is reused', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.directory, 'asset.png'); await fs.writeFile(file, png);
    const asset = { key: 'asset-0', file, hash: sha256(png) };
    const prepared = { ...f.prepared, html: body + '<figure><img src="https://asset.invalid/asset-0" alt="配图"><figcaption>配图说明</figcaption></figure>' };
    const cache = { version: 1, images: {} };
    const first = await f.adapter.run(prepared, [asset], cache, { mode: 'apply', outputDirectory: path.join(f.directory, 'first') });
    assert.equal(first.status, 'updated', JSON.stringify(first));
    assert.equal(f.state.uploads, 1);
    const again = await f.adapter.run(prepared, [asset], cache, { mode: 'apply', outputDirectory: path.join(f.directory, 'again') });
    assert.equal(again.status, 'already_current');
    assert.equal(f.state.uploads, 1);
  } finally { await f.close(); }
});

test('native saved image captions and separate original-image links survive publication and reruns', async () => {
  const f = await fixture({ captionAttribute: true });
  try {
    const file = path.join(f.directory, 'asset.png'); await fs.writeFile(file, png);
    const assets = [{ key: 'asset-0', file, hash: sha256(png) }];
    const cache = { images: {} };
    const prepared = { ...f.prepared, html: body + '<figure><img src="https://asset.invalid/asset-0"><figcaption>作者图注 &amp; 示例</figcaption></figure><p><a href="https://example.org/full.svg">查看原图</a></p>' };
    const first = await f.adapter.run(prepared, assets, cache, { mode: 'apply', outputDirectory: f.directory });
    assert.equal(first.status, 'updated', JSON.stringify(first));
    const after = JSON.parse(await fs.readFile(path.join(f.directory, 'after.json'), 'utf8'));
    assert.match(after.html, /data-caption=/); assert.doesNotMatch(after.html, /<figcaption/);
    const again = await f.adapter.run(prepared, assets, cache, { mode: 'apply', outputDirectory: path.join(f.directory, 'again') });
    assert.equal(again.status, 'already_current'); assert.equal(f.state.updates, 1);
  } finally { await f.close(); }
});

test('acknowledged images in an unpublished saved draft are reused without another upload', async () => {
  const f = await fixture({ initialDraft: { title: '0x00：新标题', html: body + `<figure><img src="${cdn}"><figcaption>已上传</figcaption></figure>` } });
  try {
    const file = path.join(f.directory, 'asset.png'); await fs.writeFile(file, png);
    const hash = sha256(png);
    const assets = [{ key: 'asset-0', hash, file }];
    const cache = { images: {}, references: { [hash]: { imageHash: 'v2-aabbccdd' } } };
    const prepared = { ...f.prepared, html: body + '<figure><img src="https://asset.invalid/asset-0"><figcaption>已上传</figcaption></figure>' };
    const result = await f.adapter.run(prepared, assets, cache, { mode: 'apply', outputDirectory: f.directory });
    assert.equal(result.status, 'updated', JSON.stringify(result));
    assert.equal(f.state.uploads, 0); assert.equal(f.state.updates, 1);
  } finally { await f.close(); }
});

test('verify mode and an unexpected author cannot publish', async () => {
  const f = await fixture({ author: 'someone-else' });
  try {
    const result = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
    assert.equal(result.code, 'AUTHOR_MISMATCH');
    assert.equal(f.state.updates, 0);
  } finally { await f.close(); }
  const g = await fixture();
  try {
    const result = await g.adapter.run(g.prepared, [], { images: {} }, { mode: 'verify', outputDirectory: g.directory });
    assert.equal(result.status, 'different');
    assert.equal(result.editorAccessible, true);
    assert.equal(g.state.updates, 0);
  } finally { await g.close(); }
});

test('format loss in the editor is detected before the Update button is clicked', async () => {
  const f = await fixture({ breakFormatting: true });
  try {
    const result = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
    assert.equal(result.code, 'EDITOR_FORMAT_MISMATCH');
    assert.equal(f.state.updates, 0);
  } finally { await f.close(); }
});

test('website published reads support verify and update when the reading page returns 403', async () => {
  const f = await fixture({ blockPublic: true });
  try {
    const cache = { images: {} };
    const verify = await f.adapter.run(f.prepared, [], cache, { mode: 'verify', outputDirectory: path.join(f.directory, 'verify') });
    assert.equal(verify.status, 'different', JSON.stringify(verify));
    assert.equal(verify.editorAccessible, true);
    assert.equal(f.state.updates, 0);
    assert.equal(f.state.publicReads, 0);
    const apply = await f.adapter.run(f.prepared, [], cache, { mode: 'apply', outputDirectory: path.join(f.directory, 'apply') });
    assert.equal(apply.status, 'updated', JSON.stringify(apply));
    assert.equal(apply.validation.checks.metadata, true);
    assert.equal(f.state.updates, 1);
    assert.equal(f.state.declaration, '包含 AI 辅助创作 作者对内容负责');
    const after = JSON.parse(await fs.readFile(path.join(f.directory, 'apply/after.json'), 'utf8'));
    assert.equal(after.readSource, 'website-article');
    assert.ok(f.state.websiteReads >= 3);
  } finally { await f.close(); }
});

test('website denial, truncated content or missing metadata stops before changing the draft', async () => {
  for (const options of [{ publishedStatus: 403 }, { publishedStatus: 429 }, { truncated: true }, { missingMetadata: true }, { author: 'someone-else' }]) {
    const f = await fixture({ blockPublic: true, ...options });
    try {
      const result = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
      assert.equal(result.status, 'failed');
      assert.equal(result.submitted, false);
      assert.equal(result.draftChanged, false);
      assert.equal(f.state.updates, 0);
      assert.equal(f.state.publicReads, 0);
    } finally { await f.close(); }
  }
});

test('website published reads verify decoded images and reuse uploaded CDN assets', async () => {
  const f = await fixture({ blockPublic: true, popupUpload: true });
  try {
    const file = path.join(f.directory, 'asset.png'); await fs.writeFile(file, png);
    const asset = { key: 'asset-0', file, hash: sha256(png) };
    const prepared = { ...f.prepared, html: body + '<figure><img src="https://asset.invalid/asset-0" alt="配图"><figcaption>配图说明</figcaption></figure>' };
    const cache = { images: {} };
    const first = await f.adapter.run(prepared, [asset], cache, { mode: 'apply', outputDirectory: path.join(f.directory, 'first') });
    assert.equal(first.status, 'updated', JSON.stringify(first));
    assert.equal(first.validation.checks.images, true);
    const again = await f.adapter.run(prepared, [asset], cache, { mode: 'apply', outputDirectory: path.join(f.directory, 'again') });
    assert.equal(again.status, 'already_current');
    assert.equal(f.state.uploads, 1);
  } finally { await f.close(); }
});

test('a saved editor draft cannot count as a published update without a website published-body match', async () => {
  const f = await fixture({ blockPublic: true, skipPublication: true });
  try {
    const result = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
    assert.equal(result.code, 'PUBLIC_VERIFY_FAILED', JSON.stringify(result));
    assert.equal(result.submitted, true);
    assert.equal(f.state.updates, 0);
  } finally { await f.close(); }
});

test('publishing waits for an acknowledged server draft when editor autosave is delayed', async () => {
  const f = await fixture({ blockPublic: true, autosaveDelay: 500, publishSavedDraft: true });
  try {
    const result = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
    assert.equal(result.status, 'updated', JSON.stringify(result));
    assert.equal(f.state.updates, 1);
    assert.equal(f.state.html.includes('副标题'), true);
    const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'saved-draft-validation.json'), 'utf8'));
    assert.equal(saved.ok, true);
  } finally { await f.close(); }
});

test('a draft that only exists in the editing DOM cannot be published', async () => {
  const f = await fixture({ blockPublic: true, discardDraftSaves: true });
  try {
    const result = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
    assert.equal(result.code, 'DRAFT_NOT_SAVED', JSON.stringify(result));
    assert.equal(result.submitted, false);
    assert.equal(f.state.updates, 0);
  } finally { await f.close(); }
});

test('a matching saved draft cannot hide a different published article', async () => {
  const f = await fixture({ initialDraft: { title: '0x00：新标题', html: body }, blockPublic: true });
  try {
    const result = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'verify', outputDirectory: f.directory });
    assert.equal(result.status, 'different');
    assert.equal(f.state.updates, 0);
    const before = JSON.parse(await fs.readFile(path.join(f.directory, 'before.json'), 'utf8'));
    assert.equal(before.html, '<p>旧正文</p>');
  } finally { await f.close(); }
});

test('website read refusal after publication cannot cause a second submit', async () => {
  const f = await fixture({ blockPublic: true, statusAfterPublication: 403 });
  try {
    const result = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
    assert.equal(result.code, 'ARTICLE_ACCESS_RESTRICTED');
    assert.equal(result.submitted, true);
    assert.equal(f.state.updates, 1);
    assert.equal(f.state.websiteReads, 2);
  } finally { await f.close(); }
});

test('website rate limiting stops before editing and does not fall back to a draft', async () => {
  const f = await fixture({ blockPublic: true, publishedStatus: 429 });
  try {
    const result = await f.adapter.run(f.prepared, [], { images: {} }, { mode: 'apply', outputDirectory: f.directory });
    assert.equal(result.code, 'WEBSITE_RATE_LIMITED');
    assert.equal(result.submitted, false);
    assert.equal(result.draftChanged, false);
    assert.equal(f.state.draft, null);
    assert.equal(f.state.updates, 0);
  } finally { await f.close(); }
});
