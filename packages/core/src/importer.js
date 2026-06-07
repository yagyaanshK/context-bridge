import fs from 'node:fs/promises';
import path from 'node:path';
import { createTurn, normalizeProvider, normalizeSurface } from './schema.js';
import { writeSession } from './store.js';

export async function importTranscript(root, sourcePath, options = {}) {
  const absoluteSource = path.resolve(root, sourcePath);
  const text = await fs.readFile(absoluteSource, 'utf8');
  const provider = normalizeProvider(options.provider);
  const surface = normalizeSurface(options.surface);
  const defaults = {
    provider,
    surface,
    metadata: {
      sourcePath: path.relative(root, absoluteSource).replaceAll('\\', '/')
    }
  };
  const rawTurns = parseTranscript(text, path.extname(sourcePath).toLowerCase());
  const turns = rawTurns.map((turn) => createTurn(turn, defaults)).filter((turn) => turn.content.trim().length > 0);
  if (turns.length === 0) {
    throw new Error(`No importable turns found in ${sourcePath}`);
  }
  return writeSession(root, turns, {
    provider,
    surface,
    sourcePath: defaults.metadata.sourcePath
  });
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
