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

export async function addManifestEntry(root, key, entry) {
  const manifest = await readManifest(root);
  manifest[key] = Array.isArray(manifest[key]) ? manifest[key] : [];
  manifest[key].push(entry);
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
  });
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

export async function writeSnapshot(root, snapshot) {
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
  return { id, path: absolutePath, relativePath };
}

export async function latestSnapshot(root) {
  const manifest = await readManifest(root);
  const snapshots = manifest.snapshots || [];
  if (snapshots.length === 0) return null;
  const latest = snapshots[snapshots.length - 1];
  return readJson(path.join(resolveLedger(root), latest.path));
}

export async function writeExport(root, target, content) {
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
  return { id, path: absolutePath, relativePath };
}
