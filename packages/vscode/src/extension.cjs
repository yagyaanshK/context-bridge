const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');
const { AccountsStore, AccountsWebview } = require('./accounts-view.cjs');
const { LoginPanel } = require('./login-view.cjs');

let accountsProvider;
let accountStatus;
let loginPanel;

async function activateExtension(context) {
  accountsProvider = new AccountsStore(core);
  const accountsWebview = new AccountsWebview(accountsProvider);
  loginPanel = new LoginPanel(context, core, accountsProvider);

  // The panel is only visible when its view is open, so the account in use also
  // lives in the status bar - that is where you look while actually working.
  accountStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  accountStatus.command = 'contextBridge.switchAccount';
  accountStatus.name = 'Context Bridge: active account';
  accountsProvider.onDidChange(() => accountsProvider.summary().then(renderStatus));

  context.subscriptions.push(
    accountStatus,
    accountsProvider.emitter,
    vscode.window.registerWebviewViewProvider('contextBridgeAccounts', accountsWebview),
    command('contextBridge.switchAccount', (item) => switchAccount(item)),
    command('contextBridge.showRawUsage', (item) => showRawUsage(item)),
    command('contextBridge.undoAccountSwitch', () => undoAccountSwitch()),
    command('contextBridge.addAccount', (item) => addAccount(item)),
    command('contextBridge.importAccount', (item) => importAccount(item)),
    command('contextBridge.addCodexAccount', () => addAccount({ provider: 'codex' })),
    command('contextBridge.addClaudeAccount', () => addAccount({ provider: 'claude' })),
    command('contextBridge.importCodexAccount', () => importAccount({ provider: 'codex' })),
    command('contextBridge.importClaudeAccount', () => importAccount({ provider: 'claude' })),
    command('contextBridge.signInAccount', (item) => signInAccount(item)),
    command('contextBridge.refreshAccountQuota', () => refreshAccountQuota()),
    command('contextBridge.openAccountTerminal', (item) => openAccountTerminal(item)),
    command('contextBridge.renameAccount', (item) => renameAccount(item)),
    command('contextBridge.forgetAccount', (item) => forgetAccount(item)),
    command('contextBridge.discoverClaude', () => discover('claude')),
    command('contextBridge.discoverCodex', () => discover('codex')),
    command('contextBridge.importLatestClaude', () => importLatest('claude')),
    command('contextBridge.importLatestCodex', () => importLatest('codex')),
    command('contextBridge.handoffToClaudeExisting', () => handoff('claude', 'existing')),
    command('contextBridge.handoffToClaudeNew', () => handoff('claude', 'new')),
    command('contextBridge.handoffToCodexExisting', () => handoff('codex', 'existing')),
    command('contextBridge.handoffToCodexNew', () => handoff('codex', 'new')),
    command('contextBridge.openLatestHandoff', () => openLatestHandoff()),
    command('contextBridge.copyLatestHandoffPrompt', () => copyLatestHandoffPrompt())
  );

  // Populate the panel and status bar from cache on activation. Offline, so
  // opening a window never costs a call to the usage endpoint.
  accountsProvider.reloadUsage({ offline: true }).catch(() => {});
}

function deactivate() {}

// ---------------------------------------------------------------------------
// Codex subscriptions
//
// Each account owns a CODEX_HOME. Signing in, running a session, and reading
// quota all happen against that directory, so several subscriptions stay logged
// in at once and nothing has to be swapped to use a different one.
//
// The one exception is "Set as Default", which writes the official CLI's own
// home. The official Codex CLI and VS Code extension read only that path, so
// pointing them at an account is necessarily machine-wide.
// ---------------------------------------------------------------------------

// Switch which subscription the official Codex CLI and VS Code extension use.
//
// They read only the default CODEX_HOME, so this necessarily rewrites that
// credential rather than scoping anything to one window. It is still a cheap,
// reversible action - every subscription stays signed in on disk - so it runs
// on a single click and offers an undo afterwards instead of a confirmation
// prompt beforehand.
async function switchAccount(item) {
  const account = await resolveAccount(item, { excludeActive: true });
  if (!account) return;

  const { activateCodexAccount, activateClaudeAccount } = await core();
  const activate = account.provider === 'claude' ? activateClaudeAccount : activateCodexAccount;
  await activate(account.id);
  await accountsProvider.reloadUsage({ offline: true });

  const usage = accountsProvider.usage.get(account.id);
  const remaining = usage?.windows?.length
    ? ` · ${formatPercent(Math.min(...usage.windows.map((window) => window.remainingPercent)))} left`
    : '';

  vscode.window
    .showInformationMessage(
      `${agentName(account.provider)} is now using "${account.label}"${remaining}. Reload if an open session does not pick it up.`,
      'Reload Window',
      'Undo'
    )
    .then((choice) => {
      if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
      else if (choice === 'Undo') undoAccountSwitch({ provider: account.provider });
    });
}

