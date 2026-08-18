import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';

export function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

export async function listJsonlFiles(root) {
  const files = [];
  await walk(root, files);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function readJsonlObjects(filePath, onObject) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;
    try {
      await onObject(JSON.parse(line), lineNumber);
    } catch (error) {
      await onObject({
        type: 'parse_error',
        error: error.message,
        rawLine: line
      }, lineNumber);
    }
  }
}

export async function readFirstJsonlObjects(filePath, limit = 80) {
  const objects = [];
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      objects.push(JSON.parse(line));
    } catch (error) {
      objects.push({
        type: 'parse_error',
        error: error.message,
        rawLine: line
      });
    }
    if (objects.length >= limit) {
      rl.close();
      stream.destroy();
      break;
    }
  }

  return objects;
}

export function pathsSameOrNested(candidate, root) {
  if (!candidate || !root) return false;
  const resolvedCandidate = normalizePath(candidate);
  const resolvedRoot = normalizePath(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

export function normalizePath(value) {
  return path.resolve(String(value)).replace(/[\\/]+/g, path.sep).toLowerCase();
}

async function walk(root, files) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const stat = await fs.stat(fullPath);
      files.push({
        path: fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  }
}

// The tail of a JSONL file, without reading the whole thing.
//
// Session transcripts run to hundreds of megabytes, so "what was asked most
// recently" cannot be answered by streaming from the start. Read a bounded
// window off the end instead and parse the complete lines in it. A window that
// lands mid-line simply yields fewer objects, which is fine: this only ever
// enriches a label.
export async function readLastJsonlObjects(filePath, limit = 40, maxBytes = 256 * 1024) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return [];

    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

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
