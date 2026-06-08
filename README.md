# Context Bridge

Context Bridge is a local, vendor-neutral handoff layer for developers who switch between coding agents such as Codex and Claude.

The goal is simple: continue the same project conversation across tools without asking another AI to summarize it.

## Why This Exists

Developers increasingly use multiple agentic coding tools in the same project. One agent might be better at a refactor, another at UI iteration, another at code review. The hard part is continuity: after a meaningful session in one tool, the next tool often starts with partial context, stale assumptions, or a lossy summary.

Context Bridge treats continuity as a local project artifact:

- exact transcript imports are preserved as JSONL
- workspace state is captured with Git and file metadata
- handoff prompts are generated deterministically
- no AI summarization is required in the core flow
- CLI comes first, IDE and UI wrappers can reuse the same core package

## Status

This repository is in the first implementation pass. The current MVP supports:

- initializing a `.context-bridge/` ledger
- importing JSON, JSONL, Markdown, or plain text transcripts
- discovering native Claude Code and Codex transcript files
- importing native Claude Code and Codex JSONL sessions
- launching Claude or Codex and importing the transcript changed during that run
- normalizing turns into a shared schema
- capturing a deterministic workspace snapshot
- generating handoff markdown for Codex, Claude, or another agent
- checking ledger status
- VS Code commands for extension-based Claude/Codex handoffs

## Install From Source

```bash
git clone https://github.com/yagyaanshK/context-bridge.git
cd context-bridge
npm install
npm test
```

Run the CLI locally:

```bash
node packages/cli/bin/context-bridge.js --help
```

Package the VS Code extension locally:

```bash
npm run package:vscode
```

Then install `dist/context-bridge-0.1.0.vsix` via `Install from VSIX...` in VS Code or a compatible fork such as Cursor, Windsurf, or Google Antigravity.

## Quick Start

Inside any coding project:

```bash
context-bridge init
context-bridge import --provider claude --surface cli ./claude-transcript.jsonl
context-bridge discover --provider claude
context-bridge import-native --provider claude --last
context-bridge snapshot
context-bridge export --to codex
```

The export command writes a handoff file under:

```text
.context-bridge/exports/
```

Paste that generated handoff into the receiving tool, or point the tool at the file when it supports file context.

## Repository Format

Context Bridge writes local project state under `.context-bridge/`:

```text
.context-bridge/
  manifest.json
  sessions/
    2026-06-08T10-15-30-000Z-claude-cli.jsonl
  snapshots/
    2026-06-08T10-20-00-000Z.json
  exports/
    2026-06-08T10-21-00-000Z-to-codex.md
  attachments/
```

The folder is ignored by default because it can contain private transcripts, command output, file paths, and other sensitive project details.

## Design Principle

Context Bridge does not try to merge native vendor chats. That would be brittle and dependent on private product internals. Instead, it creates a shared conversation ledger that tools can consume.

Native transcript support is read-only. Context Bridge copies and normalizes Claude/Codex transcript data into `.context-bridge/`; it does not edit files under `~/.claude` or `~/.codex`.

When transcripts exceed the target context budget, Context Bridge does deterministic packaging:

- preserve all user messages first
- preserve recent turns verbatim
- preserve workspace snapshots and changed-file metadata
- keep older raw transcripts on disk as referenced attachments
- never rewrite old messages as an AI-generated summary

## Roadmap

- richer CLI session wrappers with PTY terminal capture
- native transcript store adapters for more agent tools
- package and publish the VS Code extension
- browser or desktop helpers for web/desktop UIs
- MCP server exposing the ledger to agent tools
- privacy scanner for secrets before export
- conflict detector for incompatible decisions across sessions

## Contributing

The project is meant to stay free and useful for developers. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
