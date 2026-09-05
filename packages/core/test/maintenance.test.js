import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  accountMaintenanceLockPath,
  claudeConfigPath,
  claudeCredentialsPath,
  claudeHome,
  codexHome,
  createAccount,
  importCodexAuthText,
  maintainAccounts,
  readClaudeAuth,
  readCodexAuth
} from '../src/index.js';
import { withFileLock } from '../src/fs-utils.js';

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

function codexCredential(accountId, accessToken, refreshToken) {
  return {
    auth_mode: 'oauth',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: jwt({ sub: accountId, email: `${accountId}@example.com` }),
      account_id: accountId
    },
    last_refresh: '2026-08-01T00:00:00.000Z'
  };
}

function codexAccess(exp, nonce) {
  return jwt({ exp, nonce });
}

function response(payload) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

function unauthorized() {
  return {
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => '',
    json: async () => ({})
  };
}

function codexUsage() {
  return {
    rate_limit: {
      primary_window: {
        used_percent: 12,
        limit_window_seconds: 18_000,
        reset_at: Math.floor(Date.now() / 1000) + 3600
      }
    }
  };
}

function claudeCredential(accessToken, refreshToken, expiresAt, extras = {}) {
  return {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
      ...extras
    }
  };
}

function claudeUsage() {
  return {
    five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3600_000).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
    extra_usage: { is_enabled: false }
  };
}

async function sandbox() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-maintenance-'));
  return {
    home,
    defaultCodexHome: path.join(home, 'live-codex'),
    defaultClaudeHome: path.join(home, 'live-claude'),
    agentProcesses: []
  };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('maintenance skips API-key accounts without making a request', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'API key', provider: 'codex' }, options);
  await importCodexAuthText(account.id, JSON.stringify({ OPENAI_API_KEY: 'sk-test' }), options);

  const maintenance = await maintainAccounts({
    ...options,
    fetch: () => assert.fail('API-key maintenance must not reach the network')
  });

  assert.deepEqual(maintenance.results[0], {
    accountId: account.id,
    provider: 'codex',
    status: 'skipped',
    reason: 'api-key'
  });
});

test('maintenance refreshes an expired inactive Codex login and reads quota', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Idle', provider: 'codex' }, options);
  const past = Math.floor(Date.now() / 1000) - 3600;
  const future = Math.floor(Date.now() / 1000) + 10 * 24 * 3600;
  await writeJson(
    path.join(codexHome(account.id, options), 'auth.json'),
    codexCredential('acct_idle', codexAccess(past, 'old'), 'rt.old')
  );

  const requested = [];
  const maintenance = await maintainAccounts({
    ...options,
    fetch: async (url) => {
      requested.push(url);
      if (url.includes('/oauth/token')) {
        return response({
          access_token: codexAccess(future, 'new'),
          refresh_token: 'rt.new',
          id_token: jwt({ sub: 'acct_idle', email: 'idle@example.com' })
        });
      }
      return response(codexUsage());
    }
  });

  assert.equal(maintenance.results[0].status, 'refreshed');
  assert.equal((await readCodexAuth(codexHome(account.id, options))).refreshToken, 'rt.new');
  assert.equal(requested.length, 2, 'one token refresh and one quota request');
});

test('maintenance synchronizes a live Codex rotation without refreshing it', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Active', provider: 'codex' }, options);
  const future = Math.floor(Date.now() / 1000) + 10 * 24 * 3600;
  await writeJson(
    path.join(codexHome(account.id, options), 'auth.json'),
    codexCredential('acct_active', codexAccess(future, 'snapshot'), 'rt.snapshot')
  );
  await writeJson(
    path.join(options.defaultCodexHome, 'auth.json'),
    codexCredential('acct_active', codexAccess(future, 'live'), 'rt.live')
  );

  const requested = [];
  const maintenance = await maintainAccounts({
    ...options,
    fetch: async (url) => {
      requested.push(url);
      assert.equal(url.includes('/oauth/token'), false, 'Turntrail must not refresh the active account');
      return response(codexUsage());
    }
  });

  assert.equal(maintenance.results[0].status, 'checked');
  assert.equal(maintenance.results[0].active, true);
  assert.equal(maintenance.results[0].synchronized, true);
  assert.equal((await readCodexAuth(codexHome(account.id, options))).refreshToken, 'rt.live');
  assert.equal(requested.length, 1);
});

