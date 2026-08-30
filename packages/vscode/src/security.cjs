const LOGIN_HOSTS = new Set([
  'auth.openai.com',
  'claude.ai',
  'platform.claude.com',
  'console.anthropic.com'
]);

function allowedLoginUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !LOGIN_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  if (url.username || url.password) return undefined;
  return url.toString();
}

function safeAgentCommand(command, target, available = []) {
  if (typeof command !== 'string' || !available.includes(command)) return undefined;
  const provider = target === 'claude' ? /claude|anthropic/i : /codex|openai|chatgpt/i;
  const action = /open|focus|show|chat|new|agent|sidebar|view/i;
  const dangerous = /delete|remove|uninstall|reset|clear|logout|signout|revoke/i;
  return provider.test(command) && action.test(command) && !dangerous.test(command) ? command : undefined;
}

function safeClaudeUri(value, editorScheme = 'vscode') {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return undefined;
  }
  if (url.protocol !== `${editorScheme}:` || url.hostname !== 'anthropic.claude-code' || url.pathname !== '/open') {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  return url.toString();
}

function appendBoundedOutput(current, chunk, limit = 64 * 1024) {
  return `${String(current || '')}${String(chunk || '')}`.slice(-Math.max(1, limit));
}

module.exports = { allowedLoginUrl, appendBoundedOutput, safeAgentCommand, safeClaudeUri };
