import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const roots = [
  'packages/core/src',
  'packages/cli/src',
  'packages/cli/bin',
  'packages/vscode/src'
];

const files = [];
for (const root of roots) {
  await collect(root, files);
}

for (const file of files) {
  await check(file);
}

function check(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Syntax check failed for ${file}`));
    });
  });
}

async function collect(root, files) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collect(fullPath, files);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.cjs'))) {
      files.push(fullPath);
    }
  }
}
