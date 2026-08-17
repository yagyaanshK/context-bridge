import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, listFiles, pathExists, readJson, resolveLedger, timestampForPath, writeJson } from './fs-utils.js';

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
    throw new Error('Context Bridge is not initialized. Run `context-bridge init` first.');
  }
  return readJson(manifestPath);
}

export async function writeManifest(root, manifest) {
  await writeJson(path.join(resolveLedger(root), 'manifest.json'), manifest);
}

export async function addManifestEntry(root, key, entry, options = {}) {
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
}

export async function writeSession(root, turns, options = {}) {
  await initStore(root);
  const provider = options.provider || turns[0]?.provider || 'unknown';
  const surface = options.surface || turns[0]?.surface || 'unknown';
  const sessionId = options.sessionId || `${timestampForPath()}-${provider}-${surface}`;
  const fileName = `${sessionId}.jsonl`;
  const relativePath = path.join('sessions', fileName).replaceAll('\\', '/');
  const absolutePath = path.join(resolveLedger(root), relativePath);
  const content = turns.map((turn) => JSON.stringify({ ...turn, sessionId: turn.sessionId || sessionId })).join('\n') + '\n';
  await fs.writeFile(absolutePath, content, 'utf8');
  await addManifestEntry(root, 'sessions', {
    id: sessionId,
    provider,
    surface,
    path: relativePath,
    turnCount: turns.length,
    importedAt: new Date().toISOString(),
    sourcePath: options.sourcePath
  }, { upsertBy: 'id' });
  return { id: sessionId, path: absolutePath, relativePath, turnCount: turns.length };
}

export async function readAllTurns(root) {
  const ledger = resolveLedger(root);
  const sessionFiles = await listFiles(path.join(ledger, 'sessions'), '.jsonl');
  const turns = [];
  for (const filePath of sessionFiles) {
    const text = await fs.readFile(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      turns.push(JSON.parse(line));
    }
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
  const id = timestampForPath();
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
  return readJson(path.join(resolveLedger(root), snapshots[snapshots.length - 1].path));
}

export async function writeExport(root, target, content, options = {}) {
  await initStore(root);
  const id = `${timestampForPath()}-to-${target}`;
  const relativePath = path.join('exports', `${id}.md`).replaceAll('\\', '/');
  const absolutePath = path.join(resolveLedger(root), relativePath);
  await fs.writeFile(absolutePath, content, 'utf8');
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
  const manifest = await readManifest(root);
  const entries = Array.isArray(manifest[key]) ? manifest[key] : [];
  if (entries.length <= keep) return { removed: 0 };

  const ledger = path.resolve(resolveLedger(root));
  const stale = entries.slice(0, entries.length - keep);
  let removed = 0;

  for (const entry of stale) {
    if (!entry?.path) continue;
    const target = path.resolve(ledger, entry.path);
    if (target !== ledger && !target.startsWith(`${ledger}${path.sep}`)) continue;
    await fs.rm(target, { force: true });
    removed++;
  }

  manifest[key] = entries.slice(entries.length - keep);
  manifest.updatedAt = new Date().toISOString();
  await writeManifest(root, manifest);
  return { removed };
}

function pickKeep(value, fallback) {
  if (value === 0 || value === false) return 0;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
}
