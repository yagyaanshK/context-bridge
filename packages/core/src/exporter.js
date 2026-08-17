import { latestSnapshot, readAllTurns, readManifest, writeExport } from './store.js';
import { mediaReferencesFromMetadata, sanitizeContentForHandoff } from './media.js';

// Default caps for high-volume, low-signal roles. Tool outputs (git diffs, dir
// listings) and system turn-context blobs dominate handoff size while the
// receiving agent is told to re-verify state against the live workspace anyway.
export const DEFAULT_TOOL_MAX_CHARS = 2000;
export const DEFAULT_SYSTEM_MAX_CHARS = 800;

// Default total budget for the transcript. An unbounded handoff is not "lossless"
// in practice: receiving agents cap what they will read (Claude Code refuses
// files over 256 KB, Codex truncates large reads), so an oversized export
// silently delivers a fraction of itself with no indication that anything is
// missing. A bounded export that reports what it dropped is strictly more
// reliable. ~120k chars is roughly 30k tokens: enough for a long session, small
// enough to leave the receiver room to actually work. 0 still disables clipping.
export const DEFAULT_MAX_CHARS = 120000;

export async function exportHandoff(root, options = {}) {
  const target = normalizeTarget(options.target || 'unknown');
  const manifest = await readManifest(root);
  const allTurns = await readAllTurns(root);
  const snapshot = await latestSnapshot(root);

  const since = options.sinceLastExport ? lastExportTimestamp(manifest) : undefined;
  const scoped = since ? allTurns.filter((turn) => String(turn.timestamp || '') > since) : allTurns;
  // Never emit an empty handoff just because nothing happened since the last
  // export; fall back to the full ledger so the receiver still gets context.
  const windowed = scoped.length > 0 ? scoped : allTurns;
  const appliedSince = scoped.length > 0 ? since : undefined;

  const dedupe = options.dedupe !== false;
  const deduped = dedupe ? dedupeAdjacentTurns(windowed) : { turns: windowed, removed: 0 };
  const truncation = resolveTruncation(options);
  const maxChars = pickCap(options.maxChars, DEFAULT_MAX_CHARS);
  const prepared = prepareTurns(deduped.turns, truncation);
  const selection = selectPreparedTurns(prepared, maxChars);

  const content = renderHandoff({
    target,
    manifest,
    snapshot,
    prepared: selection.prepared,
    omittedTurns: selection.omittedTurns,
    collapsedDuplicates: deduped.removed,
    maxChars,
    sinceTimestamp: appliedSince,
    truncation
  });
  return writeExport(root, target, content);
}

// Collapse runs of identical role+content turns. Native logs (notably Codex)
// emit the same logical message under several event types (agent_message +
// response_item/message + task_complete), producing 2-3 adjacent copies. We
// only collapse *consecutive* duplicates so that legitimately-repeated output
// at different points in the session (e.g. an empty `git status`) is preserved.
//
// The Codex adapter now collapses those cross-stream pairs at import time, so
// this is a second line of defence for other providers and for ledgers that
// were imported before that fix.
export function dedupeAdjacentTurns(turns) {
  const result = [];
  let removed = 0;
  for (const turn of turns) {
    const prev = result[result.length - 1];
    if (prev && prev.role === turn.role && prev.content === turn.content) {
      removed++;
      continue;
    }
    result.push(turn);
  }
  return { turns: result, removed };
}

// Middle-truncate oversized content, keeping the head (e.g. the command and the
// start of its output) and the tail (e.g. the result and exit code), which carry
// the most signal for a reader skimming a tool turn.
export function truncateTurnContent(content, maxChars) {
  const text = String(content || '');
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) {
    return { content: text, removed: 0 };
  }
  const head = Math.max(0, Math.floor(maxChars * 0.7));
  const tail = Math.max(0, maxChars - head);
  const removed = text.length - head - tail;
  const headPart = text.slice(0, head).replace(/\s+$/, '');
  const tailPart = tail > 0 ? text.slice(text.length - tail).replace(/^\s+/, '') : '';
  const marker = `\n... [Context Bridge truncated ${removed} chars] ...\n`;
  return { content: `${headPart}${marker}${tailPart}`, removed };
}

