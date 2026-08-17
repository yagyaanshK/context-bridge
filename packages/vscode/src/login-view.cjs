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

    const method = message.method;
    const args = codexLoginArgs(method);
    this.post({ type: 'running', method });

    const result = await this.run(args, codexHome(accountId), method, message.apiKey);
    if (!result.ok) {
      this.post({ type: 'failed', method, message: result.message });
      return;
    }

    const auth = await refreshCodexAccountIdentity(accountId);
    if (!auth) {
      this.post({
        type: 'failed',
        method,
        message: 'Sign-in finished but no credential was written. Try again.'
      });
      return;
    }

    await this.store.reloadUsage({ force: true });
    this.post({ type: 'done', method, email: auth.claims?.email, label: this.target.label });
  }

  run(args, home, method, apiKey) {
    return new Promise((resolve) => {
      const child = spawn('codex', args, {
        env: {
          ...process.env,
          CODEX_HOME: home,
          // Ask for plain output. Highlighting wraps the device code and the
          // links in escape sequences; the parser strips them anyway, but not
          // emitting them is the cheaper half of the fix.
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          CLICOLOR: '0',
          TERM: 'dumb'
        },
        // The launcher on Windows is a shim, not an executable.
        shell: process.platform === 'win32'
      });
      this.child = child;

      let output = '';

      const onChunk = async (chunk) => {
        output += chunk.toString();
        const { parseCodexLoginOutput: parse } = await this.core();
        // `codex login` opens the browser itself. Opening it again from here
        // launched the page twice and raised the editor's own "open external
        // website?" prompt on top of it. The panel offers the link as a manual
        // fallback instead, for when the CLI could not open one.
        this.post({ type: 'progress', method, parsed: parse(output) });
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
  .method .chev { margin-left: auto; opacity: 0.6; transition: transform 160ms ease; }
  .card.open .method .chev { transform: rotate(180deg); }
  .card {
    border-radius: 9px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28));
    overflow: hidden;
  }
  .card > .method { border: none; border-radius: 0; width: 100%; }
  .card.open { border-color: var(--vscode-focusBorder); }
  .card .body {
    display: flex; flex-direction: column; gap: 13px;
    padding: 15px 16px 16px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28));
    background: var(--vscode-editorWidget-background);
  }
  .outcome {
    margin: 0; padding: 13px 16px; border-radius: 9px; line-height: 1.5;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28));
    background: var(--vscode-editorWidget-background);
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

    <section class="card" data-method="browser">
      <button class="method primary" data-open="browser">
        <span class="glyph">↗</span>
        <span><b>Sign in with ChatGPT</b><span>Opens your browser and waits for you to finish</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="status"><span class="spinner"></span><span data-status>Starting…</span></div>
        <div data-link hidden>
          <p class="note">Your browser should have opened. If it did not, open the page yourself:</p>
          <div class="row"><button class="action primary" data-verify>Open sign-in page</button></div>
          <p class="link" data-authlink></p>
        </div>
        <div class="row">
          <button class="action" data-retry="browser">Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
      </div>
    </section>

    <section class="card" data-method="device">
      <button class="method" data-open="device">
        <span class="glyph">⌗</span>
        <span><b>Use a device code</b><span>For remote or headless machines, or a different device</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="status"><span class="spinner"></span><span data-status>Requesting a code…</span></div>
        <div data-code-block hidden>
          <div class="code" data-code></div>
          <p class="note" data-hint></p>
          <div class="row">
            <button class="action primary" data-verify>Open the sign-in page</button>
            <button class="action" data-copy>Copy code</button>
          </div>
        </div>
        <div class="row">
          <button class="action" data-retry="device">Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
      </div>
    </section>

    <section class="card" data-method="apikey">
      <button class="method" data-open="apikey">
        <span class="glyph">⚿</span>
        <span><b>Use an API key</b><span>Billed per token, not against a subscription</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="field">
          <label for="apiKey">OpenAI API key</label>
          <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false">
        </div>
        <div class="status" data-busy hidden><span class="spinner"></span><span data-status>Verifying…</span></div>
        <div class="row">
          <button class="action primary" data-submit-key>Sign in with this key</button>
          <button class="action" data-retry="apikey" hidden>Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
        <p class="note">The key is passed straight to <code>codex</code> on standard input. Context Bridge does not store or log it.</p>
      </div>
    </section>

  </div>

  <p class="outcome" id="outcome" hidden></p>
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

const card = (name) => document.querySelector('.card[data-method="' + name + '"]');
const within = (name, selector) => card(name).querySelector(selector);
const STARTING = { browser: 'Opening your browser…', device: 'Requesting a code…', apikey: 'Verifying the key…' };

// One method runs at a time, but every method stays on screen. Opening a card
// expands it in place and starts that flow; the others remain available so a
// method that is not working can be abandoned without losing the panel.
function open(name, options = {}) {
  document.querySelectorAll('.card').forEach((element) => {
    const isTarget = element.dataset.method === name;
    element.classList.toggle('open', isTarget);
    element.querySelector('.body').hidden = !isTarget;
  });
  $('outcome').hidden = true;
  method = name;
  reset(name);
  // The API key card collects input before it can run.
  if (name === 'apikey' && !options.run) { $('apiKey').focus(); return; }
  run(name, options.apiKey);
}

