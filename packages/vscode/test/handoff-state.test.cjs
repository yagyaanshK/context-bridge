const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { handoffForRoot, normalizedPath } = require('../src/handoff-state.cjs');

test('latest handoff is visible only in the workspace that created it', () => {
  const first = path.resolve('workspace-a');
  const second = path.resolve('workspace-b');
  const latest = { root: first, handoffPath: path.join(first, '.turntrail', 'exports', 'one.md') };
  assert.equal(handoffForRoot(latest, first), latest);
  assert.equal(handoffForRoot(latest, second), undefined);
  assert.equal(handoffForRoot(latest, undefined), undefined);
});

test('Windows workspace comparison is case-insensitive without changing POSIX behavior', () => {
  assert.equal(normalizedPath('C:\\Work\\Repo', 'win32'), normalizedPath('c:\\work\\repo', 'win32'));
  if (process.platform !== 'win32') {
    assert.notEqual(normalizedPath('/Work/Repo', 'linux'), normalizedPath('/work/repo', 'linux'));
  }
});