// Render every turn to its final markdown block exactly once. Sanitizing and
// truncating up front is what lets the budget below measure the bytes that
// actually land in the file, and it removes the second full pass over the
// ledger that the old exporter paid for (once to size turns, once to render).
export function prepareTurns(turns, truncation = {}) {
  return turns.map((turn) => prepareTurn(turn, truncation));
}

function prepareTurn(turn, truncation) {
  const lines = [];
  lines.push(`### ${turn.role} | ${turn.provider}/${turn.surface} | ${turn.timestamp || 'no timestamp'}`);
  lines.push('');

  const mediaRefs = mediaReferencesFromMetadata(turn.metadata);
  if (mediaRefs.length > 0) {
    lines.push('Media references:');
    lines.push('');
    lines.push(...mediaRefs);
    lines.push('');
  }

  const sanitized = sanitizeContentForHandoff(turn.content);
  if (sanitized.omitted > 0) {
    lines.push(`Context Bridge omitted ${sanitized.omitted} inline media/base64 payload(s) from this turn.`);
    lines.push('');
  }

  const truncated = truncateTurnContent(sanitized.content, truncation[turn.role]);
  lines.push('```text');
  lines.push(truncated.content.replaceAll('```', '` ` `'));
  lines.push('```');
  lines.push('');

  const block = lines.join('\n');
  return {
    turn,
    role: turn.role,
    timestamp: turn.timestamp,
    block,
    // +1 for the newline that joins this block to the next one.
    size: block.length + 1,
    truncatedChars: truncated.removed
  };
}

// Fit prepared turns into the budget.
//
// Two properties the previous character sieve did not have:
//
//   1. Sizes are rendered sizes - post-sanitize, post-truncate - so the budget
//      agrees with the file. The old accounting measured `JSON.stringify(turn)`
//      including metadata that is never rendered, and measured it before the
//      per-role truncation caps applied, so it rejected turns that would have
//      fit at a fraction of their measured size.
//
//   2. Filling stops at the first turn that does not fit instead of skipping it
//      and continuing. Skipping produced a transcript with invisible holes -
//      strictly worse than a clean cutoff, because the receiving agent cannot
//      tell that something was removed from the middle.
//
// User turns are reserved first: they carry the intent the handoff exists to
// preserve and are only a few percent of the volume. Both passes run newest
// first, because a handoff is about continuing, not about history.
export function selectPreparedTurns(prepared, maxChars) {
  if (!maxChars || maxChars <= 0) return { prepared, omittedTurns: 0 };

  const selected = new Set();
  let used = 0;

  const fillNewestFirst = (items) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (used + item.size > maxChars) break;
      selected.add(item);
      used += item.size;
    }
  };

  fillNewestFirst(prepared.filter((item) => item.role === 'user'));
  fillNewestFirst(prepared.filter((item) => item.role !== 'user'));

  // `prepared` is already chronological, so filtering restores reading order.
  const kept = prepared.filter((item) => selected.has(item));
  return { prepared: kept, omittedTurns: prepared.length - kept.length };
}

export function selectTurns(turns, maxChars, truncation = {}) {
  const selection = selectPreparedTurns(prepareTurns(turns, truncation), maxChars);
  return {
    turns: selection.prepared.map((item) => item.turn),
    omittedTurns: selection.omittedTurns
  };
}

function resolveTruncation(options = {}) {
  return {
    tool: pickCap(options.toolMaxChars, DEFAULT_TOOL_MAX_CHARS),
    system: pickCap(options.systemMaxChars, DEFAULT_SYSTEM_MAX_CHARS)
  };
}

