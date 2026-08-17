const vscode = require('vscode');

// Codex subscriptions, shaped for switching rather than for reading.
//
// The list mirrors what the official client cannot offer: every subscription
// you hold, what each has left, and which one the official Codex UI is using
// right now. Clicking a row switches to it - the primary action is the whole
// point of the panel, so it is a single click rather than a context menu.
class AccountsProvider {
  constructor(core) {
    this.core = core;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.usage = new Map();
    this.activeId = undefined;
    this.onDidChangeActive = new vscode.EventEmitter();
  }

  refresh() {
    this.emitter.fire();
  }

  async accounts() {
    const { listAccounts } = await this.core();
    return listAccounts({ provider: 'codex' });
  }

  async reloadActive(accounts) {
    const { activeCodexAccountId } = await this.core();
    const list = accounts || (await this.accounts());
    this.activeId = await activeCodexAccountId(list);
    this.onDidChangeActive.fire(this.summary(list));
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
    this.refresh();
    return accounts;
  }

  // What the status bar shows: the account in use and how much it has left.
  summary(accounts) {
    const active = (accounts || []).find((account) => account.id === this.activeId);
    if (!active) return { label: undefined };
    const usage = this.usage.get(active.id);
    return { label: active.label, remaining: usage ? headline(usage) : undefined };
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (element?.windows) return element.windows.map((window) => windowItem(window));
    if (element) return [];

    const accounts = await this.accounts();
    if (accounts.length === 0) return [addItem('Add a subscription')];

    if (this.activeId === undefined) await this.reloadActive(accounts);

    const rows = accounts.map((account) =>
      accountItem(account, this.usage.get(account.id), account.id === this.activeId)
    );
    return [pooledItem(accounts, this.usage), ...rows, addItem('Add another subscription')];
  }
}

// Mirrors the pooled figure in the reference UI: the sum of what every
// subscription has left, which is what you actually have available across all
// of them before any of them has to be switched away from.
function pooledItem(accounts, usageMap) {
  const values = accounts
    .map((account) => (usageMap.get(account.id) ? headline(usageMap.get(account.id)) : undefined))
    .filter((value) => typeof value === 'number');

  const item = new vscode.TreeItem('Usage remaining', vscode.TreeItemCollapsibleState.None);
  const count = `${accounts.length} connected subscription${accounts.length === 1 ? '' : 's'}`;
  item.description =
    values.length > 0 ? `${count} · ${formatPercent(values.reduce((sum, value) => sum + value, 0))}` : count;
  item.iconPath = new vscode.ThemeIcon('dashboard');
  item.contextValue = 'contextBridgePooled';
  item.tooltip = new vscode.MarkdownString(
    values.length > 0
      ? `Summed remaining quota across ${accounts.length} subscription(s).\n\nEach figure is that account's tightest window.`
      : 'Quota has not been read yet. Use the refresh button above.'
  );
  return item;
}

function addItem(label) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('add');
  item.command = { command: 'contextBridge.addCodexAccount', title: label };
  item.contextValue = 'contextBridgeAdd';
  return item;
}

function accountItem(account, usage, isActive) {
  const windows = usage?.windows || [];
  const item = new vscode.TreeItem(
    account.label,
    windows.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  );

  const remaining = usage ? headline(usage) : undefined;
  item.description = describeAccount(account, usage, remaining, isActive);
  item.iconPath = accountIcon(usage, remaining, isActive);
  item.contextValue = isActive ? 'contextBridgeCodexAccountActive' : 'contextBridgeCodexAccount';
  item.id = account.id;
  item.windows = windows;
  item.account = account;
  item.tooltip = accountTooltip(account, usage, remaining, isActive);

  // Single click switches. Every subscription stays signed in, so this is cheap
  // and reversible rather than something to guard behind a confirmation.
  if (!isActive) {
    item.command = { command: 'contextBridge.switchAccount', title: 'Use this subscription', arguments: [item] };
  }
  return item;
}

