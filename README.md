# Context Bridge

**Continue the same coding session across different AI agents — without asking one AI to summarize another.**

Context Bridge is a local, vendor-neutral handoff layer for developers who switch between agentic coding tools such as **Claude Code** and **Codex**. It captures an exact transcript and workspace snapshot, then generates a clean handoff you paste into the next tool.

- 🔒 **Local-only** — everything lives in your project under `.context-bridge/`. No accounts, no telemetry, no network calls.
- 🧾 **Lossless** — native transcripts are imported verbatim as JSONL. No AI summary in the core flow.
- ✂️ **Lean handoffs** — duplicate turns are collapsed, noisy tool output is trimmed, and inline screenshots are stripped, so a handoff stays small enough for the next agent to actually read.
- 🧰 **Two ways to use it** — a `context-bridge` CLI and a VS Code extension (works in forks like Cursor, Windsurf, and Google Antigravity).

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

Then in your editor run **“Extensions: Install from VSIX…”** and pick `dist/context-bridge-<version>.vsix` (currently `context-bridge-0.1.4.vsix`). This works in VS Code and compatible forks (Cursor, Windsurf, Google Antigravity).

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

## Quick start (VS Code)

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

**Export options:** `--max-chars <n>` (budget, 0 = off) · `--no-dedupe` · `--tool-max-chars <n>` (default 2000) · `--system-max-chars <n>` (default 800). All flags accept kebab- or camelCase.

---

## VS Code commands & settings

**Commands** (Command Palette → “Context Bridge: …”): Discover / Import Latest (Claude·Codex), Handoff to New/Existing (Claude·Codex), Open Latest Handoff, Copy Latest Handoff Prompt.

**Settings** (`contextBridge.*`):

| Setting | Default | Effect |
|---------|---------|--------|
| `dedupeTurns` | `true` | Collapse consecutive duplicate turns. |
| `toolMaxChars` | `2000` | Truncate long tool outputs (0 = off). |
| `systemMaxChars` | `800` | Truncate long system turns (0 = off). |
| `maxExportChars` | `0` | Optional hard character budget. |
| `openHandoffDocument` | `true` | Open the handoff file after export. |
| `allowExternalClaudeUri` | `false` | Allow opening `vscode://` links (keep off in forks). |

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

**Safe to install / run.** It is local-only: no network, no telemetry, no accounts. It treats native transcripts as **read-only** — it copies from `~/.claude` and `~/.codex` but never edits them. Generated data stays in the project’s git-ignored `.context-bridge/`.

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

PTY terminal capture · more native adapters · published Marketplace extension · MCP server exposing the ledger · pre-export secret scanner · cross-session conflict detection.

## Contributing

Context Bridge aims to stay free and useful for developers. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
