const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const PROVIDERS = new Set(['claude', 'codex']);
const MARKER = 'TURNTRAIL_MANAGED_TERMINAL';
// Managed prompts are short pointers to local handoff files. Keeping the bound
// below Windows' process command-line ceiling leaves room for executable and
// resume arguments as well as the prompt itself.
const MAX_PROMPT_CHARS = 16 * 1024;

class ManagedTerminalStore {
  constructor(options = {}) {
    this.window = options.window || vscode.window;
    this.resolveLaunch = options.resolveLaunch || resolveProviderLaunch;
    this.platform = options.platform || process.platform;
    this.records = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  start(context) {
    for (const terminal of this.window.terminals || []) this.attach(terminal);
    context.subscriptions.push(
      this.window.onDidOpenTerminal((terminal) => this.attach(terminal)),
      this.window.onDidCloseTerminal((terminal) => this.detach(terminal)),
      this.emitter
    );
  }

  async launch(input) {
    const provider = validateProvider(input?.provider);
    const root = validateRoot(input?.root);
    const sessionId = optionalIdentifier(input?.sessionId, 512, 'session id');
    const prompt = optionalText(input?.prompt, MAX_PROMPT_CHARS, 'handoff prompt');
    const title = displayText(input?.title, 160) || (sessionId ? `Session ${sessionId.slice(0, 8)}` : 'New session');
    const args = managedTerminalArgs(provider, { sessionId, prompt });
    const launch = await this.resolveLaunch(provider, args, { platform: this.platform });
    const id = crypto.randomUUID();
    const env = {
      [MARKER]: '1',
      TURNTRAIL_MANAGED_ID: id,
      TURNTRAIL_MANAGED_PROVIDER: provider,
      TURNTRAIL_MANAGED_ROOT: root,
      TURNTRAIL_MANAGED_SESSION_ID: sessionId || '',
      TURNTRAIL_MANAGED_TITLE: title
    };
    const terminal = this.window.createTerminal({
      name: `Turntrail · ${provider === 'claude' ? 'Claude' : 'Codex'} · ${title}`,
      cwd: root,
      shellPath: launch.command,
      shellArgs: launch.args,
      env,
      isTransient: false
    });
    const record = { id, provider, root, sessionId, title, terminal, createdAt: new Date().toISOString() };
    this.records.set(id, record);
    terminal.show(false);
    this.fire();
    return record;
  }

  attach(terminal) {
    const env = terminal?.creationOptions?.env;
    if (!env || env[MARKER] !== '1') return undefined;
    const id = safeId(env.TURNTRAIL_MANAGED_ID);
    const provider = safeProvider(env.TURNTRAIL_MANAGED_PROVIDER);
    const root = safeRoot(env.TURNTRAIL_MANAGED_ROOT);
    if (
      !id ||
      !provider ||
      !root ||
      terminal.exitStatus !== undefined ||
      !matchesProviderLaunch(terminal.creationOptions, provider)
    ) return undefined;
    let sessionId;
    try {
      sessionId = optionalIdentifier(env.TURNTRAIL_MANAGED_SESSION_ID, 512, 'session id');
    } catch {
      return undefined;
    }
    const record = {
      id,
      provider,
      root,
      sessionId,
      title: displayText(env.TURNTRAIL_MANAGED_TITLE, 160) || 'Managed session',
      terminal,
      createdAt: new Date().toISOString()
    };
    this.records.set(id, record);
    this.fire();
    return record;
  }

  detach(terminal) {
    for (const [id, record] of this.records) {
      if (record.terminal === terminal) this.records.delete(id);
    }
    this.fire();
  }

  get(id) {
    return this.records.get(String(id || ''));
  }

  list(provider, root) {
    const normalizedRoot = root ? normalizedPath(root, this.platform) : undefined;
    return [...this.records.values()].filter((record) => {
      if (record.terminal.exitStatus !== undefined) return false;
      if (provider && record.provider !== provider) return false;
      return !normalizedRoot || normalizedPath(record.root, this.platform) === normalizedRoot;
    });
  }

  viewModel(root) {
    return this.list(undefined, root).map((record) => ({
      id: record.id,
      provider: record.provider,
      sessionId: record.sessionId,
      title: record.title,
      createdAt: record.createdAt
    }));
  }

  focus(id) {
    const record = this.requireLive(id);
    record.terminal.show(false);
    return record;
  }

  close(id) {
    const record = this.get(id);
    if (!record) throw new Error('That managed terminal is no longer available.');
    record.terminal.dispose();
    this.records.delete(record.id);
    this.fire();
  }

  inject(id, prompt) {
    const record = this.requireLive(id);
    const text = optionalText(prompt, MAX_PROMPT_CHARS, 'handoff prompt');
    if (!text) throw new Error('Cannot inject an empty handoff prompt.');
    record.terminal.show(false);
    record.terminal.sendText(text, true);
    return record;
  }

  requireLive(id) {
    const record = this.get(id);
    if (!record) throw new Error('That managed terminal is no longer available.');
    if (record.terminal.exitStatus !== undefined) {
      this.records.delete(record.id);
      this.fire();
      throw new Error('That managed agent has exited. Open or resume it before injecting a handoff.');
    }
    return record;
  }

  fire() {
    this.emitter.fire();
  }
}

function managedTerminalArgs(provider, options = {}) {
  const normalized = validateProvider(provider);
  const sessionId = optionalIdentifier(options.sessionId, 512, 'session id');
  const prompt = optionalText(options.prompt, MAX_PROMPT_CHARS, 'handoff prompt');
  const args = sessionId
    ? normalized === 'claude' ? ['--resume', sessionId] : ['resume', sessionId]
    : [];
  if (prompt) args.push(prompt);
  return args;
}

async function resolveProviderLaunch(provider, args, options = {}) {
  const command = validateProvider(provider);
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const candidates = options.candidates || await windowsCandidates(command, options);
    const exists = options.existsSync || fs.existsSync;
    for (const candidate of candidates) {
      if (/\.(?:exe|com)$/i.test(candidate)) return { command: candidate, args: [...args] };
      if (/\.ps1$/i.test(candidate)) {
        return powerShellLaunch(candidate, args, options);
      }
      if (/\.(?:cmd|bat)$/i.test(candidate)) {
        const script = candidate.replace(/\.(?:cmd|bat)$/i, '.ps1');
        if (exists(script)) return powerShellLaunch(script, args, options);
        throw new Error(`Cannot safely launch Windows command shim ${candidate}: no sibling PowerShell shim was found.`);
      }
    }
    throw new Error(`Could not safely locate the ${command} executable. Install its CLI and ensure it is on PATH.`);
  }

