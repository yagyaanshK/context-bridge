// Driving the official `codex login` without a terminal.
//
// Context Bridge never performs the OAuth exchange itself. Doing so would mean
// holding a subscription's tokens in a tool that is not the official client,
// which is the line the provider's terms draw. Instead the official binary runs
// as a child process and we read its output to drive our own progress UI: the
// browser is opened for the user, a device code is shown large, an API key is
// piped to stdin. The credential is still written by `codex`, into the
// CODEX_HOME we point it at.

export const CODEX_LOGIN_MODES = ['browser', 'device', 'apikey'];

export function codexLoginArgs(mode) {
  if (mode === 'device') return ['login', '--device-auth'];
  if (mode === 'apikey') return ['login', '--with-api-key'];
  if (mode === 'browser' || mode === undefined) return ['login'];
  throw new Error(`Unknown Codex login mode: ${mode}`);
}

// Colour codes wrap the very values we need to read. An escape like [32m
// ends with `m`, a word character, so a \b assertion in front of a highlighted
// device code never matches and the code becomes invisible to the parser. URLs
// pick up the trailing reset sequence and break. Strip escapes before anything
// else looks at the text.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = new RegExp('\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*\u0007', 'g');

export function stripAnsi(text) {
  return String(text || '')
    .replace(ANSI_PATTERN, '')
    // Progress redraws use a bare carriage return; treat it as a line break so
    // rewritten lines stay separate rather than running together.
    .replace(/\r(?!\n)/g, '\n');
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`)]+/g;
// Device codes are chunked and upper case, but the halves are not equal length:
// the CLI issues things like XJPT-7M1V3. Pinning this to 4+4 matched nothing at
// all on a real code.
const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4,8}[-\s][A-Z0-9]{4,8})\b/;
const EXPIRY_PATTERN = /expires in (\d+)\s*(minute|hour|second)s?/i;

// Pull the actionable bits out of whatever the CLI has printed so far.
//
// Written against observed output and deliberately loose: the exact wording is
// not a contract, so anything recognisable is used and anything unfamiliar is
// simply ignored rather than treated as failure.
export function parseCodexLoginOutput(text) {
  const output = stripAnsi(text);
  const urls = output.match(URL_PATTERN) || [];
  const cleaned = urls.map((url) => url.replace(/[.,;:]+$/, ''));

  // The authorize URL is the one to send the user to. A local callback server
  // address is printed too and must never be mistaken for it.
  const authorizeUrl = cleaned.find((url) => /\/oauth\/authorize|response_type=code/.test(url));
  const verificationUrl = cleaned.find((url) => /\/device|activate|\/auth\b/.test(url) && !isLoopback(url));
  const loopbackUrl = cleaned.find((url) => isLoopback(url));

  // Search for the code with URLs removed. Authorize URLs carry long opaque
  // parameters that can otherwise be mistaken for one.
  const withoutUrls = output.replace(URL_PATTERN, ' ');
  const code = DEVICE_CODE_PATTERN.exec(withoutUrls);
  const expiry = EXPIRY_PATTERN.exec(output);

  return {
    authorizeUrl,
    verificationUrl: verificationUrl && verificationUrl !== authorizeUrl ? verificationUrl : undefined,
    loopbackUrl,
    deviceCode: code ? code[1].replace(/\s/g, '-') : undefined,
    expiresIn: expiry ? `${expiry[1]} ${expiry[2]}${Number(expiry[1]) === 1 ? '' : 's'}` : undefined,
    // Surfaced so the panel can say what is happening rather than sit blank.
    waitingForBrowser: /navigate to this URL|did not open|Starting local login server/i.test(output),
    alreadyLoggedIn: /already logged in|already authenticated/i.test(output)
  };
}

export function isLoopback(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(String(url || ''));
}

// `codex login` exits non-zero on failure, but its message is the useful part.
// Keep the last non-empty line, which is where the reason lands.
export function codexLoginFailureReason(output, exitCode) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // The generic hint is printed on success paths too and explains nothing.
    .filter((line) => !/remote or headless machine/i.test(line));
  const last = lines[lines.length - 1];
  return last || `codex login exited with code ${exitCode}`;
}
