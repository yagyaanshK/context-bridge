import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, pathExists, readJson } from '../fs-utils.js';
import { accountDir, updateAccount } from './store.js';

export const CODEX_PROVIDER = 'codex';

// Multi-account Codex is multi-directory Codex. The CLI keeps its identity in
// `auth.json` under whatever CODEX_HOME points at, so giving each account its
// own home lets every subscription stay signed in at once - no swapping, no
// re-login, and no risk of one switch interrupting another session's token
// refresh.
export function codexHome(accountId, options = {}) {
  return path.join(accountDir(accountId, options), 'codex-home');
}

export function defaultCodexHome(options = {}) {
  return options.defaultCodexHome || process.env.CODEX_HOME || path.join(options.home || os.homedir(), '.codex');
}

export function codexAuthPath(home) {
  return path.join(home, 'auth.json');
}

// The environment a spawned `codex` process needs to act as this account.
export function codexEnv(accountId, options = {}) {
  return { CODEX_HOME: codexHome(accountId, options) };
}

export async function readCodexAuth(home) {
  const file = codexAuthPath(home);
  if (!(await pathExists(file))) return null;

  let raw;
  try {
    raw = await readJson(file);
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error.message}`);
  }

  const tokens = raw.tokens || {};
  return {
    path: file,
    accessToken: tokens.access_token || tokens.accessToken,
    refreshToken: tokens.refresh_token || tokens.refreshToken,
    idToken: tokens.id_token || tokens.idToken,
    accountId: tokens.account_id || tokens.accountId,
    lastRefresh: raw.last_refresh || raw.lastRefresh,
    claims: decodeJwtClaims(tokens.id_token || tokens.idToken)
  };
}

export async function isSignedIn(accountId, options = {}) {
  const auth = await readCodexAuth(codexHome(accountId, options));
  return Boolean(auth?.accessToken);
}

// Copy an existing login into an account home. Used for "I already ran
// `codex login`, adopt that" rather than making the user sign in again.
export async function importCodexAuth(accountId, sourceHome, options = {}) {
  const source = codexAuthPath(sourceHome);
  if (!(await pathExists(source))) {
    throw new Error(`No Codex login found at ${source}. Run \`codex login\` first, or pick another directory.`);
  }
  const target = codexHome(accountId, options);
  await ensureDir(target);
  await copyCredential(source, codexAuthPath(target));

  const auth = await readCodexAuth(target);
  await updateAccount(
    accountId,
    { email: auth?.claims?.email, plan: auth?.claims?.plan, signedInAt: new Date().toISOString() },
    options
  );
  return auth;
}

// Point the *official* Codex CLI and VS Code extension at this account by
// writing its credential into the default home. This is the one operation that
// is machine-global rather than per-session: the official tooling reads only
// the default directory, so making an account "default" is the only way to
// reach it. The previous credential is kept beside it so the swap is reversible.
export async function activateCodexAccount(accountId, options = {}) {
  const source = codexAuthPath(codexHome(accountId, options));
  if (!(await pathExists(source))) {
    throw new Error(`Account "${accountId}" is not signed in yet.`);
  }

  const target = defaultCodexHome(options);
  await ensureDir(target);
  const targetAuth = codexAuthPath(target);

  let backup;
  if (await pathExists(targetAuth)) {
    backup = path.join(target, 'auth.context-bridge-backup.json');
    await fs.copyFile(targetAuth, backup);
  }

  await copyCredential(source, targetAuth);
  await updateAccount(accountId, { lastUsedAt: new Date().toISOString() }, options);
  return { target: targetAuth, backup };
}

// auth.json is a live credential. Write it 0600 so activating an account does
// not quietly widen its permissions; on Windows the mode is ignored, which is
// why this is best-effort rather than load-bearing.
async function copyCredential(source, target) {
  const contents = await fs.readFile(source, 'utf8');
  await fs.writeFile(target, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(target, 0o600);
  } catch {
    // Windows and some network filesystems do not support POSIX modes.
  }
}

// The id_token is a JWT. We read its payload purely to label the account in the
// UI - never to make a trust decision - so it is decoded, not verified.
export function decodeJwtClaims(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return undefined;
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    const auth = payload['https://api.openai.com/auth'] || {};
    return {
      email: payload.email || payload.preferred_username,
      plan: auth.chatgpt_plan_type || auth.chatgptPlanType,
      accountId: auth.chatgpt_account_id || auth.chatgptAccountId
    };
  } catch {
    return undefined;
  }
}
