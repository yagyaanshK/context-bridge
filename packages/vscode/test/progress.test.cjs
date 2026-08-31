const assert = require('node:assert/strict');
const test = require('node:test');
const { runWithCancellation } = require('../src/progress.cjs');

test('VS Code cancellation becomes an AbortSignal and always removes its listener', async () => {
  let handler;
  let disposed = false;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(callback) {
      handler = callback;
      return { dispose() { disposed = true; } };
    }
  };
  const running = runWithCancellation(token, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), {
      once: true
    });
  }));
  handler();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(disposed, true);
});

test('already-cancelled operations start with an aborted signal', async () => {
  const token = {
    isCancellationRequested: true,
    onCancellationRequested() {
      return { dispose() {} };
    }
  };
  await runWithCancellation(token, ({ signal }) => {
    assert.equal(signal.aborted, true);
  });
});
