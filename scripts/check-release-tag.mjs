import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const tag = process.argv[2];
const rootPackage = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(tag, `v${rootPackage.version}`, `release tag must be v${rootPackage.version}`);
console.log(`Release tag ${tag} matches package metadata.`);
