import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collapseCodexStreamDuplicates,
  dedupeAdjacentTurns,
  discoverNativeSessions,
  exportHandoff,
  importNativeSession,
  importTranscript,
  initStore,
  prepareTurns,
  readAllTurns,
  readManifest,
  sanitizeContentForHandoff,
  selectTurns,
  truncateTurnContent,
  writeSession,
  DEFAULT_MAX_CHARS
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

test('budgeted selection prefers recent turns and stops instead of skipping', () => {
  const turns = [
    { role: 'tool', content: 'old-small', timestamp: '1' },
    { role: 'tool', content: 'x'.repeat(4000), timestamp: '2' },
    { role: 'tool', content: 'recent-small', timestamp: '3' }
  ];
  const selected = selectTurns(turns, 400);
  // The oversized middle turn must act as a wall: the newest turn fits, and
  // filling stops there rather than reaching past the gap for `old-small`.
  // Skipping it would produce a transcript with an invisible hole.
  assert.equal(selected.turns.length, 1);
  assert.equal(selected.turns[0].content, 'recent-small');
  assert.equal(selected.omittedTurns, 2);
});

test('budgeted selection returns turns in chronological order', () => {
  const turns = [
    { role: 'user', content: 'first', timestamp: '1' },
    { role: 'assistant', content: 'second', timestamp: '2' },
    { role: 'user', content: 'third', timestamp: '3' }
  ];
  const selected = selectTurns(turns, 100000);
  assert.deepEqual(selected.turns.map((turn) => turn.content), ['first', 'second', 'third']);
  assert.equal(selected.omittedTurns, 0);
});

test('budget measures truncated rendered size, not raw turn size', () => {
  // A 50 KB tool turn renders to well under 2 KB once the tool cap applies. The
  // old accounting sized the raw turn (plus never-rendered metadata) and so
  // rejected turns that comfortably fit.
  const turns = [{ role: 'tool', content: 'y'.repeat(50000), timestamp: '1', metadata: { padding: 'z'.repeat(5000) } }];
  const truncation = { tool: 2000 };
  const [prepared] = prepareTurns(turns, truncation);
  assert.ok(prepared.size < 2500, `rendered size was ${prepared.size}`);

  const selected = selectTurns(turns, 3000, truncation);
  assert.equal(selected.turns.length, 1);
  assert.equal(selected.omittedTurns, 0);
});

test('prepareTurns sanitizes and truncates each turn exactly once', () => {
  const turns = [{ role: 'tool', content: 'HEAD' + 'm'.repeat(9000) + 'TAIL', timestamp: '1' }];
  const [prepared] = prepareTurns(turns, { tool: 500 });
  assert.ok(prepared.truncatedChars > 0);
  assert.equal(prepared.size, prepared.block.length + 1);
  assert.match(prepared.block, /Context Bridge truncated \d+ chars/);
  // One truncation marker means one truncation pass.
  assert.equal(prepared.block.split('Context Bridge truncated').length - 1, 1);
});

test('export applies a default character budget', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-budget-'));
  await initStore(root);
  // Uncapped roles, so only the total budget can hold this down.
  const turns = Array.from({ length: 400 }, (_, index) => ({
    role: 'assistant',
    content: `message ${index} ${'q'.repeat(1000)}`,
    provider: 'openai',
    surface: 'cli',
    timestamp: String(index).padStart(4, '0')
  }));
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'budget-test' });

  const exported = await exportHandoff(root, { target: 'claude' });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.ok(handoff.length <= DEFAULT_MAX_CHARS + 4000, `handoff was ${handoff.length} chars`);
  assert.match(handoff, /Export max chars: 120000/);
  assert.match(handoff, /Omitted turns due to budget: \d+/);
  // Recency wins: the last message survives, the first does not.
  assert.match(handoff, /message 399/);
  assert.doesNotMatch(handoff, /message 0 /);
});

test('export honours an explicitly disabled budget', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-nobudget-'));
  await initStore(root);
  const turns = Array.from({ length: 200 }, (_, index) => ({
    role: 'assistant',
    content: `message ${index} ${'q'.repeat(1000)}`,
    provider: 'openai',
    surface: 'cli',
    timestamp: String(index).padStart(4, '0')
  }));
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'nobudget-test' });

  const exported = await exportHandoff(root, { target: 'claude', maxChars: 0 });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.match(handoff, /message 0 /);
  assert.match(handoff, /message 199/);
  assert.doesNotMatch(handoff, /Omitted turns due to budget/);
});