function agentName(provider) {
  return provider === 'claude' ? 'Claude Code' : 'Codex';
}

async function undoAccountSwitch(item) {
  const { restoreCodexBackup, restoreClaudeBackup } = await core();
  const provider = item?.provider === 'claude' ? 'claude' : 'codex';
  const restore = provider === 'claude' ? restoreClaudeBackup : restoreCodexBackup;
  await restore();
  await accountsProvider.reloadUsage({ offline: true });
  vscode.window.showInformationMessage(`Context Bridge: restored the previous ${agentName(provider)} login.`);
}

// The usage payload is not a published contract, so when the panel cannot find
// any windows this shows exactly what came back. Beats guessing at the shape.
async function showRawUsage(item) {
  const account = await resolveAccount(item);
  if (!account) return;

  const api = await core();
  const claude = account.provider === 'claude';

  const endpoint = claude ? api.CLAUDE_USAGE_URL : api.CODEX_USAGE_URL;
  const auth = claude
    ? await api.ensureClaudeAccessToken(account.id)
    : await api.readCodexAuth(api.codexHome(account.id));
  if (!auth?.accessToken) throw new Error(`"${account.label}" is not signed in.`);

  const headers = claude
    ? api.claudeApiHeaders(auth.accessToken)
    : {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'context-bridge',
        ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {})
      };

  const raw = await withProgress(`Reading usage for ${account.label}`, async () => {
    const response = await fetch(endpoint, { headers });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  });

  const parse = claude ? api.fetchClaudeUsage : api.fetchCodexUsage;
  const parsed = await parse(auth).catch((error) => ({ error: error.message }));
  const document = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify(
      {
        note: `Raw response from the ${agentName(account.provider)} usage endpoint, plus how Context Bridge parsed it. No tokens are included.`,
        endpoint,
        httpStatus: raw.status,
        rawResponse: raw.body,
        parsedByContextBridge: parsed
      },
      null,
      2
    )
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

function renderStatus(summary) {
  if (!summary?.label) {
    accountStatus.hide();
    return;
  }
  const remaining = summary.remaining;
  accountStatus.text =
    remaining === undefined
      ? `$(arrow-swap) ${summary.label}`
      : `$(arrow-swap) ${summary.label} ${formatPercent(remaining)}`;
  accountStatus.tooltip = `${summary.title || 'Codex'} is using "${summary.label}". Click to switch account.`;
  accountStatus.backgroundColor =
    typeof remaining === 'number' && remaining <= 10
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  accountStatus.show();
}

function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

// Naming and sign-in both happen in the panel, so adding an account is one
// uninterrupted flow rather than an input box followed by a terminal.
async function addAccount(item) {
  const provider = await resolveProvider(item);
  if (!provider) return;
  const accounts = await accountsProvider.accounts(provider);
  await loginPanel.open({ provider, label: `${agentName(provider)} ${accounts.length + 1}` });
}

// The panel names the agent it was clicked in; the palette has to ask.
async function resolveProvider(item) {
  if (item?.provider === 'codex' || item?.provider === 'claude') return item.provider;
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Codex', description: 'ChatGPT subscription or API key', provider: 'codex' },
      { label: 'Claude Code', description: 'Claude Pro, Max, Team or Console account', provider: 'claude' }
    ],
    { placeHolder: 'Which agent?' }
  );
  return picked?.provider;
}

