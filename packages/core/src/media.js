const INLINE_DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g;
const QUOTED_DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[^"`'\r\n]+/g;
const JSON_BASE64_FIELD_RE = /(?:image|screenshot|data|bytes|base64)/i;

export function sanitizeContentForHandoff(content) {
  const stats = {
    inlineImages: 0,
    jsonFields: 0,
    base64Tokens: 0,
    secrets: 0
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
  const redacted = redactSecrets(text);
  text = redacted.content;
  stats.secrets = redacted.count;

  return {
    content: text,
    omitted: stats.inlineImages + stats.jsonFields + stats.base64Tokens + stats.secrets,
    stats
  };
}

export function mediaReferencesFromMetadata(metadata = {}) {
  const media = metadata.media || {};
  const refs = [];
  for (const path of media.localImages || []) {
    refs.push(`- Local image (untrusted path): ${safeMetadataValue(path)}`);
  }
  for (const path of media.localFiles || []) {
    refs.push(`- Local file (untrusted path): ${safeMetadataValue(path)}`);
  }
  if (media.inlineImageCount) {
    refs.push(`- Inline images omitted from transcript: ${media.inlineImageCount}`);
  }
  return refs;
}

export function safeMetadataValue(value) {
  const sanitized = sanitizeContentForHandoff(value).content
    .replace(/\r?\n/g, '\\n')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replaceAll('`', '\\u0060')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
  return `\`${sanitized}\``;
}

export function redactSecrets(content) {
  let text = String(content || '');
  let count = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      count++;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  };

  replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]');
  replace(/\b(Authorization\s*:\s*)(Bearer|Basic)\s+[^\s"']+/gi, (_match, prefix, scheme) => `${prefix}${scheme} [REDACTED]`);
  replace(/\b(https?:\/\/[^\s/@:]+:)[^\s/@]+@/gi, (_match, prefix) => `${prefix}[REDACTED]@`);
  replace(
    /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|cookie)["']?\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi,
    (_match, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`
  );
  replace(
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|cookie)\s*[:=]\s*)(?!\[REDACTED\])[^\s,;]+/gi,
    (_match, prefix) => `${prefix}[REDACTED]`
  );
  replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED TOKEN]');
  replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]');

  return { content: text, count };
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
