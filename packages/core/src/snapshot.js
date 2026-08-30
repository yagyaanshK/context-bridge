import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeSnapshot } from './store.js';

const execFileAsync = promisify(execFile);

// Hard cap on the diff stored in the ledger. A handoff taken mid-edit is
// exactly when the uncommitted diff matters most, but a runaway diff should
// not be allowed to bloat every snapshot file.
const SNAPSHOT_DIFF_MAX_CHARS = 20000;

export async function captureSnapshot(root, options = {}) {
  const snapshot = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    root: path.resolve(root),
    git: await gitSnapshot(root, options),
    topLevelFiles: await topLevelFiles(root, options)
  };
  return writeSnapshot(root, snapshot, { keep: options.keepSnapshots });
}

async function gitSnapshot(root, options) {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], options);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return { available: false };
  }
  // `git diff HEAD` covers staged and unstaged changes together, which is what
  // "work in progress that is not committed yet" actually means to a reader.
  const [branch, status, head, remotes, diffStat, diff] = await Promise.all([
    git(root, ['branch', '--show-current'], options),
    git(root, ['status', '--short', '--branch'], options),
    git(root, ['log', '-1', '--oneline'], options),
    git(root, ['remote', '-v'], options),
    git(root, ['diff', 'HEAD', '--stat'], options),
    git(root, ['diff', 'HEAD'], options)
  ]);

  const diffText = diff.stdout.trimEnd();
  const clipped = diffText.length > SNAPSHOT_DIFF_MAX_CHARS;

  return {
    available: true,
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    status: status.stdout.trimEnd(),
    remotes: remotes.stdout.trimEnd(),
    diffStat: diffStat.stdout.trimEnd(),
    diff: clipped ? diffText.slice(0, SNAPSHOT_DIFF_MAX_CHARS) : diffText,
    diffClipped: clipped
  };
}

async function git(root, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd: root, timeout: 10000, signal: options.signal });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message
    };
  }
}

async function topLevelFiles(root, options = {}) {
  options.signal?.throwIfAborted();
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.name !== '.git' && entry.name !== '.context-bridge' && entry.name !== 'node_modules')
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
