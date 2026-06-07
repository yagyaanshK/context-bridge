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

## Adapter Rules

Adapters should normalize into the shared turn schema and preserve original content. If a source format is lossy or uncertain, store the raw import as an attachment and mark the normalized turns with metadata.

## Commit Style

Use clear, direct commit messages:

```text
Add deterministic handoff exporter
Implement JSONL transcript importer
Document local ledger format
```