async function importAccount(item) {
  const provider = await resolveProvider(item);
  if (!provider) return;

  const api = await core();
  const claude = provider === 'claude';
  const source = claude ? api.defaultClaudeHome() : api.defaultCodexHome();
  const credential = claude ? '.credentials.json' : 'auth.json';
  if (!fs.existsSync(path.join(source, credential))) {
    throw new Error(
      `No existing ${agentName(provider)} login found at ${source}. Sign in from the panel instead.`
    );
  }

  const label = await vscode.window.showInputBox({
    title: `Import current ${agentName(provider)} login`,
    prompt: `Name for the account currently signed in at ${source}`,
    value: 'Primary',
    validateInput: (value) => (value.trim() ? undefined : 'Enter a name.')
  });
  if (!label) return;

  const account = await api.createAccount({ label: label.trim(), provider });
  let auth = claude
    ? await api.importClaudeAuth(account.id, source)
    : await api.importCodexAuth(account.id, source);
  // A Claude credential carries no email; ask the API who it belongs to.
  if (claude) auth = (await api.backfillClaudeProfile(account.id).catch(() => auth)) || auth;

  await accountsProvider.reloadUsage({ force: true });
  vscode.window.showInformationMessage(
    `Context Bridge: imported ${auth?.claims?.email || auth?.email || label.trim()} as "${account.label}". The original login is untouched.`
  );
}

async function signInAccount(item) {
  const account = await resolveAccount(item);
  if (account) {
    await loginPanel.open({ provider: account.provider, accountId: account.id, label: account.label });
  }
}

async function openAccountTerminal(item) {
  const account = await resolveAccount(item);
  if (!account) return;
  const api = await core();
  const claude = account.provider === 'claude';

  const signedIn = claude ? await api.isClaudeSignedIn(account.id) : await api.isSignedIn(account.id);
  if (!signedIn) throw new Error(`"${account.label}" is not signed in yet. Use "Sign In" first.`);

  if (claude) await api.ensureClaudeHome(account.id);
  else await api.ensureCodexHome(account.id);

  const root = await workspaceRoot();
  const terminal = vscode.window.createTerminal({
    name: `${agentName(account.provider)} · ${account.label}`,
    cwd: root,
    // One environment variable is the whole isolation mechanism: the CLI
    // treats whatever it points at as its entire world.
    env: claude ? api.claudeEnv(account.id) : api.codexEnv(account.id)
  });
  terminal.show();
  terminal.sendText(claude ? 'claude' : 'codex');
}

// Rename changes only the display label. The account id forms the path to its
// credential directory and is deliberately left alone, so renaming can never
// invalidate a login or require signing in again.
async function renameAccount(item) {
  const account = await resolveAccount(item);
  if (!account) return;
  const { updateAccount } = await core();

  let label = typeof item?.label === 'string' ? item.label.trim() : '';
  if (!label) {
    // The panel edits inline; the palette has to ask.
    label = (
      await vscode.window.showInputBox({
        title: 'Rename subscription',
        value: account.label,
        prompt: 'This changes the display name only, not the stored login.',
        validateInput: (value) => (value.trim() ? undefined : 'Enter a name.')
      })
    )?.trim();
  }
  if (!label || label === account.label) return;

  await updateAccount(account.id, { label });
  await accountsProvider.reloadUsage({ offline: true });
}

// The panel confirms in the card before calling this, so an invocation carrying
// `confirmed` acts immediately. Only the command palette, which has nowhere to
// put an inline confirmation, falls back to a dialog.
async function forgetAccount(item) {
  const account = await resolveAccount(item);
  if (!account) return;
  const { removeAccount } = await core();

  let purge = Boolean(item?.purge);
  if (!item?.confirmed) {
    const choice = await vscode.window.showWarningMessage(
      `Remove "${account.label}" from Context Bridge?`,
      {
        modal: true,
        detail:
          `"Forget" removes it from this list but leaves its login on disk at ${account.dir}, so it can be added back.\n\n` +
          `"Delete Credentials" also erases that directory. That cannot be undone.`
      },
      'Forget',
      'Delete Credentials'
    );
    if (choice !== 'Forget' && choice !== 'Delete Credentials') return;
    purge = choice === 'Delete Credentials';
  }

  await removeAccount(account.id, { purge });
  accountsProvider.usage.delete(account.id);
  await accountsProvider.reloadUsage({ offline: true });
  vscode.window.setStatusBarMessage(
    `Context Bridge: removed "${account.label}"${purge ? ' and deleted its credentials' : ''}.`,
    4000
  );
}

async function refreshAccountQuota() {
  const accounts = await withProgress('Reading account quota', () =>
    accountsProvider.reloadUsage({ force: true })
  );
  if (accounts.length === 0) {
    vscode.window.showInformationMessage('Context Bridge: no accounts yet. Add one from the Context Bridge panel.');
  }
}

