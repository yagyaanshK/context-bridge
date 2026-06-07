import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportHandoff, importTranscript, initStore, readAllTurns, selectTurns } from '../src/index.js';

test('imports jsonl transcripts and exports deterministic handoff', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-core-'));
  await initStore(root);
  await fs.writeFile(
    path.join(root, 'transcript.jsonl'),
    [
      JSON.stringify({ role: 'user', content: 'Please inspect auth.' }),
      JSON.stringify({ role: 'assistant', content: 'I found src/auth.js.' })
    ].join('\n'),
    'utf8'
  );

  const imported = await importTranscript(root, 'transcript.jsonl', { provider: 'claude', surface: 'cli' });
  assert.equal(imported.turnCount, 2);

  const turns = await readAllTurns(root);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].provider, 'anthropic');

  const exported = await exportHandoff(root, { target: 'codex' });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.match(handoff, /Context Bridge Handoff: codex/);
  assert.match(handoff, /Please inspect auth/);
});

test('budgeted turn selection keeps user turns first', () => {
  const turns = [
    { role: 'assistant', content: 'a'.repeat(1000), timestamp: '1' },
    { role: 'user', content: 'keep me', timestamp: '2' },
    { role: 'tool', content: 'b'.repeat(1000), timestamp: '3' }
  ];
  const selected = selectTurns(turns, 300);
  assert.equal(selected.turns.length, 1);
  assert.equal(selected.turns[0].role, 'user');
  assert.equal(selected.omittedTurns, 2);
});
