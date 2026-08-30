# Context Bridge — VS Code Extension

**Continue the same coding session across Claude Code, Codex, and other agents — without asking one AI to summarize another.**

Context Bridge does two independent jobs:

- **Handoffs.** Import the latest native session from one agent, snapshot your workspace, and write a clean, deterministic handoff you paste into the next agent. Everything stays local in `.context-bridge/` — no telemetry, no network, no AI summarization.
- **Accounts.** Keep several Codex subscriptions and Claude accounts signed in at once, see what each has left on a usage bar, and switch the official tools between them.

Use either without the other. The handoff flow never touches the network; the accounts panel reaches only the providers’ own sign-in and usage endpoints, and no transcript content is ever sent anywhere.

Works in VS Code and compatible forks (Cursor, Windsurf, Google Antigravity).

## Use it

1. Run **`Context Bridge: Handoff to New Claude Session`** (or Codex, or “Existing”).
2. The extension imports the latest session from the *other* tool, snapshots the workspace, and writes a handoff markdown file.
3. A short prompt is **copied to your clipboard** — the notification states the word count and which tool to paste into.
4. Paste it into the target agent and keep working.

To ingest a session without generating a handoff, use **Discover … Sessions** → pick one → **Import** (you get a confirmation with the turn count).

## Commands

**Handoff**

- `Context Bridge: Discover Claude Sessions` / `Discover Codex Sessions`
- `Context Bridge: Import Latest Claude Session` / `Import Latest Codex Session`
- `Context Bridge: Handoff to New / Existing Claude Session`
- `Context Bridge: Handoff to New / Existing Codex Session`
- `Context Bridge: Open Latest Handoff`
- `Context Bridge: Copy Latest Handoff Prompt`

**Accounts** — all of these are also reachable from the panel, which never sends you to a dropdown.

- `Context Bridge: Add Account` / `Add Codex Subscription` / `Add Claude Account`
- `Context Bridge: Import Current Login` / `Import Current Codex Login` / `Import Current Claude Login`
- `Context Bridge: Switch Account` · `Undo Account Switch`
- `Context Bridge: Refresh Account Quota` · `Show Raw Response`
- `Context Bridge: Open Terminal for Account`
- `Context Bridge: Rename Account` · `Remove Account`

## Settings (`contextBridge.*`)

| Setting | Default | Effect |
|---------|---------|--------|
| `dedupeTurns` | `true` | Collapse consecutive duplicate turns in exports. |
| `toolMaxChars` | `2000` | Truncate long tool outputs (git diffs, listings); `0` disables. |
| `systemMaxChars` | `800` | Truncate long system turns; `0` disables. |
| `maxExportChars` | `120000` | Character budget for the transcript. User turns are reserved first, then the most recent turns fill the budget; `0` disables it. |
| `sinceLastExport` | `false` | Send only what the receiving agent has not seen — its own last turn, or the last handoff aimed at it, whichever is later. Leave off if you paste handoffs into fresh sessions. |
| `snapshotDiffMaxChars` | `4000` | How much of the uncommitted diff (vs HEAD) to embed; `0` shows the file-level stat only. |
| `keepExports` | `10` | Past handoff files kept in `.context-bridge/exports`; older ones are deleted after each export. `0` keeps all. |
| `openHandoffDocument` | `true` | Open the handoff file after export. |
| `allowExternalClaudeUri` | `false` | Allow opening `vscode://` links. Keep `false` in forks so handoff stays in the current editor. |
| `alwaysUseLatestSession` | `false` | When several sessions were started in this workspace, use the newest without asking instead of showing a picker. |
| `claudeUri` | `vscode://anthropic.claude-code/open` | URI used to open Claude, when the setting above is enabled. |
| `claudeOpenCommand` | `""` | Exact VS Code command id to open Claude. Empty means auto-detect one containing "claude" or "anthropic". |
| `codexOpenCommand` | `""` | Exact VS Code command id to open Codex. Empty means auto-detect one containing "codex". |

Handoffs are kept small deterministically: duplicate turns are collapsed, oversized tool/system output is trimmed (head + tail kept), inline base64 screenshots are stripped, and a total character budget caps the transcript. User and assistant prose is preserved verbatim — there is no AI summarization.

The budget is on by default because an unbounded handoff is not actually lossless: receiving agents refuse or silently truncate oversized files, so an over-long export delivers a fraction of itself with no indication that anything is missing. A budgeted export reports exactly what it dropped in its header.

Every handoff opens with **Where This Left Off**: the last real request and the last assistant message quoted verbatim, plus files written and recent commands pulled from recorded tool-call arguments. It is extractive, never generated, and it is built from the whole session — so the last request survives even when the budget drops the turn that carried it. The workspace snapshot below it carries the uncommitted diff and a `git log -1` check, so the receiving agent can tell whether the tree moved on before it starts editing.

