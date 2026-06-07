import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';

test('cli init and status write expected output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-cli-'));
  let output = '';
  const io = { stdout: { write: (chunk) => { output += chunk; } } };

  await runCli(['init', '--cwd', root], io);
  assert.match(output, /Initialized Context Bridge/);

  output = '';
  await runCli(['status', '--cwd', root], io);
  assert.match(output, /Sessions: 0/);
});
