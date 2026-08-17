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

const USED_PERCENT_KEYS = ['used_percent', 'usedPercent', 'percent_used', 'percentUsed'];
// Expressed 0-1 rather than 0-100, so it needs scaling before use.
const UTILIZATION_KEYS = ['utilization', 'usage_fraction'];
const RESET_KEYS = ['resets_at', 'resetsAt', 'reset_at', 'resetAt', 'resets_in_seconds', 'resetsInSeconds'];
const WINDOW_KEYS = ['limit_window_seconds', 'limitWindowSeconds', 'window_seconds', 'windowSeconds', 'window_minutes'];
const PLAN_KEYS = ['plan_type', 'planType', 'plan', 'chatgpt_plan_type'];

// The response shape is observed from the wire, not from a published contract,
// and it differs between providers and over time. Rather than guessing at one
// nesting, walk the payload and collect every object that carries a usage
// percentage. That survives the windows moving under a different key, being
// wrapped in an extra envelope, or arriving as a list instead of a map.
export function normalizeCodexUsage(payload) {
  const windows = [];
  const seen = new Set();
  let plan;

  const visit = (node, key, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;

    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${key || 'window'}_${index + 1}`, depth + 1));
      return;
    }

    for (const planKey of PLAN_KEYS) {
      if (!plan && typeof node[planKey] === 'string') plan = node[planKey];
    }

    const window = readWindow(node, key);
    if (window) {
      const identity = `${window.key}:${window.usedPercent}:${window.windowSeconds ?? ''}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        windows.push(window);
      }
      // A node that is itself a window has no nested windows worth finding.
      return;
    }

    for (const [childKey, value] of Object.entries(node)) {
      visit(value, childKey, depth + 1);
    }
  };

  visit(payload, undefined, 0);
  // Tightest window first. Unknown durations sort last, and must compare equal
  // to each other rather than producing NaN from Infinity - Infinity.
  const rank = (window) => window.windowSeconds ?? Number.MAX_SAFE_INTEGER;
  windows.sort((a, b) => rank(a) - rank(b));
  return { fetchedAt: new Date().toISOString(), windows, plan };
}

function readWindow(node, key) {
  let usedPercent = firstNumber(...USED_PERCENT_KEYS.map((name) => node[name]));

  if (usedPercent === undefined) {
    const utilization = firstNumber(...UTILIZATION_KEYS.map((name) => node[name]));
    // A utilization is a 0-1 fraction; anything above 1 is already a percentage
    // that happens to use the same key name.
    if (utilization !== undefined) usedPercent = utilization <= 1 ? utilization * 100 : utilization;
  }
  if (usedPercent === undefined) return null;

  const minutes = firstNumber(node.window_minutes, node.windowMinutes);
  const windowSeconds = firstNumber(...WINDOW_KEYS.map((name) => node[name])) ?? (minutes ? minutes * 60 : undefined);
  const name = node.key || node.name || node.window || node.id || key;

  return {
    key: String(name || 'window'),
    label: windowLabel(name, windowSeconds),
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: toIso(firstNumber(...RESET_KEYS.map((name2) => node[name2])), node),
    windowSeconds
  };
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

function toIso(seconds, node) {
  // Some payloads carry the reset as an ISO string instead of a number.
  for (const key of RESET_KEYS) {
    const value = node?.[key];
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  if (!Number.isFinite(seconds)) return undefined;
  // Values too small to be an epoch are a duration until reset, not a timestamp.
  const ms = seconds < 315_360_000 ? Date.now() + seconds * 1000 : seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
