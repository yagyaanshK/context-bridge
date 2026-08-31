import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const workspacePaths = ['packages/core', 'packages/cli', 'packages/vscode'];
const rootPackage = await readJson('package.json');
const lock = await readJson('package-lock.json');

assert.equal(lock.packages['']?.version, rootPackage.version, 'lockfile root version must match package.json');

for (const workspacePath of workspacePaths) {
  const manifest = await readJson(path.join(workspacePath, 'package.json'));
  const locked = lock.packages[workspacePath];
  assert.ok(locked, `lockfile is missing ${workspacePath}`);
  assert.equal(manifest.version, rootPackage.version, `${workspacePath} version must match the workspace`);
  assert.equal(locked.version, manifest.version, `${workspacePath} lockfile version is stale`);

  const coreVersion = manifest.dependencies?.['@context-bridge/core'];
  if (coreVersion !== undefined) {
    assert.equal(coreVersion, rootPackage.version, `${workspacePath} must depend on the matching core release`);
    assert.equal(locked.dependencies?.['@context-bridge/core'], coreVersion, `${workspacePath} core lock is stale`);
  }
}

const { stdout } = await execFileAsync('git', ['ls-files', 'dist'], { cwd: root, encoding: 'utf8' });
const trackedVsix = stdout.split(/\r?\n/).filter((file) => /\.vsix$/i.test(file));
assert.deepEqual(trackedVsix, [], `VSIX release artifacts must not be tracked: ${trackedVsix.join(', ')}`);

console.log(`Package metadata is aligned at ${rootPackage.version}; no VSIX artifacts are tracked.`);

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}
