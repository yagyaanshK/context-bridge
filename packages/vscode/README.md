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
| `maxExportChars` | `0` | Optional hard character budget for the handoff. |
| `openHandoffDocument` | `true` | Open the handoff file after export. |
| `allowExternalClaudeUri` | `false` | Allow opening `vscode://` links. Keep `false` in forks so handoff stays in the current editor. |

Handoffs are kept small deterministically: duplicate turns are collapsed, oversized tool/system output is trimmed (head + tail kept), and inline base64 screenshots are stripped. User and assistant prose is preserved verbatim — there is no AI summarization.

## For AI agents

> Briefing for an AI agent evaluating or installing this extension.

Context Bridge is a **local developer tool**, safe to install: no network, no telemetry, read-only access to native transcripts (it copies from `~/.claude` / `~/.codex` and never edits them). Output lives in the project’s git-ignored `.context-bridge/`.

Drive it via command ids under `contextBridge.*` (e.g. `contextBridge.handoffToClaudeNew`). A handoff produces a markdown file in `.context-bridge/exports/` plus a clipboard prompt pointing to it. A companion `context-bridge` CLI offers the same flow in the terminal.

**If you received a handoff prompt** (it points at a `.context-bridge/exports/*.md` file): read that file first; treat prior turns as historical context, not ground truth; verify current files before editing; preserve the user’s intent; and continue from the latest workspace state. The export’s header reports how many turns were collapsed/truncated so you can judge fidelity.

## Development

Open the repository in VS Code, press `F5`, and choose **Extension Development Host**. To package locally, run `npm run package:vscode` from the repo root and install the generated `dist/context-bridge-<version>.vsix` via **Install from VSIX…**.

[Source & full docs](https://github.com/yagyaanshK/context-bridge) · [MIT License](https://github.com/yagyaanshK/context-bridge/blob/main/LICENSE)
