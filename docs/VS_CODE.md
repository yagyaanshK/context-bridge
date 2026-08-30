# VS Code Extension

Context Bridge includes a VS Code extension package for developers who use Claude and Codex primarily through IDE extensions.

It does two separate jobs: it generates **handoffs** between the two agents, and it manages **accounts** for both of them in a sidebar panel. The two are independent — you can use either without the other.

## Commands

Open the command palette and run:

**Handoff**

- `Context Bridge: Handoff to Existing Claude Session`
- `Context Bridge: Handoff to New Claude Session`
- `Context Bridge: Handoff to Existing Codex Session`
- `Context Bridge: Handoff to New Codex Session`
- `Context Bridge: Discover Claude Sessions`
- `Context Bridge: Discover Codex Sessions`
- `Context Bridge: Import Latest Claude Session`
- `Context Bridge: Import Latest Codex Session`
- `Context Bridge: Open Latest Handoff`
- `Context Bridge: Copy Latest Handoff Prompt`

**Accounts**

- `Context Bridge: Add Account` / `Add Codex Subscription` / `Add Claude Account`
- `Context Bridge: Import Current Login` / `Import Current Codex Login` / `Import Current Claude Login`
- `Context Bridge: Switch Account`
- `Context Bridge: Undo Account Switch`
- `Context Bridge: Refresh Account Quota`
- `Context Bridge: Open Terminal for Account`
- `Context Bridge: Rename Account`
- `Context Bridge: Remove Account`
- `Context Bridge: Show Raw Response`

Everything in the accounts group is also reachable from the panel, which never hands you off to a
dropdown: confirmations and renames happen inline in the card you clicked.

## The Accounts Panel

The panel lists Codex subscriptions and Claude accounts in two labelled sections, each with its own
cards, usage bars and pooled total. Nothing is pooled across the two — the quotas are not the same
currency, and switching one has no effect on the other.

Each card shows the plan, masked email, and **one labelled bar per limit window** — a five-hour and
a weekly bar for Claude, whichever Codex reports for a subscription — each with its own colour and
its own reset. The percentage beside the name is the tightest window, the one that will stop you
first. Hovering reveals a pencil to rename; renaming changes the label only, never the directory
holding the credential, so it cannot invalidate a login.

| Action | Effect |
|--------|--------|
| **Use this** | Points that agent's official CLI and extension at this account (machine-wide). |
| **Terminal** | Starts the agent as that account without changing the machine default. |
| **Sign in** | Opens the sign-in panel for that agent. |
| **Refresh now** | Forces a usage read; otherwise readings are cached for five minutes. |
| **Raw Response** | Shows the endpoint's actual JSON next to how Context Bridge parsed it. |
| **Remove** | Forget the account, or also delete its credentials. Confirmed inline. |

### Signing in

**Codex** delegates to the official binary: Context Bridge spawns `codex login` with `CODEX_HOME`
set and reads its output to render progress. It never performs the OAuth exchange. Methods: browser,
device code, access token, API key, paste an existing `auth.json`.

**Claude** cannot work that way. Its login is an Ink terminal UI needing raw mode on stdin, so a
piped child process dies before printing anything, and `claude setup-token` writes no credential by
design. The official extension avoids this by bundling the CLI runtime, which another extension
cannot borrow. So Context Bridge runs the same public PKCE flow the CLI runs and writes the
credential itself — meaning **it handles Claude tokens, which it never does for Codex**. Methods:
browser (loopback on port 54545), authorization code (no local port, for SSH and containers), adopt
the login at `~/.claude`, or paste a `.credentials.json`.

On macOS Claude keeps credentials in the Keychain rather than a file, so the adopt and paste methods
have nothing to read there; the two OAuth methods work everywhere.

### Switching

Switching rewrites the one credential path the official tooling reads, which is what makes the
official UI start using your choice. For Claude that is two files — the credential plus the
`oauthAccount` key in `~/.claude.json`, where the displayed email lives. The rest of that file is
project history and caches and is left byte-identical. Both files are backed up first, and the
confirmation toast offers **Undo**.

Before **Use this**, close that agent's CLI processes and close or reload every editor window hosting
its extension. Context Bridge checks for native `codex` and `claude` extension subprocesses and
refuses the switch while they are running. This is deliberate: a process started under the old
account can refresh later and overwrite the newly selected machine credential. Reselecting the
already-active account is allowed because it does not replace the credential.

## The Handoff Card

