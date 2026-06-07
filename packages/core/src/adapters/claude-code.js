import path from 'node:path';
import { createTurn } from '../schema.js';
import { writeSession } from '../store.js';
import { homePath, listJsonlFiles, pathsSameOrNested, readFirstJsonlObjects, readJsonlObjects } from './common.js';

export const CLAUDE_PROVIDER = 'anthropic';

export async function discoverClaudeSessions(options = {}) {
  const root = options.root || process.cwd();
  const projectsDir = options.projectsDir || homePath('.claude', 'projects');
  const files = await listJsonlFiles(projectsDir);
  const sessions = [];

  for (const file of files.slice(0, options.limit || 200)) {
    const meta = await inspectClaudeFile(file.path);
    const matchesProject = meta.cwd ? pathsSameOrNested(meta.cwd, root) || pathsSameOrNested(root, meta.cwd) : false;
    if (!options.all && !matchesProject) continue;
    sessions.push({
      provider: CLAUDE_PROVIDER,
      surface: 'cli',
      path: file.path,
      sessionId: meta.sessionId || path.basename(file.path, '.jsonl'),
      cwd: meta.cwd,
      title: meta.title,
      modifiedAt: file.modifiedAt,
      mtimeMs: file.mtimeMs,
      size: file.size,
      matchesProject
    });
  }

  return sessions;
}

export async function importClaudeSession(root, session) {
  const turns = [];
  await readJsonlObjects(session.path, (event, lineNumber) => {
    const turn = claudeEventToTurn(event, session, lineNumber);
    if (turn) turns.push(turn);
  });
  if (turns.length === 0) throw new Error(`No importable Claude turns found in ${session.path}`);
  return writeSession(root, turns, {
    provider: CLAUDE_PROVIDER,
    surface: 'cli',
    sessionId: `native-claude-${session.sessionId}`,
    sourcePath: session.path
  });
}

export function claudeEventToTurn(event, session, lineNumber) {
  const role = event.message?.role || event.type;
  const content = claudeContent(event);
  if (!content.trim()) return null;

  return createTurn(
    {
      id: event.uuid,
      role,
      timestamp: event.timestamp,
      content,
      metadata: {
        nativeProvider: 'claude-code',
        nativeType: event.type,
        nativeSessionId: event.sessionId || session.sessionId,
        nativePath: session.path,
        lineNumber,
        cwd: event.cwd || session.cwd
      }
    },
    {
      provider: CLAUDE_PROVIDER,
      surface: 'cli',
      sessionId: `native-claude-${session.sessionId}`
    }
  );
}

function claudeContent(event) {
  if (event.message?.content !== undefined) return contentBlocksToText(event.message.content);
  if (event.toolUseResult !== undefined) return contentBlocksToText(event.toolUseResult);
  if (event.attachment !== undefined) return contentBlocksToText(event.attachment);
  if (event.aiTitle) return `Title: ${event.aiTitle}`;
  if (event.operation) return `Queue operation: ${event.operation}`;
  if (event.type === 'parse_error') return `Parse error: ${event.error}\n${event.rawLine}`;
  return '';
}

function contentBlocksToText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(contentBlocksToText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.name === 'string' && value.input) {
      return `Tool call: ${value.name}\n${JSON.stringify(value.input, null, 2)}`;
    }
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

async function inspectClaudeFile(filePath) {
  const objects = await readFirstJsonlObjects(filePath, 80);
  let cwd;
  let sessionId;
  let title;

  for (const event of objects) {
    cwd ||= event.cwd;
    sessionId ||= event.sessionId;
    title ||= event.aiTitle;
    if (cwd && sessionId && title) break;
  }

  return {
    cwd,
    sessionId: sessionId || path.basename(filePath, '.jsonl'),
    title
  };
}