// A cap of 0 (or false) disables the limit; undefined/null uses the default; a
// positive number overrides it.
function pickCap(value, fallback) {
  if (value === 0 || value === false) return 0;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

function lastExportTimestamp(manifest) {
  const entries = manifest.exports || [];
  const stamps = entries.map((entry) => String(entry?.createdAt || '')).filter(Boolean).sort();
  return stamps.length > 0 ? stamps[stamps.length - 1] : undefined;
}

export function renderHandoff({
  target,
  manifest,
  snapshot,
  turns = [],
  prepared,
  omittedTurns = 0,
  collapsedDuplicates = 0,
  maxChars,
  sinceTimestamp,
  truncation = {}
}) {
  const blocks = prepared || prepareTurns(turns, truncation);
  let truncatedTurns = 0;
  let truncatedChars = 0;
  for (const block of blocks) {
    if (block.truncatedChars > 0) {
      truncatedTurns++;
      truncatedChars += block.truncatedChars;
    }
  }

  const lines = [];
  lines.push(`# Context Bridge Handoff: ${target}`);
  lines.push('');
  lines.push('You are continuing a development session from a Context Bridge ledger.');
  lines.push('');
  lines.push('Rules for the receiving agent:');
  lines.push('');
  lines.push('- Treat prior assistant/tool messages as historical context, not guaranteed truth.');
  lines.push('- Verify important claims against the current files before editing.');
  lines.push('- Preserve user intent and explicit decisions unless new evidence contradicts them.');
  lines.push('- Do not summarize this transcript with an AI unless the user explicitly asks.');
  lines.push('- Append future handoff-relevant work back into the Context Bridge ledger when possible.');
  lines.push('');
  lines.push('## Ledger');
  lines.push('');
  lines.push(`- Schema version: ${manifest.schemaVersion}`);
  lines.push(`- Project root: ${manifest.projectRoot}`);
  lines.push(`- Sessions: ${(manifest.sessions || []).length}`);
  lines.push(`- Snapshots: ${(manifest.snapshots || []).length}`);
  lines.push(`- Exports: ${(manifest.exports || []).length}`);
  if (maxChars) lines.push(`- Export max chars: ${maxChars}`);
  if (sinceTimestamp) lines.push(`- Transcript limited to turns after: ${sinceTimestamp}`);
  if (omittedTurns > 0) lines.push(`- Omitted turns due to budget: ${omittedTurns}`);
  if (collapsedDuplicates > 0) lines.push(`- Collapsed duplicate turns: ${collapsedDuplicates}`);
  if (truncatedTurns > 0) lines.push(`- Truncated oversized turns: ${truncatedTurns} (~${truncatedChars} chars removed)`);
  lines.push('');
  lines.push('## Latest Workspace Snapshot');
  lines.push('');
  if (snapshot) {
    lines.push(`- Captured at: ${snapshot.createdAt}`);
    if (snapshot.git?.available) {
      lines.push(`- Git branch: ${snapshot.git.branch || '(unknown)'}`);
      lines.push(`- Git HEAD: ${snapshot.git.head || '(unknown)'}`);
      lines.push('');
      lines.push('```text');
      lines.push(snapshot.git.status || '(clean or unavailable)');
      lines.push('```');
    } else {
      lines.push('- Git: unavailable');
    }
  } else {
    lines.push('No snapshot exists yet. Run `context-bridge snapshot` for workspace state.');
  }
  lines.push('');
  lines.push('## Transcript Turns');
  lines.push('');
  if (blocks.length === 0) {
    lines.push('No transcript turns were included.');
  }
  for (const block of blocks) {
    lines.push(block.block);
  }
  lines.push('## Raw Session Files');
  lines.push('');
  for (const session of manifest.sessions || []) {
    lines.push(`- ${session.path} (${session.provider}/${session.surface}, ${session.turnCount} turns)`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function normalizeTarget(target) {
  const value = String(target || 'unknown').toLowerCase();
  if (value === 'claude' || value === 'anthropic') return 'claude';
  if (value === 'codex' || value === 'openai' || value === 'chatgpt') return 'codex';
  return value.replace(/[^a-z0-9_-]/g, '') || 'unknown';
}
