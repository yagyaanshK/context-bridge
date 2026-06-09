import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverNativeSessions,
  exportHandoff,
  importNativeSession,
  importTranscript,
  initStore,
  readAllTurns,
  sanitizeContentForHandoff,
  selectTurns
} from '../src/index.js';

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

test('imports synthetic Claude Code native transcript', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-claude-'));
  const projectsDir = path.join(root, 'native-claude');
  await fs.mkdir(path.join(projectsDir, 'project'), { recursive: true });
  const transcript = path.join(projectsDir, 'project', 'abc.jsonl');
  await fs.writeFile(
    transcript,
    [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', cwd: root, message: { role: 'user', content: 'Start here' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', cwd: root, message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } })
    ].join('\n'),
    'utf8'
  );

  const sessions = await discoverNativeSessions('claude', { root, projectsDir });
  assert.equal(sessions.length, 1);
  const imported = await importNativeSession(root, 'claude', { root, projectsDir, last: true });
  assert.equal(imported.turnCount, 2);
});

test('imports synthetic Codex native transcript', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-codex-'));
  const sessionsDir = path.join(root, 'native-codex');
  await fs.mkdir(path.join(sessionsDir, '2026', '01', '01'), { recursive: true });
  const transcript = path.join(sessionsDir, '2026', '01', '01', 'rollout-test.jsonl');
  await fs.writeFile(
    transcript,
    [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'codex1', cwd: root, source: 'cli' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Continue this task' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Working on it' } })
    ].join('\n'),
    'utf8'
  );

  const sessions = await discoverNativeSessions('codex', { root, sessionsDir });
  assert.equal(sessions.length, 1);
  const imported = await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  assert.equal(imported.turnCount, 2);
});

test('sanitizes inline base64 media during handoff rendering', () => {
  const blob = `${'A'.repeat(1200)}+/${'B'.repeat(1200)}==`;
  const result = sanitizeContentForHandoff(`screenshot:\n${blob}`);
  assert.equal(result.omitted, 1);
  assert.match(result.content, /omitted base64 blob/);
  assert.ok(result.content.length < 200);
});

test('Codex native import preserves local image paths instead of inline media payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-codex-media-'));
  const sessionsDir = path.join(root, 'native-codex');
  await fs.mkdir(path.join(sessionsDir, '2026', '01', '01'), { recursive: true });
  const transcript = path.join(sessionsDir, '2026', '01', '01', 'rollout-media.jsonl');
  await fs.writeFile(
    transcript,
    [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'codex-media', cwd: root, source: 'ide' } }),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Look at this screenshot.',
          local_images: [path.join(root, 'screenshots', 'one.png')],
          images: ['data:image/png;base64,AAAA']
        }
      })
    ].join('\n'),
    'utf8'
  );

  await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  const turns = await readAllTurns(root);
  assert.match(turns[0].content, /Look at this screenshot/);
  assert.match(turns[0].content, /Attached local images/);
  assert.match(turns[0].content, /one\.png/);
  assert.equal(turns[0].metadata.media.inlineImageCount, 1);
});
