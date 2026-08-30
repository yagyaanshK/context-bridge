import path from 'node:path';
import {
  activateCodexAccount,
  captureSnapshot,
  codexHome,
  createAccount,
  discoverNativeSessions,
  exportHandoff,
  getCodexUsage,
  headlineRemaining,
  importCodexAuth,
  importNativeSession,
  importTranscript,
  initStore,
  isSignedIn,
  listAccounts,
  normalizeNativeProvider,
  readManifest,
  removeAccount,
  defaultCodexHome
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
  context-bridge export --to <target> [--max-chars <n>] [--no-dedupe] [--since-last-export]
                        [--tool-max-chars <n>] [--system-max-chars <n>] [--cwd <path>]
  context-bridge status [--cwd <path>]
  context-bridge accounts [--provider codex] [--refresh]
  context-bridge account add <label> [--import]
  context-bridge account use <id>
  context-bridge account remove <id> [--purge]

Account options:
  --import                Adopt the login already in the default CODEX_HOME
                          instead of signing in fresh.
  --refresh               Force a quota read instead of using the cache.
  --use <id>              Print the shell export needed to run codex as an
                          account without changing the machine default.
  --purge                 Delete the managed credential and the live default
                          login when this account is active.

Export options:
  --max-chars <n>         Character budget for the transcript (default 120000, 0 = off).
                          Receiving agents refuse or silently truncate oversized
                          handoffs, so the budget is on by default.
  --no-dedupe             Keep consecutive duplicate turns instead of collapsing them.
  --since-last-export     Send only what the target has not seen: its own last turn,
                          or the last handoff aimed at it, whichever is later.
                          Off by default: a new agent session has no memory of
                          what an earlier handoff already delivered.
  --tool-max-chars <n>    Truncate tool-output turns over n chars (default 2000, 0 = off).
  --system-max-chars <n>  Truncate system turns over n chars (default 800, 0 = off).
  --snapshot-diff-max-chars <n>
                          How much uncommitted diff to embed (default 4000, 0 = off).
  --keep-exports <n>      Past handoff files to keep (default 10, 0 = keep all).
  --no-summary            Omit the extractive "Where This Left Off" section.

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
      maxChars: flags.maxChars !== undefined ? Number(flags.maxChars) : undefined,
      dedupe: flags['no-dedupe'] ? false : undefined,
      sinceLastExport: Boolean(flags.sinceLastExport),
      toolMaxChars: flags.toolMaxChars !== undefined ? Number(flags.toolMaxChars) : undefined,
      systemMaxChars: flags.systemMaxChars !== undefined ? Number(flags.systemMaxChars) : undefined,
      snapshotDiffMaxChars:
        flags.snapshotDiffMaxChars !== undefined ? Number(flags.snapshotDiffMaxChars) : undefined,
      keepExports: flags.keepExports !== undefined ? Number(flags.keepExports) : undefined,
      summary: flags['no-summary'] ? false : undefined
    });
    io.stdout.write(`Wrote handoff to ${result.relativePath}\n`);
    return;
  }

  if (command === 'status') {
    const manifest = await readManifest(cwd);
    io.stdout.write(renderStatus(manifest));
    return;
  }

  if (command === 'accounts') {
    const accounts = await listAccounts({ provider: flags.provider || 'codex' });
    if (accounts.length === 0) {
      io.stdout.write('No accounts yet. Add one with `context-bridge account add <label>`.\n');
      return;
    }
    const rows = [];
    for (const account of accounts) {
      const usage = await getCodexUsage(account.id, { force: Boolean(flags.refresh), offline: !flags.refresh });
      rows.push(renderAccountRow(account, usage, await isSignedIn(account.id)));
    }
    io.stdout.write(`Accounts:\n\n${rows.join('\n')}\n`);
    return;
  }

  if (command === 'account') {
    const action = args[0];

    if (action === 'add') {
      const label = args.slice(1).join(' ').trim();
      if (!label) throw new Error('account add requires a label');
      const account = await createAccount({ label, provider: 'codex' });
      if (flags.import) {
        const auth = await importCodexAuth(account.id, defaultCodexHome());
        io.stdout.write(`Added ${account.id} (${auth?.claims?.email || label}) from ${defaultCodexHome()}\n`);
      } else {
        io.stdout.write(
          `Added ${account.id}. Sign in with:\n\n  CODEX_HOME="${codexHome(account.id)}" codex login\n`
        );
      }
      return;
    }

    if (action === 'use') {
      const id = args[1];
      if (!id) throw new Error('account use requires an account id');
      const result = await activateCodexAccount(id);
      io.stdout.write(
        `Default Codex account is now ${id}.\nWrote ${result.target}` +
          (result.backup ? `\nPrevious login backed up to ${result.backup}\n` : '\n')
      );
      return;
    }

    if (action === 'remove') {
      const id = args[1];
      if (!id) throw new Error('account remove requires an account id');
      const result = await removeAccount(id, { purge: Boolean(flags.purge) });
      io.stdout.write(
        `Removed ${id}${result.purged ? ' and deleted its credentials' : ' (credentials kept on disk)'}` +
          (result.livePurged ? ', including the active default login' : '') +
          '\n'
      );
      return;
    }

    throw new Error(`unknown account action: ${action || '(none)'}`);
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
        setFlag(flags, key, true);
      } else {
        setFlag(flags, key, next);
        i++;
      }
    } else {
      args.push(token);
    }
  }

  return { command, args, flags };
}

// Store each flag under its raw (kebab-case) key and a camelCase alias so that
// `--max-chars` and `--maxChars` are equivalent.
function setFlag(flags, key, value) {
  flags[key] = value;
  const camel = key.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
  if (camel !== key) flags[camel] = value;
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

function renderAccountRow(account, usage, signedIn) {
  const remaining = usage ? headlineRemaining(usage) : undefined;
  const state =
    !signedIn || usage?.error === 'not-signed-in'
      ? 'not signed in'
      : usage?.error
        ? `unavailable (${usage.error})`
        : remaining === undefined
          ? 'quota not read (use --refresh)'
          : `${remaining}% left`;

  const detail = (usage?.windows || [])
    .map((window) => `${window.label} ${window.remainingPercent}%`)
    .join(', ');

  return [
    `  ${account.id}`,
    `    ${account.label}${account.email ? ` <${account.email}>` : ''}`,
    `    ${state}${detail ? ` — ${detail}` : ''}`,
    `    ${codexHome(account.id)}`
  ].join('\n');
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