// Invoked from a panel card we already know the account for, or from the
// palette and status bar where we have to ask. The picker spans both agents
// and labels which is which, and shows remaining quota so the choice can be
// made without opening the panel first.
async function resolveAccount(item, options = {}) {
  if (item?.account) return item.account;

  const accounts = await accountsProvider.accounts(item?.provider);
  // Buttons in the panel identify their account directly; the palette and the
  // status bar arrive with nothing and have to ask.
  if (item?.accountId) {
    const known = accounts.find((account) => account.id === item.accountId);
    if (known) return known;
  }

  if (accounts.length === 0) {
    throw new Error('No accounts yet. Add one from the Context Bridge panel first.');
  }

  // "Active" is per agent: switching Codex says nothing about Claude, so each
  // agent contributes its own account to exclude.
  const activeIds = new Set();
  for (const provider of ['codex', 'claude']) {
    if (!accounts.some((account) => account.provider === provider)) continue;
    const activeId = await accountsProvider.reloadActive(provider);
    if (activeId) activeIds.add(activeId);
  }

  const pool = options.excludeActive ? accounts.filter((account) => !activeIds.has(account.id)) : accounts;
  if (pool.length === 0) {
    vscode.window.showInformationMessage('Context Bridge: every account is already in use by its agent.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    pool.map((account) => {
      const usage = accountsProvider.usage.get(account.id);
      const remaining = usage?.windows?.length
        ? Math.min(...usage.windows.map((window) => window.remainingPercent))
        : undefined;
      return {
        label: `${activeIds.has(account.id) ? '$(check) ' : ''}${account.label}`,
        description: [
          agentName(account.provider),
          remaining === undefined ? undefined : `${formatPercent(remaining)} left`,
          account.email
        ]
          .filter(Boolean)
          .join(' · '),
        account
      };
    }),
    { placeHolder: options.excludeActive ? 'Switch to which account?' : 'Choose an account' }
  );
  return picked?.account;
}

function numberSetting(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

// Arguments must be forwarded: commands invoked from the panel carry the
// subscription they act on. Dropping them made every button fall through to the
// "choose a subscription" picker, which is exactly what the panel exists to
// avoid.
function command(name, handler) {
  return vscode.commands.registerCommand(name, async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      vscode.window.showErrorMessage(`Context Bridge: ${error.message}`);
    }
  });
}

async function core() {
  return import('@context-bridge/core');
}

async function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) throw new Error('Open a workspace folder first.');
  if (folders.length === 1) return folders[0].uri.fsPath;
  const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose workspace for Context Bridge' });
  if (!picked) throw new Error('No workspace selected.');
  return picked.uri.fsPath;
}

// Pick the native session to use as a source. A native session records the
// folder it was started in; agents (e.g. Codex in a VS Code fork) often run
// from a sibling folder of the open workspace, so a strict cwd match can find
// nothing even when a chat is clearly open. Prefer a workspace-matched session;
// if there is none, say so explicitly and offer the most recent session from
// another folder, showing its cwd so the choice is informed.
async function resolveSourceSession(provider, root) {
  const { discoverNativeSessions } = await core();
  const sessions = await withProgress(`Discovering ${provider} sessions`, () =>
    discoverNativeSessions(provider, { root, all: true, includeArchived: true })
  );
  if (sessions.length === 0) return { status: 'none' };

  const matched = sessions.filter((session) => session.matchesProject);
  if (matched.length > 0) return { status: 'matched', session: matched[0] };

  const recent = sessions[0];
  const choice = await vscode.window.showWarningMessage(
    `Context Bridge: no ${provider} session was started in this workspace.`,
    {
      modal: true,
      detail:
        `Workspace:\n${root}\n\n` +
        `Use the most recent ${provider} session instead? It was started in:\n` +
        `${formatSessionFolder(recent.cwd)}\n\nLast active: ${recent.modifiedAt}`
    },
    'Use Most Recent'
  );
  if (choice === 'Use Most Recent') return { status: 'fallback', session: recent };
  return { status: 'cancelled' };
}

