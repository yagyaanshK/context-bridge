import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathsOverlap, pathsSameOrNested } from '../src/adapters/common.js';

const identityRealpath = async (value) => value;

test('path matching folds case only on Windows', async () => {
  assert.equal(
    await pathsSameOrNested('C:\\Work\\Repo\\src', 'c:\\work\\repo', {
      platform: 'win32',
      realpath: identityRealpath
    }),
    true
  );
  assert.equal(
    await pathsSameOrNested('/Work/Repo/src', '/work/repo', {
      platform: 'linux',
      realpath: identityRealpath
    }),
    false
  );
  assert.equal(
    await pathsSameOrNested('/work/repository', '/work/repo', {
      platform: 'linux',
      realpath: identityRealpath
    }),
    false,
    'a lexical prefix is not a nested path'
  );
});

test('path matching resolves directory links before comparing', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-paths-'));
  const project = path.join(temp, 'real', 'project');
  const source = path.join(project, 'src');
  const alias = path.join(temp, 'alias');
  await fs.mkdir(source, { recursive: true });
  await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');

  assert.equal(await pathsSameOrNested(path.join(alias, 'src'), project), true);
  assert.equal(await pathsOverlap(project, path.join(alias, 'src')), true);
});
