import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeSnapshot } from './store.js';
import { redactSecrets } from './media.js';

const execFileAsync = promisify(execFile);

// Hard cap on the diff stored in the ledger. A handoff taken mid-edit is
// exactly when the uncommitted diff matters most, but a runaway diff should
// not be allowed to bloat every snapshot file.
export const SNAPSHOT_DIFF_MAX_CHARS = 20000;
export const DEFAULT_GIT_MAX_BUFFER = 128 * 1024;
export const DEFAULT_MAX_UNTRACKED_FILES = 100;

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
  const headExists = (await git(root, ['rev-parse', '--verify', 'HEAD'], options)).exitCode === 0;
  const diffCommands = headExists
    ? [[['diff', 'HEAD', '--stat'], ['diff', 'HEAD']]]
    : [[['diff', '--cached', '--stat'], ['diff', '--cached']], [['diff', '--stat'], ['diff']]];
  const [branch, status, head, remotes, untracked, ...diffResults] = await Promise.all([
    git(root, ['branch', '--show-current'], options),
    git(root, ['status', '--short', '--branch'], options),
    headExists ? git(root, ['log', '-1', '--oneline'], options) : Promise.resolve(emptyGitResult()),
    git(root, ['remote', '-v'], options),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'], options),
    ...diffCommands.flatMap(([statArgs, diffArgs]) => [git(root, statArgs, options), git(root, diffArgs, options)])
  ]);

  const trackedStats = [];
  const trackedDiffs = [];
  let trackedClipped = false;
  for (let index = 0; index < diffResults.length; index += 2) {
    trackedStats.push(diffResults[index].stdout.trimEnd());
    trackedDiffs.push(diffResults[index + 1].stdout.trimEnd());
    trackedClipped ||= diffResults[index].stdoutClipped || diffResults[index + 1].stdoutClipped;
  }

  const untrackedPaths = completeNullSeparated(untracked.stdout, untracked.stdoutClipped)
    .slice(0, positiveLimit(options.maxUntrackedFiles, DEFAULT_MAX_UNTRACKED_FILES));
  const untrackedDiff = await renderUntrackedDiff(root, untrackedPaths, options);
  const combinedDiff = [...trackedDiffs.filter(Boolean), untrackedDiff.text].filter(Boolean).join('\n');
  const clipped = trackedClipped || untracked.stdoutClipped || untrackedDiff.clipped ||
    combinedDiff.length > SNAPSHOT_DIFF_MAX_CHARS;
  const untrackedStats = untrackedPaths.map((file) => ` ${safePathLabel(file)} | untracked`);
  const diffStat = [...trackedStats.filter(Boolean), ...untrackedStats]
    .join('\n')
    .slice(0, SNAPSHOT_DIFF_MAX_CHARS);

  return {
    available: true,
    branch: branch.stdout.trim(),
    head: headExists ? head.stdout.trim() : '(no commits yet)',
    status: status.stdout.trimEnd(),
    statusClipped: status.stdoutClipped || undefined,
    remotes: redactSecrets(remotes.stdout.trimEnd()).content,
    remotesClipped: remotes.stdoutClipped || undefined,
    diffStat,
    diff: combinedDiff.slice(0, SNAPSHOT_DIFF_MAX_CHARS),
    diffClipped: clipped,
    untrackedFiles: untrackedPaths.length,
    untrackedListClipped: untracked.stdoutClipped || undefined
  };
}

async function git(root, args, options = {}) {
  const maxBuffer = positiveLimit(options.gitMaxBuffer, DEFAULT_GIT_MAX_BUFFER);
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: root,
      timeout: 10000,
      signal: options.signal,
      encoding: 'utf8',
      maxBuffer
    });
    return { exitCode: 0, stdout, stderr, stdoutClipped: false };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const maxBufferExceeded = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    return {
      exitCode: maxBufferExceeded ? 0 : typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout || '').slice(0, maxBuffer),
      stderr: String(error.stderr || error.message || '').slice(0, maxBuffer),
      stdoutClipped: maxBufferExceeded
    };
  }
}

function emptyGitResult() {
  return { exitCode: 0, stdout: '', stderr: '', stdoutClipped: false };
}

function completeNullSeparated(value, clipped) {
  const parts = String(value || '').split('\0');
  if (clipped && !String(value || '').endsWith('\0')) parts.pop();
  return parts.filter(Boolean);
}

async function renderUntrackedDiff(root, files, options = {}) {
  let text = '';
  let clipped = false;
  const canonicalRoot = await fs.realpath(root);
  for (const relative of files) {
    options.signal?.throwIfAborted();
    const remaining = SNAPSHOT_DIFF_MAX_CHARS - text.length;
    if (remaining <= 0) {
      clipped = true;
      break;
    }
    const absolute = path.resolve(root, relative);
    const relation = path.relative(path.resolve(root), absolute);
    if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) continue;
    let handle;
    try {
      const canonical = await fs.realpath(absolute);
      const canonicalRelation = path.relative(canonicalRoot, canonical);
      if (canonicalRelation === '..' || canonicalRelation.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelation)) {
        continue;
      }
      if ((await fs.lstat(absolute)).isSymbolicLink()) continue;
      handle = await fs.open(canonical, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      const maxBytes = Math.min(stat.size, remaining, SNAPSHOT_DIFF_MAX_CHARS);
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      const body = buffer.subarray(0, bytesRead);
      const label = safePathLabel(relative);
      const content = body.includes(0)
        ? '[binary content omitted]'
        : body.toString('utf8').split(/\r?\n/).map((line) => `+${line}`).join('\n');
      const patch = `diff --git a/${label} b/${label}\nnew file\n--- /dev/null\n+++ b/${label}\n${content}\n`;
      text += patch.slice(0, remaining);
      if (stat.size > bytesRead || patch.length > remaining) clipped = true;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return { text: text.trimEnd(), clipped };
}

function safePathLabel(value) {
  return String(value || '').replace(/[\r\n\0]/g, '?').replaceAll('\\', '/');
}

function positiveLimit(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function topLevelFiles(root, options = {}) {
  options.signal?.throwIfAborted();
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) =>
      entry.name !== '.git' &&
      entry.name !== '.turntrail' &&
      entry.name !== '.context-bridge' &&
      entry.name !== 'node_modules'
    )
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
