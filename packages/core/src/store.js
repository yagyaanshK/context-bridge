import fs from 'node:fs/promises';
import path from 'node:path';
import { readJsonlObjects } from './adapters/common.js';
import {
  ensureDir,
  listFiles,
  pathExists,
  readJson,
  resolveExistingInside,
  resolveInside,
  resolveLedger,
  uniqueArtifactId,
  validatePathSegment,
  withFileLock,
  writeFileAtomic,
  writeJson
} from './fs-utils.js';

export async function initStore(root, options = {}) {
  const ledger = resolveLedger(root);
  await ensureDir(ledger);
  await ensureDir(path.join(ledger, 'sessions'));
  await ensureDir(path.join(ledger, 'snapshots'));
  await ensureDir(path.join(ledger, 'exports'));
  await ensureDir(path.join(ledger, 'attachments'));

  const manifestPath = path.join(ledger, 'manifest.json');
  if (!(await pathExists(manifestPath)) || options.force) {
    await writeJson(manifestPath, {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      projectRoot: path.resolve(root),
      sessions: [],
      snapshots: [],
      exports: []
    });
  }

  return readManifest(root);
}

export async function readManifest(root) {
  const manifestPath = path.join(resolveLedger(root), 'manifest.json');
  if (!(await pathExists(manifestPath))) {
    throw new Error('Turntrail is not initialized. Run `turntrail init` first.');
  }
  return readJson(manifestPath);
}

export async function writeManifest(root, manifest) {
  await writeJson(path.join(resolveLedger(root), 'manifest.json'), manifest);
}

export async function addManifestEntry(root, key, entry, options = {}) {
  return withFileLock(manifestFile(root), async () => {
    const manifest = await readManifest(root);
    manifest[key] = Array.isArray(manifest[key]) ? manifest[key] : [];
    // Upsert by a matching field (e.g. session id) so re-importing the same
    // source replaces its entry instead of accumulating stale duplicates.
    const matchField = options.upsertBy;
    const existingIndex = matchField
      ? manifest[key].findIndex((item) => item && item[matchField] === entry[matchField])
      : -1;
    if (existingIndex >= 0) {
      manifest[key][existingIndex] = entry;
    } else {
      manifest[key].push(entry);
    }
    manifest.updatedAt = new Date().toISOString();
    await writeManifest(root, manifest);
    return manifest;
  }, options);
}

export async function writeSession(root, turns, options = {}) {
  await initStore(root);
  const provider = options.provider || turns[0]?.provider || 'unknown';
  const surface = options.surface || turns[0]?.surface || 'unknown';
  const sessionId = validatePathSegment(
    options.sessionId || `${uniqueArtifactId()}-${safeIdPart(provider)}-${safeIdPart(surface)}`,
    'Session id'
  );
  const fileName = `${sessionId}.jsonl`;
  const relativePath = path.join('sessions', fileName).replaceAll('\\', '/');
  const absolutePath = resolveInside(path.join(resolveLedger(root), 'sessions'), fileName);
  const content = turns.map((turn) => JSON.stringify({ ...turn, sessionId: turn.sessionId || sessionId })).join('\n') + '\n';
  await writeFileAtomic(absolutePath, content);
  await addManifestEntry(root, 'sessions', {
    id: sessionId,
    provider,
    surface,
    path: relativePath,
    turnCount: turns.length,
    importedAt: new Date().toISOString(),
    sourcePath: options.sourcePath,
    // Which chat in the agent's own app this came from, so a handoff can name
    // the one to return to rather than leaving you to find it.
    nativeSessionId: options.nativeSessionId,
    title: options.title,
    named: options.named || undefined
  }, { upsertBy: 'id' });
  return { id: sessionId, path: absolutePath, relativePath, turnCount: turns.length };
}

export const DEFAULT_MAX_LEDGER_TURNS = 50000;
export const DEFAULT_MAX_LEDGER_CHARS = 64 * 1024 * 1024;

export async function readAllTurns(root, options = {}) {
  const ledger = resolveLedger(root);
  const sessionFiles = await listFiles(path.join(ledger, 'sessions'), '.jsonl', {
    signal: options.signal,
    maxEntries: options.maxSessionFiles || 10000
  });
  const maxTurns = positiveLimit(options.maxLedgerTurns, DEFAULT_MAX_LEDGER_TURNS);
  const maxChars = positiveLimit(options.maxLedgerChars, DEFAULT_MAX_LEDGER_CHARS);
  const turns = [];
  let chars = 0;
  for (const filePath of sessionFiles) {
    options.signal?.throwIfAborted();
    await readJsonlObjects(
      filePath,
      (turn) => {
        chars += String(turn.content || '').length;
        if (turns.length + 1 > maxTurns || chars > maxChars) {
          throw new Error(
            `Ledger exceeds the export safety limit (${maxTurns} turns or ${maxChars} content characters). ` +
              'Raise maxLedgerTurns/maxLedgerChars deliberately or prune obsolete imported sessions.'
          );
        }
        turns.push(turn);
      },
      options
    );
  }
  return turns.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
}