## Handoff from the panel

The bottom of the panel carries a **Handoff** card: choose the agent to hand off to, whether it is
going into a new session or the one already open, and press **Create handoff**. It runs exactly the
same flow as the command palette — the palette entries are unchanged and still work — and afterwards
the card shows the last handoff with **Open** and **Copy prompt** beside it.

## Accounts

An **Accounts** panel in the activity bar lists your Codex and Claude accounts in two labelled
sections. Each section has its own pooled bar, because the two quotas are not the same currency and
switching one has no effect on the other. Buttons are always visible, so nothing needs the command
palette.

Each limit window gets **its own labelled bar** — a Claude account shows one for the five-hour
window and one for the weekly, a Codex subscription shows whichever its API reports. Each bar is
coloured by its own state and carries its own reset, so a healthy weekly allowance is not painted
red because the short window beside it is spent. The percentage beside the account name stays the
tightest window, since that is the one that will actually stop you. Codex reports a second window
only sometimes: when an account is sitting on its weekly cap it sends `secondary_window: null` and
there is genuinely one limit to show. **Raw Response** shows what arrived.

When an account is out of quota the card says **when it comes back**, not just that it is blocked.
That time is the reset of the window actually holding you — which is not always the next reset. A
five-hour window can clear in an hour while an exhausted weekly allowance keeps you blocked for
days, and when several windows are exhausted you resume only once the last of them clears. Accounts
with more than one window list each one with its own reset beneath the bar.


