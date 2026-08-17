// Extractive session summary.
//
// Everything here is lifted verbatim from the ledger or derived mechanically.
// That is a deliberate constraint, not a limitation: the handoff instructs the
// receiving agent not to summarize the transcript with an AI, so the exporter
// must not do so either. The goal is only to save the receiver from reading
// fifteen thousand lines to discover what the last request was.

const TOOL_CALL_PATTERN = /^Tool call: (\S+)\n([\s\S]*)$/;
const FILE_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath', 'target_file'];
const COMMAND_KEYS = ['command', 'cmd'];

// Tool names that indicate the call changed a file rather than just read one.
const WRITE_TOOL_PATTERN = /write|edit|create|update|patch|apply|append|insert/i;

// User turns that agent harnesses inject rather than the person typing. Picking
// one of these as "the last request" would be actively misleading, so they are
// skipped - unless they are all there is, in which case the raw last turn wins.
const INJECTED_CONTEXT_PATTERN =
  /^\s*(?:<environment_context>|<INSTRUCTIONS>|<system-reminder>|<permissions instructions>|<collaboration_mode>|Turn context:|#\s*AGENTS\.md instructions|Caveat: The messages below)/i;

export function summarizeSession(turns, options = {}) {
  const maxQuoteChars = positive(options.maxQuoteChars, 1200);
  const maxFiles = positive(options.maxFiles, 12);
  const maxCommands = positive(options.maxCommands, 8);

  const counts = { user: 0, assistant: 0, tool: 0, system: 0, other: 0 };
  for (const turn of turns) {
    if (counts[turn.role] === undefined) counts.other++;
    else counts[turn.role]++;
  }

  const userTurns = turns.filter((turn) => turn.role === 'user' && String(turn.content || '').trim());
  const authored = userTurns.filter((turn) => !INJECTED_CONTEXT_PATTERN.test(String(turn.content || '')));
  const lastUser = last(authored.length > 0 ? authored : userTurns);
  const lastAssistant = last(turns.filter((turn) => turn.role === 'assistant' && String(turn.content || '').trim()));

  const scanned = scanToolCalls(turns);

  return {
    counts,
    firstTimestamp: turns.length > 0 ? turns[0].timestamp : undefined,
    lastTimestamp: turns.length > 0 ? turns[turns.length - 1].timestamp : undefined,
    lastUser: lastUser && { timestamp: lastUser.timestamp, content: clip(lastUser.content, maxQuoteChars) },
    lastAssistant:
      lastAssistant && { timestamp: lastAssistant.timestamp, content: clip(lastAssistant.content, maxQuoteChars) },
    filesWritten: rankByFrequency(scanned.filesWritten).slice(0, maxFiles),
    commands: scanned.commands.slice(-maxCommands)
  };
}

// Walk tool turns for the structured arguments the adapters preserve as
// `Tool call: <name>\n<json>`. Anything that does not parse is skipped rather
// than guessed at.
function scanToolCalls(turns) {
  const filesWritten = [];
  const commands = [];

  for (const turn of turns) {
    if (turn.role !== 'tool') continue;
    const match = TOOL_CALL_PATTERN.exec(String(turn.content || ''));
    if (!match) continue;
    const [, toolName, body] = match;

    let args;
    try {
      args = JSON.parse(body);
    } catch {
      continue;
    }
    if (!args || typeof args !== 'object') continue;

    if (WRITE_TOOL_PATTERN.test(toolName)) {
      for (const key of FILE_KEYS) {
        const value = args[key];
        if (typeof value === 'string' && looksLikePath(value)) filesWritten.push(value);
      }
    }

    for (const key of COMMAND_KEYS) {
      const value = args[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      const command = clip(collapseWhitespace(value), 200);
      // Consecutive repeats of the same command carry no extra information.
      if (commands[commands.length - 1] !== command) commands.push(command);
    }
  }

  return { filesWritten, commands };
}

function looksLikePath(value) {
  if (value.length > 400) return false;
  return /[\\/]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value);
}

function rankByFrequency(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
}

function collapseWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function clip(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).replace(/\s+$/, '')}\n... [Context Bridge clipped ${text.length - maxChars} chars] ...`;
}

function last(items) {
  return items.length > 0 ? items[items.length - 1] : undefined;
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
