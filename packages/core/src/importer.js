import fs from 'node:fs/promises';
import path from 'node:path';
import { createBoundedTurnCollector, readJsonlObjects } from './adapters/common.js';
import { createTurn, normalizeProvider, normalizeSurface } from './schema.js';
import { writeSession } from './store.js';

export const DEFAULT_MAX_NON_JSONL_IMPORT_BYTES = 32 * 1024 * 1024;

export async function importTranscript(root, sourcePath, options = {}) {
  const absoluteSource = path.resolve(root, sourcePath);
  options.signal?.throwIfAborted();
  const provider = normalizeProvider(options.provider);
  const surface = normalizeSurface(options.surface);
  const defaults = {
    provider,
    surface,
    metadata: {
      sourcePath: path.relative(root, absoluteSource).replaceAll('\\', '/')
    }
  };
  const extension = path.extname(sourcePath).toLowerCase();
  const collector = createBoundedTurnCollector(options);
  if (extension === '.jsonl') {
    await readJsonlObjects(
      absoluteSource,
      (raw) => {
        const turn = createTurn(raw, defaults);
        if (turn.content.trim()) collector.push(turn);
      },
      options
    );
  } else {
    const stat = await fs.stat(absoluteSource);
    const maxBytes = positiveLimit(options.maxNonJsonlImportBytes, DEFAULT_MAX_NON_JSONL_IMPORT_BYTES);
    if (stat.size > maxBytes) {
      throw new Error(
        `Import file is ${stat.size} bytes, above the ${maxBytes}-byte safety limit for ${extension || 'text'} files. ` +
          'Convert it to JSONL for streaming or raise maxNonJsonlImportBytes deliberately.'
      );
    }
    const text = await fs.readFile(absoluteSource, 'utf8');
    for (const raw of parseTranscript(text, extension)) {
      const turn = createTurn(raw, defaults);
      if (turn.content.trim()) collector.push(turn);
    }
  }
  const { turns } = collector;
  if (turns.length === 0) {
    throw new Error(`No importable turns found in ${sourcePath}`);
  }
  return writeSession(root, turns, {
    provider,
    surface,
    sourcePath: defaults.metadata.sourcePath
  });
}

function positiveLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function parseTranscript(text, extension = '') {
  if (extension === '.jsonl') return parseJsonl(text);
  if (extension === '.json') return parseJson(text);
  return [
    {
      role: 'unknown',
      content: text,
      metadata: {
        importedAs: 'raw-text'
      }
    }
  ];
}

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseJson(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.messages)) return parsed.messages;
  if (Array.isArray(parsed.turns)) return parsed.turns;
  if (Array.isArray(parsed.conversation)) return parsed.conversation;
  return [parsed];
}