test('maintenance repairs an early Codex 401 while the selected account is idle', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Active', provider: 'codex' }, options);
  const future = Math.floor(Date.now() / 1000) + 10 * 24 * 3600;
  const old = codexCredential('acct_active', codexAccess(future, 'old'), 'rt.old');
  await writeJson(path.join(codexHome(account.id, options), 'auth.json'), old);
  await writeJson(path.join(options.defaultCodexHome, 'auth.json'), old);

  let usageCalls = 0;
  const maintenance = await maintainAccounts({
    ...options,
    fetch: async (url) => {
      if (url.includes('/oauth/token')) {
        return response({
          access_token: codexAccess(future, 'new'),
          refresh_token: 'rt.new',
          id_token: jwt({ sub: 'acct_active', email: 'active@example.com' })
        });
      }
      usageCalls++;
      return usageCalls === 1 ? unauthorized() : response(codexUsage());
    }
  });

  assert.equal(maintenance.results[0].status, 'refreshed');
  assert.equal(maintenance.results[0].revalidated, true);
  assert.equal((await readCodexAuth(codexHome(account.id, options))).refreshToken, 'rt.new');
  assert.equal((await readCodexAuth(options.defaultCodexHome)).refreshToken, 'rt.new');
  assert.equal(usageCalls, 2, 'the rejected usage read is retried once after refresh');
});

test('maintenance defers early Codex 401 repair while a Codex process owns the login', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Active', provider: 'codex' }, options);
  const future = Math.floor(Date.now() / 1000) + 10 * 24 * 3600;
  const current = codexCredential('acct_active', codexAccess(future, 'current'), 'rt.current');
  await writeJson(path.join(codexHome(account.id, options), 'auth.json'), current);
  await writeJson(path.join(options.defaultCodexHome, 'auth.json'), current);

  const maintenance = await maintainAccounts({
    ...options,
    agentProcesses: [{ pid: 42, name: 'codex.exe' }],
    fetch: async (url) => {
      assert.equal(url.includes('/oauth/token'), false, 'maintenance must not race the live Codex refresh token');
      return unauthorized();
    }
  });

  assert.equal(maintenance.results[0].status, 'deferred');
  assert.equal(maintenance.results[0].reason, 'codex-running');
  assert.equal((await readCodexAuth(options.defaultCodexHome)).refreshToken, 'rt.current');
});

test('maintenance synchronizes a live Claude rotation without refreshing it', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Claude active', provider: 'claude' }, options);
  const expiresAt = Date.now() + 8 * 3600 * 1000;
  const credential = (accessToken, refreshToken) => ({
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes: ['user:inference']
    }
  });
  const profile = { oauthAccount: { emailAddress: 'claude@example.com', organizationUuid: 'org_1' } };
  await writeJson(claudeCredentialsPath(claudeHome(account.id, options)), credential('snapshot', 'rt.snapshot'));
  await writeJson(claudeConfigPath(claudeHome(account.id, options), options), profile);
  await writeJson(claudeCredentialsPath(options.defaultClaudeHome), credential('live', 'rt.live'));
  await writeJson(claudeConfigPath(options.defaultClaudeHome, options), profile);

  const maintenance = await maintainAccounts({
    ...options,
    fetch: async (url) => {
      assert.equal(url.includes('/oauth/token'), false, 'Turntrail must not refresh the active account');
      return response({
        five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3600_000).toISOString() },
        seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
        extra_usage: { is_enabled: false }
      });
    }
  });

  assert.equal(maintenance.results[0].status, 'checked');
  assert.equal(maintenance.results[0].active, true);
  assert.equal(maintenance.results[0].synchronized, true);
  assert.equal((await readClaudeAuth(claudeHome(account.id, options), options)).refreshToken, 'rt.live');
});

