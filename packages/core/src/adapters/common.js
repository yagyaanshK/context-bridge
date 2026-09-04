import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReadStream } from 'node:fs';

export function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

export const DEFAULT_MAX_DISCOVERY_FILES = 5000;
export const DEFAULT_MAX_DISCOVERY_ENTRIES = 50000;
export const DEFAULT_MAX_JSONL_LINE_CHARS = 8 * 1024 * 1024;
export const DEFAULT_MAX_IMPORTED_TURNS = 50000;
export const DEFAULT_MAX_IMPORTED_CHARS = 64 * 1024 * 1024;

export async function listJsonlFiles(root, options = {}) {
  return listSessionFiles(root, { ...options, extensions: ['.jsonl'] });
}

export async function listSessionFiles(root, options = {}) {
  const files = [];
  const state = {
    entries: 0,
    maxEntries: positiveLimit(options.maxEntries, DEFAULT_MAX_DISCOVERY_ENTRIES),
    maxFiles: positiveLimit(options.maxFiles, DEFAULT_MAX_DISCOVERY_FILES),
    extensions: new Set((options.extensions || ['.jsonl']).map((item) => String(item).toLowerCase())),
    signal: options.signal
  };
  await walk(root, files, state, 0);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function jsonlFileInfo(filePath) {
  return sessionFileInfo(filePath, ['.jsonl']);
}

export async function sessionFileInfo(filePath, extensions = ['.jsonl']) {
  const absolute = path.resolve(filePath);
  const stat = await fs.stat(absolute);
  const allowed = new Set(extensions.map((item) => String(item).toLowerCase()));
  if (!stat.isFile() || !allowed.has(path.extname(absolute).toLowerCase())) {
    throw new Error(`Native session is not a supported ${[...allowed].join(' or ')} file: ${absolute}`);
  }
  return {
    path: absolute,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    modifiedAt: stat.mtime.toISOString()
  };
}

export function createBoundedTurnCollector(options = {}) {
  const maxTurns = positiveLimit(options.maxImportedTurns, DEFAULT_MAX_IMPORTED_TURNS);
  const maxChars = positiveLimit(options.maxImportedChars, DEFAULT_MAX_IMPORTED_CHARS);
  const turns = [];
  let chars = 0;
  return {
    turns,
    push(turn) {
      options.signal?.throwIfAborted();
      if (!turn) return;
      chars += String(turn.content || '').length;
      if (turns.length + 1 > maxTurns || chars > maxChars) {
        throw new Error(
          `Transcript exceeds the in-memory import safety limit (${maxTurns} turns or ${maxChars} content characters). ` +
            'Raise maxImportedTurns/maxImportedChars deliberately or import a smaller session.'
        );
      }
      turns.push(turn);
    }
  };
}

export async function readJsonlObjects(filePath, onObject, options = {}) {
  const maxLineChars = positiveLimit(options.maxLineChars, DEFAULT_MAX_JSONL_LINE_CHARS);
  const stream = createReadStream(filePath, { encoding: 'utf8', signal: options.signal });
  let lineNumber = 0;
  let pending = '';

  const emit = async (line) => {
    lineNumber++;
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      parsed = {
        type: 'parse_error',
        error: error.message,
        rawLine: line.slice(0, 4096),
        rawLineClipped: line.length > 4096
      };
    }
    return onObject(parsed, lineNumber);
  };

  for await (const chunk of stream) {
    options.signal?.throwIfAborted();
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (line.length > maxLineChars) throw new Error(`JSONL line ${lineNumber + 1} exceeds the ${maxLineChars}-character safety limit.`);
      if ((await emit(line)) === false) {
        stream.destroy();
        return;
      }
    }
    if (pending.length > maxLineChars) throw new Error(`JSONL line ${lineNumber + 1} exceeds the ${maxLineChars}-character safety limit.`);
  }
  if (pending) await emit(pending.replace(/\r$/, ''));
}

export async function readFirstJsonlObjects(filePath, limit = 80, options = {}) {
  const objects = [];
  await readJsonlObjects(
    filePath,
    (object) => {
      objects.push(object);
      return objects.length < limit;
    },
    options
  );
  return objects;
}

export async function pathsSameOrNested(candidate, root, options = {}) {
  if (!candidate || !root) return false;
  const [resolvedCandidate, resolvedRoot] = await Promise.all([
    normalizePath(candidate, options),
    normalizePath(root, options)
  ]);
  return isSameOrNested(resolvedCandidate, resolvedRoot, options.platform);
}

export async function pathsOverlap(left, right, options = {}) {
  if (!left || !right) return false;
  const [resolvedLeft, resolvedRight] = await Promise.all([
    normalizePath(left, options),
    normalizePath(right, options)
  ]);
  return isSameOrNested(resolvedLeft, resolvedRight, options.platform) ||
    isSameOrNested(resolvedRight, resolvedLeft, options.platform);
}

export async function normalizePath(value, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathApi.resolve(String(value));
  let canonical = resolved;
  try {
    canonical = await (options.realpath || fs.realpath)(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const normalized = pathApi.normalize(canonical);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrNested(candidate, root, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const relative = pathApi.relative(root, candidate);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

async function walk(root, files, state, depth) {
  state.signal?.throwIfAborted();
  if (depth > 16) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    state.signal?.throwIfAborted();
    state.entries++;
    if (state.entries > state.maxEntries) {
      throw new Error(`Native session discovery exceeded ${state.maxEntries} filesystem entries. Narrow the provider session directory or raise maxDiscoveryEntries.`);
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files, state, depth + 1);
    } else if (entry.isFile() && state.extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(await sessionFileInfo(fullPath, [...state.extensions]));
      if (files.length > state.maxFiles) {
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        files.length = state.maxFiles;
      }
    }
  }
}

function positiveLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// The tail of a JSONL file, without reading the whole thing.
//
// Session transcripts run to hundreds of megabytes, so "what was asked most
// recently" cannot be answered by streaming from the start. Read a bounded
// window off the end instead and parse the complete lines in it. A window that
// lands mid-line simply yields fewer objects, which is fine: this only ever
// enriches a label.
export async function readLastJsonlObjects(filePath, limit = 40, maxBytes = 256 * 1024, options = {}) {
  let handle;
  try {
    options.signal?.throwIfAborted();
    handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return [];

    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    options.signal?.throwIfAborted();

    const lines = buffer.toString('utf8').split(/\r?\n/);
    // When the window started mid-file the first line is a fragment - and may
    // begin mid-character, which is the other reason to drop it.
    if (start > 0) lines.shift();

    const objects = [];
    for (let index = lines.length - 1; index >= 0 && objects.length < limit; index--) {
      const line = lines[index];
      if (!line || !line.trim()) continue;
      try {
        objects.push(JSON.parse(line));
      } catch {
        // A truncated or oversized line is skipped rather than reported: this
        // path is decorative, and a parse error here is expected at the edges.
      }
    }
    return objects.reverse();
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}
