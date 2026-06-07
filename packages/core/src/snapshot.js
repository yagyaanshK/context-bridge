import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeSnapshot } from './store.js';

const execFileAsync = promisify(execFile);

export async function captureSnapshot(root) {
  const snapshot = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    root: path.resolve(root),
    git: await gitSnapshot(root),
    topLevelFiles: await topLevelFiles(root)
  };
  return writeSnapshot(root, snapshot);
}

async function gitSnapshot(root) {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return { available: false };
  }
  const [branch, status, head, remotes] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['status', '--short', '--branch']),
    git(root, ['log', '-1', '--oneline']),
    git(root, ['remote', '-v'])
  ]);
  return {
    available: true,
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    status: status.stdout.trimEnd(),
    remotes: remotes.stdout.trimEnd()
  };
}

async function git(root, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd: root, timeout: 10000 });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message
    };
  }
}

async function topLevelFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.name !== '.git' && entry.name !== '.context-bridge' && entry.name !== 'node_modules')
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
