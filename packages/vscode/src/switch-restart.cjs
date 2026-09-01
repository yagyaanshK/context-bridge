const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const REQUEST_SUFFIX = '.request.json';
const RESULT_SUFFIX = '.result.json';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

async function createSwitchRequest(directory, data, options = {}) {
  const provider = data?.provider === 'claude' ? 'claude' : data?.provider === 'codex' ? 'codex' : undefined;
  if (!provider) throw new Error('A queued switch requires a supported provider.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(data.accountId || ''))) {
    throw new Error('A queued switch requires a valid account id.');
  }

  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await removeExpiredRequests(root, options.now?.() ?? Date.now());
  const pending = await pendingSwitchRequests(root);
  if (pending.some(({ value }) => value.provider === provider)) {
    throw new Error(`A ${provider === 'codex' ? 'Codex' : 'Claude'} account switch is already waiting.`);
  }

  const id = options.id || randomUUID();
  const requestedAt = options.now?.() ?? Date.now();
  const timeoutMs = boundedTimeout(data.timeoutMs);
  const requestPath = path.join(root, `${id}${REQUEST_SUFFIX}`);
  const resultPath = path.join(root, `${id}${RESULT_SUFFIX}`);
  const request = {
    schemaVersion: 1,
    id,
    provider,
    accountId: String(data.accountId),
    accountLabel: String(data.accountLabel || ''),
    requestedAt: new Date(requestedAt).toISOString(),
    deadlineAt: new Date(requestedAt + timeoutMs).toISOString(),
    editorHostPid: positiveInteger(data.editorHostPid),
    relaunch: sanitizeRelaunch(data.relaunch),
    blockers: sanitizeBlockers(data.blockers)
  };
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
  return { id, requestPath, resultPath, request };
}

function startSwitchHelper({ editorExecutable, helperPath, requestPath, env = process.env, spawnImpl = spawn }) {
  if (!path.isAbsolute(editorExecutable) || !path.isAbsolute(helperPath) || !path.isAbsolute(requestPath)) {
    throw new Error('The queued switch helper requires absolute executable and file paths.');
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl(editorExecutable, [helperPath, requestPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env: nodeWorkerEnvironment(env)
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

function editorRelaunch(processInfo, workspace) {
  const executable = path.resolve(processInfo.execPath);
  const args = ['--new-window'];
  if (workspace?.workspaceFile) args.push(path.resolve(workspace.workspaceFile));
  else if (workspace?.folder) args.push(path.resolve(workspace.folder));
  return { executable, args, cwd: workspace?.folder ? path.resolve(workspace.folder) : undefined };
}

async function consumeSwitchResults(directory) {
  const root = path.resolve(directory);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const results = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(RESULT_SUFFIX))) {
    const file = path.join(root, entry.name);
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value?.schemaVersion === 1 && typeof value.success === 'boolean') results.push(value);
    } catch {
      // A partial or externally corrupted result is not actionable. Discard it
      // rather than showing the same failure on every editor start.
    } finally {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }
  return results.sort((left, right) => String(left.completedAt).localeCompare(String(right.completedAt)));
}

function nodeWorkerEnvironment(environment) {
  const clean = editorEnvironment(environment);
  clean.ELECTRON_RUN_AS_NODE = '1';
  return clean;
}

function editorEnvironment(environment) {
  const clean = { ...environment };
  delete clean.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(clean)) {
    if (key.startsWith('VSCODE_')) delete clean[key];
  }
  return clean;
}

function resultPathForRequest(requestPath) {
  if (!String(requestPath).endsWith(REQUEST_SUFFIX)) throw new Error('Invalid queued switch request filename.');
  return `${requestPath.slice(0, -REQUEST_SUFFIX.length)}${RESULT_SUFFIX}`;
}

async function pendingSwitchRequests(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const pending = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(REQUEST_SUFFIX))) {
    const file = path.join(directory, entry.name);
    try {
      pending.push({ file, value: JSON.parse(await fs.readFile(file, 'utf8')) });
    } catch {
      // The helper reports malformed requests. Do not let one hide valid work.
    }
  }
  return pending;
}

async function removeExpiredRequests(directory, now) {
  for (const { file, value } of await pendingSwitchRequests(directory)) {
    const deadline = Date.parse(value.deadlineAt);
    if (!Number.isFinite(deadline) || deadline >= now) continue;
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

function sanitizeRelaunch(value) {
  if (!value || !path.isAbsolute(String(value.executable || ''))) return undefined;
  const args = Array.isArray(value.args) ? value.args.slice(0, 8).map((item) => String(item).slice(0, 4096)) : [];
  return {
    executable: path.resolve(String(value.executable)),
    args,
    cwd: value.cwd ? path.resolve(String(value.cwd)) : undefined
  };
}

function sanitizeBlockers(blockers) {
  return (Array.isArray(blockers) ? blockers : []).slice(0, 64).map((item) => ({
    pid: positiveInteger(item.pid),
    name: String(item.name || '').slice(0, 128),
    kind: item.kind === 'ide-background' ? 'ide-background' : 'interactive',
    editor: item.editor ? String(item.editor).slice(0, 128) : undefined
  }));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function boundedTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(number, 30_000), 60 * 60 * 1000);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  REQUEST_SUFFIX,
  RESULT_SUFFIX,
  consumeSwitchResults,
  createSwitchRequest,
  editorEnvironment,
  editorRelaunch,
  nodeWorkerEnvironment,
  resultPathForRequest,
  startSwitchHelper
};
