import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

// Tests are often launched from an editor terminal whose extension host marks
// Electron processes as Node workers. A nested Code process must start as a
// standalone application with no parent-editor IPC channel.
for (const key of Object.keys(process.env)) {
  if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) delete process.env[key];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDevelopmentPath = path.join(root, 'packages', 'vscode');
const extensionTestsPath = path.join(extensionDevelopmentPath, 'integration', 'host.cjs');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-vscode-'));
const home = path.join(scratch, 'home');
const userData = path.join(scratch, 'user-data');
const extensionsDir = path.join(scratch, 'extensions');
const workspaceA = path.join(scratch, 'workspace-a');
const workspaceB = path.join(scratch, 'workspace-b');
const fakeBin = path.join(scratch, 'fake-bin');
await Promise.all([home, userData, extensionsDir, workspaceA, workspaceB, fakeBin].map((dir) => fs.mkdir(dir, { recursive: true })));
await Promise.all([
  fs.writeFile(path.join(workspaceA, 'README.md'), '# Workspace A\n', 'utf8'),
  fs.writeFile(path.join(workspaceB, 'README.md'), '# Workspace B\n', 'utf8')
]);
await writeFakeCodex(fakeBin);

const vscodeExecutablePath = await downloadAndUnzipVSCode('1.95.3');
const commonEnv = {
  TURNTRAIL_EXTENSION_TESTS: '1',
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  PATH: integrationPath(fakeBin)
};

await trusted('smoke-and-seed', workspaceA);
await trusted('other-workspace', workspaceB);
await untrusted(workspaceB);

console.log('VS Code extension-host scenarios passed: commands, webview, managed terminals, cancellation, workspace isolation, trust, and fork schemes.');

async function writeFakeCodex(directory) {
  if (process.platform === 'win32') {
    await Promise.all([
      fs.writeFile(path.join(directory, 'codex.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8'),
      fs.writeFile(path.join(directory, 'codex.ps1'), 'Write-Output "managed codex fixture"\nStart-Sleep -Seconds 30\n', 'utf8')
    ]);
    return;
  }
  const executable = path.join(directory, 'codex');
  await fs.writeFile(executable, '#!/bin/sh\necho "managed codex fixture"\nsleep 30\n', { mode: 0o755 });
}

function integrationPath(directory) {
  if (process.platform !== 'win32') return [directory, '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
  const windows = process.env.SystemRoot || 'C:\\Windows';
  return [
    directory,
    path.join(windows, 'System32'),
    path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0')
  ].join(path.delimiter);
}

async function trusted(scenario, workspace) {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspace,
      '--disable-extensions',
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensionsDir}`
    ],
    extensionTestsEnv: { ...commonEnv, TURNTRAIL_TEST_SCENARIO: scenario }
  });
}

async function untrusted(workspace) {
  const args = [
    workspace,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    '--disable-extensions',
    `--user-data-dir=${path.join(scratch, 'untrusted-user-data')}`,
    `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    `--extensionTestsPath=${extensionTestsPath}`
  ];
  await spawnAndWait(vscodeExecutablePath, args, {
    ...process.env,
    ...commonEnv,
    TURNTRAIL_TEST_SCENARIO: 'untrusted'
  });
}

function spawnAndWait(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`VS Code untrusted test exited with ${code ?? signal}`));
    });
  });
}
