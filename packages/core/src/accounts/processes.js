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
  if (Array.isArray(options.agentProcesses)) return options.agentProcesses.map(normalizeProcess);
  if (typeof options.listAgentProcesses === 'function') {
    return (await options.listAgentProcesses()).map(normalizeProcess);
  }

  const platform = options.platform || process.platform;
  const run = options.execFile || execFileAsync;
  try {
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
      'Context Bridge did not change the live credential.'
  );
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
