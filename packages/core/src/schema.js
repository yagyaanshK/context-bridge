import crypto from 'node:crypto';

export const PROVIDERS = new Set(['openai', 'anthropic', 'codex', 'claude', 'other', 'unknown']);
export const SURFACES = new Set(['cli', 'ide', 'desktop', 'web', 'api', 'unknown']);
export const ROLES = new Set(['user', 'assistant', 'tool', 'system', 'unknown']);

export function normalizeProvider(provider = 'unknown') {
  const value = String(provider || 'unknown').toLowerCase();
  if (value === 'codex' || value === 'openai' || value === 'chatgpt') return 'openai';
  if (value === 'claude' || value === 'anthropic') return 'anthropic';
  return PROVIDERS.has(value) ? value : 'unknown';
}

export function normalizeSurface(surface = 'unknown') {
  const value = String(surface || 'unknown').toLowerCase();
  return SURFACES.has(value) ? value : 'unknown';
}

export function normalizeRole(role = 'unknown') {
  const value = String(role || 'unknown').toLowerCase();
  if (value === 'human') return 'user';
  if (value === 'ai' || value === 'model') return 'assistant';
  return ROLES.has(value) ? value : 'unknown';
}

export function createTurn(input, defaults = {}) {
  const content = coerceContent(input.content ?? input.text ?? input.message ?? input.value ?? '');
  const timestamp = input.timestamp || input.createdAt || input.created_at || defaults.timestamp || new Date().toISOString();
  const provider = normalizeProvider(input.provider || defaults.provider);
  const surface = normalizeSurface(input.surface || defaults.surface);
  const role = normalizeRole(input.role || input.author || input.type);
  const sessionId = input.sessionId || input.session_id || defaults.sessionId || undefined;
  const metadata = {
    ...(defaults.metadata || {}),
    ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {})
  };
  const id = input.id || stableTurnId({ provider, surface, sessionId, role, timestamp, content });

  return removeUndefined({
    id,
    provider,
    surface,
    sessionId,
    role,
    timestamp,
    content,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined
  });
}

export function stableTurnId(turn) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(turn))
    .digest('hex')
    .slice(0, 16);
  return `turn_${hash}`;
}

function coerceContent(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(coerceContent).join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
