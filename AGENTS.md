# Agent Instructions

This repository builds Turntrail: a local handoff layer for continuing developer agent sessions across Codex, Claude, and other tools.

The repository has two independent halves: **handoff** (local-only, no network) and **accounts**
(optional multi-account management for Codex and Claude). Neither depends on the other.

## Product Constraints

- Preserve raw transcript content.
- Do not use AI summarization in core workflows.
- Keep local ledgers private by default.
- Prefer deterministic transforms over heuristic rewriting.
- Keep the core package independent from CLI, IDE, browser, or desktop wrappers.
- Keep the handoff path free of network calls. The accounts subsystem is the only part that may
  reach the network, and only the providers' own sign-in and usage endpoints.

## Credential Rules

These are invariants, not preferences. Breaking one is a security regression.

- **Never move a user's existing login.** Adopting one copies it; `~/.codex` and `~/.claude` stay
  as they were. Only an explicit *switch* writes there, and it backs up what it replaces.
- **Validate before writing.** A rejected paste must leave any existing credential untouched.
- **Secrets go to stdin, never argv**, so they never appear in a process listing.
- **Credentials are written `0600`** (best-effort; Windows ignores POSIX modes) and live under
  `~/.turntrail/accounts/`, never inside a project's `.turntrail/`.
- **Never log or echo a token**, including in error messages and the raw-response viewer.
- **Delegate the OAuth exchange when the provider's CLI can perform it.** Codex can, so Turntrail
  only spawns `codex login` and reads its output. Claude cannot — its login is an Ink TUI
  requiring raw mode on stdin, and `setup-token` writes no credential — so Turntrail runs the
  PKCE flow itself. That asymmetry is deliberate; do not "simplify" it by making Codex match Claude.
- **Fail loudly on undocumented endpoints.** The Claude OAuth endpoints are not a published
  contract. Every error path must name what the user can do about it rather than degrade silently.

## Code Guidelines

- Use Node.js built-ins unless a dependency materially simplifies the code.
- Keep filesystem writes scoped to the selected workspace and `.turntrail/`.
- Avoid changing generated local ledgers in tests.
- Add tests for importer/exporter behavior when changing schema logic.
- Add tests for credential handling when changing the accounts subsystem, including the rejection
  message for each way a paste can be wrong.
- Provider payload shapes are observed from the wire, not published. Read them defensively and keep
  a raw-response escape hatch for when they change.

## Surfaces

Build in this order:

1. core package
2. CLI wrapper
3. VS Code extension
4. browser/desktop UI helpers
5. MCP server