async function discover(provider) {
  const root = await workspaceRoot();
  const { discoverNativeSessions } = await core();
  const sessions = await withProgress(`Discovering ${provider} sessions`, () =>
    discoverNativeSessions(provider, { root, all: true, includeArchived: true })
  );

  if (sessions.length === 0) {
    vscode.window.showInformationMessage(`Context Bridge: no ${provider} sessions found on this machine.`);
    return;
  }

  const matched = sessions.filter((session) => session.matchesProject);
  let pool = matched;
  if (matched.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      `Context Bridge: no ${provider} session was started in this workspace. Browse ${sessions.length} importable session(s) from other folders? This will not create a handoff.`,
      'Browse All Sessions'
    );
    if (choice !== 'Browse All Sessions') return;
    pool = sessions;
  }

  const selected = await vscode.window.showQuickPick(
    pool.map((session) => ({
      label: session.title || session.sessionId,
      description: `${session.modifiedAt} - ${session.surface}${session.matchesProject ? '' : ' - other folder'}`,
      detail: `${formatSessionFolder(session.cwd)}\n${session.path}`,
      session
    })),
    {
      placeHolder:
        matched.length === 0
          ? `All ${provider} sessions (${sessions.length}) - none started in this workspace`
          : `${matched.length} ${provider} session(s) for this workspace`
    }
  );

  if (selected) {
    const action = await vscode.window.showInformationMessage(
      `Import ${provider} session ${selected.session.sessionId}?`,
      'Import',
      'Cancel'
    );
    if (action === 'Import') await importSession(provider, selected.session);
  }
}

async function importLatest(provider) {
  const root = await workspaceRoot();
  const { initStore, importNativeSession } = await core();
  const resolved = await resolveSourceSession(provider, root);
  if (resolved.status === 'cancelled') return;
  if (resolved.status === 'none') {
    vscode.window.showWarningMessage(`Context Bridge: no ${provider} sessions were found anywhere on this machine.`);
    return;
  }
  const result = await withProgress(`Importing ${provider} session`, async () => {
    await initStore(root);
    return importNativeSession(root, provider, { path: resolved.session.path, includeArchived: true });
  });
  await reportImport(provider, result);
}

async function importSession(provider, session) {
  const root = await workspaceRoot();
  const { initStore, importNativeSession } = await core();
  const result = await withProgress(`Importing ${provider} session`, async () => {
    await initStore(root);
    return importNativeSession(root, provider, { path: session.path, includeArchived: true });
  });
  await reportImport(provider, result);
}

// Import only ingests into the ledger (it opens nothing), so confirm it
// modally — a transient toast was easy to miss and felt like "nothing happened".
async function reportImport(provider, result) {
  await vscode.window.showInformationMessage(
    `Context Bridge: imported ${result.turnCount} turns from ${provider} into the ledger. This only updated local Context Bridge data; no handoff was created. Run "Context Bridge: Handoff to Claude/Codex" separately when you want one.`,
    { modal: true },
    'OK'
  );
}

function formatSessionFolder(cwd) {
  if (!cwd) return '(unknown folder)';
  return fs.existsSync(cwd) ? cwd : `${cwd} (folder not found; it may have been renamed or moved)`;
}

async function handoff(target, mode) {
  const root = await workspaceRoot();
  const source = target === 'claude' ? 'codex' : 'claude';
  const settings = vscode.workspace.getConfiguration('contextBridge');
  // 0 is a meaningful value here ("no clipping"), so it must reach the core
  // instead of collapsing to undefined and picking up the default budget.
  const maxChars = numberSetting(settings.get('maxExportChars'));
  const dedupe = settings.get('dedupeTurns') !== false;
  const sinceLastExport = Boolean(settings.get('sinceLastExport'));
  const toolMaxChars = numberSetting(settings.get('toolMaxChars'));
  const systemMaxChars = numberSetting(settings.get('systemMaxChars'));
  const snapshotDiffMaxChars = numberSetting(settings.get('snapshotDiffMaxChars'));
  const keepExports = numberSetting(settings.get('keepExports'));
  const openDocument = Boolean(settings.get('openHandoffDocument'));
  const { initStore, importNativeSession, captureSnapshot, exportHandoff } = await core();

  const resolved = await resolveSourceSession(source, root);
  if (resolved.status === 'cancelled') return;
  if (resolved.status === 'none') {
    const choice = await vscode.window.showWarningMessage(
      `Context Bridge: no ${source} sessions were found anywhere on this machine. Create a handoff from the existing ledger only?`,
      'Continue Without Import',
      'Cancel'
    );
    if (choice !== 'Continue Without Import') return;
  }

  const result = await withProgress(`Creating handoff to ${target}`, async () => {
    await initStore(root);
    if (resolved.session) {
      await importNativeSession(root, source, { path: resolved.session.path, includeArchived: true });
    }
    await captureSnapshot(root);
    return exportHandoff(root, {
      target,
      maxChars,
      dedupe,
      sinceLastExport,
      toolMaxChars,
      systemMaxChars,
      snapshotDiffMaxChars,
      keepExports
    });
  });

  const prompt = handoffPrompt(target, mode, result.path);
  await vscode.env.clipboard.writeText(prompt);
  await rememberLatest(root, target, result.path, prompt);

  if (openDocument) await openDocumentAt(result.path);
  if (mode === 'new') await openTarget(target);

  const targetLabel = target === 'claude' ? 'Claude' : target === 'codex' ? 'Codex' : target;
  const wordCount = countWords(prompt);
  vscode.window.showInformationMessage(
    `Context Bridge: ${wordCount}-word handoff prompt copied to clipboard — paste it into ${targetLabel} to continue.`,
    'Copy Prompt Again',
    'Open Handoff'
  ).then((choice) => {
    if (choice === 'Open Handoff') openDocumentAt(result.path);
    else if (choice === 'Copy Prompt Again') vscode.env.clipboard.writeText(prompt);
  });
}