test('maintenance proactively refreshes an idle active Claude login in both stores', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Claude active', provider: 'claude' }, options);
  const expiresSoon = Date.now() + 2 * 3600 * 1000;
  const profile = { oauthAccount: { emailAddress: 'claude@example.com', organizationUuid: 'org_1' } };
  const old = claudeCredential('access.old', 'refresh.old', expiresSoon, { refreshTokenExpiresAt: 1_900_000_000_000 });
  await writeJson(claudeCredentialsPath(claudeHome(account.id, options)), old);
  await writeJson(claudeConfigPath(claudeHome(account.id, options), options), profile);
  await writeJson(claudeCredentialsPath(options.defaultClaudeHome), old);
  await writeJson(claudeConfigPath(options.defaultClaudeHome, options), profile);

  const requested = [];
  const maintenance = await maintainAccounts({
    ...options,
    fetch: async (url) => {
      requested.push(url);
      if (url.includes('/oauth/token')) {
        return response({
          access_token: 'access.new',
          refresh_token: 'refresh.new',
          expires_in: 28_800,
          scope: 'user:inference'
        });
      }
      return response(claudeUsage());
    }
  });

  assert.equal(maintenance.results[0].status, 'refreshed');
  assert.equal(maintenance.results[0].active, true);
  assert.equal(maintenance.results[0].refreshed, true);
  assert.equal((await readClaudeAuth(options.defaultClaudeHome, options)).refreshToken, 'refresh.new');
  assert.equal((await readClaudeAuth(claudeHome(account.id, options), options)).refreshToken, 'refresh.new');
  const liveRaw = JSON.parse(await fs.readFile(claudeCredentialsPath(options.defaultClaudeHome), 'utf8'));
  assert.equal(liveRaw.claudeAiOauth.refreshTokenExpiresAt, 1_900_000_000_000, 'unknown provider fields survive');
  assert.equal(requested.length, 2, 'one token refresh and one quota request');
});

test('maintenance repairs an early Claude 401 while the selected account is idle', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Claude active', provider: 'claude' }, options);
  const profile = { oauthAccount: { emailAddress: 'claude@example.com', organizationUuid: 'org_1' } };
  const old = claudeCredential('access.old', 'refresh.old', Date.now() + 8 * 3600 * 1000);
  await writeJson(claudeCredentialsPath(claudeHome(account.id, options)), old);
  await writeJson(claudeConfigPath(claudeHome(account.id, options), options), profile);
  await writeJson(claudeCredentialsPath(options.defaultClaudeHome), old);
  await writeJson(claudeConfigPath(options.defaultClaudeHome, options), profile);

  let usageCalls = 0;
  const maintenance = await maintainAccounts({
    ...options,
    fetch: async (url) => {
      if (url.includes('/oauth/token')) {
        return response({
          access_token: 'access.new',
          refresh_token: 'refresh.new',
          expires_in: 28_800,
          scope: 'user:inference'
        });
      }
      usageCalls++;
      return usageCalls === 1 ? unauthorized() : response(claudeUsage());
    }
  });

  assert.equal(maintenance.results[0].status, 'refreshed');
  assert.equal(maintenance.results[0].revalidated, true);
  assert.equal((await readClaudeAuth(options.defaultClaudeHome, options)).refreshToken, 'refresh.new');
  assert.equal((await readClaudeAuth(claudeHome(account.id, options), options)).refreshToken, 'refresh.new');
  assert.equal(usageCalls, 2, 'the rejected usage read is retried once after refresh');
});

