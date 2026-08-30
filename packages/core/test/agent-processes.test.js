import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAgentStopped, listAgentProcesses, matchingAgentProcesses } from '../src/index.js';

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
