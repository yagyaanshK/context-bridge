import path from 'node:path';
import { ensureDir, pathExists, readJson, writeJson } from '../fs-utils.js';
import { accountDir } from './store.js';
import { codexHome, readCodexAuth } from './codex.js';

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

// Poll slowly and cache. Provider usage endpoints are rate limited in their own
// right, and a panel that refreshes on every render is how monitoring tools end
// up permanently 429'd. Nothing here is time critical: a quota reading minutes
// old is still a good basis for choosing an account.
export const DEFAULT_QUOTA_TTL_MS = 5 * 60 * 1000;

export function quotaCachePath(accountId, options = {}) {
  return path.join(accountDir(accountId, options), 'quota.json');
}

export async function readQuotaCache(accountId, options = {}) {
  const file = quotaCachePath(accountId, options);
  if (!(await pathExists(file))) return null;
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

async function writeQuotaCache(accountId, usage, options = {}) {
  await ensureDir(accountDir(accountId, options));
  await writeJson(quotaCachePath(accountId, options), usage);
}

// Returns the cached reading unless it is older than the TTL. `force` refreshes
// regardless; `offline` never touches the network.
export async function getCodexUsage(accountId, options = {}) {
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_QUOTA_TTL_MS;
  const cached = await readQuotaCache(accountId, options);

  if (cached && !options.force) {
    const age = Date.now() - Date.parse(cached.fetchedAt || 0);
    if (Number.isFinite(age) && age >= 0 && age < ttl) return { ...cached, fromCache: true };
  }
  if (options.offline) return cached ? { ...cached, fromCache: true } : null;

  const auth = await readCodexAuth(codexHome(accountId, options));
  if (!auth?.accessToken) {
    return { accountId, error: 'not-signed-in', fetchedAt: new Date().toISOString(), windows: [] };
  }

  try {
    const usage = await fetchCodexUsage(auth, options);
    await writeQuotaCache(accountId, { accountId, ...usage }, options);
    return { accountId, ...usage, fromCache: false };
  } catch (error) {
    // A failed refresh must not discard a good previous reading - the panel is
    // more useful showing a stale number with its age than showing nothing.
    if (cached) return { ...cached, fromCache: true, staleReason: error.message };
    return { accountId, error: error.message, fetchedAt: new Date().toISOString(), windows: [] };
  }
}

export async function fetchCodexUsage(auth, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available.');

  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/json',
    'User-Agent': options.userAgent || 'context-bridge'
  };
  const accountId = auth.accountId || auth.claims?.accountId;
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;

  const response = await fetchImpl(options.usageUrl || CODEX_USAGE_URL, { headers });
  if (!response.ok) {
    throw new Error(`Usage request failed: ${response.status} ${response.statusText || ''}`.trim());
  }

  return normalizeCodexUsage(await response.json());
}

// The response shape is observed from the wire, not from a published contract,
// so read defensively: accept several key spellings, tolerate missing windows,
// and never let an unexpected payload throw.
export function normalizeCodexUsage(payload) {
  const source = payload?.rate_limits || payload?.rateLimits || payload?.usage || payload || {};
  const candidates = Array.isArray(source) ? source : Object.entries(source).map(([key, value]) => ({ key, ...value }));

  const windows = [];
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const usedPercent = firstNumber(item.used_percent, item.usedPercent, item.percent_used);
    if (usedPercent === undefined) continue;

    const resetSeconds = firstNumber(item.resets_at, item.resetsAt, item.reset_at, item.resets_in_seconds);
    const windowSeconds = firstNumber(item.limit_window_seconds, item.window_seconds, item.windowSeconds);

    windows.push({
      key: item.key || item.name || item.window || 'window',
      label: windowLabel(item.key || item.name || item.window, windowSeconds),
      usedPercent: clampPercent(usedPercent),
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: toIso(resetSeconds),
      windowSeconds
    });
  }

  return { fetchedAt: new Date().toISOString(), windows, plan: payload?.plan_type || payload?.plan };
}

// The headline number for a panel: the tightest window is the one that will
// actually stop you, so the account's "remaining" is its worst window.
export function headlineRemaining(usage) {
  const values = (usage?.windows || [])
    .map((window) => window.remainingPercent)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : undefined;
}

function windowLabel(key, windowSeconds) {
  if (Number.isFinite(windowSeconds)) {
    if (windowSeconds >= 31_000_000) return 'annual';
    if (windowSeconds >= 2_400_000) return 'monthly';
    if (windowSeconds >= 500_000) return 'weekly';
    const hours = Math.round(windowSeconds / 3600);
    if (hours >= 1) return `${hours}h`;
  }
  return String(key || 'window').replace(/_/g, ' ');
}

function firstNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(num)) return num;
  }
  return undefined;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function toIso(seconds) {
  if (!Number.isFinite(seconds)) return undefined;
  // Values under a plausible epoch are a duration until reset, not a timestamp.
  const ms = seconds < 10_000_000_000 && seconds < 315_360_000 ? Date.now() + seconds * 1000 : seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
