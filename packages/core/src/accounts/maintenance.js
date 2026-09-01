import path from 'node:path';
import { withFileLock } from '../fs-utils.js';
import {
  codexHome,
  isActiveCodexAccount,
  readCodexAuth,
  syncActiveCodexAccount
} from './codex.js';
import {
  claudeHome,
  isActiveClaudeAccount,
  readClaudeAuth,
  syncActiveClaudeAccount
} from './claude.js';
import { getClaudeUsage, getCodexUsage } from './quota.js';
import { accountsRoot, listAccounts } from './store.js';

export const DEFAULT_ACCOUNT_MAINTENANCE_INTERVAL_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_ACCOUNT_MAINTENANCE_LOCK_TIMEOUT_MS = 100;
export const DEFAULT_ACCOUNT_MAINTENANCE_LOCK_STALE_MS = 60 * 60 * 1000;

export function accountMaintenanceLockPath(options = {}) {
  return path.join(accountsRoot(options), 'account-maintenance');
}

// Refresh due OAuth credentials and update quota caches for all managed
// accounts. A machine-wide lock prevents several editor windows or an OS
// scheduler from rotating the same refresh token concurrently.
export async function maintainAccounts(options = {}) {
  const startedAt = new Date().toISOString();
  try {
    return await withFileLock(
      accountMaintenanceLockPath(options),
      async () => {
        const results = [];
        for (const account of await listAccounts(options)) {
          options.signal?.throwIfAborted();
          results.push(await maintainAccount(account, options));
        }
        return {
          startedAt,
          completedAt: new Date().toISOString(),
          locked: false,
          results
        };
      },
      {
        ...options,
        lockTimeoutMs: options.maintenanceLockTimeoutMs ?? DEFAULT_ACCOUNT_MAINTENANCE_LOCK_TIMEOUT_MS,
        lockStaleMs: options.maintenanceLockStaleMs ?? DEFAULT_ACCOUNT_MAINTENANCE_LOCK_STALE_MS
      }
    );
  } catch (error) {
    if (/Timed out waiting for storage lock:/.test(error.message)) {
      return {
        startedAt,
        completedAt: new Date().toISOString(),
        locked: true,
        results: []
      };
    }
    throw error;
  }
}

async function maintainAccount(account, options) {
  try {
    if (account.provider === 'codex') return maintainCodexAccount(account, options);
    if (account.provider === 'claude') return maintainClaudeAccount(account, options);
    return result(account, 'skipped', { reason: 'unsupported-provider' });
  } catch (error) {
    return result(account, 'failed', { error: error.message });
  }
}

async function maintainCodexAccount(account, options) {
  const before = await readCodexAuth(codexHome(account.id, options));
  if (before?.apiKey) return result(account, 'skipped', { reason: 'api-key' });
  if (!before?.accessToken) return result(account, 'skipped', { reason: 'not-signed-in' });

  const active = await isActiveCodexAccount(account.id, options);
  if (active) await syncActiveCodexAccount(account.id, options);
  const synchronized = await readCodexAuth(codexHome(account.id, options));
  const usage = await getCodexUsage(account.id, maintenanceUsageOptions(options));
  const after = await readCodexAuth(codexHome(account.id, options));
  return usageResult(account, usage, {
    active,
    refreshed: credentialChanged(synchronized, after),
    synchronized: active && credentialChanged(before, synchronized)
  });
}

async function maintainClaudeAccount(account, options) {
  const before = await readClaudeAuth(claudeHome(account.id, options), options);
  if (!before?.accessToken) return result(account, 'skipped', { reason: 'not-signed-in' });

  const active = await isActiveClaudeAccount(account.id, options);
  if (active) await syncActiveClaudeAccount(account.id, options);
  const synchronized = await readClaudeAuth(claudeHome(account.id, options), options);
  const usage = await getClaudeUsage(account.id, maintenanceUsageOptions(options));
  const after = await readClaudeAuth(claudeHome(account.id, options), options);
  return usageResult(account, usage, {
    active,
    refreshed: credentialChanged(synchronized, after),
    synchronized: active && credentialChanged(before, synchronized)
  });
}

function maintenanceUsageOptions(options) {
  return {
    ...options,
    allowActiveRefresh: false,
    force: true,
    offline: false
  };
}

function credentialChanged(before, after) {
  return Boolean(
    before &&
      after &&
      (before.accessToken !== after.accessToken || before.refreshToken !== after.refreshToken)
  );
}

function usageResult(account, usage, details) {
  if (usage?.error) return result(account, 'failed', { ...details, error: usage.error });
  if (usage?.staleReason) return result(account, 'stale', { ...details, error: usage.staleReason });
  return result(account, details.refreshed ? 'refreshed' : 'checked', details);
}

function result(account, status, details = {}) {
  return {
    accountId: account.id,
    provider: account.provider,
    status,
    ...details
  };
}
