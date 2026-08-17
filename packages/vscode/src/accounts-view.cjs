const crypto = require('node:crypto');
const vscode = require('vscode');

// Codex subscriptions.
//
// Split into a store (what we know) and a webview (how it looks). The panel is
// a webview rather than a tree because the useful presentation here is a
// meter: a percentage is much easier to judge against a filled bar than as a
// number, and a TreeItem cannot render one.

class AccountsStore {
  constructor(core) {
    this.core = core;
    this.usage = new Map();
    this.activeId = undefined;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  async accounts() {
    const { listAccounts } = await this.core();
    return listAccounts({ provider: 'codex' });
  }

  async reloadActive(accounts) {
    const { activeCodexAccountId } = await this.core();
    const list = accounts || (await this.accounts());
    this.activeId = await activeCodexAccountId(list);
    return this.activeId;
  }

  async reloadUsage(options = {}) {
    const { getCodexUsage } = await this.core();
    const accounts = await this.accounts();
    await Promise.all(
      accounts.map(async (account) => {
        try {
          this.usage.set(account.id, await getCodexUsage(account.id, options));
        } catch (error) {
          this.usage.set(account.id, { error: error.message, windows: [] });
        }
      })
    );
    await this.reloadActive(accounts);
    this.emitter.fire(await this.viewModel(accounts));
    return accounts;
  }

  async refresh() {
    this.emitter.fire(await this.viewModel());
  }

  // Everything the panel and the status bar draw, resolved in one place so the
  // two can never disagree about which subscription is in use.
  async viewModel(known) {
    const { isSignedIn } = await this.core();
    const accounts = known || (await this.accounts());
    if (this.activeId === undefined && accounts.length > 0) await this.reloadActive(accounts);

    // Read sign-in state from disk rather than inferring it from a quota
    // result: a subscription that has never been polled has no usage record at
    // all, and treating that as signed in offered "Use this" on an account that
    // could not possibly be switched to.
    const signedIn = new Map(
      await Promise.all(accounts.map(async (account) => [account.id, await isSignedIn(account.id).catch(() => false)]))
    );

    const rows = accounts.map((account) => {
      const usage = this.usage.get(account.id);
      const windows = usage?.windows || [];
      const remaining = remainingOf(usage);
      return {
        id: account.id,
        label: account.label,
        plan: account.plan ? planLabel(account.plan) : undefined,
        email: usage?.email || account.email,
        active: account.id === this.activeId,
        signedIn: signedIn.get(account.id) === true,
        error: usage?.error === 'not-signed-in' ? undefined : usage?.error,
        limitReached: Boolean(usage?.limitReached),
        credits: usage?.credits,
        remaining,
        resetsAt: nextReset(windows),
        fetchedAt: usage?.fetchedAt,
        staleReason: usage?.staleReason,
        loaded: Boolean(usage),
        windows: windows.map((window) => ({
          label: window.label,
          remaining: window.remainingPercent,
          resetsAt: window.resetsAt
        }))
      };
    });

    const values = rows.map((row) => row.remaining).filter((value) => typeof value === 'number');
    return {
      rows,
      pooled: {
        count: rows.length,
        total: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined,
        // The pooled bar is an average so it stays on a 0-100 scale even as
        // subscriptions are added; the headline number stays the sum, which is
        // what "how much do I have across everything" actually means.
        average: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined
      }
    };
  }

  async summary() {
    const accounts = await this.accounts();
    const active = accounts.find((account) => account.id === this.activeId);
    if (!active) return { label: undefined };
    const usage = this.usage.get(active.id);
    return { label: active.label, remaining: remainingOf(usage), limitReached: Boolean(usage?.limitReached) };
  }
}

class AccountsWebview {
  constructor(store) {
    this.store = store;
    this.view = undefined;
    store.onDidChange((model) => this.post(model));
  }

  async resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);

