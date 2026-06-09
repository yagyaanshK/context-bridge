# Architecture

Context Bridge has one durable idea: the continuity layer should live in the project, not inside a single vendor chat.

## Packages

```text
packages/core
  schema normalization
  native transcript adapters
  context store filesystem layout
  importers
  workspace snapshots
  deterministic handoff generation

packages/cli
  command-line interface around core
```

Future wrappers should call `packages/core` instead of reimplementing ledger logic.

## Data Flow

```text
Claude / Codex / other transcript
        |
        v
import adapter
        |
        v
normalized JSONL session
        |
        +--> workspace snapshot
        |
        v
deterministic handoff markdown
        |
        v
next agent session
```

## Shared Turn Schema

Each normalized turn is written as one JSON object per line:

```json
{
  "id": "turn_...",
  "provider": "anthropic",
  "surface": "cli",
  "sessionId": "optional-source-session-id",
  "role": "user",
  "timestamp": "2026-06-08T10:15:30.000Z",
  "content": "exact user message",
  "metadata": {
    "sourcePath": "claude-transcript.jsonl"
  }
}
```

## Native Adapters

Native adapters are read-only scanners for local agent transcript stores.

Claude Code:

```text
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

Codex:

```text
~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl
~/.codex/archived_sessions/rollout-*.jsonl
```

Adapters should:

- parse JSONL line by line
- preserve original content exactly where practical
- preserve local image paths instead of embedding base64 images
- filter by recorded `cwd` when available
- never rewrite native session files
- store source path and line number in metadata

## Deterministic Packaging

The exporter never asks an AI to summarize. It builds a markdown handoff from:

- project manifest
- latest workspace snapshot
- selected transcript turns
- raw transcript references

If a budget is provided, the exporter includes turns by a deterministic priority order:

1. all user turns
2. most recent assistant/tool/system turns
3. older assistant/tool/system turns while budget remains

Raw sessions remain available on disk even when not fully embedded.

Inline media handling:

- local image paths are shown as references when available
- inline `data:image/...;base64` payloads are replaced with compact omission markers
- long bare base64 blobs are replaced with compact omission markers
- raw native transcript files remain referenced for auditability

## Privacy Model

`.context-bridge/` is gitignored because it may contain:

- private conversations
- shell output
- changed file paths
- local branch names
- issue descriptions or client data
- proprietary code snippets

Publishing a project that uses Context Bridge should not publish its local ledger by accident.