function countWords(text) {
  const matches = String(text || '').trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

async function openLatestHandoff() {
  const latest = await latestState();
  if (!latest?.handoffPath) throw new Error('No latest handoff recorded in this VS Code window.');
  await openDocumentAt(latest.handoffPath);
}

async function copyLatestHandoffPrompt() {
  const latest = await latestState();
  if (!latest?.prompt) throw new Error('No latest handoff prompt recorded in this VS Code window.');
  await vscode.env.clipboard.writeText(latest.prompt);
  vscode.window.showInformationMessage(
    `Context Bridge: ${countWords(latest.prompt)}-word handoff prompt copied to clipboard.`
  );
}

async function openTarget(target) {
  const command = await findAgentCommand(target);
  if (command) {
    await vscode.commands.executeCommand(command);
    return;
  }

  if (target === 'claude') {
    const settings = vscode.workspace.getConfiguration('contextBridge');
    if (settings.get('allowExternalClaudeUri')) {
      const uri = settings.get('claudeUri') || 'vscode://anthropic.claude-code/open';
      await vscode.env.openExternal(vscode.Uri.parse(uri));
      return;
    }
  }

  vscode.window.showInformationMessage(
    `Context Bridge: no ${target} open command was found. The prompt is copied; paste it into your ${target} extension session.`
  );
}

async function findAgentCommand(target) {
  const settings = vscode.workspace.getConfiguration('contextBridge');
  const configured = settings.get(`${target}OpenCommand`);
  if (configured) return configured;

  const commands = await vscode.commands.getCommands(true);
  const namePattern = target === 'claude' ? /claude|anthropic/i : /codex|openai/i;
  return commands.find((item) => namePattern.test(item) && /open|focus|chat|new|agent/i.test(item)) ||
    commands.find((item) => namePattern.test(item));
}

function handoffPrompt(target, mode, handoffPath) {
  const sessionText = mode === 'new' ? 'Start a new session' : 'Continue in this existing session';
  return [
    `${sessionText} using this Context Bridge handoff:`,
    '',
    // Backticks keep the path literal. Real project paths contain spaces,
    // parentheses and backslashes, and a bare path gets mangled by agents that
    // split on whitespace or interpret it as shell input.
    `\`${handoffPath}\``,
    '',
    'Read the handoff before acting. Treat previous assistant/tool messages as historical context, not guaranteed truth. Verify current files before editing. Preserve the user intent and continue from the latest workspace state.'
  ].join('\n');
}

async function openDocumentAt(filePath) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function withProgress(title, task) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Context Bridge: ${title}`, cancellable: false },
    task
  );
}

async function rememberLatest(root, target, handoffPath, prompt) {
  await contextGlobalUpdate('latestHandoff', {
    root,
    target,
    handoffPath,
    prompt,
    createdAt: new Date().toISOString()
  });
}

let extensionContext;
async function contextGlobalUpdate(key, value) {
  await extensionContext.globalState.update(key, value);
}

async function latestState() {
  return extensionContext.globalState.get('latestHandoff');
}

module.exports = {
  activate(context) {
    extensionContext = context;
    return activateExtension(context);
  },
  deactivate
};