    view.webview.onDidReceiveMessage((message) => {
      const commands = {
        switch: 'contextBridge.switchAccount',
        signin: 'contextBridge.signInAccount',
        terminal: 'contextBridge.openAccountTerminal',
        raw: 'contextBridge.showRawUsage',
        forget: 'contextBridge.forgetAccount',
        purge: 'contextBridge.forgetAccount',
        add: 'contextBridge.addCodexAccount',
        import: 'contextBridge.importCodexAccount',
        refresh: 'contextBridge.refreshAccountQuota'
      };
      const command = commands[message?.type];
      if (!command) return;
      // `confirmed` tells the handler the panel already asked in the card, so
      // it must not raise a dialog of its own.
      vscode.commands.executeCommand(
        command,
        message.id ? { accountId: message.id, confirmed: true, purge: Boolean(message.purge) } : undefined
      );
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) this.store.refresh();
    });
    this.post(await this.store.viewModel());
  }

  post(model) {
    if (this.view?.visible) this.view.webview.postMessage({ type: 'state', model });
  }
}

function remainingOf(usage) {
  const values = (usage?.windows || [])
    .map((window) => window.remainingPercent)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : undefined;
}

function nextReset(windows) {
  const times = (windows || [])
    .map((window) => Date.parse(window.resetsAt || ''))
    .filter((value) => Number.isFinite(value));
  return times.length > 0 ? new Date(Math.min(...times)).toISOString() : undefined;
}

