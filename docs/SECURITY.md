# Security Model

Turntrail is a local developer tool. The handoff path does not upload transcripts, snapshots, or exports. The optional account and quota features communicate only with the configured provider endpoints.

## Private data

The `.turntrail/` ledger is a verbatim working record. Native transcripts, command output, paths, and workspace snapshots can contain sensitive information. Keep the directory excluded from version control and do not share it as an archive.

Generated handoff Markdown applies deterministic redaction to common credential assignments, authorization headers, private keys, JWTs, provider token formats, and credentials embedded in HTTP Git remotes. It also removes inline base64 media. Pattern-based redaction cannot recognize every private value, so review an export before posting it publicly.

## Filesystem boundaries

Account and session identifiers are restricted to safe filename segments. Manifest paths are resolved and verified inside their expected ledger directory before being read. Registry and manifest updates use atomic replacement plus a bounded cross-process lock so concurrent editor windows cannot silently discard each other's updates.

## Provider compatibility

The optional account panel depends on observed private provider interfaces. Successful token, profile,
credential, and quota payloads are validated before use; incompatible shapes produce a redacted, versioned
compatibility error instead of being accepted or cached. See [Provider Contracts](PROVIDER_CONTRACTS.md) for
the contract inventory, failure behavior, and maintenance procedure.

## Account switch isolation

Turntrail never replaces a live provider credential while that provider has a running process. IDE
background services count because they retain authentication state and can refresh persisted tokens.
When the extension queues a switch, a detached local helper waits for three consecutive process-free
polls and then calls the same fail-closed switch routine used by the CLI. The routine checks the
process list again before its final atomic credential copy.

Queued request files live in the extension's global storage, are written `0600` where supported, and
contain an account id, a bounded blocker description, a deadline, and editor relaunch metadata. They
never contain access tokens, refresh tokens, API keys, or credential contents. Requests expire after
15 minutes; malformed, expired, raced, or failed requests do not modify the live provider login.

## Untrusted metadata

Transcript content is intentionally passed to the receiving agent as historical conversation. Paths, branch names, session labels, media references, and other metadata are separately flattened and escaped so they cannot add Markdown sections or close a fenced block. Handoffs explicitly tell the receiving agent to treat metadata as data, never instructions.

## Reporting

Do not include credentials, private transcripts, or a populated `.turntrail/` directory in a report. Open a GitHub security advisory for vulnerabilities that would expose data or modify files outside the documented boundaries.
