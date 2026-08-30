import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, pathExists, readJson } from '../fs-utils.js';
import { accountDir, listAccounts, updateAccount } from './store.js';
import { fetchClaudeProfile, refreshClaudeToken } from './claude-oauth.js';
import { assertAgentStopped } from './processes.js';

export const CLAUDE_PROVIDER = 'claude';

// Same mechanism as Codex, different environment variable. Claude Code keeps
// its whole world - credential, config, project history - under
// CLAUDE_CONFIG_DIR, so one directory per account keeps every subscription
// signed in at once.
export function claudeHome(accountId, options = {}) {
  return path.join(accountDir(accountId, options), 'claude-home');
}

export function defaultClaudeHome(options = {}) {
  return (
    options.defaultClaudeHome || process.env.CLAUDE_CONFIG_DIR || path.join(options.home || os.homedir(), '.claude')
  );
}

export function claudeCredentialsPath(home) {
  return path.join(home, '.credentials.json');
}

// Claude's config file is laid out asymmetrically, and getting this wrong means
// writing identity into a file nothing reads. With CLAUDE_CONFIG_DIR set, the
// config lives *inside* that directory. With the stock `~/.claude` home it sits
// beside it, at `~/.claude.json`. Verified on disk rather than assumed.
export function claudeConfigPath(home, options = {}) {
  const configured = options.defaultClaudeHome || process.env.CLAUDE_CONFIG_DIR;
  const stockHome = path.join(options.home || os.homedir(), '.claude');
  if (!configured && path.resolve(home) === path.resolve(stockHome)) {
    return path.join(options.home || os.homedir(), '.claude.json');
  }
  return path.join(home, '.claude.json');
}

export async function ensureClaudeHome(accountId, options = {}) {
  const home = claudeHome(accountId, options);
  await ensureDir(home);
  return home;
}

// The environment a spawned `claude` needs to act as this account.
export function claudeEnv(accountId, options = {}) {
  return { CLAUDE_CONFIG_DIR: claudeHome(accountId, options) };
}

// Identity and credential live in two different files, so both are read. The
// credential alone cannot say who signed in: unlike Codex there is no JWT to
// decode, and the email is only ever recorded in the config.
export async function readClaudeAuth(home, options = {}) {
  const file = claudeCredentialsPath(home);
  if (!(await pathExists(file))) return null;

  let raw;
  try {
    raw = await readJson(file);
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error.message}`);
  }

  const oauth = raw.claudeAiOauth || {};
  const profile = await readClaudeProfile(home, options);
  return {
    path: file,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
    organizationUuid: raw.organizationUuid || profile?.organizationUuid,
    email: profile?.emailAddress,
    plan: claudePlan(oauth, profile),
    profile
  };
}

// The `oauthAccount` block Claude Code writes into its config: who is signed in,
// which organization, and on what plan.
export async function readClaudeProfile(home, options = {}) {
  const file = claudeConfigPath(home, options);
  if (!(await pathExists(file))) return undefined;
  try {
    const config = await readJson(file);
    return config?.oauthAccount;
  } catch {
    // A corrupt or half-written config must not make an account unreadable -
    // the credential is what actually matters.
    return undefined;
  }
}

function claudePlan(oauth, profile) {
  if (typeof oauth?.subscriptionType === 'string') return oauth.subscriptionType;
  const organizationType = profile?.organizationType;
  // `claude_pro` / `claude_max` name the plan with a redundant prefix.
  if (typeof organizationType === 'string') return organizationType.replace(/^claude[_-]/, '');
  return undefined;
}

export async function isClaudeSignedIn(accountId, options = {}) {
  const auth = await readClaudeAuth(claudeHome(accountId, options), options).catch(() => null);
  return Boolean(auth?.accessToken);
}

// Adopt the login already sitting in the stock config directory.
export async function importClaudeAuth(accountId, sourceHome, options = {}) {
  const source = claudeCredentialsPath(sourceHome);
  if (!(await pathExists(source))) {
    throw new Error(`No Claude login found at ${source}. Run \`claude\` and sign in first, or pick another directory.`);
  }

  const target = await ensureClaudeHome(accountId, options);
  await copyCredential(source, claudeCredentialsPath(target));

  // Carry the identity across too, otherwise the adopted account has a working
  // login that cannot be labelled with an email.
  const profile = await readClaudeProfile(sourceHome, options);
  if (profile) await writeClaudeProfile(claudeConfigPath(target, options), profile);

  return refreshClaudeAccountIdentity(accountId, options);
}

