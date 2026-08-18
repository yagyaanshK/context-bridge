import fs from 'node:fs/promises';
import { homePath } from './common.js';

// Codex's own name for a chat.
//
// Codex does name its threads - the name in the app sidebar, and whatever
// `/rename` was given - it just does not write that name into the transcript.
// It keeps it in `~/.codex/session_index.jsonl`, keyed by thread id, which is
// the same id that names the rollout file. That makes it a direct join onto a
// discovered session.
//
// The file is append-only: renaming a thread adds a line rather than rewriting
// one, so an id appears as many times as it has been named and the last entry
// is the current name. On this machine 60 lines covered 37 distinct threads.
//
// Codex keeps a second copy in the `threads` table of `~/.codex/state_5.sqlite`,
// which also has `title` and `name` columns, and reading both looks prudent.
// Measured against a real install it is not worth it: of 64 threads there was
// not one the database could name that the index had not already named, and its
// `name` column was empty throughout. Skipping it keeps this to a plain file
// read - no SQLite dependency, no locked-database or write-ahead-log handling,
// and no exposure to the drift between the two stores that Codex has open bugs
// about on Windows.
export async function readCodexThreadNames(options = {}) {
  const file = options.sessionIndex || homePath('.codex', 'session_index.jsonl');
  const names = new Map();

  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    // Codex versions that predate the index, or a fresh install. Callers fall
    // back to naming a session from its transcript.
    return names;
  }

  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      // A partially flushed final line should not cost us the whole index.
      continue;
    }
    const id = typeof entry?.id === 'string' ? entry.id : undefined;
    if (!id) continue;
    const name = typeof entry?.thread_name === 'string' ? entry.thread_name.trim() : '';
    // A later line supersedes an earlier one, and clearing a name is a rename
    // like any other.
    if (name) names.set(id, name);
    else names.delete(id);
  }

  return names;
}
