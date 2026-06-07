import { discoverClaudeSessions, importClaudeSession } from './claude-code.js';
import { discoverCodexSessions, importCodexSession } from './codex.js';

export async function discoverNativeSessions(provider, options = {}) {
  const normalized = normalizeNativeProvider(provider);
  if (normalized === 'claude') return discoverClaudeSessions(options);
  if (normalized === 'codex') return discoverCodexSessions(options);
  throw new Error(`Unsupported native provider: ${provider}`);
}

export async function importNativeSession(root, provider, options = {}) {
  const normalized = normalizeNativeProvider(provider);
  const sessions = await discoverNativeSessions(normalized, {
    ...options,
    all: options.path || options.sessionId ? true : options.all,
    limit: options.path || options.sessionId ? 10000 : options.limit
  });
  const session = selectSession(sessions, options);
  if (!session) {
    throw new Error(`No ${normalized} native session matched the requested filters.`);
  }
  if (normalized === 'claude') return importClaudeSession(root, session);
  if (normalized === 'codex') return importCodexSession(root, session);
  throw new Error(`Unsupported native provider: ${provider}`);
}

export function selectSession(sessions, options = {}) {
  if (options.path) {
    return sessions.find((session) => session.path === options.path || session.path === String(options.path));
  }
  if (options.sessionId) {
    return sessions.find((session) => session.sessionId === options.sessionId);
  }
  if (options.last || !options.sessionId) {
    return sessions[0];
  }
  return null;
}

export function normalizeNativeProvider(provider) {
  const value = String(provider || '').toLowerCase();
  if (value === 'claude' || value === 'anthropic') return 'claude';
  if (value === 'codex' || value === 'openai' || value === 'chatgpt') return 'codex';
  return value;
}
