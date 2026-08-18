# Contributing

Context Bridge should remain easy to inspect, easy to run locally, and conservative about user data.

## Development

```bash
npm install
npm test
npm run lint
```

The current implementation uses Node.js built-ins where possible. Add dependencies only when they remove meaningful complexity.

## Privacy Rules

- Do not upload transcripts by default.
- Do not send transcript content to an AI model in core workflows.
- Treat `.context-bridge/` as private user data.
- Keep exports deterministic and inspectable.
- Prefer explicit user action before reading native tool stores.
- Keep the handoff path free of network calls.

## Credential Rules

The accounts subsystem handles live provider credentials. See [AGENTS.md](AGENTS.md#credential-rules)
for the full list; the short version:

- adopting a login copies it — a user's existing `~/.codex` or `~/.claude` is never moved or edited
- validate before writing, so a bad paste cannot damage a working login
- secrets on stdin, never argv; files written `0600`; tokens never logged
- credentials live in `~/.context-bridge/`, never in a project

If you are adding a provider, prefer delegating sign-in to its official CLI. Performing the OAuth
exchange in Context Bridge is a last resort, taken for Claude only because its CLI cannot be driven
non-interactively, and it must be documented where users will see it.

## Adapter Rules

Adapters should normalize into the shared turn schema and preserve original content. If a source format is lossy or uncertain, store the raw import as an attachment and mark the normalized turns with metadata.

## Commit Style

Use clear, direct commit messages:

```text
Add deterministic handoff exporter
Implement JSONL transcript importer
Document local ledger format
```
