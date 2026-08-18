# Context Bridge

**Continue the same coding session across different AI agents — without asking one AI to summarize another.**

Context Bridge is a local, vendor-neutral handoff layer for developers who switch between agentic coding tools such as **Claude Code** and **Codex**. It captures an exact transcript and workspace snapshot, then generates a clean handoff you paste into the next tool.

- 🔒 **Local-only** — everything lives in your project under `.context-bridge/`. No accounts, no telemetry, no network calls.
- 🧾 **Lossless** — native transcripts are imported verbatim as JSONL. No AI summary in the core flow.
- ✂️ **Lean handoffs** — duplicate turns are collapsed, noisy tool output is trimmed, and inline screenshots are stripped, so a handoff stays small enough for the next agent to actually read.
- 🧰 **Two ways to use it** — a `context-bridge` CLI and a VS Code extension (works in forks like Cursor, Windsurf, and Google Antigravity).
- 👥 **Many accounts, one panel** — keep several Codex subscriptions and Claude accounts signed in at once, see what each has left, and switch the official tools between them.

---

## The problem

You use more than one coding agent in the same project — one is better at refactors, another at UI, another at review. The pain is **continuity**: after a real session in one tool, the next tool starts with partial context, stale assumptions, or a lossy summary.

Context Bridge treats continuity as a **local project artifact**, not a feature of any one vendor.

---

## Install

**From source (CLI + extension):**

```bash
git clone https://github.com/yagyaanshK/context-bridge.git
cd context-bridge
npm install
npm test
```

Run the CLI:

```bash
node packages/cli/bin/context-bridge.js --help
```

**VS Code extension:** build the VSIX and install it.

```bash
npm run package:vscode
```

Then in your editor run **“Extensions: Install from VSIX…”** and pick `dist/context-bridge-<version>.vsix` (currently `context-bridge-0.7.4.vsix`). This works in VS Code and compatible forks (Cursor, Windsurf, Google Antigravity).

---

## Quick start (CLI)

```bash
context-bridge init                                  # create the .context-bridge/ ledger
context-bridge discover --provider claude            # find native Claude Code sessions
context-bridge import-native --provider claude --last # import the most recent one
context-bridge snapshot                              # capture git + file state
context-bridge export --to codex                     # write a handoff for Codex
```

The handoff markdown lands in `.context-bridge/exports/`. Paste it (or point the receiving tool at the file) and keep working.

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

## Quick start (VS Code)

Use the **Handoff** card at the bottom of the Context Bridge panel — pick the agent, pick new or
existing, press **Create handoff** — or the command palette:

1. Run **`Context Bridge: Handoff to New Claude Session`** (or Codex / “Existing”).
2. It imports the latest session from the *other* tool, snapshots the workspace, and writes the handoff.
3. A short prompt is **copied to your clipboard** (the notification tells you the word count).
4. Paste it into the target agent.

---

## How a handoff stays small and faithful

A raw multi-tool session can be megabytes. Context Bridge shrinks the **export** deterministically while leaving the on-disk transcript complete:

| Step | What it does |
|------|--------------|
| **Collapse duplicates** | Native logs record one message under several event types; consecutive identical turns are merged (legitimately-repeated output is kept). |
| **Trim tool/system noise** | Oversized tool outputs (git diffs, dir listings) and repeated system blobs are middle-truncated, keeping head + tail. |
| **Strip inline media** | Base64 screenshots are replaced with compact placeholders. |
| **Never summarize** | User and assistant prose is preserved verbatim. |

The ledger header of every export reports exactly what was collapsed and truncated.

---

## CLI reference

| Command | Purpose |
|---------|---------|
| `init` | Create the `.context-bridge/` ledger. |
| `import --provider <name> [--surface <name>] <file>` | Import a JSON / JSONL / Markdown / text transcript. |
| `discover --provider claude\|codex [--all]` | List native sessions for this workspace. |
| `import-native --provider claude\|codex [--last\|--session <id>]` | Import a native Claude Code / Codex session. |
| `run claude\|codex [-- <native args>]` | Launch the agent and import the session it changed. |
| `snapshot` | Capture a git + file-metadata workspace snapshot. |
| `export --to <target> [options]` | Generate a handoff markdown file. |
| `status` | Print ledger counts. |
| `accounts [--refresh]` | List Codex subscriptions with remaining quota. |
| `account add <label> [--import]` | Register a subscription; `--import` adopts your current login. |
| `account use <id>` | Make a subscription the machine default for the official CLI. |
| `account remove <id> [--purge]` | Forget a subscription; `--purge` also deletes its credentials. |