  const executable = options.executable || await findOnPath(command, options);
  if (!executable) throw new Error(`Could not find ${command} on PATH.`);
  return { command: executable, args: [...args] };
}

function powerShellLaunch(script, args, options) {
  return {
    command: options.powerShell || 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args]
  };
}

function matchesProviderLaunch(options, provider) {
  const executable = path.basename(String(options?.shellPath || '')).toLowerCase();
  if (executable === `${provider}.exe` || executable === `${provider}.com`) return true;
  if (!/^(?:powershell|powershell\.exe|pwsh|pwsh\.exe)$/.test(executable)) return false;
  const args = Array.isArray(options?.shellArgs) ? options.shellArgs : [];
  const file = args.findIndex((item) => String(item).toLowerCase() === '-file');
  return file >= 0 && path.basename(String(args[file + 1] || '')).toLowerCase() === `${provider}.ps1`;
}

async function windowsCandidates(command, options = {}) {
  if (options.candidates) return options.candidates;
  return new Promise((resolve, reject) => {
    const child = (options.spawn || spawn)(options.whereCommand || 'where.exe', [command], {
      shell: false,
      windowsHide: true
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-64 * 1024); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return resolve([]);
      resolve(output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
    });
  });
}

async function findOnPath(command, options = {}) {
  const pathValue = options.pathValue === undefined ? process.env.PATH : options.pathValue;
  for (const directory of String(pathValue || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return undefined;
}

function validateProvider(value) {
  const provider = safeProvider(value);
  if (!provider) throw new Error('Managed terminals support only Claude and Codex.');
  return provider;
}

function safeProvider(value) {
  const provider = String(value || '').toLowerCase();
  return PROVIDERS.has(provider) ? provider : undefined;
}

function validateRoot(value) {
  const root = safeRoot(value);
  if (!root) throw new Error('A valid absolute workspace path is required.');
  return root;
}

function safeRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) return undefined;
  return path.resolve(value);
}

function safeId(value) {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value) ? value : undefined;
}

function optionalText(value, maxLength, label) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  if (value.length > maxLength) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} is too long.`);
  return value;
}

function optionalIdentifier(value, maxLength, label) {
  const text = optionalText(value, maxLength, label);
  if (text && /[\x00-\x1f\x7f]/.test(text)) throw new Error(`Invalid ${label}.`);
  return text;
}

function displayText(value, maxLength) {
  if (value === undefined || value === null) return undefined;
  const text = String(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizedPath(value, platform = process.platform) {
  const resolved = path.resolve(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = {
  MARKER,
  ManagedTerminalStore,
  matchesProviderLaunch,
  managedTerminalArgs,
  resolveProviderLaunch
};
