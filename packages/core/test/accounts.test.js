import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activateCodexAccount,
  codexEnv,
  codexHome,
  createAccount,
  decodeJwtClaims,
  fetchCodexUsage,
  getAccount,
  getCodexUsage,
  headlineRemaining,
  importCodexAuth,
  isSignedIn,
  listAccounts,
  normalizeCodexUsage,
  readCodexAuth,
  removeAccount,
  CODEX_USAGE_URL
} from '../src/index.js';

async function sandbox() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-accounts-'));
  return { home, options: { home } };
}

function idToken(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
}

async function signIn(accountId, options, overrides = {}) {
  const home = codexHome(accountId, options);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: overrides.accessToken || 'access-token',
        refresh_token: 'refresh-token',
        account_id: overrides.accountId || 'acct_123',
        id_token: idToken({
          email: overrides.email || 'dev@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: overrides.plan || 'pro' }
        })
      },
      last_refresh: '2026-08-01T00:00:00.000Z'
    }),
    'utf8'
  );
  return home;
}

test('accounts are created with stable ids and isolated homes', async () => {
  const { options } = await sandbox();
  const first = await createAccount({ label: 'Primary', provider: 'codex' }, options);
  const second = await createAccount({ label: 'Primary', provider: 'codex' }, options);

  assert.equal(first.id, 'primary');
  assert.equal(second.id, 'primary-2', 'a colliding label must not overwrite the first account');
  assert.notEqual(codexHome(first.id, options), codexHome(second.id, options));

  const accounts = await listAccounts(options);
  assert.equal(accounts.length, 2);
  // Isolation is the whole mechanism: one env var per account, pointing at its own tree.
  assert.equal(codexEnv(first.id, options).CODEX_HOME, codexHome(first.id, options));
});

test('listAccounts can filter by provider', async () => {
  const { options } = await sandbox();
  await createAccount({ label: 'Codex one', provider: 'codex' }, options);
  await createAccount({ label: 'Claude one', provider: 'claude' }, options);
  assert.equal((await listAccounts({ ...options, provider: 'codex' })).length, 1);
  assert.equal((await listAccounts(options)).length, 2);
});

test('reading a Codex login extracts identity without verifying the token', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Work', provider: 'codex' }, options);
  assert.equal(await isSignedIn(account.id, options), false);

  await signIn(account.id, options, { email: 'work@example.com', plan: 'pro_20x' });
  const auth = await readCodexAuth(codexHome(account.id, options));

  assert.equal(auth.accessToken, 'access-token');
  assert.equal(auth.accountId, 'acct_123');
  assert.equal(auth.claims.email, 'work@example.com');
  assert.equal(auth.claims.plan, 'pro_20x');
  assert.equal(await isSignedIn(account.id, options), true);
});

test('a missing or malformed login is reported, not thrown past', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Empty', provider: 'codex' }, options);
  assert.equal(await readCodexAuth(codexHome(account.id, options)), null);

  const home = codexHome(account.id, options);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'auth.json'), '{ not json', 'utf8');
  await assert.rejects(() => readCodexAuth(home), /Could not parse/);

  assert.equal(decodeJwtClaims('not-a-jwt'), undefined);
  assert.equal(decodeJwtClaims(undefined), undefined);
});

test('importing an existing login adopts it and records the identity', async () => {
  const { home, options } = await sandbox();
  const source = path.join(home, '.codex');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'imported', id_token: idToken({ email: 'me@example.com' }) } }),
    'utf8'
  );

  const account = await createAccount({ label: 'Imported', provider: 'codex' }, options);
  await importCodexAuth(account.id, source, options);

  const auth = await readCodexAuth(codexHome(account.id, options));
  assert.equal(auth.accessToken, 'imported');
  assert.equal((await getAccount(account.id, options)).email, 'me@example.com');
});

test('activating an account writes the default home and backs up what was there', async () => {
  const { home, options } = await sandbox();
  const defaultHome = path.join(home, '.codex');
  await fs.mkdir(defaultHome, { recursive: true });
  await fs.writeFile(path.join(defaultHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'previous' } }), 'utf8');

  const account = await createAccount({ label: 'Second', provider: 'codex' }, options);
  await signIn(account.id, options, { accessToken: 'second-token' });

  const result = await activateCodexAccount(account.id, { ...options, defaultCodexHome: defaultHome });
  const written = JSON.parse(await fs.readFile(path.join(defaultHome, 'auth.json'), 'utf8'));
  assert.equal(written.tokens.access_token, 'second-token');

  // The swap must be reversible: the credential it replaced is still on disk.
  const backup = JSON.parse(await fs.readFile(result.backup, 'utf8'));
  assert.equal(backup.tokens.access_token, 'previous');
  assert.ok((await getAccount(account.id, options)).lastUsedAt);
});