> **The `account` commands are Codex-only.** Claude accounts are managed from the VS Code panel;
> the CLI's `--provider claude` flag reads Codex paths and will misreport them. See
> [docs/CLI.md](docs/CLI.md#accounts).

**Export options:** `--max-chars <n>` (budget, default 120000, 0 = off) · `--no-dedupe` · `--since-last-export` · `--tool-max-chars <n>` (default 2000) · `--system-max-chars <n>` (default 800) · `--snapshot-diff-max-chars <n>` (default 4000) · `--keep-exports <n>` (default 10) · `--no-summary`. All flags accept kebab- or camelCase.

### What a handoff contains

| Section | Purpose |
|---------|---------|
| Rules for the receiving agent | Treat the transcript as history, verify before editing. |
| **Where This Left Off** | The last real user request and the last assistant message, verbatim; files written and recent commands, derived from recorded tool-call arguments. Extractive only — nothing is generated. |
| Ledger | Counts, plus exactly what was collapsed, truncated, or dropped for budget. |
| Latest Workspace Snapshot | Branch, HEAD, remote, top-level entries, `git status`, the uncommitted diff, and a `git log -1` check so the receiver can tell whether the workspace moved on. |
| Transcript Turns | The budgeted transcript, newest activity prioritized, user turns reserved first. |

---

## VS Code commands & settings

The extension contributes an **Accounts** panel in the activity bar (see below) plus command-palette entries.

**Commands** (Command Palette → “Context Bridge: …”): Discover / Import Latest (Claude·Codex), Handoff to New/Existing (Claude·Codex), Open Latest Handoff, Copy Latest Handoff Prompt, Add / Import Account, Switch Account, Refresh Account Quota, Rename Account, Remove Account, Show Raw Response.

**Settings** (`contextBridge.*`):

| Setting | Default | Effect |
|---------|---------|--------|
| `dedupeTurns` | `true` | Collapse consecutive duplicate turns. |
| `toolMaxChars` | `2000` | Truncate long tool outputs (0 = off). |
| `systemMaxChars` | `800` | Truncate long system turns (0 = off). |
| `maxExportChars` | `120000` | Character budget for the transcript (0 = off). User turns are reserved first, then the most recent turns fill the budget. |
| `sinceLastExport` | `false` | Only include turns newer than the previous export. |
| `snapshotDiffMaxChars` | `4000` | How much uncommitted diff to embed (0 = stat only). |
| `keepExports` | `10` | Past handoff files to keep; older ones are deleted (0 = keep all). |
| `openHandoffDocument` | `true` | Open the handoff file after export. |
| `allowExternalClaudeUri` | `false` | Allow opening `vscode://` links (keep off in forks). |
| `alwaysUseLatestSession` | `false` | Skip the picker when several sessions match this workspace and take the newest. |
| `claudeUri` | `vscode://anthropic.claude-code/open` | URI used to open Claude, when the setting above is on. |
| `claudeOpenCommand` | `""` | Exact command id to open Claude. Empty means auto-detect. |
| `codexOpenCommand` | `""` | Exact command id to open Codex. Empty means auto-detect. |

---

## Multiple accounts

If you hold more than one Codex subscription or Claude account, Context Bridge keeps them all
signed in at once and shows what each has left. The **Accounts** panel in the activity bar lists
them in two labelled sections — Codex and Claude Code — each with its own cards, usage bars and
pooled total. Nothing is pooled *across* the two: the quotas are not the same currency and switching
one has no effect on the other.

Each limit window gets **its own labelled bar** — a Claude account shows one for the five-hour
window and one for the weekly, a Codex subscription shows whichever its API reports. Each bar is
coloured by its own state and carries its own reset, so a healthy weekly allowance is not painted
red because the short window beside it is spent. The percentage beside the account name stays the
tightest window, since that is the one that will actually stop you. Codex reports a second window
only sometimes: when an account is sitting on its weekly cap it sends `secondary_window: null` and
there is genuinely one limit to show. **Raw Response** shows what arrived.

### The mechanism is one environment variable

Each CLI keeps its identity under whatever its config variable points at, so every account gets its
own directory and nothing has to be swapped:

| Agent | Variable | Per-account directory |
|-------|----------|----------------------|
| Codex | `CODEX_HOME` | `~/.context-bridge/accounts/<id>/codex-home` |
| Claude | `CLAUDE_CONFIG_DIR` | `~/.context-bridge/accounts/<id>/claude-home` |

Claude's layout has one asymmetry worth knowing, because it is easy to get backwards: the config
file sits *beside* the stock `~/.claude` home, at `~/.claude.json`, but moves *inside* any custom
`CLAUDE_CONFIG_DIR`. The email the client displays lives in that config, not in the credential.

### Signing in

Every method is a card in the sign-in panel that expands in place, so one that will not work can be
abandoned without losing the others.

**Codex** — Context Bridge launches the **official** `codex` binary with `CODEX_HOME` set, reads its
output to drive the progress display, and never performs the OAuth exchange or holds a token. Five
methods: browser, device code, access token, API key, or pasting an existing `auth.json`.

**Claude** — this one is different, and the difference is forced rather than chosen. Claude Code's
login is an Ink terminal UI that requires raw mode on stdin, so a piped child process dies before
printing anything; `claude setup-token` is the same UI and writes no credential by design. The
official VS Code extension sidesteps this by *being* the CLI — it bundles the runtime — which is not
something another extension can borrow. So Context Bridge runs the same public PKCE flow the CLI
runs, against the same client id, and writes the credential itself.

> **This means Context Bridge performs the token exchange for Claude and handles those tokens**,
> which it never does for Codex. The endpoints involved are not a published contract and can change
> without notice; the flow is written to fail loudly rather than silently when they do.

Four Claude methods: browser via a loopback callback on port 54545, an authorization code needing no
local port (for SSH and containers), adopting the login already at `~/.claude`, or pasting a
`.credentials.json` from another machine. macOS keeps Claude credentials in the Keychain rather than
a file, so the adopt and paste methods have nothing to read there.

For both agents, choosing a file rather than pasting keeps the credential out of the panel entirely.
Credentials are written `0600`, and secrets go to stdin, never argv.

### Quota

Readings come from the same usage endpoints the official clients use, cached five minutes per
account. A failed refresh keeps the last good reading rather than blanking the display.

When an account is out of quota the card says **when it comes back**, not just that it is blocked.
That time is the reset of the window actually holding you — which is not always the next reset. A
five-hour window can clear in an hour while an exhausted weekly allowance keeps you blocked for
days, and when several windows are exhausted you resume only once the last of them clears. Accounts
with more than one window list each one with its own reset beneath the bar.
 Claude
access tokens expire every eight hours and the official client renews only the account it is
currently using, so Context Bridge renews the others itself — otherwise their bars would go dark.

```bash
context-bridge account add "Primary" --import   # Codex: adopt the login you already have
context-bridge account add "Subscription 2"     # then run the printed `codex login`
context-bridge accounts --refresh               # remaining quota per subscription
```

### Switching

Click **Use this** and the official CLI and extension for that agent start using the account — they
read one credential path each, so switching rewrites it and the change is machine-wide. For Claude
that means two files: the credential, plus the `oauthAccount` key inside `~/.claude.json`, because
that is where the displayed email actually lives. Everything else in that file — project history,
caches — is left byte-identical, and both files are backed up first.

The account in use is marked in the panel and shown in the status bar with its remaining quota.
Every account stays signed in, so this is cheap and reversible; the toast offers **Undo**. To use an
account *without* changing the default, use **Terminal**, which scopes the variable to that one
session.

**Switching is manual and deliberate.** Context Bridge shows you what each account has left and lets
you choose; it does not silently fail over when one runs out.

---

---

## The ledger

```text
.context-bridge/
  manifest.json          # index of sessions, snapshots, exports
  sessions/              # imported transcripts (JSONL, verbatim)
  snapshots/             # git + file-metadata snapshots
  exports/               # generated handoff markdown
  attachments/
```

`.context-bridge/` is **git-ignored by default** because it can contain private transcripts, command output, and file paths.

---

## For AI agents

> This section is a briefing for an AI agent that is browsing this repo, evaluating the extension, or has just received a Context Bridge handoff.

**What this is.** Context Bridge is a developer tool, not a model or service. It ships two artifacts from one core library:
- the **`context-bridge` CLI** (Node ≥ 20, package `context-bridge`), and
- the **Context Bridge VS Code extension** (`context-bridge-vscode`).

**What it does.** It imports native Claude Code / Codex chat transcripts into a local `.context-bridge/` ledger, snapshots the git workspace, and emits a deterministic **handoff markdown** plus a short clipboard prompt. There is **no AI summarization** in the core flow — transcripts are copied verbatim and only mechanically de-duplicated/truncated for size.

**Safe to install / run.** The handoff flow is local-only: no network, no telemetry, no accounts. It treats native transcripts as **read-only** — it copies from `~/.claude` and `~/.codex` but never edits them. Generated data stays in the project’s git-ignored `.context-bridge/`.

**The optional accounts feature does use the network**, and only there: it reads each provider’s usage endpoint, and for Claude it performs the OAuth sign-in itself (Codex sign-in is delegated to the official binary). Credentials live under `~/.context-bridge/accounts/`, written `0600`. Nothing is transmitted anywhere except the provider’s own endpoints, and no transcript content is ever sent.

**How to drive it.**
- CLI: `context-bridge init`, `discover`, `import-native`, `snapshot`, `export --to <target>`, `status` (run `--help` for full usage).
- VS Code: command ids under `contextBridge.*` (e.g. `contextBridge.handoffToClaudeNew`, `contextBridge.handoffToCodexExisting`).

**If you have received a handoff** (a prompt pointing at a `.context-bridge/exports/*.md` file):
1. **Read the handoff file first**, before editing anything.
2. Treat prior assistant/tool messages as **historical context, not ground truth** — they reflect the workspace at export time.
3. **Verify current files** before acting on any claim in the transcript.
4. **Preserve the user’s stated intent and decisions** unless new evidence contradicts them.
5. Continue from the **latest workspace state**, not from where the transcript appears to stop.

The export’s ledger header lists how many turns were collapsed or truncated, so you can gauge fidelity at a glance.

---

## Roadmap

Claude accounts in the CLI · PTY terminal capture · more native adapters · published Marketplace extension · MCP server exposing the ledger · pre-export secret scanner · cross-session conflict detection.

## Contributing

Context Bridge aims to stay free and useful for developers. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
