import path from 'node:path';
import { ensureDir, pathExists, readJson, writeJson } from '../fs-utils.js';
import { accountDir } from './store.js';
import { ensureCodexAccessToken } from './codex.js';
import { ensureClaudeAccessToken } from './claude.js';
import { claudeApiHeaders } from './claude-oauth.js';

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Poll slowly and cache. Provider usage endpoints are rate limited in their own
// right, and a panel that refreshes on every render is how monitoring tools end
// up permanently 429'd. Nothing here is time critical: a quota reading minutes
// old is still a good basis for choosing an account.
export const DEFAULT_QUOTA_TTL_MS = 5 * 60 * 1000;

// How long before a Codex access token expires to renew it proactively during a
// usage check. The token lasts ~10 days; refreshing inside its final stretch
// means an idle subscription is kept alive by the ordinary act of showing its
// quota, well before it can 401. The gap between this and the token lifetime is
// how often the rotating refresh token turns over - roughly weekly - so this
// stays comfortably under the lifetime to avoid churning it on every poll.
// (This can only run while VS Code is open to poll; an app left closed past the
// refresh token’s own lifetime still needs a fresh sign-in.)
export const CODEX_PROACTIVE_REFRESH_MS = 3 * 24 * 60 * 60 * 1000;

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
//
// Provider-agnostic: `read` resolves the account's credential and `fetch` turns
// it into a reading. Everything about caching, staleness and failure is the
// same either way, and having one copy of it means the two providers cannot
// drift into behaving differently.
async function getUsage(accountId, read, fetchUsage, options = {}) {
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_QUOTA_TTL_MS;
  const cached = await readQuotaCache(accountId, options);

  // A cached reading with no windows in it is a parse miss, not a fact about
  // the subscription, so it never satisfies a read. Otherwise a bad parse -
  // or a payload shape we did not understand at the time it was cached -
  // would keep serving "unavailable" for the whole TTL and survive the upgrade
  // that fixed it.
  const usable = (cached?.windows || []).length > 0;

  if (cached && usable && !options.force) {
    const age = Date.now() - Date.parse(cached.fetchedAt || 0);
    if (Number.isFinite(age) && age >= 0 && age < ttl) return { ...cached, fromCache: true };
  }
  if (options.offline) return cached ? { ...cached, fromCache: true } : null;

  let auth;
  try {
    auth = await read(accountId, options);
  } catch (error) {
    // Renewing an expired login is part of reading it, and can fail on its own.
    if (cached) return { ...cached, fromCache: true, staleReason: error.message };
    return { accountId, error: error.message, fetchedAt: new Date().toISOString(), windows: [] };
  }

  if (!auth?.accessToken) {
    return { accountId, error: 'not-signed-in', fetchedAt: new Date().toISOString(), windows: [] };
  }

  try {
    const usage = await fetchUsage(auth, options);
    await writeQuotaCache(accountId, { accountId, ...usage }, options);
    return { accountId, ...usage, fromCache: false };
  } catch (error) {
    // A failed refresh must not discard a good previous reading - the panel is
    // more useful showing a stale number with its age than showing nothing.
    if (cached) return { ...cached, fromCache: true, staleReason: error.message };
    return { accountId, error: error.message, fetchedAt: new Date().toISOString(), windows: [] };
  }
}

export async function getCodexUsage(accountId, options = {}) {
  // Renew before reading, exactly as the Claude path does. Checking a
  // subscription's quota is also what keeps its token from going stale: an idle
  // account refreshed here never reaches the ten-day expiry that made a switch
  // land on a dead token. The active account is left for Codex to refresh.
  // Renew inside the proactive window so checking quota also keeps the token
  // alive; a caller can still override refreshSkewMs.
  const read = (id, opts) => ensureCodexAccessToken(id, { refreshSkewMs: CODEX_PROACTIVE_REFRESH_MS, ...opts });
  return getUsage(accountId, read, fetchCodexUsage, options);
}

export async function getClaudeUsage(accountId, options = {}) {
  return getUsage(accountId, ensureClaudeAccessToken, fetchClaudeUsage, options);
}