function planLabel(plan) {
  return String(plan).replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

// All colours come from the editor's own theme tokens, so the panel follows
// whatever theme is active - including the high-contrast ones - instead of
// shipping a palette that only suits the default dark.
function html(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root {
    --gap: 10px;
    --radius: 6px;
    --hairline: var(--vscode-panel-border, rgba(128,128,128,0.25));
    --dim: var(--vscode-descriptionForeground);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--gap) 0 16px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  .pool {
    margin: 0 var(--gap) 6px;
    padding: 10px 12px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--vscode-editorWidget-background, transparent);
  }
  .pool-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .pool-title { font-weight: 600; }
  .pool-total { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 1.1em; }
  .pool-sub { color: var(--dim); font-size: 0.9em; margin-top: 2px; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .item {
    margin: 0 var(--gap);
    padding: 9px 10px;
    border: 1px solid transparent;
    border-radius: var(--radius);
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.active { border-color: var(--vscode-focusBorder); background: var(--vscode-list-inactiveSelectionBackground); }
  .head { display: flex; align-items: center; gap: 9px; }
  .avatar {
    flex: none;
    width: 26px; height: 26px;
    border-radius: 50%;
    display: grid; place-items: center;
    font-size: 0.8em; font-weight: 700;
    color: var(--vscode-editor-background, #1e1e1e);
    background: var(--tint);
  }
  .ident { min-width: 0; flex: 1; }
  .name { display: flex; align-items: center; gap: 6px; }
  .name b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plan {
    flex: none;
    font-size: 0.75em; letter-spacing: 0.02em;
    padding: 1px 6px; border-radius: 999px;
    border: 1px solid var(--hairline); color: var(--dim);
  }
  .email { color: var(--dim); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pct { flex: none; font-variant-numeric: tabular-nums; font-weight: 600; }
  .pct.warn { color: var(--vscode-charts-yellow); }
  .pct.crit { color: var(--vscode-charts-red); }
  /* The track must not carry opacity: it applies to the fill inside too, which
     washed every bar out to 35%. Dim the track's own colour instead. */
  .bar {
    position: relative; overflow: hidden;
    height: 5px; margin-top: 8px;
    border-radius: 999px;
    background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.25));
  }
  .bar > i {
    position: absolute; inset: 0 auto 0 0;
    border-radius: 999px;
    background: var(--fill);
    transition: width 220ms ease;
  }
  .meta {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-top: 6px; color: var(--dim); font-size: 0.85em;
  }
  .badge { color: var(--vscode-charts-green); font-weight: 600; }
  .badge.crit { color: var(--vscode-charts-red); }
  /* Always visible. Hiding actions until hover is what sent people to the
     command palette in the first place. */
  .actions { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
  .confirm {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    margin-top: 8px; padding-top: 8px;
    border-top: 1px solid var(--hairline);
    font-size: 0.85em; color: var(--dim);
  }
  .confirm .danger {
    background: var(--vscode-inputValidation-errorBackground, transparent);
    border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-charts-red));
    color: var(--vscode-foreground);
  }
  [hidden] { display: none !important; }
  button {
    font-family: inherit; font-size: 0.85em;
    padding: 3px 9px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .add {
    margin: 8px var(--gap) 0;
    width: calc(100% - var(--gap) * 2);
    text-align: center; padding: 7px;
    border: 1px dashed var(--hairline); background: transparent; color: var(--dim);
  }
  .add:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .empty { padding: 14px var(--gap); color: var(--dim); line-height: 1.5; }
  .windows { margin: 7px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
  .windows li { display: flex; justify-content: space-between; gap: 8px; color: var(--dim); font-size: 0.85em; }
  .windows b { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--vscode-foreground); }
  @media (prefers-reduced-motion: reduce) { .bar > i { transition: none; } }
</style>
</head>
<body>
<div id="root"><div class="empty">Loading subscriptions…</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const TINTS = ['--vscode-charts-blue','--vscode-charts-purple','--vscode-charts-green','--vscode-charts-orange','--vscode-charts-red','--vscode-charts-yellow'];

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(value) {
  if (typeof value !== 'number' || !isFinite(value)) return '—';
  return (Number.isInteger(value) ? value : value.toFixed(1)) + '%';
}
function tint(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 'var(' + TINTS[hash % TINTS.length] + ')';
}
function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '';
  const [name, domain] = email.split('@');
  return name.slice(0, 1) + '•••@' + domain;
}
function until(iso) {
  const at = Date.parse(iso || '');
  if (!isFinite(at)) return '';
  const minutes = Math.round((at - Date.now()) / 60000);
  if (minutes <= 0) return 'resetting now';
  if (minutes < 60) return 'resets in ' + minutes + 'm';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return 'resets in ' + hours + 'h';
  return 'resets in ' + Math.round(hours / 24) + 'd';
}
function level(row) {
  if (row.limitReached || (typeof row.remaining === 'number' && row.remaining <= 5)) return 'crit';
  if (typeof row.remaining === 'number' && row.remaining <= 20) return 'warn';
  return 'ok';
}
function fillColor(name) {
  return name === 'crit' ? 'var(--vscode-charts-red)'
    : name === 'warn' ? 'var(--vscode-charts-yellow)'
    : 'var(--vscode-charts-green)';
}

function renderRow(row) {
  const state = level(row);
  const width = typeof row.remaining === 'number' ? Math.max(row.remaining, row.remaining > 0 ? 2 : 0) : 0;

  let status;
  if (!row.signedIn) status = 'Not signed in';
  else if (row.error) status = esc(row.error);
  else if (row.limitReached) status = 'Limit reached';
  else if (!row.loaded) status = 'Quota not read';
  else if (typeof row.remaining !== 'number') status = 'Quota unavailable';
  else status = until(row.resetsAt);

  const credits = row.credits && row.credits.hasCredits
    ? (row.credits.unlimited ? ' · unlimited credits' : ' · ' + row.credits.balance + ' credits')
    : '';

  const windows = (row.windows || []).length > 1
    ? '<ul class="windows">' + row.windows.map((w) =>
        '<li><span>' + esc(w.label) + '</span><b>' + pct(w.remaining) + '</b></li>').join('') + '</ul>'
    : '';

  return '<li class="item' + (row.active ? ' active' : '') + '">' +
    '<div class="head">' +
      '<span class="avatar" style="--tint:' + tint(row.id) + '">' + esc((row.label || '?').slice(0, 1).toUpperCase()) + '</span>' +
      '<span class="ident">' +
        '<span class="name"><b>' + esc(row.label) + '</b>' +
          (row.plan ? '<span class="plan">' + esc(row.plan) + '</span>' : '') +
        '</span>' +
        '<span class="email">' + esc(maskEmail(row.email)) + '</span>' +
      '</span>' +
      '<span class="pct ' + (state === 'ok' ? '' : state) + '">' +
        (row.signedIn && typeof row.remaining === 'number' ? pct(row.remaining) : '—') +
      '</span>' +
    '</div>' +
    '<div class="bar"><i style="width:' + width + '%;--fill:' + fillColor(state) + '"></i></div>' +
    '<div class="meta"><span>' + status + esc(credits) + '</span>' +
      (row.active ? '<span class="badge' + (state === 'crit' ? ' crit' : '') + '">In use</span>' : '') +
    '</div>' +
    windows +
    '<div class="actions">' +
      (row.active || !row.signedIn ? '' : '<button class="primary" data-act="switch" data-id="' + esc(row.id) + '">Use this</button>') +
      (row.signedIn ? '' : '<button class="primary" data-act="signin" data-id="' + esc(row.id) + '">Sign in</button>') +
      (row.signedIn ? '<button data-act="terminal" data-id="' + esc(row.id) + '">Terminal</button>' : '') +
      (row.signedIn ? '<button data-act="raw" data-id="' + esc(row.id) + '">Raw Response</button>' : '') +
      '<button data-ask="' + esc(row.id) + '">Remove</button>' +
    '</div>' +
    '<div class="confirm" id="confirm-' + esc(row.id) + '" hidden>' +
      '<span>Remove this subscription?</span>' +
      '<button data-act="forget" data-id="' + esc(row.id) + '">Forget</button>' +
      '<button class="danger" data-act="purge" data-id="' + esc(row.id) + '">Delete credentials</button>' +
      '<button data-cancel="' + esc(row.id) + '">Cancel</button>' +
    '</div>' +
  '</li>';
}

function render(model) {
  const root = document.getElementById('root');
  if (!model || model.rows.length === 0) {
    root.innerHTML = '<div class="empty">No Codex subscriptions yet.<br>Add one, or import the login you already have.</div>' +
      '<button class="add" data-act="add">+ Add a subscription</button>' +
      '<button class="add" data-act="import">Import current Codex login</button>';
    return;
  }

  const pooled = model.pooled;
  root.innerHTML =
    '<div class="pool">' +
      '<div class="pool-top"><span class="pool-title">Usage remaining</span>' +
        '<span class="pool-total">' + (pooled.total === undefined ? '—' : pct(pooled.total)) + '</span></div>' +
      '<div class="pool-sub">' + pooled.count + ' connected subscription' + (pooled.count === 1 ? '' : 's') + '</div>' +
      '<div class="bar"><i style="width:' + (pooled.average || 0) + '%;--fill:var(--vscode-charts-blue)"></i></div>' +
    '</div>' +
    '<ul class="list">' + model.rows.map(renderRow).join('') + '</ul>' +
    '<button class="add" data-act="add">+ Add another subscription</button>';
}

// Confirmation for a destructive action happens here, in the card, so acting on
// something in this panel never hands the user off to a dialog or a picker.
document.addEventListener('click', (event) => {
  const ask = event.target.closest('[data-ask]');
  if (ask) {
    const panel = document.getElementById('confirm-' + ask.dataset.ask);
    if (panel) panel.hidden = !panel.hidden;
    return;
  }
  const cancel = event.target.closest('[data-cancel]');
  if (cancel) {
    const panel = document.getElementById('confirm-' + cancel.dataset.cancel);
    if (panel) panel.hidden = true;
    return;
  }
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  vscode.postMessage({ type: act, id: button.dataset.id, purge: act === 'purge' });
});

window.addEventListener('message', (event) => {
  if (event.data?.type === 'state') render(event.data.model);
});
</script>
</body>
</html>`;
}

module.exports = { AccountsStore, AccountsWebview };
