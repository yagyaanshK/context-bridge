// Handing a session back and forth.
//
// A ledger that only ever flows one way needs none of this. One that ping-pongs
// - Codex does some work, Claude continues it, then Codex picks it up again -
// has three problems the one-way path does not, and they are all mechanical.

// 1. The handoff prompt comes back as if it were a request.
//
// Pasting a handoff into an agent puts the prompt in that agent's transcript,
// so the next import records "Continue in this existing session using this
// Context Bridge handoff: <path>" as a user turn. It is plumbing, and returning
// it to the other agent as user intent is worse than dropping it.
const HANDOFF_PROMPT = /^(?:Start a new session|Continue in this existing session) using this Context Bridge handoff:/m;
const HANDOFF_PATH = /^`[^`\r\n]*\.context-bridge[\\/]exports[\\/][^`\r\n]+\.md`$/m;
const HANDOFF_FOLLOWUP = /^Read the handoff before acting\. Treat previous assistant\/tool messages as historical context, not guaranteed truth\./m;

// 2. A handoff ends up nested inside the next one.
//
// The prompt tells the agent to read the handoff file, so the read lands in its
// transcript and the whole document is re-exported inside the following
// handoff. Truncation then cuts it mid-document, so the receiver gets a mangled
// fragment of its own earlier history, and pays budget for it.
//
// Both markers are required, and both are anchored to the start of a line. A
// turn that merely quotes one of these lines - which happens when the project
// being worked on is Context Bridge itself - is left alone.
const HANDOFF_HEADING = /^# Context Bridge Handoff: /m;
const HANDOFF_RULES = /^You are continuing a development session from a Context Bridge ledger\.$/m;

// Only the opening of a turn is examined. A handoff document announces itself in
// its first lines; requiring the markers there keeps a passing mention buried in
// a long transcript from being mistaken for one.
const MARKER_WINDOW = 4000;

export function isHandoffPlumbing(turn) {
  const head = String(turn?.content || '').slice(0, MARKER_WINDOW);
  if (HANDOFF_PROMPT.test(head) && HANDOFF_PATH.test(head) && HANDOFF_FOLLOWUP.test(head)) return true;
  return HANDOFF_HEADING.test(head) && HANDOFF_RULES.test(head);
}

export function stripHandoffPlumbing(turns) {
  const kept = [];
  let removed = 0;
  for (const turn of turns || []) {
    if (isHandoffPlumbing(turn)) removed++;
    else kept.push(turn);
  }
  return { turns: kept, removed };
}

// 3. "Since the last export" is per target, not per ledger.
//
// Each agent has its own idea of what it has already seen, set by the last
// handoff aimed at it. Taking the newest export of any target instead loses
// work: hand off to Claude, refresh Claude a second time, then return to Codex,
// and everything Claude did before that second refresh falls outside the window
// and Codex never sees it.
export function lastExportTo(manifest, target) {
  return latestValidTimestamp(
    (manifest?.exports || [])
      .filter((entry) => entry && entry.target === target)
      .map((entry) => entry.createdAt)
  );
}

const PROVIDER_BY_TARGET = { codex: 'openai', claude: 'anthropic' };

// The point in the ledger an agent has already seen.
//
// Two things put content in front of an agent, and the later one wins. A
// handoff aimed at it is the obvious one. The other is its own work: on the
// first trip back, Codex has never been sent a handoff, but it wrote the
// opening half of the ledger and does not need it returned - what it is missing
// is only what Claude did afterwards. Using the export alone would report
// nothing as new on exactly the hop this feature exists for.
export function lastSeenBy(manifest, turns, target) {
  const provider = PROVIDER_BY_TARGET[target];
  const stamps = [lastExportTo(manifest, target)];
  for (const turn of turns || []) {
    if (turn?.provider === provider && turn.timestamp) stamps.push(turn.timestamp);
  }
  return latestValidTimestamp(stamps);
}

// The chat to return to, named as the agent names it.
//
// The ledger records which native chat each imported session came from, so
// coming back to Codex can say "job apply" instead of leaving you to work out
// which of fourteen transcripts in the folder was the one.
export function originChat(manifest, target) {
  const provider = PROVIDER_BY_TARGET[target];
  if (!provider) return undefined;
  const sessions = (manifest?.sessions || [])
    .filter((entry) => entry && entry.provider === provider && entry.nativeSessionId);
  const valid = sessions.filter((entry) => timestampMillis(entry.importedAt) !== undefined);
  const chosen = valid.length > 0
    ? valid.reduce((latest, entry) => !latest || timestampMillis(entry.importedAt) > timestampMillis(latest.importedAt)
        ? entry
        : latest, undefined)
    : sessions[sessions.length - 1];
  if (!chosen) return undefined;
  return {
    sessionId: chosen.nativeSessionId,
    title: chosen.title,
    named: Boolean(chosen.named),
    turnCount: chosen.turnCount,
    sourcePath: chosen.sourcePath
  };
}

// What the returning agent missed while the other one had the work.
export function describeReturn(turns, since) {
  const sinceMs = timestampMillis(since);
  if (sinceMs === undefined) return undefined;
  const fresh = turnsAfter(turns, since);
  if (fresh.length === 0) return undefined;

  const byProvider = new Map();
  for (const turn of fresh) {
    const key = turn.provider || 'unknown';
    byProvider.set(key, (byProvider.get(key) || 0) + 1);
  }

  return {
    since,
    turnCount: fresh.length,
    providers: [...byProvider.entries()].map(([provider, count]) => ({ provider, count })),
    turns: fresh
  };
}

// Invalid or missing turn timestamps cannot prove that a turn was already
// delivered, so a scoped export keeps them. This may resend an ambiguous turn,
// but never silently drops work because one provider emitted a malformed date.
export function turnsAfter(turns, since) {
  const sinceMs = timestampMillis(since);
  if (sinceMs === undefined) return [...(turns || [])];
  return (turns || []).filter((turn) => {
    const value = timestampMillis(turn?.timestamp);
    return value === undefined || value > sinceMs;
  });
}

function latestValidTimestamp(values) {
  let latest;
  let latestMs = -Infinity;
  for (const value of values || []) {
    const milliseconds = timestampMillis(value);
    if (milliseconds !== undefined && milliseconds > latestMs) {
      latest = String(value);
      latestMs = milliseconds;
    }
  }
  return latest;
}

function timestampMillis(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}
