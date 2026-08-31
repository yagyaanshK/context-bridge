const contracts = {
  codex: {
    version: 'codex-observed-v1',
    stability: 'observed-private',
    credentials: { file: 'auth.json', schema: 'codex-auth-v1' },
    oauth: {
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      tokenUrl: 'https://auth.openai.com/oauth/token'
    },
    usage: { url: 'https://chatgpt.com/backend-api/wham/usage', schema: 'codex-usage-v1' }
  },
  claude: {
    version: 'claude-observed-v1',
    stability: 'observed-private',
    credentials: { file: '.credentials.json', schema: 'claude-credentials-v1' },
    oauth: {
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      authorizeUrl: 'https://claude.ai/oauth/authorize',
      consoleAuthorizeUrl: 'https://platform.claude.com/oauth/authorize',
      tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
      profileUrl: 'https://api.anthropic.com/api/oauth/profile'
    },
    usage: { url: 'https://api.anthropic.com/api/oauth/usage', schema: 'claude-usage-v1' }
  }
};

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

export const PROVIDER_CONTRACTS = deepFreeze(contracts);

const PROVIDER_LABELS = { codex: 'Codex', claude: 'Claude' };

export class ProviderContractError extends Error {
  constructor(provider, operation) {
    const contract = PROVIDER_CONTRACTS[provider];
    const label = PROVIDER_LABELS[provider] || provider;
    const version = contract?.version || 'unknown';
    super(
      `${label} ${operation} no longer matches Context Bridge's observed provider contract ` +
        `(${version}). Update Context Bridge before retrying.`
    );
    this.name = 'ProviderContractError';
    this.code = 'PROVIDER_CONTRACT_CHANGED';
    this.provider = provider;
    this.operation = operation;
    this.contractVersion = version;
  }
}

export function isProviderContractError(error) {
  return error?.code === 'PROVIDER_CONTRACT_CHANGED';
}

export function validateTokenPayload(provider, payload) {
  assertRecord(provider, 'token response', payload);
  assertNonEmptyString(provider, 'token response', payload.access_token);
  assertOptionalString(provider, 'token response', payload.refresh_token);
  if (provider === 'claude') assertNonEmptyString(provider, 'token response', payload.refresh_token);
  assertOptionalString(provider, 'token response', payload.id_token);
  assertOptionalString(provider, 'token response', payload.scope);
  assertOptionalString(provider, 'token response', payload.token_type);
  if (payload.expires_in !== undefined) {
    const expiresIn = Number(payload.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw contractError(provider, 'token response');
  }
  return payload;
}

export function validateClaudeProfilePayload(payload) {
  assertRecord('claude', 'profile response', payload);
  assertRecord('claude', 'profile response', payload.account);
  for (const key of ['uuid', 'email', 'display_name', 'full_name', 'created_at']) {
    assertOptionalString('claude', 'profile response', payload.account[key]);
  }
  for (const key of ['has_claude_max', 'has_claude_pro']) {
    assertOptionalBoolean('claude', 'profile response', payload.account[key]);
  }
  const accountId = nonEmptyString(payload.account.uuid);
  const email = nonEmptyString(payload.account.email);
  if (!accountId && !email) throw contractError('claude', 'profile response');
  if (payload.organization !== undefined) {
    assertRecord('claude', 'profile response', payload.organization);
    for (const key of [
      'uuid',
      'name',
      'organization_type',
      'billing_type',
      'rate_limit_tier',
      'subscription_created_at'
    ]) {
      assertOptionalString('claude', 'profile response', payload.organization[key]);
    }
    assertOptionalBoolean('claude', 'profile response', payload.organization.has_extra_usage_enabled);
  }
  return payload;
}

export function validateUsagePayload(provider, payload, normalized) {
  assertRecord(provider, 'usage response', payload);
  if (!Array.isArray(normalized?.windows) || normalized.windows.length === 0) {
    throw contractError(provider, 'usage response');
  }
  return normalized;
}

export function validateCodexCredentialPayload(payload) {
  assertRecord('codex', 'credential file', payload);
  if (payload.tokens !== undefined) {
    assertRecord('codex', 'credential file', payload.tokens);
    for (const key of ['access_token', 'accessToken', 'refresh_token', 'refreshToken', 'id_token', 'idToken']) {
      assertOptionalString('codex', 'credential file', payload.tokens[key]);
    }
  }
  assertOptionalString('codex', 'credential file', payload.OPENAI_API_KEY);
  assertOptionalString('codex', 'credential file', payload.openai_api_key);

  if (payload.auth_mode === 'oauth' && !nonEmptyString(payload.tokens?.access_token || payload.tokens?.accessToken)) {
    throw contractError('codex', 'credential file');
  }
  return payload;
}

export function validateClaudeCredentialPayload(payload) {
  assertRecord('claude', 'credential file', payload);
  if (payload.claudeAiOauth === undefined) return payload;
  assertRecord('claude', 'credential file', payload.claudeAiOauth);
  const oauth = payload.claudeAiOauth;
  assertNonEmptyString('claude', 'credential file', oauth.accessToken);
  assertOptionalString('claude', 'credential file', oauth.refreshToken);
  assertOptionalString('claude', 'credential file', oauth.subscriptionType);
  assertOptionalString('claude', 'credential file', oauth.rateLimitTier);
  if (oauth.scopes !== undefined && !isStringArray(oauth.scopes)) throw contractError('claude', 'credential file');
  if (oauth.expiresAt !== undefined && !Number.isFinite(Number(oauth.expiresAt))) {
    throw contractError('claude', 'credential file');
  }
  return payload;
}

function assertRecord(provider, operation, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError(provider, operation);
}

function assertNonEmptyString(provider, operation, value) {
  if (!nonEmptyString(value)) throw contractError(provider, operation);
}

function assertOptionalString(provider, operation, value) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw contractError(provider, operation);
}

function assertOptionalBoolean(provider, operation, value) {
  if (value !== undefined && value !== null && typeof value !== 'boolean') throw contractError(provider, operation);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function contractError(provider, operation) {
  return new ProviderContractError(provider, operation);
}