// Snapshots and exports are regenerated artifacts, not source data, and each
// handoff is now on the order of 100 KB. Keeping the most recent few is enough
// to look back at what was sent; the rest only grow the ledger.
export const DEFAULT_KEEP_EXPORTS = 10;
export const DEFAULT_KEEP_SNAPSHOTS = 10;

export async function writeSnapshot(root, snapshot, options = {}) {
  await initStore(root);
  const id = uniqueArtifactId();
  const relativePath = path.join('snapshots', `${id}.json`).replaceAll('\\', '/');
  const absolutePath = path.join(resolveLedger(root), relativePath);
  await writeJson(absolutePath, snapshot);
  await addManifestEntry(root, 'snapshots', {
    id,
    path: relativePath,
    createdAt: snapshot.createdAt
  });
  await pruneLedgerEntries(root, 'snapshots', pickKeep(options.keep, DEFAULT_KEEP_SNAPSHOTS));
  return { id, path: absolutePath, relativePath };
}

export async function latestSnapshot(root) {
  const manifest = await readManifest(root);
  const snapshots = [...(manifest.snapshots || [])].sort((a, b) =>
    String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''))
  );
  if (snapshots.length === 0) return null;
  const ledger = resolveLedger(root);
  const snapshotDir = path.join(ledger, 'snapshots');
  const entryPath = snapshots[snapshots.length - 1].path;
  const candidate = resolveInside(ledger, entryPath);
  const contained = await resolveExistingInside(snapshotDir, candidate);
  if (path.extname(contained).toLowerCase() !== '.json') throw new Error('Latest snapshot path is not a JSON file.');
  return readJson(contained);
}

export async function writeExport(root, target, content, options = {}) {
  await initStore(root);
  const id = `${uniqueArtifactId()}-to-${safeIdPart(target)}`;
  const relativePath = path.join('exports', `${id}.md`).replaceAll('\\', '/');
  const absolutePath = path.join(resolveLedger(root), relativePath);
  await writeFileAtomic(absolutePath, content);
  await addManifestEntry(root, 'exports', {
    id,
    target,
    path: relativePath,
    createdAt: new Date().toISOString()
  });
  await pruneLedgerEntries(root, 'exports', pickKeep(options.keep, DEFAULT_KEEP_EXPORTS));
  return { id, path: absolutePath, relativePath };
}

// Drop the oldest manifest entries of a kind, deleting their files.
//
// Only files the manifest itself recorded are removed, and only after resolving
// back inside the ledger directory, so a malformed or hand-edited entry cannot
// make this delete something elsewhere on disk. `keep` of 0 disables pruning.
export async function pruneLedgerEntries(root, key, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return { removed: 0 };
  return withFileLock(manifestFile(root), async () => {
    const manifest = await readManifest(root);
    const entries = Array.isArray(manifest[key]) ? manifest[key] : [];
    if (entries.length <= keep) return { removed: 0 };

    const ledger = path.resolve(resolveLedger(root));
    const stale = entries.slice(0, entries.length - keep);
    let removed = 0;

    for (const entry of stale) {
      if (!entry?.path) continue;
      let target;
      try {
        target = resolveInside(ledger, entry.path);
      } catch {
        continue;
      }
      await fs.rm(target, { force: true });
      removed++;
    }

    manifest[key] = entries.slice(entries.length - keep);
    manifest.updatedAt = new Date().toISOString();
    await writeManifest(root, manifest);
    return { removed };
  });
}

function pickKeep(value, fallback) {
  if (value === 0 || value === false) return 0;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

function manifestFile(root) {
  return path.join(resolveLedger(root), 'manifest.json');
}

function safeIdPart(value) {
  let result = '';
  for (const character of String(value || 'unknown')) {
    const code = character.charCodeAt(0);
    const allowed =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      character === '.' ||
      character === '_' ||
      character === '-';
    if (allowed) result += character;
    else if (result && !result.endsWith('-')) result += '-';
    if (result.length >= 24) break;
  }
  while (result.startsWith('-')) result = result.slice(1);
  while (result.endsWith('-')) result = result.slice(0, -1);
  return result || 'unknown';
}

function positiveLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
