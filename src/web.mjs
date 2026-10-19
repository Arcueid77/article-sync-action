import { articleUrl, fail, isZhihuImage } from './core.mjs';

const identifier = value => typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : null;
const declarations = ['包含剧透', '包含医疗建议', '虚构创作', '包含理财内容', '包含 AI 辅助创作 作者对内容负责'];

// Settings and saved drafts come from the existing editor's normal GET response.
export function editorMetadata(data, prepared, { allowDraft = false } = {}) {
  if (!data || data.id !== prepared.id || (data.state !== 'published' && !(allowDraft && data.state === 'draft'))) fail('EDITOR_METADATA_INVALID', 'The editor did not load the expected article.');
  if (data.author?.url_token !== prepared.authorUrlToken) fail('AUTHOR_MISMATCH', 'The editor article belongs to a different author.');
  const newDraft = allowDraft && data.state === 'draft';
  const columnData = newDraft && !Object.hasOwn(data, 'column') ? [] : data.column;
  if (!Array.isArray(columnData) || !Array.isArray(data.topics) || (!newDraft && !Object.hasOwn(data, 'creationStatement')) || typeof data.image_url !== 'string') fail('EDITOR_METADATA_INVALID', 'Required article settings are unavailable.');
  const columns = columnData.map(column => typeof column === 'string' ? column : identifier(column?.id ?? column?.url_token));
  const topics = data.topics.map(topic => identifier(topic.id));
  if (columns.some(value => !value) || topics.some(value => !value)) fail('EDITOR_METADATA_INVALID', 'Article settings contain ambiguous identifiers.');
  if (prepared.column && !columns.includes(prepared.column.id) && !newDraft) fail('COLUMN_MISMATCH', 'The target article is not in the configured column.');
  const statement = data.creationStatement;
  let declaration = '无声明';
  if (statement?.disclaimer_status === 'open') {
    declaration = statement.disclaimer_desc;
    if (!declarations.includes(declaration)) fail('EDITOR_METADATA_INVALID', 'The creation statement requires a supported editor option.');
  } else if (statement && statement.disclaimer_status !== 'close') {
    fail('EDITOR_METADATA_INVALID', 'The creation statement state is unknown.');
  }
  if (data.image_url && !isZhihuImage(data.image_url)) fail('EDITOR_METADATA_INVALID', 'The cover is not a Zhihu CDN image.');
  return { authorUrlToken: data.author.url_token, columns: columns.sort(), topics: topics.sort(), declaration, cover: data.image_url || null };
}

// This website endpoint returns the published version, separately from /draft.
export function publishedArticle(data, prepared, { legacyNoDeclaration = false } = {}) {
  if (!data || data.id !== prepared.id || data.type !== 'article' || data.url !== articleUrl(prepared.id) || data.state !== 'published') fail('WEBSITE_ARTICLE_INVALID', 'The website did not return the expected published article.');
  if (typeof data.title !== 'string' || !data.title.trim() || typeof data.content !== 'string' || !data.content.trim() || data.content_need_truncated !== false) fail('WEBSITE_ARTICLE_INVALID', 'The website did not return the complete published title and body.');
  const omittedDeclaration = !Object.hasOwn(data, 'creation_disclaimer');
  if ((omittedDeclaration && !legacyNoDeclaration) || (!omittedDeclaration && data.creation_disclaimer !== null && typeof data.creation_disclaimer !== 'string')) fail('WEBSITE_ARTICLE_INVALID', 'The published creation statement is unavailable.');
  const columns = Array.isArray(data.column) ? data.column : data.column ? [data.column] : [];
  if ((data.column == null && data.has_column !== false) || (data.has_column === false && columns.length) || (data.has_column === true && !columns.length)) fail('EDITOR_METADATA_INVALID', 'The published column membership is unavailable or contradictory.');
  const settings = editorMetadata({
    ...data,
    column: columns,
    creationStatement: data.creation_disclaimer
      ? { disclaimer_status: 'open', disclaimer_desc: data.creation_disclaimer }
      : null,
  }, prepared);
  return { title: data.title, html: data.content, ...settings, ...(omittedDeclaration ? { declarationReadSource: 'editor-confirmed-absence' } : {}), readSource: 'website-article', publishedUpdated: Number.isSafeInteger(data.updated) ? data.updated : null };
}

