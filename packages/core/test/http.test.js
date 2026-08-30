import assert from 'node:assert/strict';
import test from 'node:test';
import { providerFetch } from '../src/index.js';

test('provider requests time out even when an injected fetch ignores AbortSignal', async () => {
  await assert.rejects(
    providerFetch('https://provider.invalid', {}, {
      requestTimeoutMs: 20,
      fetch: async () => new Promise(() => {})
    }),
    (error) => error.code === 'ETIMEDOUT' && /timed out/i.test(error.message)
  );
});

test('provider requests honor caller cancellation and forward a signal to fetch', async () => {
  const controller = new AbortController();
  let seenSignal;
  const request = providerFetch('https://provider.invalid', {}, {
    signal: controller.signal,
    requestTimeoutMs: 5_000,
    fetch: async (url, init) => {
      seenSignal = init.signal;
      return new Promise(() => {});
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, /cancelled/i);
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenSignal.aborted, true);
});

test('provider requests reject before fetch when the caller is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop now'));
  let called = false;
  await assert.rejects(
    providerFetch('https://provider.invalid', {}, {
      signal: controller.signal,
      fetch: async () => {
        called = true;
      }
    }),
    /stop now/
  );
  assert.equal(called, false);
});