test('sinceLastExport limits the transcript to turns after the previous export', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-since-'));
  await initStore(root);
  await writeSession(
    root,
    [{ role: 'user', content: 'before the export', provider: 'openai', surface: 'cli', timestamp: '2020-01-01T00:00:00.000Z' }],
    { provider: 'openai', surface: 'cli', sessionId: 'since-a' }
  );
  await exportHandoff(root, { target: 'claude' });

  await writeSession(
    root,
    [
      { role: 'user', content: 'before the export', provider: 'openai', surface: 'cli', timestamp: '2020-01-01T00:00:00.000Z' },
      { role: 'user', content: 'after the export', provider: 'openai', surface: 'cli', timestamp: '2099-01-01T00:00:00.000Z' }
    ],
    { provider: 'openai', surface: 'cli', sessionId: 'since-a' }
  );

  const scoped = await fs.readFile((await exportHandoff(root, { target: 'claude', sinceLastExport: true })).path, 'utf8');
  assert.match(scoped, /after the export/);
  assert.doesNotMatch(scoped, /```text\nbefore the export\n```/);
  assert.match(scoped, /Transcript limited to turns after:/);

  // Default stays off, so a fresh receiving session still gets the full ledger.
  const full = await fs.readFile((await exportHandoff(root, { target: 'claude' })).path, 'utf8');
  assert.match(full, /before the export/);
  assert.match(full, /after the export/);
});

test('sinceLastExport falls back to the full ledger when nothing is newer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-since-empty-'));
  await initStore(root);
  await writeSession(
    root,
    [{ role: 'user', content: 'only turn', provider: 'openai', surface: 'cli', timestamp: '2020-01-01T00:00:00.000Z' }],
    { provider: 'openai', surface: 'cli', sessionId: 'since-b' }
  );
  await exportHandoff(root, { target: 'claude' });

  const handoff = await fs.readFile((await exportHandoff(root, { target: 'claude', sinceLastExport: true })).path, 'utf8');
  assert.match(handoff, /only turn/);
  assert.doesNotMatch(handoff, /Transcript limited to turns after:/);
});

test('re-importing the same session upserts its manifest entry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-upsert-'));
  await initStore(root);
  const turns = [{ role: 'user', content: 'hello', provider: 'openai', surface: 'cli', timestamp: '1' }];
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'same-id' });
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'same-id' });
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'same-id' });

  const manifest = await readManifest(root);
  assert.equal(manifest.sessions.length, 1);
  assert.equal(manifest.sessions[0].id, 'same-id');
  // A different session id still creates a separate entry.
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'other-id' });
  const after = await readManifest(root);
  assert.equal(after.sessions.length, 2);
});

test('dedupeAdjacentTurns collapses only consecutive identical turns', () => {
  const turns = [
    { role: 'assistant', content: 'Working on it', timestamp: '1' },
    { role: 'assistant', content: 'Working on it', timestamp: '1' },
    { role: 'assistant', content: 'Working on it', timestamp: '2' },
    { role: 'tool', content: '', timestamp: '3' },
    { role: 'assistant', content: 'Different', timestamp: '4' },
    { role: 'tool', content: '', timestamp: '5' }
  ];
  const { turns: deduped, removed } = dedupeAdjacentTurns(turns);
  assert.equal(removed, 2);
  assert.equal(deduped.length, 4);
  // The two non-adjacent empty tool turns are distinct events and must survive.
  assert.equal(deduped.filter((t) => t.role === 'tool').length, 2);
});

test('truncateTurnContent keeps head and tail and reports removed chars', () => {
  const text = 'HEAD'.repeat(50) + 'MIDDLE'.repeat(200) + 'TAIL'.repeat(50);
  const result = truncateTurnContent(text, 400);
  assert.ok(result.removed > 0);
  assert.ok(result.content.length < text.length);
  assert.match(result.content, /^HEAD/);
  assert.match(result.content, /TAIL$/);
  assert.match(result.content, /Context Bridge truncated \d+ chars/);
});

test('truncateTurnContent leaves short content and disabled caps untouched', () => {
  assert.equal(truncateTurnContent('short', 400).removed, 0);
  assert.equal(truncateTurnContent('x'.repeat(5000), 0).removed, 0);
});

test('export collapses duplicate turns and truncates tool output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-dedupe-'));
  await initStore(root);
  await writeSession(
    root,
    [
      { role: 'user', content: 'do the thing', provider: 'openai', surface: 'cli', timestamp: '1' },
      { role: 'assistant', content: 'on it', provider: 'openai', surface: 'cli', timestamp: '2' },
      { role: 'assistant', content: 'on it', provider: 'openai', surface: 'cli', timestamp: '2' },
      { role: 'tool', content: 'OUT' + 'x'.repeat(5000), provider: 'openai', surface: 'cli', timestamp: '3' }
    ],
    { provider: 'openai', surface: 'cli', sessionId: 'dedupe-test' }
  );

  const exported = await exportHandoff(root, { target: 'claude' });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.match(handoff, /Collapsed duplicate turns: 1/);
  assert.match(handoff, /Truncated oversized turns: 1/);
  assert.match(handoff, /Context Bridge truncated \d+ chars/);
  // The duplicate assistant line should appear exactly once.
  assert.equal(handoff.split('\non it\n').length - 1, 1);
  // Truncated tool turn must be far smaller than the raw 5 KB.
  assert.ok(handoff.length < 4000);
});