test('maintenance defers early Claude 401 repair while a Claude process owns the login', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Claude active', provider: 'claude' }, options);
  const profile = { oauthAccount: { emailAddress: 'claude@example.com', organizationUuid: 'org_1' } };
  const current = claudeCredential('access.current', 'refresh.current', Date.now() + 8 * 3600 * 1000);
  await writeJson(claudeCredentialsPath(claudeHome(account.id, options)), current);
  await writeJson(claudeConfigPath(claudeHome(account.id, options), options), profile);
  await writeJson(claudeCredentialsPath(options.defaultClaudeHome), current);
  await writeJson(claudeConfigPath(options.defaultClaudeHome, options), profile);

  const maintenance = await maintainAccounts({
    ...options,
    agentProcesses: [{ pid: 42, name: 'claude.exe' }],
    fetch: async (url) => {
      assert.equal(url.includes('/oauth/token'), false, 'maintenance must not race the live Claude refresh token');
      return unauthorized();
    }
  });

  assert.equal(maintenance.results[0].status, 'deferred');
  assert.equal(maintenance.results[0].reason, 'claude-running');
  assert.equal((await readClaudeAuth(options.defaultClaudeHome, options)).refreshToken, 'refresh.current');
});

test('maintenance repairs a blank live Claude credential from one managed account', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Claude only', provider: 'claude' }, options);
  const future = Date.now() + 8 * 3600 * 1000;
  await writeJson(
    claudeCredentialsPath(claudeHome(account.id, options)),
    claudeCredential('managed.access', 'managed.refresh', future)
  );
  await writeJson(
    claudeConfigPath(claudeHome(account.id, options), options),
    { oauthAccount: { emailAddress: 'only@example.com', organizationUuid: 'org_only' } }
  );
  await writeJson(
    claudeCredentialsPath(options.defaultClaudeHome),
    { claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }
  );

  const maintenance = await maintainAccounts({
    ...options,
    fetch: async (url) => {
      assert.equal(url.includes('/oauth/token'), false, 'a fresh managed credential needs no rotation');
      return response(claudeUsage());
    }
  });

  assert.equal(maintenance.results[0].status, 'checked');
  assert.equal(maintenance.results[0].repaired, true);
  assert.equal((await readClaudeAuth(options.defaultClaudeHome, options)).refreshToken, 'managed.refresh');
  assert.equal((await readClaudeAuth(options.defaultClaudeHome, options)).email, 'only@example.com');
});

test('maintenance repairs a stale live Claude credential from a newer managed generation', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Claude active', provider: 'claude' }, options);
  const profile = { oauthAccount: { emailAddress: 'claude@example.com', organizationUuid: 'org_1' } };
  await writeJson(
    claudeCredentialsPath(claudeHome(account.id, options)),
    claudeCredential('managed.new', 'managed.refresh', Date.now() + 8 * 3600 * 1000)
  );
  await writeJson(claudeConfigPath(claudeHome(account.id, options), options), profile);
  await writeJson(
    claudeCredentialsPath(options.defaultClaudeHome),
    claudeCredential('live.stale', 'live.stale.refresh', Date.now() - 60_000)
  );
  await writeJson(claudeConfigPath(options.defaultClaudeHome, options), profile);

  const maintenance = await maintainAccounts({
    ...options,
    fetch: async (url) => {
      assert.equal(url.includes('/oauth/token'), false, 'the newer access token is already healthy');
      return response(claudeUsage());
    }
  });

  assert.equal(maintenance.results[0].status, 'checked');
  assert.equal((await readClaudeAuth(options.defaultClaudeHome, options)).refreshToken, 'managed.refresh');
  assert.equal((await readClaudeAuth(claudeHome(account.id, options), options)).refreshToken, 'managed.refresh');
});

test('maintenance does not guess which Claude login to repair when several are managed', async () => {
  const options = await sandbox();
  const first = await createAccount({ label: 'First', provider: 'claude' }, options);
  const second = await createAccount({ label: 'Second', provider: 'claude' }, options);
  const future = Date.now() + 8 * 3600 * 1000;
  await writeJson(claudeCredentialsPath(claudeHome(first.id, options)), claudeCredential('first', 'first.refresh', future));
  await writeJson(claudeCredentialsPath(claudeHome(second.id, options)), claudeCredential('second', 'second.refresh', future));

  const maintenance = await maintainAccounts({
    ...options,
    fetch: async () => response(claudeUsage())
  });

  assert.equal(maintenance.results.every((item) => item.repaired !== true), true);
  await assert.rejects(fs.access(claudeCredentialsPath(options.defaultClaudeHome)));
});

