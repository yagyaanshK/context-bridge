import path from 'node:path';
import { createTurn } from '../schema.js';
import { writeSession } from '../store.js';
import { homePath, listJsonlFiles, pathsSameOrNested, readFirstJsonlObjects, readJsonlObjects } from './common.js';

export const CODEX_PROVIDER = 'openai';

export async function discoverCodexSessions(options = {}) {
  const root = options.root || process.cwd();
  const sessionsDir = options.sessionsDir || homePath('.codex', 'sessions');
  const archivedDir = options.archivedDir || homePath('.codex', 'archived_sessions');
  const files = [
    ...(await listJsonlFiles(sessionsDir)),
    ...(options.includeArchived ? await listJsonlFiles(archivedDir) : [])
  ].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sessions = [];

  for (const file of files.slice(0, options.limit || 300)) {
    const meta = await inspectCodexFile(file.path);
    const matchesProject = meta.cwd ? pathsSameOrNested(meta.cwd, root) || pathsSameOrNested(root, meta.cwd) : false;
    if (!options.all && !matchesProject) continue;
    sessions.push({
      provider: CODEX_PROVIDER,
      surface: meta.source || 'cli',
      path: file.path,
      sessionId: meta.sessionId || sessionIdFromCodexPath(file.path),
      cwd: meta.cwd,
      title: meta.preview,
      modifiedAt: file.modifiedAt,
      mtimeMs: file.mtimeMs,
      size: file.size,
      matchesProject
    });
  }

  return sessions;
}

export async function importCodexSession(root, session) {
  const turns = [];
  await readJsonlObjects(session.path, (event, lineNumber) => {
    const turn = codexEventToTurn(event, session, lineNumber);
    if (turn) turns.push(turn);
  });
  if (turns.length === 0) throw new Error(`No importable Codex turns found in ${session.path}`);
  return writeSession(root, turns, {
    provider: CODEX_PROVIDER,
    surface: session.surface || 'cli',
    sessionId: `native-codex-${session.sessionId}`,
    sourcePath: session.path
  });
}

export function codexEventToTurn(event, session, lineNumber) {
  const mapped = codexEventContent(event);
  if (!mapped || !mapped.content.trim()) return null;

  return createTurn(
    {
      role: mapped.role,
      timestamp: event.timestamp || event.payload?.timestamp,
      content: mapped.content,
      metadata: {
        nativeProvider: 'codex',
        nativeType: event.type,
        nativePayloadType: event.payload?.type,
        nativeSessionId: session.sessionId,
        nativePath: session.path,
        lineNumber,
        cwd: event.payload?.cwd || session.cwd,
        ...(mapped.media ? { media: mapped.media } : {})
      }
    },
    {
      provider: CODEX_PROVIDER,
      surface: session.surface || 'cli',
      sessionId: `native-codex-${session.sessionId}`
    }
  );
}

function codexEventContent(event) {
  const payload = event.payload || {};

  if (event.type === 'event_msg' && payload.type === 'user_message') {
    return codexUserMessage(payload);
  }

  if (event.type === 'event_msg' && payload.type === 'agent_message') {
    return { role: 'assistant', content: contentToText(payload.message || payload) };
  }

  if (event.type === 'event_msg' && payload.type === 'task_complete' && payload.last_agent_message) {
    return { role: 'assistant', content: contentToText(payload.last_agent_message) };
  }

  if (event.type === 'response_item' && payload.type === 'message') {
    return { role: payload.role || 'assistant', content: contentToText(payload.content) };
  }

  if (event.type === 'response_item' && payload.type === 'function_call') {
    return { role: 'tool', content: `Tool call: ${payload.name}\n${contentToText(payload.arguments)}` };
  }

  if (event.type === 'response_item' && payload.type === 'function_call_output') {
    return { role: 'tool', content: contentToText(payload.output || payload.content || payload) };
  }

  if (event.type === 'turn_context') {
    return { role: 'system', content: `Turn context:\n${JSON.stringify(payload, null, 2)}` };
  }

  if (event.type === 'parse_error') {
    return { role: 'system', content: `Parse error: ${event.error}\n${event.rawLine}` };
  }

  return null;
}

function codexUserMessage(payload) {
  const media = mediaFromPayload(payload);
  const parts = [];
  const messageText = contentToText(payload.message || payload.text_elements || '');
  if (messageText.trim()) parts.push(messageText);
  if (media.localImages.length > 0) {
    parts.push([
      'Attached local images:',
      ...media.localImages.map((item) => `- ${item}`)
    ].join('\n'));
  }
  if (media.inlineImageCount > 0) {
    parts.push(`Inline image payloads omitted from imported text: ${media.inlineImageCount}`);
  }
  const content = parts.join('\n\n');
  return {
    role: 'user',
    content,
    media
  };
}

function mediaFromPayload(payload) {
  const localImages = [];
  const localFiles = [];
  let inlineImageCount = 0;

  for (const item of payload.local_images || payload.localImages || []) {
    const text = mediaItemPath(item);
    if (text) localImages.push(text);
  }

  for (const item of payload.local_files || payload.localFiles || []) {
    const text = mediaItemPath(item);
    if (text) localFiles.push(text);
  }

  for (const item of payload.images || []) {
    const text = mediaItemPath(item);
    if (text) localImages.push(text);
    else inlineImageCount++;
  }

  return {
    localImages: [...new Set(localImages)],
    localFiles: [...new Set(localFiles)],
    inlineImageCount
  };
}

function mediaItemPath(item) {
  if (typeof item === 'string') {
    if (/^data:image\//i.test(item)) return '';
    return item;
  }
  if (!item || typeof item !== 'object') return '';
  return item.path || item.filePath || item.localPath || item.uri || item.url || '';
}

function contentToText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(contentToText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return contentToText(value.content);
    if (value.type && value.text) return String(value.text);
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

async function inspectCodexFile(filePath) {
  const objects = await readFirstJsonlObjects(filePath, 40);
  let sessionId;
  let cwd;
  let source;
  let preview;

  for (const event of objects) {
    if (event.type === 'session_meta') {
      sessionId ||= event.payload?.id;
      cwd ||= event.payload?.cwd;
      source ||= event.payload?.source;
    }
    if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
      preview ||= contentToText(event.payload.message).slice(0, 120);
    }
    if (sessionId && cwd && preview) break;
  }

  return {
    sessionId,
    cwd,
    source,
    preview
  };
}

function sessionIdFromCodexPath(filePath) {
  const base = path.basename(filePath, '.jsonl');
  return base.replace(/^rollout-/, '');
}
