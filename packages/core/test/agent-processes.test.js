import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAgentStopped,
  classifyAgentProcesses,
  listAgentProcesses,
  matchingAgentProcesses,
  terminateAgentProcesses
} from '../src/index.js';

const processes = [
  { pid: 10, name: 'Code.exe', commandLine: 'Code.exe --type=utility' },
  { pid: 11, name: 'codex.exe', commandLine: 'codex.exe app-server' },
  { pid: 12, name: 'claude.exe', commandLine: 'claude.exe --output-format stream-json' },
  { pid: 13, name: 'node', commandLine: 'node /opt/node_modules/@openai/codex/bin/codex.js' },
  { pid: 14, name: 'node', commandLine: 'node /opt/node_modules/@anthropic-ai/claude-code/cli.js' },
  { pid: 15, name: 'node', commandLine: 'node packages/core/test/claude.test.js' }
];

test('agent process matching ignores editors and test names but finds native and npm agents', () => {
  assert.deepEqual(matchingAgentProcesses('codex', processes).map((item) => item.pid), [11, 13]);
  assert.deepEqual(matchingAgentProcesses('claude', processes).map((item) => item.pid), [12, 14]);
});

test('Codex extension services are distinguished from interactive Codex processes', () => {
  const running = [
    { pid: 100, name: 'Code.exe', commandLine: 'Code.exe' },
    { pid: 101, parentPid: 100, name: 'Code.exe', commandLine: 'Code.exe --type=utility' },
    {
      pid: 102,
      parentPid: 101,
      name: 'codex.exe',
      executablePath: 'C:\\Users\\dev\\.vscode\\extensions\\openai.chatgpt-1.2.3\\bin\\windows-x86_64\\codex.exe',
      commandLine: 'codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled'
    },
    { pid: 103, parentPid: 102, name: 'codex-code-mode-host.exe' },
    { pid: 104, name: 'codex.exe', commandLine: 'codex exec --full-auto' },
    { pid: 105, name: 'codex.exe', commandLine: 'codex app-server' }
  ];

  assert.deepEqual(
    classifyAgentProcesses('codex', running).map(({ pid, kind, editor }) => ({ pid, kind, editor })),
    [
      { pid: 102, kind: 'ide-background', editor: 'VS Code' },
      { pid: 103, kind: 'ide-background', editor: 'VS Code' },
      { pid: 104, kind: 'interactive', editor: undefined },
      { pid: 105, kind: 'interactive', editor: undefined }
    ]
  );
});

test('Codex extension services are recognized across common VS Code forks', () => {
  for (const [name, folder, editor] of [
    ['Cursor.exe', '.cursor', 'Cursor'],
    ['Windsurf.exe', '.windsurf', 'Windsurf'],
    ['Antigravity.exe', '.antigravity', 'Google Antigravity'],
    ['VSCodium.exe', '.vscode-oss', 'VSCodium']
  ]) {
    const classified = classifyAgentProcesses('codex', [
      { pid: 1, name },
      { pid: 2, parentPid: 1, name },
      {
        pid: 3,
        parentPid: 2,
        name: 'codex.exe',
        executablePath: `C:\\Users\\dev\\${folder}\\extensions\\openai.chatgpt-build\\bin\\codex.exe`,
        commandLine: 'codex.exe app-server'
      }
    ]);
    assert.equal(classified[0]?.kind, 'ide-background', name);
    assert.equal(classified[0]?.editor, editor, name);
  }
});

test('Claude processes remain interactive blockers until the provider exposes a restart contract', () => {
  const classified = classifyAgentProcesses('claude', [
    { pid: 1, name: 'Code.exe' },
    { pid: 2, parentPid: 1, name: 'claude.exe', commandLine: 'claude.exe --output-format stream-json' }
  ]);
  assert.equal(classified[0]?.kind, 'interactive');
  assert.equal(classified[0]?.editor, undefined);
});

test('Claude extension services and Kiro Codex services identify their editor owner', () => {
  const running = [
    { pid: 1, name: 'Kiro.exe' },
    { pid: 2, parentPid: 1, name: 'Kiro.exe' },
    {
      pid: 3,
      parentPid: 2,
      name: 'codex.exe',
      executablePath: 'C:\\Users\\dev\\.kiro\\extensions\\openai.chatgpt-build\\bin\\codex.exe',
      commandLine: 'codex.exe app-server'
    },
    {
      pid: 4,
      parentPid: 2,
      name: 'claude.exe',
      executablePath: 'C:\\Users\\dev\\.kiro\\extensions\\anthropic.claude-code-2.1.0\\resources\\claude.exe',
      commandLine: 'claude.exe --output-format stream-json'
    }
  ];

  assert.equal(classifyAgentProcesses('codex', running)[0]?.editor, 'Kiro');
  assert.equal(classifyAgentProcesses('claude', running)[0]?.editor, 'Kiro');
});

test('confirmed process termination re-enumerates and stops matching provider processes only', async () => {
  const samples = [
    [
      { pid: 10, name: 'codex.exe', commandLine: 'codex.exe app-server' },
      { pid: 11, name: 'claude.exe', commandLine: 'claude.exe' }
    ],
    []
  ];
  const killed = [];
  const result = await terminateAgentProcesses('codex', {
    platform: 'win32',
    listAgentProcesses: async () => samples.shift() || [],
    killProcess: (pid, signal) => killed.push({ pid, signal }),
    sleep: async () => {},
    now: (() => { let value = 0; return () => ++value; })()
  });

  assert.deepEqual(killed, [{ pid: 10, signal: 'SIGKILL' }]);
  assert.deepEqual(result.terminated.map((item) => item.pid), [10]);
  assert.deepEqual(result.remaining, []);
});

test('process termination reports provider processes that keep restarting', async () => {
  let now = 0;
  const killed = [];
  const result = await terminateAgentProcesses('codex', {
    platform: 'linux',
    listAgentProcesses: async () => [{ pid: 10, name: 'codex', commandLine: 'codex app-server' }],
    killProcess: (pid, signal) => killed.push({ pid, signal }),
    sleep: async () => { now += 100; },
    now: () => now,
    gracefulMs: 100,
    timeoutMs: 250,
    pollMs: 100
  });

  assert.deepEqual(killed.slice(0, 2), [
    { pid: 10, signal: 'SIGTERM' },
    { pid: 10, signal: 'SIGKILL' }
  ]);
  assert.deepEqual(result.remaining.map((item) => item.pid), [10]);
});

test('the switch preflight names the process and confirms no credential was changed', async () => {
  await assert.rejects(
    assertAgentStopped('codex', { agentProcesses: [{ pid: 42, name: 'codex.exe' }] }),
    /codex\.exe \(PID 42\).*did not change the live credential/i
  );
  await assert.doesNotReject(assertAgentStopped('claude', { agentProcesses: [] }));
});

test('Windows process enumeration accepts both singleton and array JSON', async () => {
  const execFile = async () => ({
    stdout: JSON.stringify({ ProcessId: 7, ParentProcessId: 1, Name: 'codex.exe', CommandLine: 'codex.exe app-server' })
  });
  const listed = await listAgentProcesses({ platform: 'win32', execFile });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].pid, 7);
});

test('process enumeration fails closed when the operating-system query fails', async () => {
  await assert.rejects(
    listAgentProcesses({ platform: 'linux', execFile: async () => { throw new Error('permission denied'); } }),
    /Could not inspect running agent processes: permission denied/
  );
});