test('maintenance uses the retained live profile to repair the right Claude login', async () => {
  const options = await sandbox();
  const first = await createAccount({ label: 'First', provider: 'claude' }, options);
  const second = await createAccount({ label: 'Second', provider: 'claude' }, options);
  const future = Date.now() + 8 * 3600 * 1000;
  await writeJson(claudeCredentialsPath(claudeHome(first.id, options)), claudeCredential('first', 'first.refresh', future));
  await writeJson(claudeConfigPath(claudeHome(first.id, options), options), {
    oauthAccount: { emailAddress: 'first@example.com', organizationUuid: 'org_first' }
  });
  await writeJson(claudeCredentialsPath(claudeHome(second.id, options)), claudeCredential('second', 'second.refresh', future));
  await writeJson(claudeConfigPath(claudeHome(second.id, options), options), {
    oauthAccount: { emailAddress: 'second@example.com', organizationUuid: 'org_second' }
  });
  await writeJson(claudeCredentialsPath(options.defaultClaudeHome), {
    claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 }
  });
  await writeJson(claudeConfigPath(options.defaultClaudeHome, options), {
    oauthAccount: { emailAddress: 'second@example.com', organizationUuid: 'org_second' }
  });

  const maintenance = await maintainAccounts({
    ...options,
    fetch: async () => response(claudeUsage())
  });

  assert.equal(maintenance.results.find((item) => item.accountId === second.id).repaired, true);
  assert.equal((await readClaudeAuth(options.defaultClaudeHome, options)).refreshToken, 'second.refresh');
});

test('maintenance never refreshes the live Claude credential while Claude is running', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Claude active', provider: 'claude' }, options);
  const expiresSoon = Date.now() + 60_000;
  const profile = { oauthAccount: { emailAddress: 'claude@example.com' } };
  const current = claudeCredential('live.access', 'live.refresh', expiresSoon);
  await writeJson(claudeCredentialsPath(claudeHome(account.id, options)), current);
  await writeJson(claudeConfigPath(claudeHome(account.id, options), options), profile);
  await writeJson(claudeCredentialsPath(options.defaultClaudeHome), current);
  await writeJson(claudeConfigPath(options.defaultClaudeHome, options), profile);

  const maintenance = await maintainAccounts({
    ...options,
    agentProcesses: [{ pid: 42, name: 'claude.exe' }],
    fetch: async () => assert.fail('a deferred active credential must make no provider request')
  });

  assert.equal(maintenance.results[0].status, 'deferred');
  assert.equal(maintenance.results[0].active, true);
  assert.equal(maintenance.results[0].refreshed, false);
  assert.equal(maintenance.results[0].reason, 'claude-running');
  assert.equal((await readClaudeAuth(options.defaultClaudeHome, options)).refreshToken, 'live.refresh');
});

test('maintenance fails closed when the agent process list cannot be inspected', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Claude', provider: 'claude' }, options);
  await writeJson(
    claudeCredentialsPath(claudeHome(account.id, options)),
    claudeCredential('managed.access', 'managed.refresh', Date.now() + 8 * 3600 * 1000)
  );

  await assert.rejects(
    maintainAccounts({
      ...options,
      agentProcesses: undefined,
      listAgentProcesses: async () => { throw new Error('permission denied'); },
      fetch: async () => assert.fail('maintenance must not reach the provider')
    }),
    /Could not inspect running agent processes.*permission denied/
  );
});

test('maintenance reports lock contention instead of racing another process', async () => {
  const options = await sandbox();
  const maintenance = await withFileLock(
    accountMaintenanceLockPath(options),
    () => maintainAccounts(options),
    { lockStaleMs: 60_000 }
  );

  assert.equal(maintenance.locked, true);
  assert.deepEqual(maintenance.results, []);
});
