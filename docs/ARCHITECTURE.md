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

Codex names its threads but keeps the name out of the transcript, in an append-only index read
alongside the rollout files and joined on the thread id:

```text
~/.codex/session_index.jsonl   {"id", "thread_name", "updated_at"}
```

Codex mirrors these names into a `threads` table in `~/.codex/state_5.sqlite`, which is deliberately
not read. Measured against a real install of 64 threads, the table named nothing the index had not
already named and its `name` column was empty throughout, so reading it would buy a SQLite
dependency, locked-database handling and exposure to the drift between the two stores for nothing.

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

1. user turns, newest first; an oversized latest request is truncated into the budget rather than dropped
2. most recent assistant/tool/system turns
3. older assistant/tool/system turns while budget remains

Raw sessions remain available on disk even when not fully embedded.

JSONL parsing is streaming and line-bounded. Discovery retains a bounded newest candidate set, and import/export enforce explicit turn and content ceilings. These limits bound memory without modifying the native source or the complete sessions already stored in the ledger; callers can deliberately raise them for unusually large workspaces. Core loops accept an abort signal, which the VS Code progress notification wires to its Cancel action.

Inline media handling:

- local image paths are shown as references when available
- inline `data:image/...;base64` payloads are replaced with compact omission markers
- long bare base64 blobs are replaced with compact omission markers
- raw native transcript files remain referenced for auditability

## Round Trips

A ledger that only flows one way needs none of this. One that ping-pongs does, and
`packages/core/src/roundtrip.js` holds the three mechanics involved.

**Plumbing removal.** Pasting a handoff puts the prompt into the receiving agent's transcript, and
the prompt tells that agent to read the handoff file — so re-importing it captures both. Left alone,
the next handoff carries a user turn that is really Context Bridge's prompt, plus a whole handoff
document nested inside itself and truncated mid-page. `stripHandoffPlumbing` drops both. Detection
requires two markers, each anchored to the start of a line and found within the first 4000 characters,
so a turn that merely quotes one — which happens whenever Context Bridge is the project being worked
on — is kept.

**Per-agent watermarks.** `lastSeenBy` answers how far an agent has already seen: the later of the
last handoff aimed at it and its own last turn in the ledger. Both halves matter. Using the newest
export of any target loses work — hand off to Claude, refresh Claude again, return to Codex, and
everything Claude did before the refresh falls outside the window. Ignoring the agent's own turns
breaks the first return trip, where the agent has been sent no handoff at all but wrote half the
ledger itself.

**Origin chats.** `writeSession` records the native session id and the agent's own name for it, so
`originChat` can say which chat a handoff should be continued in, and the VS Code session picker can
offer it first. Only agent-assigned names are used; an unnamed session's opening request is not a
name, and for a session started from a handoff it is Context Bridge's own prompt.

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

### Credential sources, and what Context Bridge does not touch

`~/.codex` is shared by more than one program, and they do not all authenticate the same way. This
matters because it bounds what switching an account can and cannot affect.

- The **Codex CLI** and the **Codex IDE extension** (VS Code, Cursor, and forks) read the OAuth
  credential at `~/.codex/auth.json`. This is the only credential Context Bridge reads, renews, or
  rewrites when you switch a Codex account.
- The **Codex/ChatGPT desktop app** keeps its *working data* in `~/.codex` as well — a thread
  database (`state_5.sqlite`), a session index (`session_index.jsonl`), logs, and an Electron state
  file (`.codex-global-state.json`) — but it does **not** authenticate through `auth.json`. Its
  account is selected by an id recorded in `.codex-global-state.json`, with no token stored beside
  it; the actual credential lives in the app's own protected session, separate from `auth.json`.
  (Observed on a real install: with `auth.json` holding one account, the desktop app ran a different
  one; no plaintext token, OS credential-manager entry, or browser session store for it could be
  found on disk.) OpenAI's desktop apps follow the usual Electron pattern — sign in with OAuth 2.0 +
  PKCE through the system browser, then store the session with the OS-backed keystore (Electron
  `safeStorage`, which wraps DPAPI on Windows and Keychain on macOS) and/or the OS credential
  manager — which is precisely why the token is not a readable file. The classic ChatGPT desktop app
  keeps its data under `%APPDATA%\OpenAI\ChatGPT\` (macOS: `~/Library/Application Support/ChatGPT/`);
  the newer Codex desktop app uses `~/.codex` together with `%LOCALAPPDATA%\OpenAI\Codex`.

The consequence is the useful part: switching a Codex account in Context Bridge rewrites `auth.json`
and so moves the **CLI and IDE extension**, and nothing else. The desktop app is unaffected and can
stay signed in as a different account at the same time. The reverse holds too — the desktop app
never changes `auth.json` — which is why the two can run different accounts simultaneously.

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
- `resumesAt()` answers "when does this start working again", which is deliberately not the next
  reset: a window with room can reset sooner than the one blocking you, and several exhausted
  windows clear you only when the last of them resets. `nextResetAt()` is the plain earliest reset
  and must never be used to answer the first question

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
