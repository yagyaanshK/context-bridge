import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readSessionPreview, renderSessionPreview, writeSession } from '../src/index.js';

test('session preview reads one recorded session and renders transcript content safely', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-preview-'));
  await writeSession(root, [
    { id: 'one', role: 'user', provider: 'openai', surface: 'cli', timestamp: '2026-09-04T00:00:00.000Z', content: 'Use ``` inside this request' },
    { id: 'two', role: 'assistant', provider: 'openai', surface: 'cli', timestamp: '2026-09-04T00:00:01.000Z', content: 'Done' }
  ], { provider: 'openai', surface: 'cli', sessionId: 'preview-one', title: 'Preview me' });

  const preview = await readSessionPreview(root, 'preview-one');
  assert.equal(preview.turns.length, 2);
  assert.equal(preview.clipped, false);
  const markdown = renderSessionPreview(preview);
  assert.match(markdown, /^# Preview me/m);
  assert.match(markdown, /## User \| 2026-09-04T00:00:00.000Z/);
  assert.match(markdown, /````\nUse ``` inside this request\n````/);
});

test('session preview stops at bounded turn and character limits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-preview-limit-'));
  await writeSession(root, [
    { id: 'one', role: 'user', provider: 'cursor', surface: 'ide', content: '12345' },
    { id: 'two', role: 'assistant', provider: 'cursor', surface: 'ide', content: '67890' }
  ], { provider: 'cursor', surface: 'ide', sessionId: 'preview-limit' });

  const preview = await readSessionPreview(root, 'preview-limit', { maxTurns: 1, maxChars: 6 });
  assert.equal(preview.turns.length, 1);
  assert.equal(preview.clipped, true);
  assert.match(renderSessionPreview(preview), /Preview clipped at the configured safety limit/);
});

test('session preview rejects unknown and unsafe session ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-preview-path-'));
  await assert.rejects(() => readSessionPreview(root, '../outside'), /safe in a filename/);
  await assert.rejects(() => readSessionPreview(root, 'missing'), /not initialized|not recorded/);
});
