const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

// Sign-in, without handing the user a terminal.
//
// The official `codex` binary still performs the whole OAuth exchange and still
// writes the credential - Context Bridge only runs it as a child process with
// CODEX_HOME pointed at the right directory, reads its output, and presents the
// result. We never see the authorization code and never hold a token.

class CodexLoginPanel {
  constructor(context, core, store) {
    this.context = context;
    this.core = core;
    this.store = store;
    this.panel = undefined;
    this.child = undefined;
    this.target = undefined;
  }

  async open(target = {}) {
    this.target = target;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'contextBridgeCodexLogin',
        'Connect a Codex subscription',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.webview.html = html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message));
      this.panel.onDidDispose(() => {
        this.cancel();
        this.panel = undefined;
      });
    }
    this.post({ type: 'ready', label: target.label || '', locked: Boolean(target.accountId) });
  }

  post(message) {
    this.panel?.webview.postMessage(message);
  }

  cancel() {
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  async onMessage(message) {
    if (message?.type === 'cancel') {
      this.cancel();
      this.post({ type: 'idle' });
      return;
    }
    if (message?.type === 'openExternal' && message.url) {
      vscode.env.openExternal(vscode.Uri.parse(message.url));
      return;
    }
    if (message?.type === 'copy' && message.value) {
      await vscode.env.clipboard.writeText(message.value);
      this.post({ type: 'copied' });
      return;
    }
    if (message?.type === 'start') {
      try {
        await this.start(message);
      } catch (error) {
        this.post({ type: 'failed', message: error.message });
      }
    }
  }

  async start(message) {
    const { createAccount, ensureCodexHome, codexHome, refreshCodexAccountIdentity, codexLoginArgs } =
      await this.core();

    if (this.child) throw new Error('A sign-in is already running. Cancel it first.');

    let accountId = this.target?.accountId;
    if (!accountId) {
      const label = String(message.label || '').trim();
      if (!label) throw new Error('Give this subscription a name first.');
      const account = await createAccount({ label, provider: 'codex' });
      accountId = account.id;
      this.target = { accountId, label };
    }
    // `codex` will not create CODEX_HOME; it exits if the path is missing.
    await ensureCodexHome(accountId);

    const args = codexLoginArgs(message.method);
    this.post({ type: 'running', method: message.method });

    const result = await this.run(args, codexHome(accountId), message.method, message.apiKey);
    if (!result.ok) {
      this.post({ type: 'failed', message: result.message });
      return;
    }

    const auth = await refreshCodexAccountIdentity(accountId);
    if (!auth) {
      this.post({ type: 'failed', message: 'Sign-in finished but no credential was written. Please try again.' });
      return;
    }

    await this.store.reloadUsage({ force: true });
    this.post({ type: 'done', email: auth.claims?.email, label: this.target.label });
  }

  run(args, home, method, apiKey) {
    return new Promise((resolve) => {
      const child = spawn('codex', args, {
        env: { ...process.env, CODEX_HOME: home },
        // The launcher on Windows is a shim, not an executable.
        shell: process.platform === 'win32'
      });
      this.child = child;

      let output = '';
      let opened = false;

      const onChunk = async (chunk) => {
        output += chunk.toString();
        const { parseCodexLoginOutput: parse } = await this.core();
        const parsed = parse(output);

        // Open the browser once, on the user's behalf, as the CLI would have.
        if (!opened && method !== 'device' && parsed.authorizeUrl) {
          opened = true;
          vscode.env.openExternal(vscode.Uri.parse(parsed.authorizeUrl));
        }
        this.post({ type: 'progress', parsed });
      };

      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);

      if (method === 'apikey') {
        child.stdin?.end(`${String(apiKey || '').trim()}\n`);
      }

      child.on('error', (error) => {
        this.child = undefined;
        resolve({
          ok: false,
          message:
            error.code === 'ENOENT'
              ? 'The `codex` command was not found. Install the Codex CLI and make sure it is on your PATH.'
              : error.message
        });
      });

      child.on('close', async (code) => {
        const wasCancelled = this.child !== child;
        this.child = undefined;
        if (wasCancelled) return resolve({ ok: false, message: 'Sign-in cancelled.' });
        if (code === 0) return resolve({ ok: true });
        const { codexLoginFailureReason: reason } = await this.core();
        resolve({ ok: false, message: reason(output, code) });
      });
    });
  }
}