The panel's bottom section runs the same handoff flow as the commands: choose the target agent,
choose a new or existing session, press **Create handoff**. Afterwards it shows the last handoff
with **Open** and **Copy prompt**. This remembered handoff is stored per workspace and is shown only
when its recorded project root matches the current workspace. The command palette entries are unchanged.

### Choosing which session

When more than one agent session was started in the same folder, Context Bridge asks which one to
hand off rather than taking the most recently touched. Sessions in one folder are not
interchangeable — a long-running chat, a quick one-off and an abandoned experiment all look the same
to a timestamp — and the last one you happened to focus is often not the one worth continuing. The picker calls each
session by the name the agent itself gave it. Claude Code writes that name into the transcript; Codex
keeps its thread name — the one in the app sidebar, and whatever `/rename` was given — outside the
transcript in `~/.codex/session_index.jsonl`, which Context Bridge reads and joins on the thread id.

What is left unnamed is mostly machinery: forks and subagent runs, which the agent never names and
which the app does not list. For those the opening request is a poor stand-in, because sessions
forked from a common parent share it word for word and would render as identical rows, so the most
recent substantive request leads instead — that is where they diverge. Trailing replies like "yes" or
"continue" are skipped when choosing it. Every row also carries age, surface, size and whether the
session was forked, and subagent transcripts are labelled as such.

Set `contextBridge.alwaysUseLatestSession` to skip the question and always take the newest.

## How Handoff Works

Context Bridge generates the same deterministic handoff whether you paste it into an existing session or a new one.

When handing off to Claude, the extension imports the latest Codex native transcript for the workspace, captures a workspace snapshot, generates a handoff markdown file, and copies a concise prompt to the clipboard.

When handing off to Codex, the extension imports the latest Claude native transcript for the workspace, captures a workspace snapshot, generates a handoff markdown file, and copies a concise prompt to the clipboard.

Discovery, import, and handoff progress notifications have a **Cancel** action. Cancellation propagates through provider-directory walking, JSONL parsing, snapshot commands, and ledger export rather than leaving background work in the extension host.

The receiving prompt points at the handoff file instead of pasting a giant transcript into the chat box:

```text
Continue in this existing session using this Context Bridge handoff:

<path-to-.context-bridge/exports/...md>

Read the handoff before acting...
```

Screenshot payloads embedded in native transcripts are not pasted into the handoff. Context Bridge keeps local image paths when available and replaces inline base64 image blobs with compact omission markers.

## Existing vs New Session

Use an existing session for short round trips where the original conversation is still coherent.

Use a new session when the old native chat is long, stale, noisy, or confused. The Context Bridge ledger remains the source of truth either way.

## Claude

For new Claude sessions, Context Bridge first tries to find and execute an installed Claude/Anthropic command in the current editor.

You can set `contextBridge.claudeOpenCommand` to the exact command id if your editor exposes one.

Context Bridge no longer opens the Claude Code URI by default because VS Code forks may hand `vscode://...` links to Microsoft VS Code instead of the current editor. If you want that external behavior, enable `contextBridge.allowExternalClaudeUri`.

The optional URI setting is:

```text
vscode://anthropic.claude-code/open
```

You can override it with `contextBridge.claudeUri`.

## Codex

Codex does not currently have a documented URI equivalent in this project. Context Bridge tries to find an installed VS Code command containing `codex` or `openai`; if that fails, it leaves the prompt on the clipboard and opens the handoff document.

You can set `contextBridge.codexOpenCommand` to the exact Codex command id if your installation exposes one.

## Development

```bash
npm install
npm test
npm run lint
```

Then open the repository in VS Code and press `F5` to launch an Extension Development Host. The repository includes `.vscode/launch.json`, so VS Code should open the Extension Development Host directly instead of asking you to select a debugger.

## Local VSIX Install

For normal use, package a VSIX:

```bash
npm run package:vscode
```

This writes:

```text
dist/context-bridge-0.7.4.vsix
```

Install it from the Extensions view:

1. Open Extensions.
2. Click the `...` menu.
3. Choose `Install from VSIX...`.
4. Select `dist/context-bridge-0.7.4.vsix`.

This is the best path before marketplace publication because it works like a normal extension install.

## VS Code Forks

Context Bridge uses the standard VSIX extension format and the public VS Code extension API. The local VSIX should install in VS Code-compatible editors that support VSIX extensions, including Cursor, Windsurf, and Google Antigravity.

If a fork does not expose the same Claude/Codex extension commands, Context Bridge still generates the handoff file and copies the prompt. The user can paste the prompt into the target agent manually.
