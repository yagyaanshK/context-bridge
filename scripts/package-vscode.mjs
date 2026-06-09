import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const vscodePackage = path.join(root, 'packages', 'vscode');
const corePackage = path.join(root, 'packages', 'core');
const sourceExtensionPkg = JSON.parse(await fs.readFile(path.join(vscodePackage, 'package.json'), 'utf8'));
const sourceCorePkg = JSON.parse(await fs.readFile(path.join(corePackage, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'stage-vscode');
const vsixName = `context-bridge-${sourceExtensionPkg.version}.vsix`;
const vsixOut = path.join(dist, vsixName);
const stagedVsix = path.join(stage, vsixName);

await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(path.join(stage, 'src'), { recursive: true });
await fs.mkdir(path.join(stage, 'node_modules', '@context-bridge', 'core'), { recursive: true });
await fs.mkdir(dist, { recursive: true });

await copyFile(path.join(vscodePackage, 'README.md'), path.join(stage, 'README.md'));
await copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
await copyFile(path.join(vscodePackage, 'src', 'extension.cjs'), path.join(stage, 'src', 'extension.cjs'));
await copyDir(path.join(corePackage, 'src'), path.join(stage, 'node_modules', '@context-bridge', 'core', 'src'));

const extensionPkg = sourceExtensionPkg;
delete extensionPkg.devDependencies;
extensionPkg.dependencies = {
  '@context-bridge/core': sourceCorePkg.version
};
extensionPkg.repository = {
  type: 'git',
  url: 'https://github.com/yagyaanshK/context-bridge.git'
};
extensionPkg.files = [
  'src/**',
  'README.md',
  'LICENSE',
  'node_modules/@context-bridge/core/**'
];
await writeJson(path.join(stage, 'package.json'), extensionPkg);

const corePkg = sourceCorePkg;
delete corePkg.devDependencies;
await writeJson(path.join(stage, 'node_modules', '@context-bridge', 'core', 'package.json'), corePkg);

await run(process.execPath, [
  path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce'),
  'package',
  '--out',
  vsixName
], stage);

await fs.copyFile(stagedVsix, vsixOut);
console.log(`Packaged ${vsixOut}`);

async function copyFile(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(source, target);
    else if (entry.isFile()) await copyFile(source, target);
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