function html(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: grid;
    place-items: center;
    overflow: auto;
  }
  #bg { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 0; }
  .shell {
    position: relative; z-index: 1;
    width: min(560px, 92vw);
    padding: 40px 0 56px;
    display: flex; flex-direction: column; gap: 26px;
  }
  .hero { text-align: center; display: flex; flex-direction: column; gap: 10px; align-items: center; }
  .mark {
    width: 54px; height: 54px; border-radius: 15px;
    display: grid; place-items: center;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-size: 24px; font-weight: 700;
  }
  h1 { margin: 6px 0 0; font-size: 1.75rem; font-weight: 600; letter-spacing: -0.01em; }
  .lede { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.55; max-width: 42ch; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  label { font-size: 0.85rem; color: var(--vscode-descriptionForeground); }
  input {
    font-family: inherit; font-size: 1rem; padding: 9px 11px; border-radius: 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .methods { display: flex; flex-direction: column; gap: 10px; }
  .method {
    display: flex; align-items: center; gap: 13px; width: 100%; text-align: left;
    padding: 14px 16px; border-radius: 9px; cursor: pointer;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28));
    color: inherit; font-family: inherit; font-size: 1rem;
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .method:hover { border-color: var(--vscode-focusBorder); transform: translateY(-1px); }
  .method:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .method[disabled] { opacity: 0.5; cursor: default; transform: none; }
  .method .glyph {
    flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 15px;
  }
  .method.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .method.primary .glyph { background: rgba(255,255,255,0.22); color: inherit; }
  .method b { display: block; font-weight: 600; }
  .method span { display: block; font-size: 0.83rem; opacity: 0.75; margin-top: 1px; }
  .panel {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28));
    border-radius: 9px; padding: 18px; display: flex; flex-direction: column; gap: 14px;
    background: var(--vscode-editorWidget-background);
  }
  .code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 2rem; font-weight: 700; letter-spacing: 0.16em; text-align: center;
    padding: 14px; border-radius: 8px; user-select: all;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.14));
  }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  button.action {
    font-family: inherit; font-size: 0.9rem; padding: 7px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  button.action.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.action:hover { filter: brightness(1.12); }
  .status { display: flex; align-items: center; gap: 10px; color: var(--vscode-descriptionForeground); font-size: 0.92rem; }
  .spinner {
    width: 15px; height: 15px; flex: none; border-radius: 50%;
    border: 2px solid currentColor; border-right-color: transparent;
    animation: spin 800ms linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error { color: var(--vscode-errorForeground); font-size: 0.92rem; line-height: 1.5; }
  .ok { color: var(--vscode-charts-green); font-weight: 600; }
  .note { color: var(--vscode-descriptionForeground); font-size: 0.82rem; line-height: 1.6; }
  .link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; word-break: break-all; }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
    .method { transition: none; }
  }
</style>
</head>
<body>
<canvas id="bg" aria-hidden="true"></canvas>
<div class="shell">
  <div class="hero">
    <div class="mark">⇄</div>
    <h1>Connect a Codex subscription</h1>
    <p class="lede">Context Bridge runs the official <code>codex</code> sign-in and stores the result in
      its own directory, so your existing login stays exactly as it is.</p>
  </div>

  <div class="field" id="nameField">
    <label for="label">Name this subscription</label>
    <input id="label" type="text" placeholder="Subscription 2" autocomplete="off" spellcheck="false">
  </div>

  <div class="methods" id="methods">
    <button class="method primary" data-method="browser">
      <span class="glyph">↗</span>
      <span><b>Sign in with ChatGPT</b><span>Opens your browser and waits for you to finish</span></span>
    </button>
    <button class="method" data-method="device">
      <span class="glyph">⌘</span>
      <span><b>Use a device code</b><span>For remote or headless machines, or a different device</span></span>
    </button>
    <button class="method" data-method="apikey">
      <span class="glyph">⚿</span>
      <span><b>Use an API key</b><span>Billed per token, not against a subscription</span></span>
    </button>
  </div>

  <div class="field" id="apiKeyField" hidden>
    <label for="apiKey">OpenAI API key</label>
    <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false">
    <div class="row">
      <button class="action primary" id="apiKeySubmit">Sign in with this key</button>
      <button class="action" data-cancel>Back</button>
    </div>
    <p class="note">The key is passed straight to <code>codex</code> on standard input. Context Bridge does not store or log it.</p>
  </div>

  <div class="panel" id="progress" hidden>
    <div class="status" id="statusRow"><span class="spinner"></span><span id="statusText">Starting sign-in…</span></div>
    <div id="deviceBlock" hidden>
      <div class="code" id="deviceCode"></div>
      <p class="note" id="deviceHint"></p>
      <div class="row">
        <button class="action primary" id="openVerify">Open the sign-in page</button>
        <button class="action" id="copyCode">Copy code</button>
      </div>
    </div>
    <div id="browserBlock" hidden>
      <p class="note">Your browser should have opened. If it did not, use this link:</p>
      <p class="link" id="authLink"></p>
    </div>
    <div class="row"><button class="action" data-cancel>Cancel</button></div>
  </div>

  <div class="panel" id="result" hidden>
    <p id="resultText"></p>
    <div class="row"><button class="action primary" id="closeButton">Done</button></div>
  </div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let method = 'browser';