function reset(name) {
  const body = card(name).querySelector('.body');
  body.querySelectorAll('[data-link], [data-code-block], [data-busy]').forEach((element) => { element.hidden = true; });
  const status = within(name, '.status');
  if (status && name !== 'apikey') status.hidden = false;
  const copy = within(name, '[data-copy]');
  if (copy) copy.textContent = 'Copy code';
}

function run(name, apiKey) {
  within(name, '[data-status]').textContent = STARTING[name] || 'Starting…';
  const busy = within(name, '[data-busy]');
  if (busy) busy.hidden = false;
  vscode.postMessage({ type: 'start', method: name, label: $('label').value, apiKey });
}

document.querySelectorAll('[data-open]').forEach((button) =>
  button.addEventListener('click', () => {
    const name = button.dataset.open;
    // Clicking the header of the card that is already open collapses it.
    if (card(name).classList.contains('open')) {
      vscode.postMessage({ type: 'cancel' });
      card(name).classList.remove('open');
      card(name).querySelector('.body').hidden = true;
      return;
    }
    vscode.postMessage({ type: 'cancel' });
    open(name);
  }));

document.querySelectorAll('[data-retry]').forEach((button) =>
  button.addEventListener('click', () => {
    const name = button.dataset.retry;
    vscode.postMessage({ type: 'cancel' });
    $('outcome').hidden = true;
    reset(name);
    if (name === 'apikey') {
      const key = $('apiKey').value.trim();
      if (!key) { $('apiKey').focus(); return; }
      run(name, key);
      return;
    }
    run(name);
  }));

document.querySelectorAll('[data-cancel]').forEach((button) =>
  button.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
    document.querySelectorAll('.card').forEach((element) => {
      element.classList.remove('open');
      element.querySelector('.body').hidden = true;
    });
  }));

document.querySelector('[data-submit-key]').addEventListener('click', () => {
  const key = $('apiKey').value.trim();
  if (!key) { $('apiKey').focus(); return; }
  run('apikey', key);
});
$('apiKey').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.querySelector('[data-submit-key]').click();
});

document.querySelectorAll('[data-verify]').forEach((button) =>
  button.addEventListener('click', () => {
    if (button.dataset.url) vscode.postMessage({ type: 'openExternal', url: button.dataset.url });
  }));
document.querySelectorAll('[data-copy]').forEach((button) =>
  button.addEventListener('click', () =>
    vscode.postMessage({ type: 'copy', value: within(method, '[data-code]').textContent })));

window.addEventListener('message', (event) => {
  const data = event.data || {};
  const name = data.method || method;

  if (data.type === 'ready') {
    $('label').value = data.label || '';
    $('nameField').hidden = Boolean(data.locked);
    return;
  }
  if (data.type === 'running') {
    within(name, '[data-status]').textContent = STARTING[name] || 'Starting…';
    return;
  }
  if (data.type === 'progress') {
    const parsed = data.parsed || {};
    if (parsed.deviceCode) {
      within(name, '[data-code-block]').hidden = false;
      within(name, '[data-code]').textContent = parsed.deviceCode;
      within(name, '[data-hint]').textContent = 'Enter this code after signing in'
        + (parsed.expiresIn ? '. It expires in ' + parsed.expiresIn + '.' : '.');
      within(name, '[data-status]').textContent = 'Waiting for you to enter the code…';
      if (parsed.verificationUrl) within(name, '[data-verify]').dataset.url = parsed.verificationUrl;
    }
    if (parsed.authorizeUrl) {
      const block = within(name, '[data-link]');
      if (block) {
        block.hidden = false;
        const link = within(name, '[data-authlink]');
        link.textContent = parsed.authorizeUrl;
        link.onclick = () => vscode.postMessage({ type: 'openExternal', url: parsed.authorizeUrl });
        const verify = within(name, '[data-verify]');
        if (verify) verify.dataset.url = parsed.authorizeUrl;
      }
      within(name, '[data-status]').textContent = 'Waiting for you to finish in the browser…';
    }
    return;
  }
  if (data.type === 'copied') {
    const copy = within(name, '[data-copy]');
    if (copy) copy.textContent = 'Copied';
    return;
  }
  if (data.type === 'done') {
    document.querySelectorAll('.card').forEach((element) => {
      element.classList.remove('open');
      element.querySelector('.body').hidden = true;
    });
    const outcome = $('outcome');
    outcome.hidden = false;
    outcome.innerHTML = '<span class="ok">Connected.</span> '
      + (data.email ? esc(data.email) + ' is now available as “' : '“') + esc(data.label || '') + '”.';
    return;
  }
  if (data.type === 'failed') {
    const status = within(name, '.status');
    if (status) status.hidden = true;
    const busy = within(name, '[data-busy]');
    if (busy) busy.hidden = true;
    const retry = within(name, '[data-retry]');
    if (retry) retry.hidden = false;
    const outcome = $('outcome');
    outcome.hidden = false;
    outcome.innerHTML = '<span class="error">Sign-in did not complete.</span><br>' + esc(data.message || '');
    return;
  }
});

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
</script>
</body>
</html>`;
}

module.exports = { CodexLoginPanel };