// Point the official Claude Code CLI and extension at this account.
//
// Two files, because Claude splits credential from identity: the token decides
// what works, the config decides which email the UI shows. Writing only the
// first leaves Claude Code displaying the previous account. Both are backed up
// before being replaced, and the config is patched at the `oauthAccount` key
// rather than overwritten - the rest of that file is project history and caches
// that have nothing to do with which account is in use.
export async function activateClaudeAccount(accountId, options = {}) {
  const source = claudeCredentialsPath(claudeHome(accountId, options));
  if (!(await pathExists(source))) {
    throw new Error(`Account "${accountId}" is not signed in yet.`);
  }

  const target = defaultClaudeHome(options);
  await ensureDir(target);
  const targetCredentials = claudeCredentialsPath(target);

  let outgoing;
  if (await pathExists(targetCredentials)) {
    const accounts = await listAccounts({ ...options, provider: CLAUDE_PROVIDER });
    outgoing = await activeClaudeAccountId(accounts, options);
  }

  if (outgoing === accountId) {
    await updateAccount(accountId, { lastUsedAt: new Date().toISOString() }, options);
    return { target: targetCredentials, alreadyActive: true };
  }
  await assertAgentStopped(CLAUDE_PROVIDER, options);

  // The official client refreshes the active credential in place. Capture that
  // live state before replacing it, otherwise switching away strands a stale
  // refresh token in the managed account.
  if (outgoing) {
    await copyCredential(targetCredentials, claudeCredentialsPath(claudeHome(outgoing, options)));
    const liveProfile = await readClaudeProfile(target, options);
    if (liveProfile) await writeClaudeProfile(claudeConfigPath(claudeHome(outgoing, options), options), liveProfile);
  }

  // Renew before touching the live home. If the incoming credential cannot be
  // renewed, leave the currently active account intact and ask for sign-in.
  const incoming = await ensureClaudeAccessToken(accountId, { ...options, allowActiveRefresh: true });
  if (!incoming?.accessToken) throw new Error(`Account "${accountId}" is not signed in yet.`);
  const expiresAt = Number(incoming.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS <= Date.now()) {
    throw new Error(`Account "${accountId}" has expired and cannot be renewed. Sign in again.`);
  }
  await assertAgentStopped(CLAUDE_PROVIDER, options);

  let backup;
  if (await pathExists(targetCredentials)) {
    backup = claudeCredentialsBackupPath(target);
    await fs.copyFile(targetCredentials, backup);
  }
  await copyCredential(source, targetCredentials);

  const profile = await readClaudeProfile(claudeHome(accountId, options), options);
  let configBackup;
  if (profile) {
    const config = claudeConfigPath(target, options);
    if (await pathExists(config)) {
      configBackup = claudeConfigBackupPath(config);
      await fs.copyFile(config, configBackup);
    }
    await writeClaudeProfile(config, profile);
  }

  await updateAccount(accountId, { lastUsedAt: new Date().toISOString() }, options);
  return { target: targetCredentials, backup, configBackup };
}

export async function restoreClaudeBackup(options = {}) {
  const target = defaultClaudeHome(options);
  const backup = claudeCredentialsBackupPath(target);
  if (!(await pathExists(backup))) throw new Error('No Context Bridge backup to restore.');
  await assertAgentStopped(CLAUDE_PROVIDER, options);
  await copyCredential(backup, claudeCredentialsPath(target));

  const config = claudeConfigPath(target, options);
  const configBackup = claudeConfigBackupPath(config);
  if (await pathExists(configBackup)) await fs.copyFile(configBackup, config);

  return { restored: claudeCredentialsPath(target) };
}

function claudeCredentialsBackupPath(home) {
  return path.join(home, '.credentials.context-bridge-backup.json');
}

function claudeConfigBackupPath(config) {
  return `${config}.context-bridge-backup`;
}

// Which registered account the official Claude tooling is using. Tokens rotate,
// so profile identity is the fallback after direct token matches.
export async function activeClaudeAccountId(accounts, options = {}) {
  const current = await readClaudeAuth(defaultClaudeHome(options), options).catch(() => null);
  if (!current) return undefined;

  for (const account of accounts) {
    const auth = await readClaudeAuth(claudeHome(account.id, options), options).catch(() => null);
    if (sameClaudeIdentity(current, auth)) return account.id;
  }
  return undefined;
}

