import { latestSnapshot, readAllTurns, readManifest, writeExport } from './store.js';
import { mediaReferencesFromMetadata, sanitizeContentForHandoff } from './media.js';

// Default caps for high-volume, low-signal roles. Tool outputs (git diffs, dir
// listings) and system turn-context blobs dominate handoff size while the
// receiving agent is told to re-verify state against the live workspace anyway.
export const DEFAULT_TOOL_MAX_CHARS = 2000;
export const DEFAULT_SYSTEM_MAX_CHARS = 800;

export async function exportHandoff(root, options = {}) {
  const target = normalizeTarget(options.target || 'unknown');
  const manifest = await readManifest(root);
  const turns = await readAllTurns(root);
  const snapshot = await latestSnapshot(root);
  const dedupe = options.dedupe !== false;
  const deduped = dedupe ? dedupeAdjacentTurns(turns) : { turns, removed: 0 };
  const selectedTurns = selectTurns(deduped.turns, options.maxChars);
  const content = renderHandoff({
    target,
    manifest,
    snapshot,
    turns: selectedTurns.turns,
    omittedTurns: selectedTurns.omittedTurns,
    collapsedDuplicates: deduped.removed,
    maxChars: options.maxChars,
    truncation: resolveTruncation(options)
  });
  return writeExport(root, target, content);
}

// Collapse runs of identical role+content turns. Native logs (notably Codex)
// emit the same logical message under several event types (agent_message +
// response_item/message + task_complete), producing 2-3 adjacent copies. We
// only collapse *consecutive* duplicates so that legitimately-repeated output
// at different points in the session (e.g. an empty `git status`) is preserved.
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

function resolveTruncation(options = {}) {
  return {
    tool: pickCap(options.toolMaxChars, DEFAULT_TOOL_MAX_CHARS),
    system: pickCap(options.systemMaxChars, DEFAULT_SYSTEM_MAX_CHARS)
  };
}

// A cap of 0 (or false) disables truncation for that role; undefined/null uses
// the default; a positive number overrides it.
function pickCap(value, fallback) {
  if (value === 0 || value === false) return 0;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

export function selectTurns(turns, maxChars) {
  if (!maxChars || maxChars <= 0) return { turns, omittedTurns: 0 };

  const sorted = [...turns];
  const userTurns = sorted.filter((turn) => turn.role === 'user');
  const otherTurns = sorted.filter((turn) => turn.role !== 'user').reverse();
  const selected = [];
  let used = 0;

  for (const turn of userTurns) {
    const size = turnSize(turn);
    if (used + size <= maxChars) {
      selected.push(turn);
      used += size;
    }
  }

  for (const turn of otherTurns) {
    const size = turnSize(turn);
    if (used + size <= maxChars) {
      selected.push(turn);
      used += size;
    }
  }

  selected.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  return { turns: selected, omittedTurns: turns.length - selected.length };
}

export function renderHandoff({
  target,
  manifest,
  snapshot,
  turns,
  omittedTurns = 0,
  collapsedDuplicates = 0,
  maxChars,
  truncation = {}
}) {
  // Render the transcript first so the ledger header can report truncation stats.
  const transcriptLines = [];
  let truncatedTurns = 0;
  let truncatedChars = 0;
  if (turns.length === 0) {
    transcriptLines.push('No transcript turns were included.');
  }
  for (const turn of turns) {
    transcriptLines.push(`### ${turn.role} | ${turn.provider}/${turn.surface} | ${turn.timestamp || 'no timestamp'}`);
    transcriptLines.push('');
    const mediaRefs = mediaReferencesFromMetadata(turn.metadata);
    if (mediaRefs.length > 0) {
      transcriptLines.push('Media references:');
      transcriptLines.push('');
      transcriptLines.push(...mediaRefs);
      transcriptLines.push('');
    }
    const sanitized = sanitizeContentForHandoff(turn.content);
    if (sanitized.omitted > 0) {
      transcriptLines.push(`Context Bridge omitted ${sanitized.omitted} inline media/base64 payload(s) from this turn.`);
      transcriptLines.push('');
    }
    const truncated = truncateTurnContent(sanitized.content, truncation[turn.role]);
    if (truncated.removed > 0) {
      truncatedTurns++;
      truncatedChars += truncated.removed;
    }
    transcriptLines.push('```text');
    transcriptLines.push(truncated.content.replaceAll('```', '` ` `'));
    transcriptLines.push('```');
    transcriptLines.push('');
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
  lines.push(...transcriptLines);
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

function turnSize(turn) {
  return sanitizeContentForHandoff(JSON.stringify(turn)).content.length + 32;
}
