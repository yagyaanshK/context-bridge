import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { captureSnapshot, SNAPSHOT_DIFF_MAX_CHARS } from '../src/index.js';

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  await execFileAsync('git', args, { cwd: root });
}

async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-snapshot-'));
  await git(root, 'init');
  return root;
}

async function readCaptured(result) {
  return JSON.parse(await fs.readFile(result.path, 'utf8'));
}

test('an unborn repository snapshot includes staged, unstaged, and untracked content', async () => {
  const root = await repository();
  await fs.writeFile(path.join(root, 'tracked.txt'), 'staged line\n', 'utf8');
  await git(root, 'add', 'tracked.txt');
  await fs.appendFile(path.join(root, 'tracked.txt'), 'unstaged line\n', 'utf8');
  await fs.writeFile(path.join(root, 'untracked.txt'), 'untracked line\n', 'utf8');
  await git(root, 'remote', 'add', 'origin', 'https://user:super-secret-password@example.com/repo.git');

  const snapshot = await readCaptured(await captureSnapshot(root));
  assert.equal(snapshot.git.head, '(no commits yet)');
  assert.match(snapshot.git.diff, /staged line/);
  assert.match(snapshot.git.diff, /unstaged line/);
  assert.match(snapshot.git.diff, /untracked line/);
  assert.match(snapshot.git.diffStat, /untracked\.txt \| untracked/);
  assert.equal(snapshot.git.untrackedFiles, 1);
  assert.equal(snapshot.git.remotes.includes('super-secret-password'), false);
  assert.match(snapshot.git.remotes, /\[REDACTED\]/);
});

test('Git output is bounded before snapshot clipping', async () => {
  const root = await repository();
  for (let index = 0; index < 180; index++) {
    await fs.writeFile(path.join(root, `untracked-${String(index).padStart(3, '0')}-${'x'.repeat(20)}.txt`), 'content\n', 'utf8');
  }

  const snapshot = await readCaptured(await captureSnapshot(root, { gitMaxBuffer: 1024 }));
  assert.equal(Boolean(snapshot.git.statusClipped || snapshot.git.untrackedListClipped), true);
  assert.ok(snapshot.git.status.length <= 1024);
  assert.ok(snapshot.git.diff.length <= SNAPSHOT_DIFF_MAX_CHARS);
});

test('untracked filesystem links cannot disclose content outside the repository', async () => {
  const root = await repository();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-snapshot-outside-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside-snapshot-secret\n', 'utf8');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

  const snapshot = await readCaptured(await captureSnapshot(root));
  assert.equal(snapshot.git.diff.includes('outside-snapshot-secret'), false);
});
