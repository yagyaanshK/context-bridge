const vscode = require('vscode');

// Tree of Codex subscriptions with their remaining quota.
//
// Two nesting levels, because they answer different questions: the account row
// answers "can I use this one right now" with the tightest window's remaining
// percentage, and its children break that down per window so you can see which
// limit is the binding one and when it lifts.
class AccountsProvider {
  constructor(core) {
    this.core = core;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.usage = new Map();
  }

  refresh() {
    this.emitter.fire();
  }

  async reloadUsage(options = {}) {
    const { listAccounts, getCodexUsage } = await this.core();
    const accounts = await listAccounts({ provider: 'codex' });
    await Promise.all(
      accounts.map(async (account) => {
        try {
          this.usage.set(account.id, await getCodexUsage(account.id, options));
        } catch (error) {
          this.usage.set(account.id, { error: error.message, windows: [] });
        }
      })
    );
    this.refresh();
    return accounts;
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    const { listAccounts, headlineRemaining } = await this.core();

    if (element?.windows) {
      return element.windows.map((window) => windowItem(window));
    }
    if (element) return [];

    const accounts = await listAccounts({ provider: 'codex' });
    if (accounts.length === 0) {
      const empty = new vscode.TreeItem('No Codex accounts yet', vscode.TreeItemCollapsibleState.None);
      empty.description = 'Run "Add Codex Account"';
      empty.iconPath = new vscode.ThemeIcon('account');
      empty.command = { command: 'contextBridge.addCodexAccount', title: 'Add Codex Account' };
      return [empty];
    }

    return accounts.map((account) => accountItem(account, this.usage.get(account.id), headlineRemaining));
  }
}

function accountItem(account, usage, headlineRemaining) {
  const windows = usage?.windows || [];
  const item = new vscode.TreeItem(
    account.label,
    windows.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  );

  const remaining = usage ? headlineRemaining(usage) : undefined;
  item.description = describeAccount(account, usage, remaining);
  item.iconPath = accountIcon(usage, remaining);
  item.contextValue = 'contextBridgeCodexAccount';
  item.id = account.id;
  item.windows = windows;
  item.account = account;
  item.tooltip = accountTooltip(account, usage, remaining);
  return item;
}

function describeAccount(account, usage, remaining) {
  if (usage?.error === 'not-signed-in') return 'not signed in';
  if (usage?.error) return `unavailable — ${usage.error}`;
  if (remaining === undefined) return account.plan ? planLabel(account.plan) : 'quota not loaded';
  const parts = [`${formatPercent(remaining)} left`];
  if (account.plan) parts.push(planLabel(account.plan));
  if (usage?.fromCache) parts.push(age(usage.fetchedAt));
  return parts.join(' · ');
}

// Encode state in form as well as number, so an exhausted account reads at a
// glance without parsing the percentage.
function accountIcon(usage, remaining) {
  if (usage?.error === 'not-signed-in') return new vscode.ThemeIcon('circle-outline');
  if (usage?.error) return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  if (remaining === undefined) return new vscode.ThemeIcon('account');
  if (remaining <= 5) return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('problemsErrorIcon.foreground'));
  if (remaining <= 20) return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
}

function accountTooltip(account, usage, remaining) {
  const lines = [`**${account.label}**`, ''];
  if (account.email) lines.push(`${account.email}`);
  if (account.plan) lines.push(`Plan: ${planLabel(account.plan)}`);
  lines.push(`Home: \`${account.dir}\``);
  lines.push('');

  if (usage?.error === 'not-signed-in') {
    lines.push('_Not signed in. Use "Sign In" to run `codex login` for this account._');
  } else if (usage?.error) {
    lines.push(`_Quota unavailable: ${usage.error}_`);
  } else if ((usage?.windows || []).length > 0) {
    lines.push(`Remaining (tightest window): **${formatPercent(remaining)}**`, '');
    for (const window of usage.windows) {
      lines.push(`- ${window.label}: ${formatPercent(window.remainingPercent)} left${resetSuffix(window.resetsAt)}`);
    }
    lines.push('', `_Read ${age(usage.fetchedAt)}${usage.staleReason ? ` · refresh failed: ${usage.staleReason}` : ''}_`);
  } else {
    lines.push('_Quota not loaded yet._');
  }

  const tooltip = new vscode.MarkdownString(lines.join('\n'));
  tooltip.supportThemeIcons = true;
  return tooltip;
}

function windowItem(window) {
  const item = new vscode.TreeItem(window.label, vscode.TreeItemCollapsibleState.None);
  item.description = `${formatPercent(window.remainingPercent)} left${resetSuffix(window.resetsAt)}`;
  item.iconPath = new vscode.ThemeIcon('pulse');
  item.tooltip = `${formatPercent(window.usedPercent)} used of the ${window.label} window`;
  return item;
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