export async function refreshClaudeAccountIdentity(accountId, options = {}) {
  const auth = await readClaudeAuth(claudeHome(accountId, options), options).catch(() => null);
  if (!auth?.accessToken) return null;
  await updateAccount(
    accountId,
    { email: auth.email, plan: auth.plan, signedInAt: new Date().toISOString() },
    options
  );
  return auth;
}

// Adopt a login copied from another machine.
//
// Accepts the whole `.credentials.json` or just the `claudeAiOauth` object
// inside it, because both are things people reasonably copy. As with Codex, the
// rejection message names the actual problem: pasting the wrong file, a
// fragment, or a bare token are otherwise indistinguishable from "it failed".
export function parseClaudeAuthText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Paste the contents of a .credentials.json file.');

  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const hint = /^[A-Za-z0-9._-]+$/.test(trimmed)
      ? ' That looks like a bare token, but Claude needs the refresh token too: paste the whole .credentials.json file.'
      : '';
    throw new Error(`That is not valid JSON.${hint}`);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A .credentials.json holds a JSON object.');
  }

  // The bare `claudeAiOauth` object, lifted out of the file.
  if (!value.claudeAiOauth && typeof value.accessToken === 'string') {
    return { claudeAiOauth: value };
  }
  if (typeof value.claudeAiOauth?.accessToken !== 'string') {
    throw new Error(
      'This is JSON, but not a Claude credential: it has no claudeAiOauth.accessToken. ' +
        'On the signed-in machine the file is ~/.claude/.credentials.json.'
    );
  }
  return value;
}

export async function importClaudeAuthText(accountId, text, options = {}) {
  const value = parseClaudeAuthText(text);
  const home = await ensureClaudeHome(accountId, options);
  const file = claudeCredentialsPath(home);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows and some network filesystems do not support POSIX modes.
  }

  // A pasted credential carries no email - that lives in the config file, which
  // is not what was pasted - so record what the credential does say about the
  // plan and leave the account labelled by its name until Claude fills the rest
  // in on first use.
  if (typeof options.profile === 'object' && options.profile) {
    await writeClaudeProfile(claudeConfigPath(home, options), options.profile);
  }
  return refreshClaudeAccountIdentity(accountId, options);
}

