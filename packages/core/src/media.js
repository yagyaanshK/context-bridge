const INLINE_DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g;
const QUOTED_DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[^"`'\r\n]+/g;
const JSON_BASE64_FIELD_RE = /"((?:image|screenshot|data|bytes|base64)[^"]*)"\s*:\s*"([A-Za-z0-9+/=]{800,})"/gi;
const LONG_BASE64_TOKEN_RE = /(^|[^A-Za-z0-9+/=])([A-Za-z0-9+/=]{1200,})(?=$|[^A-Za-z0-9+/=])/g;

export function sanitizeContentForHandoff(content) {
  const stats = {
    inlineImages: 0,
    jsonFields: 0,
    base64Tokens: 0
  };

  let text = String(content || '');
  text = text.replace(QUOTED_DATA_IMAGE_RE, (match) => {
    stats.inlineImages++;
    return `[Context Bridge omitted inline base64 image: ${match.length} chars]`;
  });
  text = text.replace(INLINE_DATA_IMAGE_RE, (match) => {
    stats.inlineImages++;
    return `[Context Bridge omitted inline base64 image: ${match.length} chars]`;
  });
  text = text.replace(JSON_BASE64_FIELD_RE, (_match, field, value) => {
    stats.jsonFields++;
    return `"${field}": "[Context Bridge omitted base64 payload: ${value.length} chars]"`;
  });
  text = text.replace(LONG_BASE64_TOKEN_RE, (match, prefix, token) => {
    if (!looksLikeBase64(token)) return match;
    stats.base64Tokens++;
    return `${prefix}[Context Bridge omitted base64 blob: ${token.length} chars]`;
  });

  return {
    content: text,
    omitted: stats.inlineImages + stats.jsonFields + stats.base64Tokens,
    stats
  };
}

export function mediaReferencesFromMetadata(metadata = {}) {
  const media = metadata.media || {};
  const refs = [];
  for (const path of media.localImages || []) {
    refs.push(`- Local image: ${path}`);
  }
  for (const path of media.localFiles || []) {
    refs.push(`- Local file: ${path}`);
  }
  if (media.inlineImageCount) {
    refs.push(`- Inline images omitted from transcript: ${media.inlineImageCount}`);
  }
  return refs;
}

function looksLikeBase64(value) {
  if (value.length < 1200) return false;
  const slashOrPlus = (value.match(/[+/]/g) || []).length;
  const equals = (value.match(/=/g) || []).length;
  return slashOrPlus > 1 || equals > 1;
}
