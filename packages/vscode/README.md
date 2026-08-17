# Context Bridge — VS Code Extension

**Continue the same coding session across Claude Code, Codex, and other agents — without asking one AI to summarize another.**

Context Bridge imports the latest native session from one agent, snapshots your workspace, and writes a clean, deterministic **handoff** you paste into the next agent. Everything stays local in `.context-bridge/` — no accounts, no telemetry, no network.

Works in VS Code and compatible forks (Cursor, Windsurf, Google Antigravity).

## Use it

1. Run **`Context Bridge: Handoff to New Claude Session`** (or Codex, or “Existing”).
2. The extension imports the latest session from the *other* tool, snapshots the workspace, and writes a handoff markdown file.
3. A short prompt is **copied to your clipboard** — the notification states the word count and which tool to paste into.
4. Paste it into the target agent and keep working.

To ingest a session without generating a handoff, use **Discover … Sessions** → pick one → **Import** (you get a confirmation with the turn count).

## Commands

- `Context Bridge: Discover Claude Sessions` / `Discover Codex Sessions`
- `Context Bridge: Import Latest Claude Session` / `Import Latest Codex Session`
- `Context Bridge: Handoff to New / Existing Claude Session`
- `Context Bridge: Handoff to New / Existing Codex Session`
- `Context Bridge: Open Latest Handoff`
- `Context Bridge: Copy Latest Handoff Prompt`

## Settings (`contextBridge.*`)

| Setting | Default | Effect |
|---------|---------|--------|
| `dedupeTurns` | `true` | Collapse consecutive duplicate turns in exports. |
| `toolMaxChars` | `2000` | Truncate long tool outputs (git diffs, listings); `0` disables. |
| `systemMaxChars` | `800` | Truncate long system turns; `0` disables. |
| `maxExportChars` | `120000` | Character budget for the transcript. User turns are reserved first, then the most recent turns fill the budget; `0` disables it. |
| `sinceLastExport` | `false` | Only include turns newer than the previous export. Leave off unless you always paste every handoff into the same continuing session. |
| `snapshotDiffMaxChars` | `4000` | How much of the uncommitted diff (vs HEAD) to embed; `0` shows the file-level stat only. |
| `keepExports` | `10` | Past handoff files kept in `.context-bridge/exports`; older ones are deleted after each export. `0` keeps all. |
| `openHandoffDocument` | `true` | Open the handoff file after export. |
| `allowExternalClaudeUri` | `false` | Allow opening `vscode://` links. Keep `false` in forks so handoff stays in the current editor. |

Handoffs are kept small deterministically: duplicate turns are collapsed, oversized tool/system output is trimmed (head + tail kept), inline base64 screenshots are stripped, and a total character budget caps the transcript. User and assistant prose is preserved verbatim — there is no AI summarization.

The budget is on by default because an unbounded handoff is not actually lossless: receiving agents refuse or silently truncate oversized files, so an over-long export delivers a fraction of itself with no indication that anything is missing. A budgeted export reports exactly what it dropped in its header.

Every handoff opens with **Where This Left Off**: the last real request and the last assistant message quoted verbatim, plus files written and recent commands pulled from recorded tool-call arguments. It is extractive, never generated, and it is built from the whole session — so the last request survives even when the budget drops the turn that carried it. The workspace snapshot below it carries the uncommitted diff and a `git log -1` check, so the receiving agent can tell whether the tree moved on before it starts editing.

## Codex subscriptions

A **Context Bridge** panel in the activity bar lists your Codex subscriptions as cards: plan, masked
email, a usage bar, the remaining percentage of whichever window is tightest, and when it resets.
A pooled bar at the top totals what you have across all of them. Buttons appear on hover, so nothing
needs the command palette.

Each subscription gets its own `CODEX_HOME` under `~/.context-bridge/accounts/`, so they all stay
signed in simultaneously — there is nothing to swap.

**Signing in** happens in a panel offering all three methods the Codex CLI supports: browser OAuth,
a device code for remote machines, or an API key. Behind it, the official `codex` binary runs as a
background process with `CODEX_HOME` pointed at that subscription's directory — Context Bridge reads
its output to drive the progress display, but never performs the OAuth exchange and never holds a
token. The CLI opens your browser itself; if it cannot, the panel shows the link. The credential is written by `codex`, into its own
directory. **Your existing login at `~/.codex` is never touched by signing in or adding an
account**; only *switching* writes there, and it backs up what it replaces first.

**Click a row to switch.** The official Codex extension and CLI read one credential path, so
switching rewrites it — which is exactly what makes the *official* Codex UI start using the
subscription you picked. The account in use is marked, and shows in the status bar with its
remaining quota. Every subscription stays signed in, so switching back is one more click; the
confirmation toast also offers **Undo** and **Reload Window**.

| Action | Effect |
|--------|--------|
| **Click a row** | Switches Codex to that subscription. |
| **Open Codex Terminal** | Starts `codex` as that subscription without changing the machine default. |
| **Sign In** | Opens the sign-in panel: browser, device code, or API key. |
| **Refresh Quota** | Forces a usage read; otherwise readings are cached for five minutes. |
| **Raw Response** | Opens the endpoint's actual JSON next to how Context Bridge parsed it. Use this if the percentages look wrong or missing. |

Switching is manual. The panel shows what each subscription has left and lets you choose — it does
not fail over on its own when one runs out.

**What this cannot do.** A VS Code extension cannot add UI inside another extension's panel, so the
picker lives in the sidebar and status bar rather than inside Codex's own menu. Tools that put it
there patch the ChatGPT desktop application itself, which pins them to an exact app build.

---

## For AI agents

> Briefing for an AI agent evaluating or installing this extension.

Context Bridge is a **local developer tool**, safe to install: no network, no telemetry, read-only access to native transcripts (it copies from `~/.claude` / `~/.codex` and never edits them). Output lives in the project’s git-ignored `.context-bridge/`.

Drive it via command ids under `contextBridge.*` (e.g. `contextBridge.handoffToClaudeNew`). A handoff produces a markdown file in `.context-bridge/exports/` plus a clipboard prompt pointing to it. A companion `context-bridge` CLI offers the same flow in the terminal.

**If you received a handoff prompt** (it points at a `.context-bridge/exports/*.md` file): read that file first; treat prior turns as historical context, not ground truth; verify current files before editing; preserve the user’s intent; and continue from the latest workspace state. The export’s header reports how many turns were collapsed/truncated so you can judge fidelity.

## Development

Open the repository in VS Code, press `F5`, and choose **Extension Development Host**. To package locally, run `npm run package:vscode` from the repo root and install the generated `dist/context-bridge-<version>.vsix` via **Install from VSIX…**.

[Source & full docs](https://github.com/yagyaanshK/context-bridge) · [MIT License](https://github.com/yagyaanshK/context-bridge/blob/main/LICENSE)
