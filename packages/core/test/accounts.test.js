import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activateCodexAccount,
  activeCodexAccountId,
  restoreCodexBackup,
  codexEnv,
  codexHome,
  createAccount,
  decodeJwtClaims,
  ensureCodexHome,
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
  updateAccount,
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
        // Unique per account, as real refresh tokens are - this is the key the
        // active-account match relies on.
        refresh_token: overrides.refreshToken || `${accountId}-refresh`,
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

test('a new account has a CODEX_HOME that exists before anything is launched', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Fresh', provider: 'codex' }, options);
  const home = codexHome(account.id, options);

  // `codex` will not create CODEX_HOME; it exits with "that path does not
  // exist", so `codex login` could never complete for a new subscription.
  await ensureCodexHome(account.id, options);
  const stat = await fs.stat(home);
  assert.ok(stat.isDirectory(), 'CODEX_HOME must exist before codex is spawned against it');

  // Safe to call again on an account that is already set up.
  await ensureCodexHome(account.id, options);
  assert.ok((await fs.stat(home)).isDirectory());
});

test('renaming changes the label and leaves the credential where it is', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'tk', provider: 'codex' }, options);
  await signIn(account.id, options, { accessToken: 'keep-me' });
  const homeBefore = codexHome(account.id, options);

  const renamed = await updateAccount(account.id, { label: 'Work laptop' }, options);

  assert.equal(renamed.label, 'Work laptop');
  // The id forms the directory path, so it must survive a rename untouched -
  // otherwise renaming would strand or invalidate the login.
  assert.equal(renamed.id, account.id);
  assert.equal(codexHome(account.id, options), homeBefore);
  assert.equal((await readCodexAuth(homeBefore)).accessToken, 'keep-me');
  assert.equal(await isSignedIn(account.id, options), true);

  const listed = await listAccounts(options);
  assert.equal(listed.length, 1, 'renaming must not create a second account');
  assert.equal(listed[0].label, 'Work laptop');
});

test('renaming to a label that collides with another account is allowed', async () => {
  // Labels are for humans and need not be unique; ids are what must not collide.
  const { options } = await sandbox();
  const first = await createAccount({ label: 'One', provider: 'codex' }, options);
  const second = await createAccount({ label: 'Two', provider: 'codex' }, options);
  await updateAccount(second.id, { label: 'One' }, options);

  const listed = await listAccounts(options);
  assert.equal(listed.length, 2);
  assert.notEqual(listed[0].id, listed[1].id);
  assert.equal(first.id, 'one');
  assert.equal(second.id, 'two');
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

test('the account in use is detected, and survives access-token rotation', async () => {
  const { home, options } = await sandbox();
  const defaultHome = path.join(home, '.codex');
  const scoped = { ...options, defaultCodexHome: defaultHome };

  const a = await createAccount({ label: 'A', provider: 'codex' }, options);
  const b = await createAccount({ label: 'B', provider: 'codex' }, options);
  await signIn(a.id, options, { accessToken: 'a-access' });
  await signIn(b.id, options, { accessToken: 'b-access' });

  const accounts = await listAccounts(options);
  assert.equal(await activeCodexAccountId(accounts, scoped), undefined, 'nothing is active before a switch');

  await activateCodexAccount(b.id, scoped);
  assert.equal(await activeCodexAccountId(accounts, scoped), b.id);

  // Codex rotates the access token in place as it expires. Matching on that
  // alone would report no active account within the hour, so the refresh token
  // is the primary key.
  const current = JSON.parse(await fs.readFile(path.join(defaultHome, 'auth.json'), 'utf8'));
  current.tokens.access_token = 'rotated-by-codex';
  await fs.writeFile(path.join(defaultHome, 'auth.json'), JSON.stringify(current), 'utf8');
  assert.equal(await activeCodexAccountId(accounts, scoped), b.id, 'still B after a token rotation');
});

test('a switch can be undone from the backup it leaves behind', async () => {
  const { home, options } = await sandbox();
  const defaultHome = path.join(home, '.codex');
  const scoped = { ...options, defaultCodexHome: defaultHome };

  const a = await createAccount({ label: 'A', provider: 'codex' }, options);
  const b = await createAccount({ label: 'B', provider: 'codex' }, options);
  await signIn(a.id, options, { accessToken: 'a-access' });
  await signIn(b.id, options, { accessToken: 'b-access' });

  await activateCodexAccount(a.id, scoped);
  await activateCodexAccount(b.id, scoped);
  const accounts = await listAccounts(options);
  assert.equal(await activeCodexAccountId(accounts, scoped), b.id);

  await restoreCodexBackup(scoped);
  assert.equal(await activeCodexAccountId(accounts, scoped), a.id, 'undo puts the previous subscription back');
});

test('undo with nothing to restore reports it rather than corrupting the login', async () => {
  const { home, options } = await sandbox();
  await assert.rejects(() => restoreCodexBackup({ ...options, defaultCodexHome: path.join(home, '.codex') }), /No Context Bridge backup/);
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

test('usage normalization finds windows regardless of how they are nested', () => {
  // The live payload shape is not published and has moved before, so the parser
  // walks for percentage-carrying nodes instead of assuming one nesting.
  const shapes = [
    { rate_limits: { primary: { used_percent: 30, limit_window_seconds: 18000 } } },
    { primary: { used_percent: 30, limit_window_seconds: 18000 } },
    { usage: { rate_limits: { windows: [{ name: 'primary', used_percent: 30, limit_window_seconds: 18000 }] } } },
    { data: { attributes: { limits: [{ key: 'primary', usedPercent: 30, windowSeconds: 18000 }] } } }
  ];

  for (const shape of shapes) {
    const usage = normalizeCodexUsage(shape);
    assert.equal(usage.windows.length, 1, `no window found in ${JSON.stringify(shape)}`);
    assert.equal(usage.windows[0].remainingPercent, 70);
    assert.equal(usage.windows[0].label, '5h');
  }
});

// Captured verbatim from a live response, trimmed of the upsell/referral blocks
// that carry no quota. Keeping a real payload in the suite is what stops the
// next parser change from silently regressing on the shape that actually ships.
const LIVE_CODEX_PAYLOAD = {
  user_id: 'user-redacted',
  account_id: 'account-redacted',
  email: 'dev@example.com',
  plan_type: 'plus',
  rate_limit: {
    allowed: false,
    limit_reached: true,
    primary_window: {
      used_percent: 100,
      limit_window_seconds: 604800,
      reset_after_seconds: 227369,
      reset_at: 1787220169
    },
    secondary_window: null
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  credits: { has_credits: false, unlimited: false, balance: '0', approx_local_messages: [0, 0] },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 }
};

test('usage normalization handles the live Codex payload', () => {
  const usage = normalizeCodexUsage(LIVE_CODEX_PAYLOAD);

  assert.equal(usage.windows.length, 1, 'a null secondary_window must not become a window');
  assert.equal(usage.windows[0].label, 'weekly');
  assert.equal(usage.windows[0].usedPercent, 100);
  assert.equal(usage.windows[0].remainingPercent, 0);
  assert.equal(usage.windows[0].resetsAt, new Date(1787220169 * 1000).toISOString());

  assert.equal(usage.plan, 'plus');
  assert.equal(usage.email, 'dev@example.com');
  // Stated by the provider, not inferred from the percentage.
  assert.equal(usage.limitReached, true);
  assert.equal(usage.credits.hasCredits, false);
  assert.equal(usage.credits.balance, 0);
  assert.equal(headlineRemaining(usage), 0);
});

test('usage normalization ignores unrelated counters in the payload', () => {
  // The live response carries referral and spend-control blocks full of numbers.
  // None of them are quota windows and none may leak into the panel.
  const usage = normalizeCodexUsage({
    ...LIVE_CODEX_PAYLOAD,
    rate_limit_upsell: {
      referral: {
        remaining_send_capacity: 10,
        remaining_reward_capacity: 3,
        time_frame_rules: [{ invites_sent: 0, invites_total: 10, time_frame: 'month' }]
      }
    }
  });
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].key, 'primary_window');
});

test('a limit-reached reading is a fact, not an error state', () => {
  const usage = normalizeCodexUsage(LIVE_CODEX_PAYLOAD);
  assert.equal(usage.error, undefined, 'being out of quota is not a failure to read quota');
  assert.ok(usage.windows.length > 0);
});

test('usage normalization reads 0-1 utilization as well as percentages', () => {
  const usage = normalizeCodexUsage({
    five_hour: { utilization: 0.42, limit_window_seconds: 18000, resets_at: '2099-01-01T00:00:00.000Z' },
    seven_day: { utilization: 0.61, limit_window_seconds: 604800 }
  });
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].remainingPercent, 58);
  assert.equal(usage.windows[1].remainingPercent, 39);
  assert.equal(usage.windows[0].resetsAt, '2099-01-01T00:00:00.000Z');
});