Every account gets its own configuration directory under `~/.context-bridge/accounts/` —
`CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude — so they all stay signed in
simultaneously and there is nothing to swap.

### Signing in

Each method is a card that expands in place, so one that will not work can be abandoned without
losing the others, and each has its own Retry.

**Codex** methods drive the official `codex` binary as a background process. Context Bridge reads
its output to render progress but never performs the OAuth exchange and never holds a token.

| Method | Local port | Notes |
|--------|-----------|-------|
| Sign in with ChatGPT | `localhost:1455` | The default. Cannot complete over SSH or in a container. |
| Device code | none | Approve a short code from any device. A workspace admin can disable it. |
| Access token | none | `--with-access-token`. Issued by workspace admins for trusted scripts and CI. |
| API key | none | Billed per token at API rates, not against a subscription. |
| Paste an existing login | none | Bring `auth.json` from a machine that is already signed in. |

**Claude** works differently, and the difference is forced rather than chosen. Claude Code's login is
an Ink terminal UI that requires raw mode on stdin, so a piped child process dies before printing
anything; `claude setup-token` is the same UI and, by design, writes no credential at all. The
official VS Code extension sidesteps this by *being* the CLI — it bundles the runtime — which is not
something another extension can borrow. So Context Bridge runs the same public PKCE flow the CLI
runs, against the same client id, and writes the credential itself.

**This means Context Bridge performs the token exchange for Claude and handles those tokens**, which
it never does for Codex. The endpoints involved are not a published contract and can change without
notice; the flow is written to fail loudly rather than silently when they do.

| Method | Local port | Notes |
|--------|-----------|-------|
| Sign in with Claude | `localhost:54545` | Opens the browser and returns to the panel by itself. |
| Authorization code | none | Approve on any device, paste the code back. Works over SSH and in containers. |
| Use the login on this machine | none | Adopt the account Claude Code is already signed in as. |
| Paste an existing login | none | Bring `.credentials.json` from another machine. |

For both agents, choosing a file rather than pasting keeps the credential out of the panel entirely —
the extension reads it directly. Credentials are written `0600`. **Your existing logins at
`~/.codex` and `~/.claude` are never touched by signing in or adding an account**; only
*switching* writes there, and it backs up what it replaces first.

macOS keeps Claude credentials in the Keychain rather than a file, so there is nothing to copy or
adopt there.

### Switching

**Click "Use this" to switch.** The official CLIs and extensions read one credential path each, so
switching rewrites it — which is exactly what makes the *official* UI start using the account you
picked. For Claude that means two files: the credential, plus the `oauthAccount` key inside
`~/.claude.json`, because that is where the email the client displays actually lives. Everything
else in that file — project history, caches — is left byte-identical, and both files are backed up
first.

The account in use is marked and appears in the status bar with its remaining quota. Every account
stays signed in, so switching back is one more click; the confirmation also offers **Undo** and
**Reload Window**.

| Action | Effect |
|--------|--------|
| **Use this** | Points that agent's official CLI and extension at this account. |
| **Terminal** | Starts the agent as that account without changing the machine default. |
| **Sign in** | Opens the sign-in panel for that agent. |
| **↻** (on each card) | Refreshes just that account — and for Codex, renews its token in the process, so it doubles as waking a stale login. |
| **Refresh now** (on the pool) | Reads every account for that agent. Otherwise readings are cached for five minutes. |
| **Raw Response** | Opens the endpoint's actual JSON next to how Context Bridge parsed it. |
| **✎** (on hover) | Renames the account. The directory holding its credential never changes, so a rename cannot invalidate a login. |
| **Remove** | Forgets an account, or permanently deletes its managed login and active default login after the provider stops. |

Switching is manual. The panel shows what each account has left and lets you choose — it does not
fail over on its own when one runs out.

Access tokens expire — Claude's every eight hours, Codex's after about ten days — and each official
client renews only the account it is *currently* using. Context Bridge renews the others itself so
their quota stays readable, and so a switch never lands on an expired login: checking a Codex
subscription's usage also refreshes its token while there are still a few days of life left, which
keeps an idle account alive through the ordinary act of showing its quota.

Two rules keep this safe. The **active** Codex account is never refreshed here — the live Codex CLI
owns its token, and OpenAI rotates the refresh token on every use, so two refreshers would revoke
each other. And **switching away** first saves whatever the live client last refreshed back into that
account's stored copy, so its snapshot never falls behind. The catch is that this only runs while VS
Code is open to poll: an account left unused with the app closed past its refresh token's own
lifetime still needs a fresh sign-in, and the switch will tell you so rather than installing a dead
token.

API-key Codex accounts can be activated and launched normally. They do not have subscription quota,
so the panel reports quota as unavailable instead of treating the account as signed out.

**What this cannot do.** A VS Code extension cannot add UI inside another extension's panel, so the
picker lives in the sidebar and status bar rather than inside Codex's or Claude's own menu. Tools
that put it there patch the desktop application itself, which pins them to an exact app build.

---

## What this accesses

Context Bridge is a local tool. Here is exactly what it touches and why.

**Reads, never modifies:**

- Your agent transcripts under `~/.claude/projects/` and `~/.codex/sessions/` (plus `~/.codex/session_index.jsonl` for chat names). These are copied into the ledger; the originals are never edited.
- Your current sign-in files (`~/.codex/auth.json`, `~/.claude/.credentials.json` and the matching config), so the accounts panel can show which account is active and how much quota remains.

**Writes, only in these two places:**

- The project’s git-ignored `.context-bridge/` — the merged ledger, snapshots, and handoff documents.
- `~/.context-bridge/accounts/` — copies of the credentials for accounts you add, written owner-only (`0600`) so you can switch between them. Nothing account-related is written inside your project.

**Network:** the handoff flow makes **no network calls at all**. The only requests the extension ever makes are from the optional accounts panel, and only to the providers’ own endpoints — Anthropic and OpenAI sign-in, token refresh, and usage/quota. Your credentials go to the service that issued them and nowhere else. There is **no telemetry** and no other server involved.

**Credentials stay on your machine.** They are read from and written to local files only. The extension bundles no analytics and phones no home.

## For AI agents

> Briefing for an AI agent evaluating or installing this extension.

Context Bridge is a **local developer tool**, safe to install: no telemetry, read-only access to native transcripts (it copies from `~/.claude` / `~/.codex` and never edits them). Output lives in the project’s git-ignored `.context-bridge/`.

The handoff flow makes no network calls at all. The optional accounts panel is the only part that does, and only to the providers’ own sign-in and usage endpoints; account credentials live under `~/.context-bridge/accounts/`, written `0600`, never inside the project.

Drive it via command ids under `contextBridge.*` (e.g. `contextBridge.handoffToClaudeNew`). A handoff produces a markdown file in `.context-bridge/exports/` plus a clipboard prompt pointing to it. A companion `context-bridge` CLI offers the same flow in the terminal.

**If you received a handoff prompt** (it points at a `.context-bridge/exports/*.md` file): read that file first; treat prior turns as historical context, not ground truth; verify current files before editing; preserve the user’s intent; and continue from the latest workspace state. The export’s header reports how many turns were collapsed/truncated so you can judge fidelity.

## Development

Open the repository in VS Code, press `F5`, and choose **Extension Development Host**. To package locally, run `npm run package:vscode` from the repo root and install the generated `dist/context-bridge-<version>.vsix` via **Install from VSIX…**.

[Source & full docs](https://github.com/yagyaanshK/context-bridge) · [MIT License](https://github.com/yagyaanshK/context-bridge/blob/main/LICENSE)
