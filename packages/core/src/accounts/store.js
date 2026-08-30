import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, pathExists, readJson, resolveInside, validatePathSegment, withFileLock, writeJson } from '../fs-utils.js';

// Accounts are a property of the machine, not of a project: the same three
// subscriptions are the same three subscriptions in every repo you open. So the
// registry lives in the home directory rather than in a project's ledger.
export const ACCOUNTS_DIR = '.context-bridge';
export const REGISTRY_FILE = 'accounts.json';
export const REGISTRY_SCHEMA_VERSION = 1;

export function accountsRoot(options = {}) {
  return options.accountsRoot || path.join(options.home || os.homedir(), ACCOUNTS_DIR);
}

export function registryPath(options = {}) {
  return path.join(accountsRoot(options), REGISTRY_FILE);
}

// Each account owns a directory tree that the agent CLI treats as its entire
// world. Keeping the agent-specific home one level down leaves room for state
// of our own (quota cache) beside it without polluting what the CLI sees.
export function accountDir(id, options = {}) {
  const root = path.join(accountsRoot(options), 'accounts');
  const target = resolveInside(root, validatePathSegment(id, 'Account id'));
  try {
    const stat = fsSync.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Account directory must not be a symbolic link: ${target}`);
    const realRoot = fsSync.realpathSync(root);
    const realTarget = fsSync.realpathSync(target);
    const relative = path.relative(realRoot, realTarget);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Account directory escapes its allowed root: ${realTarget}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

export async function readRegistry(options = {}) {
  const file = registryPath(options);
  if (!(await pathExists(file))) {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, accounts: [] };
  }
  const registry = await readJson(file);
  return {
    schemaVersion: registry.schemaVersion || REGISTRY_SCHEMA_VERSION,
    accounts: Array.isArray(registry.accounts) ? registry.accounts : []
  };
}

export async function writeRegistry(registry, options = {}) {
  await ensureDir(accountsRoot(options));
  await writeJson(registryPath(options), {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    accounts: registry.accounts || []
  });
}

export async function listAccounts(options = {}) {
  const registry = await readRegistry(options);
  const provider = options.provider;
  const accounts = provider ? registry.accounts.filter((item) => item.provider === provider) : registry.accounts;
  return accounts.map((account) => ({ ...account, dir: accountDir(account.id, options) }));
}

export async function getAccount(id, options = {}) {
  const accounts = await listAccounts(options);
  return accounts.find((account) => account.id === id);
}

export async function createAccount(input, options = {}) {
  const label = String(input.label || '').trim() || 'Account';
  const provider = input.provider || 'codex';
  let account;
  await withFileLock(registryPath(options), async () => {
    const registry = await readRegistry(options);
    const id = validatePathSegment(input.id || uniqueId(label, registry.accounts), 'Account id');
    if (registry.accounts.some((item) => item.id === id)) {
      throw new Error(`An account with id "${id}" already exists.`);
    }
    account = {
      id,
      provider,
      label,
      createdAt: new Date().toISOString(),
      lastUsedAt: undefined
    };
    registry.accounts.push(removeUndefined(account));
    await writeRegistry(registry, options);
  }, options);
  await ensureDir(accountDir(account.id, options));
  return { ...account, dir: accountDir(account.id, options) };
}

export async function updateAccount(id, patch, options = {}) {
  validatePathSegment(id, 'Account id');
  return withFileLock(registryPath(options), async () => {
    const registry = await readRegistry(options);
    const index = registry.accounts.findIndex((account) => account.id === id);
    if (index < 0) throw new Error(`No account with id "${id}".`);
    registry.accounts[index] = removeUndefined({ ...registry.accounts[index], ...patch, id });
    await writeRegistry(registry, options);
    return { ...registry.accounts[index], dir: accountDir(id, options) };
  }, options);
}

// Deleting the credential directory is the destructive half, so it is opt-in.
// Forgetting an account without `purge` leaves its login on disk and recoverable.
export async function removeAccount(id, options = {}) {
  validatePathSegment(id, 'Account id');
  const before = (await readRegistry(options)).accounts.find((item) => item.id === id);
  if (!before) throw new Error(`No account with id "${id}".`);
  const livePurged = options.purge && options.purgeLive !== false
    ? await purgeActiveProviderLogin(before, options)
    : false;
  const account = await withFileLock(registryPath(options), async () => {
    const registry = await readRegistry(options);
    const found = registry.accounts.find((item) => item.id === id);
    if (!found) throw new Error(`No account with id "${id}".`);
    registry.accounts = registry.accounts.filter((item) => item.id !== id);
    await writeRegistry(registry, options);
    return found;
  }, options);

  if (!options.purge) return { removed: account, purged: false, livePurged: false };

  const dir = path.resolve(accountDir(id, options));
  const root = path.resolve(accountsRoot(options));
  // Never delete outside the accounts tree, whatever the registry claims.
  if (dir !== root && dir.startsWith(`${root}${path.sep}`)) {
    await fs.rm(dir, { recursive: true, force: true });
    return { removed: account, purged: true, livePurged };
  }
  return { removed: account, purged: false, livePurged };
}

async function purgeActiveProviderLogin(account, options) {
  if (account.provider === 'claude') {
    const { purgeActiveClaudeAccount } = await import('./claude.js');
    return purgeActiveClaudeAccount(account.id, options);
  }
  if (account.provider === 'codex') {
    const { purgeActiveCodexAccount } = await import('./codex.js');
    return purgeActiveCodexAccount(account.id, options);
  }
  return false;
}

function uniqueId(label, accounts) {
  const base =
    String(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'account';
  const taken = new Set(accounts.map((account) => account.id));
  if (!taken.has(base)) return base;
  let counter = 2;
  while (taken.has(`${base}-${counter}`)) counter++;
  return `${base}-${counter}`;
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
