# CLI Reference

The binary name is `context-bridge`. The short alias `cb` can be added later when publishing packages.

## `init`

Create a `.context-bridge/` ledger in the current project.

```bash
context-bridge init
```

## `import`

Import a transcript file into the local ledger.

```bash
context-bridge import --provider claude --surface cli ./transcript.jsonl
context-bridge import --provider codex --surface ide ./codex-export.json
context-bridge import --provider other ./notes.md
```

Supported inputs:

- `.jsonl`: one JSON object per line
- `.json`: arrays, common `{ messages: [...] }` shapes, or a single object
- `.md` / `.txt`: preserved as a single imported transcript turn

## `snapshot`

Capture workspace state.

```bash
context-bridge snapshot
```

The snapshot includes Git branch, status, latest commit, and top-level files when available.

## `export`

Generate a deterministic handoff file.

```bash
context-bridge export --to codex
context-bridge export --to claude --max-chars 60000
```

The generated file appears in `.context-bridge/exports/`.

## `status`

Show ledger status.

```bash
context-bridge status
```