test('activating an account that never signed in fails loudly', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Never', provider: 'codex' }, options);
  await assert.rejects(() => activateCodexAccount(account.id, options), /not signed in/);
});

test('forgetting an account leaves credentials unless purge is requested', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Temp', provider: 'codex' }, options);
  await signIn(account.id, options);

  await removeAccount(account.id, options);
  assert.equal((await listAccounts(options)).length, 0);
  // Still recoverable: forgetting is not deleting.
  const auth = await readCodexAuth(codexHome(account.id, options));
  assert.equal(auth.accessToken, 'access-token');

  const restored = await createAccount({ label: 'Temp', provider: 'codex' }, options);
  const purged = await removeAccount(restored.id, { ...options, purge: true });
  assert.equal(purged.purged, true);
  assert.equal(await readCodexAuth(codexHome(restored.id, options)), null);
});

test('usage request carries the account header and bearer token', async () => {
  let seen;
  const auth = { accessToken: 'tok', accountId: 'acct_9' };
  await fetchCodexUsage(auth, {
    fetch: async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ rate_limits: {} }) };
    }
  });

  assert.equal(seen.url, CODEX_USAGE_URL);
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.equal(seen.init.headers['ChatGPT-Account-Id'], 'acct_9');
});

test('usage normalization tolerates the shapes the endpoint actually returns', () => {
  const usage = normalizeCodexUsage({
    rate_limits: {
      primary: { used_percent: 12, limit_window_seconds: 18000, resets_at: 1830000000 },
      secondary: { usedPercent: 40.44, limit_window_seconds: 604800 },
      broken: { note: 'no percentage here' }
    }
  });

  assert.equal(usage.windows.length, 2, 'entries without a percentage are skipped, not guessed at');
  const [five, week] = usage.windows;
  assert.equal(five.label, '5h');
  assert.equal(five.remainingPercent, 88);
  assert.equal(week.label, 'weekly');
  assert.equal(week.remainingPercent, 59.6);
  assert.equal(headlineRemaining(usage), 59.6, 'the tightest window is the one that stops you');
});

test('usage normalization clamps out-of-range percentages', () => {
  const usage = normalizeCodexUsage({ rate_limits: { a: { used_percent: 140 }, b: { used_percent: -5 } } });
  assert.equal(usage.windows[0].remainingPercent, 0);
  assert.equal(usage.windows[1].remainingPercent, 100);
});

test('quota reads come from cache until the TTL expires', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Cached', provider: 'codex' }, options);
  await signIn(account.id, options);

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => ({ rate_limits: { primary: { used_percent: 10, limit_window_seconds: 18000 } } }) };
  };

  const first = await getCodexUsage(account.id, { ...options, fetch: fetchImpl });
  assert.equal(first.windows[0].remainingPercent, 90);
  assert.equal(calls, 1);

  await getCodexUsage(account.id, { ...options, fetch: fetchImpl });
  assert.equal(calls, 1, 'a fresh cache entry must not hit the network again');

  await getCodexUsage(account.id, { ...options, fetch: fetchImpl, force: true });
  assert.equal(calls, 2, 'force refreshes regardless of age');
});

test('a failed refresh keeps the last good reading instead of blanking the panel', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Flaky', provider: 'codex' }, options);
  await signIn(account.id, options);

  await getCodexUsage(account.id, {
    ...options,
    fetch: async () => ({ ok: true, json: async () => ({ rate_limits: { p: { used_percent: 25, limit_window_seconds: 18000 } } }) })
  });

  const degraded = await getCodexUsage(account.id, {
    ...options,
    force: true,
    fetch: async () => ({ ok: false, status: 429, statusText: 'Too Many Requests' })
  });

  assert.equal(degraded.windows[0].remainingPercent, 75, 'the stale-but-good reading survives');
  assert.match(degraded.staleReason, /429/);
  assert.equal(degraded.fromCache, true);
});

test('quota for an account with no login reports that rather than erroring', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Anon', provider: 'codex' }, options);
  const usage = await getCodexUsage(account.id, { ...options, fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(usage.error, 'not-signed-in');
  assert.deepEqual(usage.windows, []);
});

test('offline mode never touches the network', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Offline', provider: 'codex' }, options);
  await signIn(account.id, options);
  const usage = await getCodexUsage(account.id, {
    ...options,
    offline: true,
    fetch: () => {
      throw new Error('network must not be used in offline mode');
    }
  });
  assert.equal(usage, null);
});
