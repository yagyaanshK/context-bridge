import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverNativeSessions,
  importTranscript,
  initStore,
  prepareTurns,
  readAllTurns,
  selectPreparedTurns,
  writeSession
} from '../src/index.js';
import { readJsonlObjects } from '../src/adapters/common.js';

async function tempRoot(prefix = 'context-bridge-scale-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('an oversized latest user request is truncated into the budget instead of dropped', () => {
  const prepared = prepareTurns([
    { role: 'assistant', provider: 'openai', surface: 'cli', timestamp: '1', content: 'older answer' },
    { role: 'user', provider: 'openai', surface: 'cli', timestamp: '2', content: `START-${'x'.repeat(10000)}-END` },
    { role: 'assistant', provider: 'openai', surface: 'cli', timestamp: '3', content: 'answering the large request' }
  ]);
  const selected = selectPreparedTurns(prepared, 700);
  assert.equal(selected.prepared.some((item) => item.role === 'user'), true);
  const user = selected.prepared.find((item) => item.role === 'user');
  assert.ok(user.size <= 700);
  assert.match(user.block, /START-/);
  assert.match(user.block, /-END/);
  assert.match(user.block, /Turntrail truncated/);

  const impossiblySmall = selectPreparedTurns(prepared, 10);
  assert.equal(impossiblySmall.prepared.some((item) => item.role === 'user'), true, 'intent wins even when header overhead exceeds the budget');
});

test('JSONL reading bounds an individual line before invoking the callback', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'huge.jsonl');
  await fs.writeFile(source, `${'x'.repeat(1000)}\n`, 'utf8');
  let called = 0;
  await assert.rejects(
    () => readJsonlObjects(source, () => called++, { maxLineChars: 100 }),
    /exceeds the 100-character safety limit/
  );
  assert.equal(called, 0);
});

test('JSONL callback failures propagate once and are not retried as parse errors', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'one.jsonl');
  await fs.writeFile(source, `${JSON.stringify({ value: 1 })}\n`, 'utf8');
  let called = 0;
  await assert.rejects(
    () =>
      readJsonlObjects(source, () => {
        called++;
        throw new Error('consumer failed');
      }),
    /consumer failed/
  );
  assert.equal(called, 1);
});

test('non-JSONL imports reject files above their configured whole-file limit', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'large.txt');
  await fs.writeFile(source, 'x'.repeat(1000), 'utf8');
  await assert.rejects(() => importTranscript(root, source, { maxNonJsonlImportBytes: 100 }), /above the 100-byte safety limit/);
});

test('streamed JSONL imports and ledger reads enforce bounded turn counts', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'turns.jsonl');
  await fs.writeFile(
    source,
    Array.from({ length: 4 }, (_, index) => JSON.stringify({ role: 'user', content: `turn ${index}` })).join('\n'),
    'utf8'
  );
  await assert.rejects(() => importTranscript(root, source, { maxImportedTurns: 2 }), /in-memory import safety limit/);

  await initStore(root);
  await writeSession(
    root,
    Array.from({ length: 4 }, (_, index) => ({ role: 'user', content: `stored ${index}`, timestamp: String(index) })),
    { sessionId: 'bounded-ledger' }
  );
  await assert.rejects(() => readAllTurns(root, { maxLedgerTurns: 2 }), /Ledger exceeds the export safety limit/);
});

test('native discovery observes cancellation before walking provider storage', async () => {
  const root = await tempRoot();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => discoverNativeSessions('codex', { root, sessionsDir: root, signal: controller.signal }),
    (error) => error?.name === 'AbortError'
  );
});
