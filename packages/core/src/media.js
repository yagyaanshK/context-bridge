const INLINE_DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g;
const QUOTED_DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[^"`'\r\n]+/g;
const JSON_BASE64_FIELD_RE = /(?:image|screenshot|data|bytes|base64)/i;

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
  text = replaceJsonBase64Fields(text, stats);
  text = replaceLongBase64Tokens(text, stats);

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

function replaceJsonBase64Fields(text, stats) {
  let output = '';
  let last = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '"') {
      i++;
      continue;
    }

    const fieldEnd = findJsonStringEnd(text, i + 1);
    if (fieldEnd === -1) break;
    const field = text.slice(i + 1, fieldEnd);
    let cursor = fieldEnd + 1;
    while (/\s/.test(text[cursor] || '')) cursor++;
    if (text[cursor] !== ':') {
      i = fieldEnd + 1;
      continue;
    }
    cursor++;
    while (/\s/.test(text[cursor] || '')) cursor++;
    if (text[cursor] !== '"') {
      i = cursor;
      continue;
    }

    const valueStart = cursor + 1;
    const valueEnd = findJsonStringEnd(text, valueStart);
    if (valueEnd === -1) break;
    const value = text.slice(valueStart, valueEnd);
    if (JSON_BASE64_FIELD_RE.test(field) && value.length >= 800 && isBase64Token(value)) {
      stats.jsonFields++;
      output += text.slice(last, cursor);
      output += `"[Context Bridge omitted base64 payload: ${value.length} chars]"`;
      last = valueEnd + 1;
    }
    i = valueEnd + 1;
  }

  return output ? output + text.slice(last) : text;
}

function replaceLongBase64Tokens(text, stats) {
  let output = '';
  let last = 0;
  let i = 0;

  while (i < text.length) {
    if (!isBase64Char(text[i])) {
      i++;
      continue;
    }

    const start = i;
    while (i < text.length && isBase64Char(text[i])) i++;
    const token = text.slice(start, i);
    if (token.length >= 1200 && looksLikeBase64(token)) {
      stats.base64Tokens++;
      output += text.slice(last, start);
      output += `[Context Bridge omitted base64 blob: ${token.length} chars]`;
      last = i;
    }
  }

  return output ? output + text.slice(last) : text;
}

function findJsonStringEnd(text, start) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '"') return i;
  }
  return -1;
}

function isBase64Token(value) {
  if (!value || value.length % 4 === 1) return false;
  for (let i = 0; i < value.length; i++) {
    if (!isBase64Char(value[i])) return false;
  }
  return true;
}

function isBase64Char(char) {
  return (
    (char >= 'A' && char <= 'Z') ||
    (char >= 'a' && char <= 'z') ||
    (char >= '0' && char <= '9') ||
    char === '+' ||
    char === '/' ||
    char === '='
  );
}
