const path = require('node:path');

function handoffForRoot(latest, root, platform = process.platform) {
  if (!latest?.root || !root) return undefined;
  return normalizedPath(latest.root, platform) === normalizedPath(root, platform) ? latest : undefined;
}

function normalizedPath(value, platform = process.platform) {
  const resolved = path.resolve(String(value || ''));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = { handoffForRoot, normalizedPath };