test('export with dedupe disabled keeps duplicate turns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-nodedupe-'));
  await initStore(root);
  await writeSession(
    root,
    [
      { role: 'assistant', content: 'twice', provider: 'openai', surface: 'cli', timestamp: '1' },
      { role: 'assistant', content: 'twice', provider: 'openai', surface: 'cli', timestamp: '1' }
    ],
    { provider: 'openai', surface: 'cli', sessionId: 'nodedupe-test' }
  );
  const exported = await exportHandoff(root, { target: 'claude', dedupe: false });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.equal(handoff.split('\ntwice\n').length - 1, 2);
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

test('Codex import collapses the same message written to both native streams', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-codex-streams-'));
  const sessionsDir = path.join(root, 'native-codex');
  await fs.mkdir(path.join(sessionsDir, '2026', '01', '01'), { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, '2026', '01', '01', 'rollout-streams.jsonl'),
    [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'streams', cwd: root, source: 'cli' } }),
      // One user message, recorded by both streams.
      JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship it' }] } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'ship it' } }),
      // One assistant message, recorded by both streams and repeated by task_complete.
      JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'shipping' }] } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'shipping' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'shipping' } })
    ].join('\n'),
    'utf8'
  );

  const imported = await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  assert.equal(imported.turnCount, 2);

  const turns = await readAllTurns(root);
  assert.deepEqual(turns.map((turn) => turn.role), ['user', 'assistant']);
  assert.equal(turns[0].content, 'ship it');
  assert.equal(turns[1].content, 'shipping');
  assert.equal(turns[0].metadata.collapsedStreams, 'item+event');
});

test('Codex import keeps a message that genuinely repeats', () => {
  // Each real message produces its own event+item pair. Both pairs collapse to
  // one turn each; the two turns must not then collapse into a single "yes".
  const turns = [
    { role: 'user', content: 'yes', metadata: { stream: 'item' } },
    { role: 'user', content: 'yes', metadata: { stream: 'event' } },
    { role: 'tool', content: 'ran something', metadata: { stream: 'item' } },
    { role: 'user', content: 'yes', metadata: { stream: 'item' } },
    { role: 'user', content: 'yes', metadata: { stream: 'event' } }
  ];
  const { turns: collapsed, removed } = collapseCodexStreamDuplicates(turns);
  assert.equal(removed, 2);
  assert.equal(collapsed.filter((turn) => turn.role === 'user').length, 2);
  assert.equal(collapsed.length, 3);
});

test('Codex import leaves single-stream transcripts untouched', () => {
  const turns = [
    { role: 'assistant', content: 'one', metadata: { stream: 'event' } },
    { role: 'assistant', content: 'two', metadata: { stream: 'event' } },
    { role: 'system', content: 'ctx', metadata: { stream: 'meta' } },
    { role: 'system', content: 'ctx', metadata: { stream: 'meta' } }
  ];
  const { turns: collapsed, removed } = collapseCodexStreamDuplicates(turns);
  assert.equal(removed, 0);
  assert.equal(collapsed.length, 4);
});

test('Codex response_item user messages keep image payloads out of the ledger', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-codex-item-media-'));
  const sessionsDir = path.join(root, 'native-codex');
  await fs.mkdir(path.join(sessionsDir, '2026', '01', '01'), { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, '2026', '01', '01', 'rollout-item-media.jsonl'),
    [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'item-media', cwd: root, source: 'cli' } }),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'see the screenshot' },
            { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(4000)}` }
          ]
        }
      })
    ].join('\n'),
    'utf8'
  );

  await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  const turns = await readAllTurns(root);
  assert.equal(turns.length, 1);
  assert.match(turns[0].content, /see the screenshot/);
  assert.match(turns[0].content, /Inline image payloads omitted from imported text: 1/);
  assert.doesNotMatch(turns[0].content, /AAAA/);
  assert.equal(turns[0].metadata.media.inlineImageCount, 1);
});

test('sanitizes inline base64 media during handoff rendering', () => {
  const blob = `${'A'.repeat(1200)}+/${'B'.repeat(1200)}==`;
  const result = sanitizeContentForHandoff(`screenshot:\n${blob}`);
  assert.equal(result.omitted, 1);
  assert.match(result.content, /omitted base64 blob/);
  assert.ok(result.content.length < 200);
});

test('sanitizes large JSON base64 fields without regex stack overflow', () => {
  const value = `${'A'.repeat(200000)}+/==`;
  const result = sanitizeContentForHandoff(`{"image_url":"${value}"}`);
  assert.equal(result.omitted, 1);
  assert.match(result.content, /omitted base64 payload/);
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
