import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WINDOWS_POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

export async function listAgentProcesses(options = {}) {
  try {
    if (Array.isArray(options.agentProcesses)) return options.agentProcesses.map(normalizeProcess);
    if (typeof options.listAgentProcesses === 'function') {
      return (await options.listAgentProcesses()).map(normalizeProcess);
    }

    const platform = options.platform || process.platform;
    const run = options.execFile || execFileAsync;
    if (platform === 'win32') return await listWindowsProcesses(run);
    if (platform === 'linux' || platform === 'darwin') return await listPosixProcesses(run);
    throw new Error(`unsupported platform ${platform}`);
  } catch (error) {
    throw new Error(`Could not inspect running agent processes: ${error.message}`);
  }
}

export function matchingAgentProcesses(provider, processes) {
  const normalized = provider === 'claude' ? 'claude' : provider === 'codex' ? 'codex' : undefined;
  if (!normalized) throw new Error(`Unsupported agent provider: ${provider}`);
  return (processes || []).map(normalizeProcess).filter((item) => processMatches(normalized, item));
}

export function classifyAgentProcesses(provider, processes) {
  const all = (processes || []).map(normalizeProcess);
  const matches = matchingAgentProcesses(provider, all);
  return matches.map((item) => {
    const editor = agentEditorOwner(provider, item, all);
    return {
      ...item,
      kind: editor ? 'ide-background' : 'interactive',
      editor
    };
  });
}

export async function assertAgentStopped(provider, options = {}) {
  const matches = matchingAgentProcesses(provider, await listAgentProcesses(options));
  if (matches.length === 0) return;

  const label = provider === 'claude' ? 'Claude' : 'Codex';
  const details = matches
    .slice(0, 3)
    .map((item) => `${item.name || 'process'}${item.pid ? ` (PID ${item.pid})` : ''}`)
    .join(', ');
  const extra = matches.length > 3 ? ` and ${matches.length - 3} more` : '';
  throw new Error(
    `${label} is still running: ${details}${extra}. ` +
      `Close its CLI processes and close or reload IDE windows hosting the ${label} extension, then retry. ` +
      'Turntrail did not change the live credential.'
  );
}

// Stop only processes that still match the provider at execution time. The
// caller must obtain explicit user confirmation before invoking this: an
// interactive agent may have work in progress. A short graceful interval lets
// POSIX clients flush state; Windows maps these signals to process termination.
export async function terminateAgentProcesses(provider, options = {}) {
  const terminate = options.killProcess || process.kill.bind(process);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const gracefulMs = boundedDuration(options.gracefulMs, 750, 0, 10_000);
  const timeoutMs = boundedDuration(options.timeoutMs, 5_000, 250, 30_000);
  const pollMs = boundedDuration(options.pollMs, 100, 1, 1_000);
  const platform = options.platform || process.platform;
  const deadline = now() + timeoutMs;
  const firstSeenAt = new Map();
  const terminated = new Map();
  let remaining = [];

  while (now() < deadline) {
    remaining = matchingAgentProcesses(provider, await listAgentProcesses(options));
    if (remaining.length === 0) return { terminated: [...terminated.values()], remaining: [] };

    for (const item of remaining) {
      if (!item.pid) continue;
      const seenAt = firstSeenAt.get(item.pid);
      const force = platform === 'win32' ||
        (seenAt !== undefined && now() - seenAt >= gracefulMs);
      if (seenAt === undefined) firstSeenAt.set(item.pid, now());
      try {
        terminate(item.pid, force ? 'SIGKILL' : 'SIGTERM');
        terminated.set(item.pid, item);
      } catch (error) {
        // ESRCH means it exited between enumeration and termination, which is
        // the outcome we wanted. Permission failures must remain visible.
        if (error?.code !== 'ESRCH') throw new Error(`Could not stop ${item.name || `PID ${item.pid}`}: ${error.message}`);
      }
    }
    await sleep(pollMs);
  }

  remaining = matchingAgentProcesses(provider, await listAgentProcesses(options));
  return { terminated: [...terminated.values()], remaining };
}

