import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCodexThreadNames } from '../src/adapters/codex-index.js';

async function withIndex(contents, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-index-'));
  const file = path.join(dir, 'session_index.jsonl');
  await fs.writeFile(file, contents);
  try {
    return await run(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('a thread is named by its entry in the index', async () => {
  const names = await withIndex(
    '{"id":"019e1d20","thread_name":"Make money","updated_at":"2026-05-12T16:59:17Z"}\n',
    (sessionIndex) => readCodexThreadNames({ sessionIndex })
  );
  assert.equal(names.get('019e1d20'), 'Make money');
});

test('the index is append-only, so the last entry for a thread wins', async () => {
  // Renaming a thread adds a line rather than rewriting one. On a real install
  // 60 lines covered 37 threads.
  const names = await withIndex(
    ['{"id":"a","thread_name":"job apply"}', '{"id":"b","thread_name":"CIBS"}', '{"id":"a","thread_name":"VC Apply"}'].join(
      '\n'
    ),
    (sessionIndex) => readCodexThreadNames({ sessionIndex })
  );
  assert.equal(names.get('a'), 'VC Apply');
  assert.equal(names.get('b'), 'CIBS');
});

test('clearing a name is a rename like any other', async () => {
  const names = await withIndex(
    '{"id":"a","thread_name":"job apply"}\n{"id":"a","thread_name":"  "}\n',
    (sessionIndex) => readCodexThreadNames({ sessionIndex })
  );
  assert.equal(names.has('a'), false);
});

test('a half-written final line does not cost the rest of the index', async () => {
  const names = await withIndex(
    '{"id":"a","thread_name":"job apply"}\n{"id":"b","thread_na',
    (sessionIndex) => readCodexThreadNames({ sessionIndex })
  );
  assert.equal(names.get('a'), 'job apply');
  assert.equal(names.size, 1);
});

test('an install with no index names nothing rather than failing', async () => {
  // Codex versions predating the index, and fresh installs.
  const names = await readCodexThreadNames({ sessionIndex: path.join(os.tmpdir(), 'no-such-codex-index.jsonl') });
  assert.equal(names.size, 0);
});

test('discovery names a session from the index and falls back without one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discover-'));
  const sessionsDir = path.join(dir, 'sessions');
  const root = path.join(dir, 'workspace');
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(root, { recursive: true });

  const rollout = (id, opening, latest) =>
    [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'vscode' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: opening } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: latest } })
    ].join('\n');

  // Both sessions open with the same paragraph, which is what forks do and what
  // made the picker unreadable. Only the named one can be told apart on sight.
  const opening = 'the current root directory has all the information about my background and profile';
  await fs.writeFile(path.join(sessionsDir, 'rollout-a.jsonl'), rollout('id-named', opening, 'add the US universities'));
  await fs.writeFile(path.join(sessionsDir, 'rollout-b.jsonl'), rollout('id-plain', opening, 'rewrite the summary section'));
  const sessionIndex = path.join(dir, 'session_index.jsonl');
  await fs.writeFile(sessionIndex, '{"id":"id-named","thread_name":"US master\'s apply"}\n');

  try {
    const { discoverCodexSessions } = await import('../src/adapters/codex.js');
    const sessions = await discoverCodexSessions({ root, sessionsDir, sessionIndex });
    const named = sessions.find((session) => session.sessionId === 'id-named');
    const plain = sessions.find((session) => session.sessionId === 'id-plain');

    assert.equal(named.named, true);
    assert.equal(named.title, "US master's apply");
    assert.equal(named.opening, opening, 'the opening request is kept as context, not lost to the name');

    assert.equal(plain.named, false);
    assert.equal(plain.title, opening, 'with no name, the opening request stands in as before');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