// Ambient background: slow drifting colour fields, drawn from the editor's own
// accent so it belongs to whatever theme is active. Static under reduced motion.
(function background() {
  const canvas = $('bg');
  const ctx = canvas.getContext('2d');
  const accent = getComputedStyle(document.body).getPropertyValue('--vscode-button-background').trim() || '#3b82f6';
  let width = 0, height = 0;

  function size() {
    const ratio = window.devicePixelRatio || 1;
    width = canvas.clientWidth; height = canvas.clientHeight;
    canvas.width = width * ratio; canvas.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  const blobs = [
    { x: 0.24, y: 0.28, r: 0.42, dx: 0.00007, dy: 0.00005 },
    { x: 0.78, y: 0.62, r: 0.38, dx: -0.00005, dy: 0.00008 },
    { x: 0.52, y: 0.86, r: 0.34, dx: 0.00006, dy: -0.00006 }
  ];
  function draw(time) {
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = 0.16;
    for (const blob of blobs) {
      const x = (blob.x + Math.sin(time * blob.dx) * 0.06) * width;
      const y = (blob.y + Math.cos(time * blob.dy) * 0.06) * height;
      const r = blob.r * Math.min(width, height);
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, accent);
      gradient.addColorStop(1, 'transparent');
      ctx.fillStyle = gradient;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function frame(time) { draw(time); requestAnimationFrame(frame); }
  window.addEventListener('resize', () => { size(); if (reduced) draw(0); });
  size();
  if (reduced) draw(0); else requestAnimationFrame(frame);
})();

function show(view) {
  $('methods').hidden = view !== 'choose';
  $('nameField').hidden = view !== 'choose' || $('nameField').dataset.locked === 'true';
  $('apiKeyField').hidden = view !== 'apikey';
  $('progress').hidden = view !== 'progress';
  $('result').hidden = view !== 'result';
}

function start(payload) {
  vscode.postMessage(Object.assign({ type: 'start', method, label: $('label').value }, payload || {}));
  show('progress');
  $('statusText').textContent = 'Starting sign-in…';
  $('deviceBlock').hidden = true;
  $('browserBlock').hidden = true;
}

document.querySelectorAll('[data-method]').forEach((button) => {
  button.addEventListener('click', () => {
    method = button.dataset.method;
    if (method === 'apikey') { show('apikey'); $('apiKey').focus(); return; }
    start();
  });
});
$('apiKeySubmit').addEventListener('click', () => {
  const key = $('apiKey').value.trim();
  if (!key) { $('apiKey').focus(); return; }
  start({ apiKey: key });
  $('apiKey').value = '';
});
document.querySelectorAll('[data-cancel]').forEach((button) =>
  button.addEventListener('click', () => { vscode.postMessage({ type: 'cancel' }); show('choose'); }));
$('closeButton').addEventListener('click', () => { show('choose'); });
$('openVerify').addEventListener('click', () => {
  const url = $('openVerify').dataset.url;
  if (url) vscode.postMessage({ type: 'openExternal', url });
});
$('copyCode').addEventListener('click', () =>
  vscode.postMessage({ type: 'copy', value: $('deviceCode').textContent }));

window.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'ready') {
    $('label').value = data.label || '';
    $('nameField').dataset.locked = data.locked ? 'true' : 'false';
    show('choose');
  }
  if (data.type === 'idle') show('choose');
  if (data.type === 'running') {
    $('statusText').textContent = data.method === 'device'
      ? 'Requesting a device code…'
      : data.method === 'apikey' ? 'Verifying the key…' : 'Opening your browser…';
  }
  if (data.type === 'progress') {
    const parsed = data.parsed || {};
    if (parsed.deviceCode) {
      $('deviceBlock').hidden = false;
      $('deviceCode').textContent = parsed.deviceCode;
      $('deviceHint').textContent = 'Enter this code after signing in'
        + (parsed.expiresIn ? '. It expires in ' + parsed.expiresIn + '.' : '.');
      $('statusText').textContent = 'Waiting for you to enter the code…';
      if (parsed.verificationUrl) $('openVerify').dataset.url = parsed.verificationUrl;
    }
    if (parsed.authorizeUrl) {
      $('browserBlock').hidden = false;
      $('authLink').textContent = parsed.authorizeUrl;
      $('authLink').onclick = () => vscode.postMessage({ type: 'openExternal', url: parsed.authorizeUrl });
      $('statusText').textContent = 'Waiting for you to finish in the browser…';
    }
  }
  if (data.type === 'copied') $('copyCode').textContent = 'Copied';
  if (data.type === 'done') {
    show('result');
    $('resultText').innerHTML = '<span class="ok">Connected.</span> '
      + (data.email ? String(data.email).replace(/[&<>]/g, '') + ' is now available as “' : '“')
      + String(data.label || '').replace(/[&<>]/g, '') + '”.';
  }
  if (data.type === 'failed') {
    show('result');
    $('resultText').innerHTML = '<span class="error">Sign-in did not complete.</span><br>'
      + String(data.message || '').replace(/[&<>]/g, '');
  }
});
</script>
</body>
</html>`;
}

module.exports = { CodexLoginPanel };
