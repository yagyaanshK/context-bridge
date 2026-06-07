import path from 'node:path';
import {
  captureSnapshot,
  exportHandoff,
  importTranscript,
  initStore,
  readManifest
} from '@context-bridge/core';

const HELP = `Context Bridge

Usage:
  context-bridge init [--cwd <path>]
  context-bridge import --provider <name> [--surface <name>] <file> [--cwd <path>]
  context-bridge snapshot [--cwd <path>]
  context-bridge export --to <target> [--max-chars <n>] [--cwd <path>]
  context-bridge status [--cwd <path>]

Examples:
  context-bridge init
  context-bridge import --provider claude --surface cli ./transcript.jsonl
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