// Store the result of a completed OAuth sign-in.
//
// Written in exactly the shape Claude Code writes, so that activating this
// account later produces a credential the official CLI and extension accept
// without knowing Context Bridge was involved.
export async function writeClaudeCredential(accountId, tokens, profile, options = {}) {
  if (!tokens?.accessToken) throw new Error('Sign-in returned no access token.');
  const home = await ensureClaudeHome(accountId, options);

  const credential = {
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      subscriptionType: profile?.plan,
      rateLimitTier: profile?.organizationRateLimitTier
    },
    organizationUuid: profile?.organizationUuid
  };

  const file = claudeCredentialsPath(home);
  await fs.writeFile(file, `${JSON.stringify(removeUndefined(credential), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows and some network filesystems do not support POSIX modes.
  }

  if (profile) await writeClaudeProfile(claudeConfigPath(home, options), claudeProfileRecord(profile));
  return refreshClaudeAccountIdentity(accountId, options);
}

// `plan` is ours, for labelling; everything else mirrors what Claude Code puts
// in `oauthAccount`, so the file stays recognisable to the official client.
function claudeProfileRecord(profile) {
  const { plan, ...record } = profile;
  return removeUndefined(record);
}

function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [
        key,
        item && typeof item === 'object' && !Array.isArray(item) ? removeUndefined(item) : item
      ])
  );
}

// Sixty seconds of slack: a token that expires while the request is in flight
// is indistinguishable from one that was already dead.
const EXPIRY_SKEW_MS = 60 * 1000;

// Is this account the one Claude Code is currently signed in as?
//
// It matters for the same reason it does on the Codex side: the active account's
// token lives in the default home, where the official client refreshes it and
// Anthropic rotates the refresh token on each use. If Context Bridge refreshed
// its own copy too, one of the two would then hold a rotated-out token and get
// "invalid_grant". Tokens drift precisely in that case, so the match falls back
// to identity - email and organization, which do not rotate.
export async function isActiveClaudeAccount(accountId, options = {}) {
  const live = await readClaudeAuth(defaultClaudeHome(options), options).catch(() => null);
  if (!live?.accessToken && !live?.refreshToken) return false;
  const auth = await readClaudeAuth(claudeHome(accountId, options), options).catch(() => null);
  return sameClaudeIdentity(live, auth);
}

function sameClaudeIdentity(left, right) {
  if (!left || !right) return false;
  if (left.refreshToken && right.refreshToken && left.refreshToken === right.refreshToken) return true;
  if (left.accessToken && right.accessToken && left.accessToken === right.accessToken) return true;
  const sameEmail = left.email && right.email && left.email.toLowerCase() === right.email.toLowerCase();
  if (!sameEmail) return false;
  // When both know their org, require it to match too; otherwise the email is
  // the best identity we have.
  if (left.organizationUuid && right.organizationUuid) return left.organizationUuid === right.organizationUuid;
  return true;
}

// A usable access token for this account, renewed if it has expired.
//
// Claude Code refreshes its own credential in place, but only for the account
// it is currently using. Every other account's token would simply go stale -
// and a stale token means the panel can never show that subscription's quota,
// which is most of the point of listing it. So Context Bridge renews them.
export async function ensureClaudeAccessToken(accountId, options = {}) {
  const auth = await readClaudeAuth(claudeHome(accountId, options), options).catch(() => null);
  if (!auth?.accessToken) return null;

  // For the active account, read the credential the official client keeps fresh
  // in the default home instead of refreshing our snapshot. Refreshing it here
  // would race Claude Code for the rotating refresh token and leave one side
  // holding a dead one - the cause of "invalid_grant" on the account in use.
  if (!options.offline && !options.allowActiveRefresh && (await isActiveClaudeAccount(accountId, options))) {
    const live = await readClaudeAuth(defaultClaudeHome(options), options).catch(() => null);
    if (live?.accessToken) return live;
  }

  const expiresAt = Number(auth.expiresAt);
  const fresh = !Number.isFinite(expiresAt) || expiresAt - EXPIRY_SKEW_MS > Date.now();
  if (fresh || options.offline) return auth;
  if (!auth.refreshToken) return auth;

  const tokens = await refreshClaudeToken(auth.refreshToken, options);
  // A refresh returns no profile, so keep the one already on disk rather than
  // wiping the account's identity every eight hours.
  const profile = await readClaudeProfile(claudeHome(accountId, options), options);
  await writeClaudeCredential(
    accountId,
    tokens,
    profile ? { ...profile, plan: auth.plan, organizationRateLimitTier: auth.rateLimitTier } : undefined,
    options
  );
  return readClaudeAuth(claudeHome(accountId, options), options);
}

// Fill in an account's identity from the API when the credential arrived
// without one - a pasted credential carries tokens but no email.
export async function backfillClaudeProfile(accountId, options = {}) {
  const auth = await ensureClaudeAccessToken(accountId, options);
  if (!auth?.accessToken) return null;
  if (auth.email) return auth;

  const profile = await fetchClaudeProfile(auth.accessToken, options).catch(() => undefined);
  if (!profile) return auth;
  await writeClaudeProfile(claudeConfigPath(claudeHome(accountId, options), options), claudeProfileRecord(profile));
  return refreshClaudeAccountIdentity(accountId, options);
}

// Patch a single key. Claude's config carries project history and caches that
// have nothing to do with which account is in use, so the file is read, one key
// replaced, and written back rather than rewritten from scratch.
async function writeClaudeProfile(file, profile) {
  let config = {};
  if (await pathExists(file)) {
    try {
      config = await readJson(file);
    } catch {
      // Unparseable config: start a fresh one rather than refusing to sign in.
      config = {};
    }
  }
  await ensureDir(path.dirname(file));
  config.oauthAccount = profile;
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

// The credential is live. Write it 0600 so activating an account does not
// quietly widen its permissions; on Windows the mode is ignored, which is why
// this is best-effort rather than load-bearing.
async function copyCredential(source, target) {
  const contents = await fs.readFile(source, 'utf8');
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(target, 0o600);
  } catch {
    // Windows and some network filesystems do not support POSIX modes.
  }
}
