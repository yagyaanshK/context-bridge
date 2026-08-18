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
  accounts/            multi-account isolation, sign-in, quota

packages/cli
  command-line interface around core

packages/vscode
  extension host: handoff commands, accounts panel, sign-in panel
```

Future wrappers should call `packages/core` instead of reimplementing ledger logic.

The two halves are independent. The **handoff** half is local-only and never touches the network.
The **accounts** half is optional, is the only part that makes network calls, and is not involved in
producing a handoff. Neither depends on the other.

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

## Accounts

An optional subsystem for running several Codex subscriptions and Claude accounts on one machine.
It shares nothing with the ledger: its state lives in the home directory, because the same accounts
are the same accounts in every repo you open.

```text
~/.context-bridge/
  accounts.json                    # registry: id, provider, label, email, plan
  accounts/<id>/
    codex-home/     or  claude-home/   # whatever that agent's CLI treats as its world
    quota.json                          # cached usage reading
```

### Isolation

Multi-account is multi-directory. Each CLI keeps its identity under one environment variable, so
pointing that variable at a per-account directory lets every account stay signed in at once:

| Agent | Variable | Credential file |
|-------|----------|-----------------|
| Codex | `CODEX_HOME` | `auth.json` |
| Claude | `CLAUDE_CONFIG_DIR` | `.credentials.json` |

Claude splits credential from identity. `.credentials.json` holds the tokens; the email and
organization live under the `oauthAccount` key of a separate config file. That file sits *beside*
the stock `~/.claude` home, at `~/.claude.json`, but moves *inside* any custom
`CLAUDE_CONFIG_DIR`. Both facts were verified on disk; getting either backwards means writing
identity into a file nothing reads.

### Sign-in

The two agents are handled differently, and the difference is forced by what their CLIs are:

- **Codex** — `codex login` prints plain text to stdout. Context Bridge spawns it with
  `CODEX_HOME` set, parses the output to drive its own progress UI, and never performs the OAuth
  exchange. The credential is written by `codex`.
- **Claude** — `claude` and `claude setup-token` render an Ink terminal UI that requires raw mode
  on stdin, so a piped child process dies before printing anything; `setup-token` also writes no
  credential by design. The official VS Code extension avoids this by bundling the CLI runtime, which
  an extension cannot borrow. So Context Bridge runs the same public PKCE flow the CLI runs and
  writes the credential itself.

**Consequence to state plainly:** for Claude, Context Bridge performs the token exchange and handles
the tokens. It does not for Codex. The Claude endpoints are not a published contract, so
`accounts/claude-oauth.js` is written to fail loudly — every error path names what the user can do
about it — rather than degrade silently when they change.

Invariants for both:

- secrets are passed on stdin, never argv, so they never appear in a process listing
- credentials are written `0600` (best-effort; Windows ignores POSIX modes)
- an existing login at `~/.codex` or `~/.claude` is never touched by adding an account
- switching backs up what it replaces, and is undoable
- validation happens before any write, so a rejected paste cannot damage a working login

### Switching

The official CLIs and extensions read one credential path each, so making an account "current" is
necessarily machine-wide. Codex is a single file copy. Claude is two writes: the credential, plus a
**patch** of the `oauthAccount` key in the config — the rest of that file is project history and
caches and must survive byte-identical.

### Quota

One cache path and one staleness policy for both providers, so they cannot drift apart:

- readings are cached five minutes per account; `force` overrides, `offline` never touches the network
- a cached reading with **zero windows** never satisfies a read — that is a parse miss, not a fact,
  and would otherwise survive the upgrade that fixed it
- a failed refresh keeps the previous reading with its age, rather than blanking the display
- the headline number is the account's **tightest** window, because that is the one that stops you

The two payloads are read differently on purpose. Codex's shape is undocumented and shifts, so the
normalizer walks the whole payload collecting anything that looks like a usage window. Claude's
response carries a curated `limits` array, so that is read directly — walking it generically invents
windows out of codenamed buckets sitting at 100% remaining and inflates the headline.

Claude access tokens expire every eight hours and the official client renews only the account it is
using, so Context Bridge renews the others before reading their quota.

## Privacy Model

`.context-bridge/` is gitignored because it may contain:

- private conversations
- shell output
- changed file paths
- local branch names
- issue descriptions or client data
- proprietary code snippets

Publishing a project that uses Context Bridge should not publish its local ledger by accident.

Account credentials are deliberately kept **out** of the project: they live in `~/.context-bridge/`,
never in `.context-bridge/`, so a repository can never carry a token even if the ledger is committed
by mistake.
