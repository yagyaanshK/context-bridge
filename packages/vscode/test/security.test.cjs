const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { allowedLoginUrl, appendBoundedOutput, safeAgentCommand, safeClaudeUri } = require('../src/security.cjs');

test('login links are HTTPS URLs on provider-owned hosts', () => {
  assert.equal(allowedLoginUrl('https://auth.openai.com/codex/device'), 'https://auth.openai.com/codex/device');
  assert.equal(
    allowedLoginUrl('https://claude.ai/oauth/authorize?state=abc'),
    'https://claude.ai/oauth/authorize?state=abc'
  );
  assert.equal(allowedLoginUrl('http://auth.openai.com/codex/device'), undefined);
  assert.equal(allowedLoginUrl('https://auth.openai.com.evil.example/codex/device'), undefined);
  assert.equal(allowedLoginUrl('file:///tmp/credential'), undefined);
  assert.equal(allowedLoginUrl('javascript:alert(1)'), undefined);
});

test('agent commands must exist, identify the provider, and describe a non-destructive UI action', () => {
  const commands = ['anthropic.claude.open', 'openai.chat.focus', 'anthropic.claude.logout', 'workbench.action.openSettings'];
  assert.equal(safeAgentCommand('anthropic.claude.open', 'claude', commands), 'anthropic.claude.open');
  assert.equal(safeAgentCommand('openai.chat.focus', 'codex', commands), 'openai.chat.focus');
  assert.equal(safeAgentCommand('anthropic.claude.logout', 'claude', commands), undefined);
  assert.equal(safeAgentCommand('workbench.action.openSettings', 'claude', commands), undefined);
  assert.equal(safeAgentCommand('anthropic.claude.open', 'codex', commands), undefined);
  assert.equal(safeAgentCommand('anthropic.claude.missing', 'claude', commands), undefined);
});

test('the optional Claude deep link accepts only the known extension URI', () => {
  assert.equal(safeClaudeUri('vscode://anthropic.claude-code/open'), 'vscode://anthropic.claude-code/open');
  assert.equal(safeClaudeUri('https://anthropic.com/open'), undefined);
  assert.equal(safeClaudeUri('vscode://other.extension/open'), undefined);
  assert.equal(safeClaudeUri('vscode://anthropic.claude-code/delete'), undefined);
  assert.equal(
    safeClaudeUri('antigravity://anthropic.claude-code/open', 'antigravity'),
    'antigravity://anthropic.claude-code/open'
  );
});

test('login process output retains only a bounded tail', () => {
  assert.equal(appendBoundedOutput('1234', '5678', 6), '345678');
  assert.equal(appendBoundedOutput('', 'x'.repeat(100), 32).length, 32);
});

test('executable command and URI settings are application-scoped', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const properties = manifest.contributes.configuration.properties;
  for (const key of [
    'turntrail.claudeUri',
    'turntrail.allowExternalClaudeUri',
    'turntrail.claudeOpenCommand',
    'turntrail.codexOpenCommand',
    'contextBridge.claudeUri',
    'contextBridge.allowExternalClaudeUri',
    'contextBridge.claudeOpenCommand',
    'contextBridge.codexOpenCommand'
  ]) {
    assert.equal(properties[key].scope, 'application', key);
  }

  for (const key of [
    'turntrail.accountMaintenance.enabled',
    'turntrail.accountMaintenance.intervalHours'
  ]) {
    assert.equal(properties[key].scope, 'application', key);
  }
});

test('every Turntrail command activates both canonical and legacy command ids', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const activationEvents = new Set(manifest.activationEvents);
  const commands = manifest.contributes.commands.map(({ command }) => command);

  for (const command of commands) {
    assert.match(command, /^turntrail\./);
    assert.equal(activationEvents.has(`onCommand:${command}`), true, command);
    assert.equal(
      activationEvents.has(`onCommand:${command.replace(/^turntrail\./, 'contextBridge.')}`),
      true,
      command
    );
  }
});
