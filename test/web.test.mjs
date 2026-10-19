import test from 'node:test';
import assert from 'node:assert/strict';
import { editorMetadata, publishedArticle } from '../src/web.mjs';

const id = '10000000000000000001';
const prepared = { id, authorUrlToken: 'fixture-author', column: { id: 'c_12345' } };
const declaration = '包含 AI 辅助创作 作者对内容负责';
const metadata = () => ({ id, state: 'published', author: { url_token: 'fixture-author' }, column: ['c_12345'], topics: [{ id: '21663433' }], image_url: 'https://pic1.zhimg.com/v2-abcd_1440w.png', creationStatement: { disclaimer_status: 'open', disclaimer_desc: declaration } });
const published = () => ({ ...metadata(), type: 'article', url: `https://zhuanlan.zhihu.com/p/${id}`, column: { id: 'c_12345' }, title: '标题', content: '<h2>标题</h2><pre><code>one\n  two</code></pre>', content_need_truncated: false, creation_disclaimer: declaration, updated: 1792255191 });

test('website published reader preserves full HTML, large string IDs and published settings', () => {
  const data = published();
  const article = publishedArticle(data, prepared);
  assert.equal(article.html, data.content);
  assert.equal(article.title, data.title);
  assert.equal(article.readSource, 'website-article');
  assert.equal(article.publishedUpdated, data.updated);
  assert.deepEqual(article.columns, [prepared.column.id]);
  assert.equal(article.declaration, declaration);
});

test('omitted legacy declarations require editor evidence and never bypass article validation', () => {
  const data = published(); delete data.creation_disclaimer;
  assert.throws(() => publishedArticle(data, prepared), { code: 'WEBSITE_ARTICLE_INVALID' });
  const article = publishedArticle(data, prepared, { legacyNoDeclaration: true });
  assert.equal(article.declaration, '无声明');
  assert.equal(article.declarationReadSource, 'editor-confirmed-absence');
  assert.throws(() => publishedArticle({ ...data, author: { url_token: 'other' } }, prepared, { legacyNoDeclaration: true }), { code: 'AUTHOR_MISMATCH' });
  assert.throws(() => publishedArticle({ ...data, content_need_truncated: true }, prepared, { legacyNoDeclaration: true }), { code: 'WEBSITE_ARTICLE_INVALID' });
  assert.throws(() => publishedArticle({ ...data, creation_disclaimer: undefined }, prepared, { legacyNoDeclaration: true }), { code: 'WEBSITE_ARTICLE_INVALID' });
  assert.equal(publishedArticle(published(), prepared, { legacyNoDeclaration: true }).declaration, declaration);
});

test('drafts, wrong article identities and incomplete published responses are rejected', () => {
  for (const changes of [
    { id: Number(id) }, { id: '10000000000000000002' }, { url: `https://zhuanlan.zhihu.com/p/${id}/edit` },
    { type: 'answer' }, { state: 'draft' }, { content: '' }, { title: '' },
    { content_need_truncated: true }, { content_need_truncated: undefined }, { creation_disclaimer: undefined },
  ]) assert.throws(() => publishedArticle({ ...published(), ...changes }, prepared), { code: 'WEBSITE_ARTICLE_INVALID' });
});

test('published identity, column, topics, cover and statement are validated independently of the draft', () => {
  for (const [changes, code] of [
    [{ author: { url_token: 'someone-else' } }, 'AUTHOR_MISMATCH'],
    [{ column: { id: 'other-column' } }, 'COLUMN_MISMATCH'],
    [{ topics: [{ id: Number(id) }] }, 'EDITOR_METADATA_INVALID'],
    [{ image_url: 'https://external.invalid/image.png' }, 'EDITOR_METADATA_INVALID'],
    [{ creation_disclaimer: 'unknown statement' }, 'EDITOR_METADATA_INVALID'],
  ]) assert.throws(() => publishedArticle({ ...published(), ...changes }, prepared), { code });
  const article = publishedArticle({ ...published(), creation_disclaimer: null, image_url: '' }, prepared);
  assert.equal(article.declaration, '无声明');
  assert.equal(article.cover, null);
});

test('editor metadata preserves the server creation statement, cover, topics and all columns', () => {
  assert.deepEqual(editorMetadata(metadata(), prepared), { authorUrlToken: 'fixture-author', columns: ['c_12345'], topics: ['21663433'], declaration, cover: 'https://pic1.zhimg.com/v2-abcd_1440w.png' });
  const data = metadata(); data.creationStatement = null; data.image_url = '';
  assert.equal(editorMetadata(data, prepared).declaration, '无声明');
  assert.equal(editorMetadata(data, prepared).cover, null);
});

test('ordinary published articles need explicit evidence when the column is omitted', () => {
  const data = { ...published(), has_column: false };
  delete data.column;
  const ordinary = { ...prepared, column: undefined };
  assert.deepEqual(publishedArticle(data, ordinary).columns, []);
  assert.throws(() => publishedArticle({ ...data, has_column: undefined }, ordinary), { code: 'EDITOR_METADATA_INVALID' });
  assert.throws(() => publishedArticle({ ...data, has_column: true }, ordinary), { code: 'EDITOR_METADATA_INVALID' });
  assert.throws(() => publishedArticle({ ...data, column: [prepared.column.id] }, ordinary), { code: 'EDITOR_METADATA_INVALID' });
  assert.throws(() => publishedArticle(data, prepared), { code: 'COLUMN_MISMATCH' });
});

test('explicit empty column membership cannot contradict has_column', () => {
  const ordinary = { ...prepared, column: undefined };
  for (const column of [[], null, undefined, '']) {
    assert.throws(() => publishedArticle({ ...published(), column, has_column: true }, ordinary), { code: 'EDITOR_METADATA_INVALID' });
  }
  for (const has_column of [false, undefined]) {
    assert.deepEqual(publishedArticle({ ...published(), column: [], has_column }, ordinary).columns, []);
  }
  assert.deepEqual(publishedArticle({ ...published(), has_column: true }, prepared).columns, [prepared.column.id]);
});

test('new drafts may omit unset column and creation statement without weakening published checks', () => {
  const data = { ...metadata(), state: 'draft' };
  delete data.column; delete data.creationStatement;
  const settings = editorMetadata(data, prepared, { allowDraft: true });
  assert.deepEqual(settings.columns, []); assert.equal(settings.declaration, '无声明');
  assert.throws(() => editorMetadata(data, prepared), { code: 'EDITOR_METADATA_INVALID' });
  assert.throws(() => editorMetadata({ ...data, state: 'published' }, prepared, { allowDraft: true }), { code: 'EDITOR_METADATA_INVALID' });
  assert.throws(() => editorMetadata({ ...data, author: { url_token: 'other' } }, prepared, { allowDraft: true }), { code: 'AUTHOR_MISMATCH' });
});

test('unknown editor metadata, ownership, columns and unsafe identifiers cannot enable a write', () => {
  for (const [changes, code] of [
    [{ state: 'draft' }, 'EDITOR_METADATA_INVALID'],
    [{ author: { url_token: 'someone-else' } }, 'AUTHOR_MISMATCH'],
    [{ column: [] }, 'COLUMN_MISMATCH'],
    [{ topics: [{ id: Number(id) }] }, 'EDITOR_METADATA_INVALID'],
    [{ creationStatement: { disclaimer_status: 'unexpected' } }, 'EDITOR_METADATA_INVALID'],
    [{ image_url: 'https://external.invalid/image.png' }, 'EDITOR_METADATA_INVALID'],
  ]) assert.throws(() => editorMetadata({ ...metadata(), ...changes }, prepared), { code });
});
