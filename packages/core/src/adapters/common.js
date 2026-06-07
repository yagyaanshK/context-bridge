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
