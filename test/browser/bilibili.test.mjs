import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { BilibiliEditor } from '../../src/bilibili-browser.mjs';
import { escapeHtml } from '../../src/core.mjs';

const html = '<blockquote><p>副标题</p></blockquote><h2>章节</h2><p><strong>加粗</strong> <code>call()</code> <a href="https://example.com/">原文</a></p><pre><code>one\n  two</code></pre><ul><li>条目</li></ul>';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const cdn = 'https://article.biliimg.com/bfs/article/abcd.png';
async function fixture(t, options = {}) {
  const state = { id: '42', title: '', html: '', saves: 0, uploads: 0, submits: 0 };
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/nav') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ code: 0, data: { mid: options.mid ?? 12345, isLogin: true } })); return; }
    if (request.url.startsWith('/x/article/creative/article/list')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ code: 0, data: { articles: options.duplicate ? [{ title: '测试文章' }] : [], page: { count: options.duplicate ? 1 : 0 } } })); return; }
    if (request.url.startsWith('/x/article/creative/draft/list')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ code: 0, data: { drafts: [], page: { count: 0 } } })); return; }
    if (request.url === '/x/article/creative/draft/addupdate') {
      let raw = ''; for await (const part of request) raw += part;
      const input = JSON.parse(raw); state.title = input.title; state.html = options.corruptSave ? input.html.replace('  two', 'two') : input.html; state.saves++;
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ code: 0, data: { aid: 42 } })); return;
    }
    if (request.url === '/upload') { for await (const part of request) { /* consume native file upload */ } state.uploads++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ url: cdn })); return; }
    if (request.url.startsWith('/platform/upload/text')) {
      response.end(`<!doctype html><meta charset="utf-8"><textarea placeholder="请输入标题">${escapeHtml(state.title)}</textarea><div class="ql-editor" contenteditable="true">${state.html}</div><input type="file" accept="image/*"><button id="save">存草稿</button><button id="submit">提交文章</button><script>
      const body=document.querySelector('.ql-editor'),title=document.querySelector('textarea');
      body.addEventListener('paste',e=>{e.preventDefault();document.execCommand('insertHTML',false,e.clipboardData.getData('text/html'));});
      save.onclick=()=>fetch('/x/article/creative/draft/addupdate',{method:'POST',body:JSON.stringify({title:title.value,html:body.innerHTML})});
      document.querySelector('input').onchange=async()=>{const data=new FormData();data.append('file',document.querySelector('input').files[0]);const res=await fetch('/upload',{method:'POST',body:data});const img=document.createElement('img');img.src=(await res.json()).url;body.append(img);};
      submit.onclick=()=>fetch('/submit',{method:'POST'});
      </script>`); return;
    }
    if (request.url === '/submit') { state.submits++; response.end('{}'); return; }
    response.writeHead(404); response.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const root = `http://127.0.0.1:${server.address().port}`;
  await context.route('https://article.biliimg.com/**', route => route.fulfill({ contentType: 'image/png', body: png }));
  const editor = new BilibiliEditor(context, { writerUrl: root + '/platform/upload/text', accountUrl: root + '/nav' });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-native-test-'));
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  return { state, editor, context, output };
}

test('native browser paste and reopened save preserve code, subtitle and links on the same draft ID', async t => {
  const f = await fixture(t), prepared = { title: '测试文章', html };
  await f.editor.assertAuthor('12345'); await f.editor.assertNoDuplicate(prepared.title);
  let allocated;
  await f.editor.createDraft(prepared, async id => { allocated = id; });
  assert.equal(allocated, '42');
  await f.editor.writeDraft(prepared, [], { id: '42' }, async () => {}, f.output);
  await f.editor.writeDraft(prepared, [], { id: '42' }, async () => {}, f.output);
  assert.equal(f.state.title, prepared.title); assert.match(f.state.html, /one\n  two/); assert.equal(f.state.submits, 0);
});

test('native image upload is required and the saved draft retains its CDN image', async t => {
  const f = await fixture(t), prepared = { title: '测试文章', html: html + '<figure><img src="https://asset.invalid/asset-0" alt="图"></figure>' };
  const file = path.join(f.output, 'test.png'); await fs.writeFile(file, png);
  const images = {};
  await f.editor.writeDraft(prepared, [{ key: 'asset-0', hash: 'a'.repeat(64), file }], { id: '42', images }, async (hash, url) => { images[hash] = url; }, f.output);
  assert.equal(f.state.uploads, 1); assert.equal(images['a'.repeat(64)], cdn); assert.ok(f.state.html.includes(cdn));
});

test('an independent saved-draft read detects server formatting loss', async t => {
  const f = await fixture(t, { corruptSave: true });
  await assert.rejects(f.editor.writeDraft({ title: '测试文章', html }, [], { id: '42' }, async () => {}, f.output), { code: 'SAVED_DRAFT_MISMATCH' });
  assert.equal(f.state.submits, 0);
});

test('wrong account or duplicate source title stops before a draft can be allocated', async t => {
  const f = await fixture(t, { mid: 54321, duplicate: true });
  await assert.rejects(f.editor.assertAuthor('12345'), { code: 'AUTHOR_MISMATCH' });
  await assert.rejects(f.editor.assertNoDuplicate('测试文章'), { code: 'UNMAPPED_EXISTING_ARTICLE' });
  assert.equal(f.state.saves, 0);
});
