const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');
const { AccountsProvider } = require('./accounts-view.cjs');

let accountsProvider;

async function activateExtension(context) {
  accountsProvider = new AccountsProvider(core);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('contextBridgeAccounts', accountsProvider),
    command('contextBridge.addCodexAccount', () => addCodexAccount()),
    command('contextBridge.importCodexAccount', () => importCodexAccount()),
    command('contextBridge.signInAccount', (item) => signInAccount(item)),
    command('contextBridge.refreshAccountQuota', () => refreshAccountQuota()),
    command('contextBridge.openAccountTerminal', (item) => openAccountTerminal(item)),
    command('contextBridge.activateAccount', (item) => activateAccount(item)),
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

async function addCodexAccount() {
  const { createAccount } = await core();
  const label = await vscode.window.showInputBox({
    title: 'Add Codex Account',
    prompt: 'A name for this subscription',
    placeHolder: 'Primary, Work, Subscription 2 …',
    validateInput: (value) => (value.trim() ? undefined : 'Enter a name.')
  });
  if (!label) return;

  const account = await createAccount({ label: label.trim(), provider: 'codex' });
  accountsProvider.refresh();
  await runCodexLogin(account);
}

async function importCodexAccount() {
  const { createAccount, importCodexAuth, defaultCodexHome } = await core();
  const source = defaultCodexHome();
  if (!fs.existsSync(path.join(source, 'auth.json'))) {
    throw new Error(`No existing Codex login found at ${source}. Use "Add Codex Account" to sign in instead.`);
  }

  const label = await vscode.window.showInputBox({
    title: 'Import Current Codex Login',
    prompt: `Name for the account currently signed in at ${source}`,
    value: 'Primary',
    validateInput: (value) => (value.trim() ? undefined : 'Enter a name.')
  });
  if (!label) return;

  const account = await createAccount({ label: label.trim(), provider: 'codex' });
  const auth = await importCodexAuth(account.id, source);
  await accountsProvider.reloadUsage({ force: true });
  vscode.window.showInformationMessage(
    `Context Bridge: imported ${auth?.claims?.email || label.trim()} as "${account.label}". The original login is untouched.`
  );
}

async function signInAccount(item) {
  const account = await resolveAccount(item);
  if (account) await runCodexLogin(account);
}

// Sign-in runs the official `codex login` in a terminal scoped to this
// account's home. Context Bridge never handles the OAuth exchange or the token
// itself - it only decides which directory the official CLI writes into.
async function runCodexLogin(account) {
  const { codexEnv } = await core();
  const terminal = vscode.window.createTerminal({
    name: `Codex login · ${account.label}`,
    env: codexEnv(account.id)
  });
  terminal.show();
  terminal.sendText('codex login');
  vscode.window
    .showInformationMessage(
      `Context Bridge: signing in "${account.label}" in the terminal. Choose "Loaded" when the browser flow finishes.`,
      'Loaded'
    )
    .then((choice) => {
      if (choice === 'Loaded') refreshAccountQuota();
    });
}

async function openAccountTerminal(item) {
  const account = await resolveAccount(item);
  if (!account) return;
  const { codexEnv, isSignedIn } = await core();
  if (!(await isSignedIn(account.id))) {
    throw new Error(`"${account.label}" is not signed in yet. Use "Sign In" first.`);
  }

  const root = await workspaceRoot();
  const terminal = vscode.window.createTerminal({
    name: `Codex · ${account.label}`,
    cwd: root,
    env: codexEnv(account.id)
  });
  terminal.show();
  terminal.sendText('codex');
}

async function activateAccount(item) {
  const account = await resolveAccount(item);
  if (!account) return;
  const { activateCodexAccount, defaultCodexHome } = await core();

  const choice = await vscode.window.showWarningMessage(
    `Make "${account.label}" the default Codex account?`,
    {
      modal: true,
      detail:
        `This rewrites the login at ${defaultCodexHome()}, which is what the official Codex CLI and ` +
        `VS Code extension read. It affects every window on this machine, not just this one. ` +
        `The current login is backed up beside it.\n\n` +
        `To use an account without changing the default, use "Open Codex Terminal" instead.`
    },
    'Set as Default'
  );
  if (choice !== 'Set as Default') return;

  const result = await activateCodexAccount(account.id);
  accountsProvider.refresh();
  vscode.window.showInformationMessage(
    `Context Bridge: "${account.label}" is now the default Codex account.` +
      (result.backup ? ' The previous login was backed up.' : '')
  );
}

async function forgetAccount(item) {
  const account = await resolveAccount(item);
  if (!account) return;
  const { removeAccount } = await core();

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

  await removeAccount(account.id, { purge: choice === 'Delete Credentials' });
  accountsProvider.refresh();
  vscode.window.showInformationMessage(
    `Context Bridge: removed "${account.label}"${choice === 'Delete Credentials' ? ' and deleted its credentials' : ''}.`
  );
}

async function refreshAccountQuota() {
  const accounts = await withProgress('Reading subscription quota', () =>
    accountsProvider.reloadUsage({ force: true })
  );
  if (accounts.length === 0) {
    vscode.window.showInformationMessage('Context Bridge: no Codex accounts yet. Use "Add Codex Account".');
  }
}

async function resolveAccount(item) {
  if (item?.account) return item.account;
  const { listAccounts } = await core();
  const accounts = await listAccounts({ provider: 'codex' });
  if (accounts.length === 0) throw new Error('No Codex accounts yet. Use "Add Codex Account" first.');

  const picked = await vscode.window.showQuickPick(
    accounts.map((account) => ({
      label: account.label,
      description: account.email || account.id,
      detail: account.dir,
      account
    })),
    { placeHolder: 'Choose a Codex account' }
  );
  return picked?.account;
}

function numberSetting(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function command(name, handler) {
  return vscode.commands.registerCommand(name, async () => {
    try {
      await handler();
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