test('usage normalization orders windows tightest first and picks up the plan', () => {
  const usage = normalizeCodexUsage({
    rate_limits: {
      weekly: { used_percent: 5, limit_window_seconds: 604800 },
      hourly: { used_percent: 80, limit_window_seconds: 18000 }
    },
    plan_type: 'pro_20x'
  });
  assert.deepEqual(usage.windows.map((w) => w.label), ['5h', 'weekly']);
  assert.equal(usage.plan, 'pro_20x');
  assert.equal(headlineRemaining(usage), 20);
});

test('usage normalization survives payloads with nothing usable in them', () => {
  for (const payload of [{}, null, { message: 'unauthorized' }, [], { a: { b: { c: 'deep but empty' } } }]) {
    const usage = normalizeCodexUsage(payload);
    assert.deepEqual(usage.windows, [], `unexpected windows for ${JSON.stringify(payload)}`);
    assert.equal(headlineRemaining(usage), undefined);
  }
});

test('usage normalization clamps out-of-range percentages', () => {
  const usage = normalizeCodexUsage({ rate_limits: { a: { used_percent: 140 }, b: { used_percent: -5 } } });
  assert.equal(usage.windows[0].remainingPercent, 0);
  assert.equal(usage.windows[1].remainingPercent, 100);
});

test('a cached reading with no windows never satisfies a read', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Stale', provider: 'codex' }, options);
  await signIn(account.id, options);

  // Stand in for a cache written by an older parser that understood nothing.
  let calls = 0;
  const empty = async () => {
    calls++;
    return { ok: true, json: async () => ({ unrecognized: 'shape' }) };
  };
  await getCodexUsage(account.id, { ...options, fetch: empty });
  assert.equal(calls, 1);

  // Without force, and well inside the TTL: an empty cache is a parse miss, not
  // a fact, so it must retry rather than serve "unavailable" for five minutes.
  const good = async () => {
    calls++;
    return { ok: true, json: async () => ({ rate_limits: { p: { used_percent: 20, limit_window_seconds: 18000 } } }) };
  };
  const usage = await getCodexUsage(account.id, { ...options, fetch: good });
  assert.equal(calls, 2, 'the empty cache entry must not have been served');
  assert.equal(usage.windows[0].remainingPercent, 80);

  // Now that a real reading is cached, the TTL applies normally.
  await getCodexUsage(account.id, { ...options, fetch: good });
  assert.equal(calls, 2);
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