async function listWindowsProcesses(run) {
  const script =
    'Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ' +
    'ConvertTo-Json -Compress';
  const { stdout } = await run(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  const text = String(stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) =>
    normalizeProcess({
      pid: item.ProcessId,
      parentPid: item.ParentProcessId,
      name: item.Name,
      executablePath: item.ExecutablePath,
      commandLine: item.CommandLine
    })
  );
}

async function listPosixProcesses(run) {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,comm=,args='], {
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024
  });
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/))
    .filter(Boolean)
    .map((match) =>
      normalizeProcess({ pid: match[1], parentPid: match[2], name: match[3], commandLine: match[4] })
    );
}

function processMatches(provider, item) {
  const name = path.basename(String(item.name || item.executablePath || '')).toLowerCase();
  if (provider === 'codex' && /^codex(?:-code-mode-host)?(?:\.exe)?$/.test(name)) return true;
  if (provider === 'claude' && /^claude(?:\.exe)?$/.test(name)) return true;

  const command = String(item.commandLine || '').toLowerCase().replaceAll('\\', '/');
  if (provider === 'codex') {
    return /(?:^|\s|["'])[^\s"']*@openai\/codex(?:\/|\s|["']|$)/.test(command);
  }
  return /(?:^|\s|["'])[^\s"']*@anthropic-ai\/claude-code(?:\/|\s|["']|$)/.test(command);
}

function agentEditorOwner(provider, item, processes) {
  if (provider === 'codex') return codexEditorOwner(item, processes);
  if (provider === 'claude') return claudeEditorOwner(item, processes);
  return undefined;
}

function codexEditorOwner(item, processes) {
  const name = processName(item);
  if (name === 'codex-code-mode-host') {
    const parent = processes.find((candidate) => candidate.pid === item.parentPid);
    return parent ? codexEditorOwner(parent, processes) : undefined;
  }
  if (name !== 'codex' || !/(?:^|\s)app-server(?:\s|$)/i.test(item.commandLine)) return undefined;

  const executable = String(item.executablePath || '').toLowerCase().replaceAll('\\', '/');
  if (!/\/extensions\/openai\.chatgpt-[^/]+\/bin\//.test(executable)) return undefined;

  const byPid = new Map(processes.filter((candidate) => candidate.pid).map((candidate) => [candidate.pid, candidate]));
  let ancestor = byPid.get(item.parentPid);
  for (let depth = 0; ancestor && depth < 8; depth++) {
    const editor = editorLabel(ancestor);
    if (editor) return editor;
    ancestor = byPid.get(ancestor.parentPid);
  }
  return undefined;
}

function claudeEditorOwner(item, processes) {
  if (processName(item) !== 'claude') return undefined;
  const executable = String(item.executablePath || '').toLowerCase().replaceAll('\\', '/');
  if (!/\/extensions\/anthropic\.claude-code-[^/]+\//.test(executable)) return undefined;
  return ancestorEditorOwner(item, processes);
}

function ancestorEditorOwner(item, processes) {
  const byPid = new Map(processes.filter((candidate) => candidate.pid).map((candidate) => [candidate.pid, candidate]));
  let ancestor = byPid.get(item.parentPid);
  for (let depth = 0; ancestor && depth < 8; depth++) {
    const editor = editorLabel(ancestor);
    if (editor) return editor;
    ancestor = byPid.get(ancestor.parentPid);
  }
  return undefined;
}

function editorLabel(item) {
  switch (processName(item)) {
    case 'code':
      return 'VS Code';
    case 'cursor':
      return 'Cursor';
    case 'windsurf':
      return 'Windsurf';
    case 'antigravity':
      return 'Google Antigravity';
    case 'kiro':
      return 'Kiro';
    case 'codium':
    case 'vscodium':
      return 'VSCodium';
    default:
      return undefined;
  }
}

function processName(item) {
  return path.basename(String(item.name || item.executablePath || '')).toLowerCase().replace(/\.exe$/, '');
}

function normalizeProcess(item = {}) {
  return {
    pid: numberOrUndefined(item.pid),
    parentPid: numberOrUndefined(item.parentPid),
    name: String(item.name || ''),
    executablePath: String(item.executablePath || ''),
    commandLine: String(item.commandLine || '')
  };
}

function numberOrUndefined(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedDuration(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}
