const assert = require('node:assert/strict');
const test = require('node:test');
const { readRawUsage } = require('../src/raw-usage.cjs');

test('raw usage normalizes the same response without a second provider request', async () => {
  let requests = 0;
  let normalized = 0;
  const api = {
    providerFetch: async () => {
      requests++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ rate_limits: { primary: { used_percent: 25 } } })
      };
    },
    normalizeCodexUsage(payload) {
      normalized++;
      return { payload };
    }
  };

  const result = await readRawUsage(api, {
    endpoint: 'https://provider.invalid/usage',
    headers: {},
    auth: {},
    claude: false
  });
  assert.equal(requests, 1);
  assert.equal(normalized, 1);
  assert.equal(result.status, 200);
  assert.equal(result.parsed.payload.rate_limits.primary.used_percent, 25);
});

test('raw usage reports an HTTP error without invoking a normalizer', async () => {
  let normalized = false;
  const api = {
    providerFetch: async () => ({ ok: false, status: 429, text: async () => '{"detail":"limited"}' }),
    normalizeClaudeUsage() {
      normalized = true;
    }
  };
  const result = await readRawUsage(api, {
    endpoint: 'https://provider.invalid/usage',
    headers: {},
    auth: {},
    claude: true
  });
  assert.match(result.parsed.error, /HTTP 429/);
  assert.equal(normalized, false);
});
