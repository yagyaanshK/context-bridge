# Agent Instructions

This repository builds Context Bridge: a local handoff layer for continuing developer agent sessions across Codex, Claude, and other tools.

## Product Constraints

- Preserve raw transcript content.
- Do not use AI summarization in core workflows.
- Keep local ledgers private by default.
- Prefer deterministic transforms over heuristic rewriting.
- Keep the core package independent from CLI, IDE, browser, or desktop wrappers.

## Code Guidelines

- Use Node.js built-ins unless a dependency materially simplifies the code.
- Keep filesystem writes scoped to the selected workspace and `.context-bridge/`.
- Avoid changing generated local ledgers in tests.
- Add tests for importer/exporter behavior when changing schema logic.

## Surfaces

Build in this order:

1. core package
2. CLI wrapper
3. VS Code extension
4. browser/desktop UI helpers
5. MCP server
