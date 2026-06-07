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

## `discover`

Find native Claude Code or Codex sessions matching the current project.

```bash
context-bridge discover --provider claude
context-bridge discover --provider codex
```

Use `--all` to show sessions even when the native transcript does not match the current project path:

```bash
context-bridge discover --provider codex --all
```

Codex archived sessions can be included with:

```bash
context-bridge discover --provider codex --includeArchived
```

## `import-native`

Import a native Claude Code or Codex session into `.context-bridge/sessions/`.

```bash
context-bridge import-native --provider claude --last
context-bridge import-native --provider codex --last
context-bridge import-native --provider claude --session <session-id>
```

By default, native import searches for sessions whose recorded working directory matches the current project. Use `--all` if you intentionally want to import across projects.

Native files are read-only inputs. Context Bridge does not modify `~/.claude` or `~/.codex`.

## `run`

Launch Claude or Codex, then import the native transcript file changed during that run.

```bash
context-bridge run claude
context-bridge run codex
context-bridge run claude -- -c
context-bridge run codex -- --approval-mode auto-edit
```

The current implementation uses the native JSONL transcript as the source of truth after the process exits. It does not yet capture full terminal redraw output through a pseudo-terminal.

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