function describeAccount(account, usage, remaining, isActive) {
  const parts = [];
  if (usage?.error === 'not-signed-in') parts.push('not signed in');
  else if (usage?.error) parts.push(`unavailable — ${usage.error}`);
  else if (remaining !== undefined) parts.push(formatPercent(remaining));
  else if (usage) parts.push('quota unavailable');

  if (account.plan) parts.push(planLabel(account.plan));
  if (isActive) parts.push('in use');
  return parts.join(' · ');
}

// Encode state in form as well as number, so the account in use and an
// exhausted account both read without parsing text.
function accountIcon(usage, remaining, isActive) {
  const color = (name) => new vscode.ThemeColor(name);
  if (isActive) return new vscode.ThemeIcon('check', color('testing.iconPassed'));
  if (usage?.error === 'not-signed-in') return new vscode.ThemeIcon('circle-outline');
  if (usage?.error) return new vscode.ThemeIcon('warning', color('problemsWarningIcon.foreground'));
  if (remaining === undefined) return new vscode.ThemeIcon('account');
  if (remaining <= 5) return new vscode.ThemeIcon('circle-slash', color('problemsErrorIcon.foreground'));
  if (remaining <= 20) return new vscode.ThemeIcon('circle-filled', color('problemsWarningIcon.foreground'));
  return new vscode.ThemeIcon('circle-filled', color('charts.blue'));
}

function accountTooltip(account, usage, remaining, isActive) {
  const lines = [`**${account.label}**`, ''];
  if (account.email) lines.push(account.email);
  if (account.plan) lines.push(`Plan: ${planLabel(account.plan)}`);
  lines.push(isActive ? '_Codex is using this subscription._' : '_Click to switch Codex to this subscription._');
  lines.push('');

  if (usage?.error === 'not-signed-in') {
    lines.push('Not signed in. Use **Sign In** to run `codex login` for this subscription.');
  } else if (usage?.error) {
    lines.push(`Quota unavailable: ${usage.error}`);
  } else if ((usage?.windows || []).length > 0) {
    lines.push(`Remaining, tightest window: **${formatPercent(remaining)}**`, '');
    for (const window of usage.windows) {
      lines.push(`- ${window.label}: ${formatPercent(window.remainingPercent)} left${resetSuffix(window.resetsAt)}`);
    }
    lines.push('', `_Read ${age(usage.fetchedAt)}${usage.staleReason ? ` · refresh failed: ${usage.staleReason}` : ''}_`);
  } else if (usage) {
    lines.push('Quota returned no recognizable windows. Run **Show Raw Usage Response** to see what came back.');
  } else {
    lines.push('Quota not read yet.');
  }

  return new vscode.MarkdownString(lines.join('\n'));
}

function windowItem(window) {
  const item = new vscode.TreeItem(window.label, vscode.TreeItemCollapsibleState.None);
  item.description = `${formatPercent(window.remainingPercent)} left${resetSuffix(window.resetsAt)}`;
  item.iconPath = new vscode.ThemeIcon('pulse');
  item.tooltip = `${formatPercent(window.usedPercent)} used of the ${window.label} window`;
  return item;
}

function headline(usage) {
  const values = (usage?.windows || [])
    .map((window) => window.remainingPercent)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : undefined;
}

function resetSuffix(resetsAt) {
  const at = Date.parse(resetsAt || '');
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((at - Date.now()) / 60000);
  if (minutes <= 0) return ' · resetting';
  if (minutes < 60) return ` · resets in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return ` · resets in ${hours}h`;
  return ` · resets in ${Math.round(hours / 24)}d`;
}

function age(fetchedAt) {
  const at = Date.parse(fetchedAt || '');
  if (!Number.isFinite(at)) return 'just now';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function planLabel(plan) {
  return String(plan).replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

module.exports = { AccountsProvider };