export async function fetchClaudeUsage(auth, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available.');

  const response = await fetchImpl(options.usageUrl || CLAUDE_USAGE_URL, {
    headers: claudeApiHeaders(auth.accessToken, options)
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('This Claude login has expired. Sign in again.');
    throw new Error(`Usage request failed: ${response.status} ${response.statusText || ''}`.trim());
  }

  return { ...normalizeClaudeUsage(await response.json()), plan: auth.plan, email: auth.email };
}

// Claude's usage payload has a known shape, so it is read directly rather than
// walked the way Codex's is.
//
// `limits` is the authoritative list: it is the curated set the client itself
// renders, already carrying a kind, a percentage, a severity and a reset. The
// top-level keys beside it include codenamed buckets that are not limits the
// user has - reading those generically invents windows sitting at 100%
// remaining and drags the headline number up with them.
const CLAUDE_WINDOW_SECONDS = { session: 5 * 3600, five_hour: 5 * 3600, weekly: 7 * 86400, seven_day: 7 * 86400 };

const CLAUDE_WINDOW_LABELS = {
  session: '5h',
  five_hour: '5h',
  weekly_all: 'weekly',
  seven_day: 'weekly',
  weekly_opus: 'weekly · Opus',
  seven_day_opus: 'weekly · Opus',
  weekly_sonnet: 'weekly · Sonnet',
  seven_day_sonnet: 'weekly · Sonnet'
};

// Only the named windows are read in the fallback. Anything else in the payload
// is deliberately ignored - see above.
const CLAUDE_FALLBACK_KEYS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

export function normalizeClaudeUsage(payload) {
  const windows = [];

  if (Array.isArray(payload?.limits) && payload.limits.length > 0) {
    for (const limit of payload.limits) {
      const usedPercent = firstNumber(limit?.percent, limit?.utilization);
      if (usedPercent === undefined) continue;
      const key = String(limit.kind || limit.group || 'window');
      windows.push(claudeWindow(key, usedPercent, limit.resets_at, limit.severity));
    }
  } else {
    for (const key of CLAUDE_FALLBACK_KEYS) {
      const node = payload?.[key];
      const usedPercent = firstNumber(node?.utilization);
      if (usedPercent === undefined) continue;
      windows.push(claudeWindow(key, usedPercent, node.resets_at));
    }
  }

  const rank = (window) => window.windowSeconds ?? Number.MAX_SAFE_INTEGER;
  windows.sort((a, b) => rank(a) - rank(b));

  return {
    fetchedAt: new Date().toISOString(),
    windows,
    // The provider states severity outright; trust it over inferring from a
    // percentage, which disagrees at the boundary.
    limitReached: windows.some((window) => window.usedPercent >= 100 || window.severity === 'exceeded'),
    credits: readClaudeCredits(payload)
  };
}

function claudeWindow(key, usedPercent, resetsAt, severity) {
  const group = key.replace(/^weekly_.*/, 'weekly').replace(/^seven_day.*/, 'weekly');
  return {
    key,
    label: CLAUDE_WINDOW_LABELS[key] || key.replace(/_/g, ' '),
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: typeof resetsAt === 'string' && Number.isFinite(Date.parse(resetsAt))
      ? new Date(resetsAt).toISOString()
      : undefined,
    windowSeconds: CLAUDE_WINDOW_SECONDS[key] || CLAUDE_WINDOW_SECONDS[group],
    severity
  };
}

// Extra usage is a second axis, exactly as credits are for Codex: a plan can be
// out of quota and still able to send.
function readClaudeCredits(payload) {
  const extra = payload?.extra_usage;
  const spend = payload?.spend;
  const enabled = Boolean(extra?.is_enabled ?? spend?.enabled);
  if (!enabled) return undefined;
  const balance = Number(spend?.balance ?? extra?.used_credits);
  return {
    hasCredits: enabled && !spend?.spend_limit_reached,
    unlimited: false,
    balance: Number.isFinite(balance) ? balance : undefined
  };
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

  return {
    fetchedAt: new Date().toISOString(),
    windows,
    plan,
    email: typeof payload?.email === 'string' ? payload.email : undefined,
    ...readLimitState(payload),
    credits: readCredits(payload)
  };
}

// The provider states outright whether the subscription is currently blocked.
// Trust that over inferring it from a percentage: the two can disagree at the
// boundary, and being told "you may not send" is the useful fact.
function readLimitState(payload) {
  const limit = payload?.rate_limit || payload?.rateLimit;
  if (!limit || typeof limit !== 'object') return {};
  const reached = limit.limit_reached ?? limit.limitReached;
  const allowed = limit.allowed;
  if (typeof reached !== 'boolean' && typeof allowed !== 'boolean') return {};
  return { limitReached: typeof reached === 'boolean' ? reached : allowed === false };
}

// Credits are a second axis: a subscription can be out of quota but still able
// to send if it holds credits, so the panel must not present quota alone as the
// whole picture.
function readCredits(payload) {
  const credits = payload?.credits;
  if (!credits || typeof credits !== 'object') return undefined;
  const balance = Number(credits.balance);
  return {
    hasCredits: Boolean(credits.has_credits ?? credits.hasCredits),
    unlimited: Boolean(credits.unlimited),
    balance: Number.isFinite(balance) ? balance : undefined
  };
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

// When a blocked account starts working again.
//
// This is deliberately not "the next reset". Two things make that wrong:
//
//   - a window with room to spare can reset sooner than the one that is
//     actually blocking you, so the earliest reset can be an hour away while
//     you stay blocked for days, and
//   - when several windows are exhausted you are held by the *last* of them to
//     clear, not the first.
//
// So: take the windows that are actually exhausted and report the latest reset
// among them. If the provider says the limit is reached but no single window
// reads as exhausted, fall back to the tightest window, which is the one that
// stopped you.
export function resumesAt(usage) {
  const windows = usage?.windows || [];
  const exhausted = windows.filter(
    (window) => window.remainingPercent <= 0 || window.usedPercent >= 100 || window.severity === 'exceeded'
  );
  const blocking = exhausted.length > 0 ? exhausted : usage?.limitReached ? windows.slice(0, 1) : [];

  const times = blocking
    .map((window) => Date.parse(window.resetsAt || ''))
    .filter((value) => Number.isFinite(value));
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : undefined;
}

// The next time anything at all resets. Useful as a general "check back then"
// for an account that still has room; never as the answer to "when am I
// unblocked" - `resumesAt` answers that.
export function nextResetAt(usage) {
  const times = (usage?.windows || [])
    .map((window) => Date.parse(window.resetsAt || ''))
    .filter((value) => Number.isFinite(value));
  return times.length > 0 ? new Date(Math.min(...times)).toISOString() : undefined;
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
