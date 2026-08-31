import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fetchClaudeProfile,
  fetchClaudeUsage,
  fetchCodexUsage,
  readClaudeAuth,
  readCodexAuth,
  refreshClaudeToken,
  refreshCodexToken,
  PROVIDER_CONTRACTS
} from '../src/index.js';

function textResponse(payload) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload))
  });
}

function jsonResponse(payload) {
  return async () => ({ ok: true, status: 200, json: async () => payload });
}

function isSafeContractError(provider, operation, secret) {
  return (error) => {
    assert.equal(error.name, 'ProviderContractError');
    assert.equal(error.code, 'PROVIDER_CONTRACT_CHANGED');
    assert.equal(error.provider, provider);
    assert.equal(error.operation, operation);
    assert.equal(error.contractVersion, PROVIDER_CONTRACTS[provider].version);
    assert.equal(error.message.includes(secret), false);
    return true;
  };
}

test('provider contract metadata is versioned, private, and immutable', () => {
  for (const provider of ['codex', 'claude']) {
    assert.match(PROVIDER_CONTRACTS[provider].version, /observed-v\d+$/);
    assert.equal(PROVIDER_CONTRACTS[provider].stability, 'observed-private');
    assert.equal(Object.isFrozen(PROVIDER_CONTRACTS[provider]), true);
    assert.equal(Object.isFrozen(PROVIDER_CONTRACTS[provider].oauth), true);
  }
});

test('malformed successful token responses fail with safe compatibility errors', async () => {
  const secret = 'provider-secret-that-must-not-leak';
  await assert.rejects(
    refreshCodexToken('refresh', {
      fetch: textResponse({ access_token: { diagnostic: secret }, diagnostic: secret })
    }),
    isSafeContractError('codex', 'token response', secret)
  );
  await assert.rejects(
    refreshClaudeToken('refresh', {
      fetch: textResponse({ access_token: 'access', expires_in: { diagnostic: secret }, diagnostic: secret })
    }),
    isSafeContractError('claude', 'token response', secret)
  );
});

test('non-JSON successful token responses are reported as contract drift', async () => {
  await assert.rejects(
    refreshCodexToken('refresh', { fetch: textResponse('<html>changed</html>') }),
    isSafeContractError('codex', 'token response', '<html>changed</html>')
  );
});

test('malformed profile responses fail before identity is normalized', async () => {
  const secret = 'profile-secret-that-must-not-leak';
  await assert.rejects(
    fetchClaudeProfile('access', {
      fetch: jsonResponse({ account: { uuid: { diagnostic: secret } }, diagnostic: secret })
    }),
    isSafeContractError('claude', 'profile response', secret)
  );
});

test('successful quota responses must contain at least one understood window', async () => {
  const secret = 'usage-secret-that-must-not-leak';
  await assert.rejects(
    fetchCodexUsage(
      { accessToken: 'access' },
      { fetch: jsonResponse({ replacement_limits: { diagnostic: secret } }) }
    ),
    isSafeContractError('codex', 'usage response', secret)
  );
  await assert.rejects(
    fetchClaudeUsage(
      { accessToken: 'access' },
      { fetch: jsonResponse({ limits_v2: [{ diagnostic: secret }] }) }
    ),
    isSafeContractError('claude', 'usage response', secret)
  );
});

test('native credential schema drift is rejected at the file boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-contracts-'));
  const codexHome = path.join(root, 'codex');
  const claudeHome = path.join(root, 'claude');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(claudeHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({ auth_mode: 'oauth', tokens: { access_token_v2: 'secret' } }),
    'utf8'
  );
  await fs.writeFile(
    path.join(claudeHome, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: { value: 'secret' } } }),
    'utf8'
  );

  await assert.rejects(
    readCodexAuth(codexHome),
    isSafeContractError('codex', 'credential file', 'secret')
  );
  await assert.rejects(
    readClaudeAuth(claudeHome, { home: root }),
    isSafeContractError('claude', 'credential file', 'secret')
  );
});
