import { latestSnapshot, readAllTurns, readManifest, writeExport } from './store.js';
import { mediaReferencesFromMetadata, sanitizeContentForHandoff } from './media.js';

export async function exportHandoff(root, options = {}) {
  const target = normalizeTarget(options.target || 'unknown');
  const manifest = await readManifest(root);
  const turns = await readAllTurns(root);
  const snapshot = await latestSnapshot(root);
  const selectedTurns = selectTurns(turns, options.maxChars);
  const content = renderHandoff({
    target,
    manifest,
    snapshot,
    turns: selectedTurns.turns,
    omittedTurns: selectedTurns.omittedTurns,
    maxChars: options.maxChars
  });
  return writeExport(root, target, content);
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

export function renderHandoff({ target, manifest, snapshot, turns, omittedTurns = 0, maxChars }) {
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
  if (turns.length === 0) {
    lines.push('No transcript turns were included.');
  }
  for (const turn of turns) {
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
    lines.push('```text');
    lines.push(sanitized.content.replaceAll('```', '` ` `'));
    lines.push('```');
    lines.push('');
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

function turnSize(turn) {
  return sanitizeContentForHandoff(JSON.stringify(turn)).content.length + 32;
}
