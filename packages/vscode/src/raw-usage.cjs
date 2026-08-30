async function readRawUsage(api, options) {
  const response = await api.providerFetch(options.endpoint, { headers: options.headers }, { signal: options.signal });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  const parsed = !response.ok
    ? { error: `Usage request failed with HTTP ${response.status}.` }
    : body && typeof body === 'object'
      ? options.claude
        ? { ...api.normalizeClaudeUsage(body), plan: options.auth.plan, email: options.auth.email }
        : api.normalizeCodexUsage(body)
      : { error: 'The usage endpoint did not return JSON.' };

  return { status: response.status, body, parsed };
}

module.exports = { readRawUsage };
