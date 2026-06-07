import path from 'node:path';
import {
  captureSnapshot,
  discoverNativeSessions,
  exportHandoff,
  importNativeSession,
  importTranscript,
  initStore,
  normalizeNativeProvider,
  readManifest
} from '@context-bridge/core';
import { spawn } from 'node:child_process';

const HELP = `Context Bridge

Usage:
  context-bridge init [--cwd <path>]
  context-bridge import --provider <name> [--surface <name>] <file> [--cwd <path>]
  context-bridge discover --provider claude|codex [--all] [--cwd <path>]
  context-bridge import-native --provider claude|codex [--last|--session <id>] [--all] [--cwd <path>]
  context-bridge run claude|codex [-- <native args>] [--cwd <path>]
  context-bridge snapshot [--cwd <path>]
  context-bridge export --to <target> [--max-chars <n>] [--cwd <path>]
  context-bridge status [--cwd <path>]

Examples:
  context-bridge init
  context-bridge import --provider claude --surface cli ./transcript.jsonl
  context-bridge discover --provider codex
  context-bridge import-native --provider claude --last
  context-bridge run codex -- --approval-mode auto-edit
  context-bridge snapshot
  context-bridge export --to codex --max-chars 60000
`;

export async function runCli(argv, io = process) {
  const { command, args, flags } = parseArgs(argv);
  const cwd = path.resolve(flags.cwd || process.cwd());

  if (!command || flags.help || command === 'help') {
    io.stdout.write(HELP);
    return;
  }

  if (command === 'init') {
    await initStore(cwd);
    io.stdout.write(`Initialized Context Bridge at ${path.join(cwd, '.context-bridge')}\n`);
    return;
  }

  if (command === 'import') {
    const source = args[0];
    if (!source) throw new Error('import requires a transcript file path');
    if (!flags.provider) throw new Error('import requires --provider <name>');
    const result = await importTranscript(cwd, source, {
      provider: flags.provider,
      surface: flags.surface || 'unknown'
    });
    io.stdout.write(`Imported ${result.turnCount} turns into ${result.relativePath}\n`);
    return;
  }

  if (command === 'discover') {
    if (!flags.provider) throw new Error('discover requires --provider claude|codex');
    const sessions = await discoverNativeSessions(flags.provider, {
      root: cwd,
      all: Boolean(flags.all),
      includeArchived: Boolean(flags.includeArchived)
    });
    io.stdout.write(renderSessions(sessions));
    return;
  }

  if (command === 'import-native') {
    if (!flags.provider) throw new Error('import-native requires --provider claude|codex');
    const result = await importNativeSession(cwd, flags.provider, {
      root: cwd,
      all: Boolean(flags.all),
      last: Boolean(flags.last) || !flags.session,
      sessionId: flags.session,
      includeArchived: Boolean(flags.includeArchived)
    });
    io.stdout.write(`Imported native session into ${result.relativePath} (${result.turnCount} turns)\n`);
    return;
  }

  if (command === 'run') {
    const provider = args[0];
    if (!provider) throw new Error('run requires claude or codex');
    const result = await runNativeCli(cwd, provider, flags._ || args.slice(1), io);
    if (result.imported) {
      io.stdout.write(`Imported native session into ${result.imported.relativePath} (${result.imported.turnCount} turns)\n`);
    } else {
      io.stdout.write('No changed native transcript was detected after the run.\n');
    }
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  if (command === 'snapshot') {
    const result = await captureSnapshot(cwd);
    io.stdout.write(`Captured snapshot at ${result.relativePath}\n`);
    return;
  }

  if (command === 'export') {
    if (!flags.to) throw new Error('export requires --to <target>');
    const result = await exportHandoff(cwd, {
      target: flags.to,
      maxChars: flags.maxChars ? Number(flags.maxChars) : undefined
    });
    io.stdout.write(`Wrote handoff to ${result.relativePath}\n`);
    return;
  }

  if (command === 'status') {
    const manifest = await readManifest(cwd);
    io.stdout.write(renderStatus(manifest));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

export function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    return { command: 'help', args: [], flags: { help: true } };
  }

  const [command, ...rest] = argv;
  const args = [];
  const flags = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }
    if (token === '--') {
      flags._ = rest.slice(i + 1);
      break;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      args.push(token);
    }
  }

  return { command, args, flags };
}

export async function runNativeCli(cwd, provider, nativeArgs = [], io = process) {
  const normalized = normalizeNativeProvider(provider);
  const executable = normalized === 'claude' ? 'claude' : normalized === 'codex' ? 'codex' : provider;
  const startedAt = Date.now();
  const before = await discoverNativeSessions(normalized, {
    root: cwd,
    all: true,
    includeArchived: true,
    limit: 10000
  });
  const beforeByPath = new Map(before.map((session) => [session.path, session.mtimeMs]));

  const exitCode = await spawnInteractive(executable, nativeArgs, cwd);

  const after = await discoverNativeSessions(normalized, {
    root: cwd,
    all: true,
    includeArchived: true,
    limit: 10000
  });
  const changed = after
    .filter((session) => {
      const previousMtime = beforeByPath.get(session.path);
      return (previousMtime === undefined || session.mtimeMs > previousMtime) && session.mtimeMs >= startedAt - 2000;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const session = changed.find((item) => item.matchesProject) || changed[0];
  if (!session) return { exitCode, imported: null };

  const imported = await importNativeSession(cwd, normalized, {
    path: session.path,
    includeArchived: true
  });
  await captureSnapshot(cwd);
  io.stdout.write(`Detected changed native transcript: ${session.path}\n`);
  return { exitCode, imported };
}

function spawnInteractive(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

function renderSessions(sessions) {
  if (sessions.length === 0) return 'No native sessions found for this project.\n';
  const lines = ['Native sessions:', ''];
  for (const session of sessions) {
    lines.push([
      session.sessionId,
      session.provider,
      session.surface,
      session.matchesProject ? 'project' : 'all',
      session.modifiedAt,
      session.cwd || '(no cwd)',
      session.path
    ].join(' | '));
  }
  lines.push('');
  return lines.join('\n');
}

function renderStatus(manifest) {
  return [
    'Context Bridge status',
    '',
    `Project root: ${manifest.projectRoot}`,
    `Schema version: ${manifest.schemaVersion}`,
    `Sessions: ${(manifest.sessions || []).length}`,
    `Snapshots: ${(manifest.snapshots || []).length}`,
    `Exports: ${(manifest.exports || []).length}`,
    ''
  ].join('\n');
}
