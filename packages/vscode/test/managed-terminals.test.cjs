const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose() {} };
    };
  }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() {}
}

const vscode = { EventEmitter, window: {} };
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const {
  MARKER,
  ManagedTerminalStore,
  managedTerminalArgs,
  resolveProviderLaunch
} = require('../src/managed-terminals.cjs');
Module._load = originalLoad;

function fakeWindow() {
  const opened = new EventEmitter();
  const closed = new EventEmitter();
  const created = [];
  return {
    terminals: [],
    created,
    onDidOpenTerminal: opened.event,
    onDidCloseTerminal: closed.event,
    createTerminal(options) {
      const terminal = {
        creationOptions: options,
        exitStatus: undefined,
        sent: [],
        shown: 0,
        disposed: false,
        show() { this.shown++; },
        sendText(text, newline) { this.sent.push([text, newline]); },
        dispose() { this.disposed = true; closed.fire(this); }
      };
      created.push(terminal);
      opened.fire(terminal);
      return terminal;
    }
  };
}

test('provider resume commands keep the complete handoff prompt in one argument', () => {
  const prompt = 'Read `C:\\repo & remove-all`\nthen continue';
  assert.deepEqual(managedTerminalArgs('claude', { sessionId: 'claude-id', prompt }), [
    '--resume', 'claude-id', prompt
  ]);
  assert.deepEqual(managedTerminalArgs('codex', { sessionId: 'codex-id', prompt }), [
    'resume', 'codex-id', prompt
  ]);
  assert.deepEqual(managedTerminalArgs('codex', { prompt }), [prompt]);
});

test('Windows launch prefers a native executable and never constructs a shell command', async () => {
  const prompt = '$(unsafe) & still one argument';
  const launch = await resolveProviderLaunch('codex', [prompt], {
    platform: 'win32',
    candidates: ['C:\\npm\\codex.cmd', 'C:\\extension\\codex.exe']
  });
  assert.equal(launch.command, 'C:\\extension\\codex.exe');
  assert.deepEqual(launch.args, [prompt]);
});

test('managed terminals launch direct agent processes and inject only while live', async () => {
  const window = fakeWindow();
  const store = new ManagedTerminalStore({
    window,
    platform: 'win32',
    resolveLaunch: async (provider, args) => ({ command: `C:\\bin\\${provider}.exe`, args })
  });
  const context = { subscriptions: [] };
  store.start(context);

  const prompt = 'Continue from C:\\repo';
  const record = await store.launch({
    provider: 'claude', root: 'C:\\repo', sessionId: 'session-1', title: 'Feature', prompt
  });
  const terminal = window.created[0];
  assert.equal(terminal.creationOptions.shellPath, 'C:\\bin\\claude.exe');
  assert.deepEqual(terminal.creationOptions.shellArgs, ['--resume', 'session-1', prompt]);
  assert.equal(terminal.creationOptions.env[MARKER], '1');
  assert.equal(terminal.shown, 1);
  assert.equal(store.viewModel('c:\\REPO')[0].id, record.id);

  store.inject(record.id, 'second handoff');
  assert.deepEqual(terminal.sent, [['second handoff', true]]);
  terminal.exitStatus = { code: 0 };
  assert.throws(() => store.inject(record.id, 'late handoff'), /has exited/i);
  assert.deepEqual(terminal.sent, [['second handoff', true]]);
});

test('only valid live Turntrail terminal markers are reattached', () => {
  const window = fakeWindow();
  const id = '12345678-1234-1234-1234-123456789abc';
  const valid = {
    exitStatus: undefined,
    creationOptions: { env: {
      [MARKER]: '1',
      TURNTRAIL_MANAGED_ID: id,
      TURNTRAIL_MANAGED_PROVIDER: 'codex',
      TURNTRAIL_MANAGED_ROOT: 'C:\\repo',
      TURNTRAIL_MANAGED_SESSION_ID: 'session-2',
      TURNTRAIL_MANAGED_TITLE: 'Restored'
    } }
  };
  const foreign = { exitStatus: undefined, creationOptions: { env: { [MARKER]: '0' } } };
  window.terminals.push(valid, foreign);
  const store = new ManagedTerminalStore({ window, platform: 'win32' });
  store.start({ subscriptions: [] });
  assert.equal(store.get(id).title, 'Restored');
  assert.equal(store.records.size, 1);
});

test('managed terminal input is bounded and provider-limited', async () => {
  assert.throws(() => managedTerminalArgs('cursor'), /only Claude and Codex/i);
  assert.throws(() => managedTerminalArgs('claude', { prompt: 'x'.repeat(64 * 1024 + 1) }), /too long/i);
});
