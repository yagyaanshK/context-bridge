# VS Code Extension

Context Bridge includes a VS Code extension package for developers who use Claude and Codex primarily through IDE extensions.

## Commands

Open the command palette and run:

- `Context Bridge: Handoff to Existing Claude Session`
- `Context Bridge: Handoff to New Claude Session`
- `Context Bridge: Handoff to Existing Codex Session`
- `Context Bridge: Handoff to New Codex Session`
- `Context Bridge: Discover Claude Sessions`
- `Context Bridge: Discover Codex Sessions`
- `Context Bridge: Import Latest Claude Session`
- `Context Bridge: Import Latest Codex Session`

## How Handoff Works

Context Bridge generates the same deterministic handoff whether you paste it into an existing session or a new one.

When handing off to Claude, the extension imports the latest Codex native transcript for the workspace, captures a workspace snapshot, generates a handoff markdown file, and copies a concise prompt to the clipboard.

When handing off to Codex, the extension imports the latest Claude native transcript for the workspace, captures a workspace snapshot, generates a handoff markdown file, and copies a concise prompt to the clipboard.

The receiving prompt points at the handoff file instead of pasting a giant transcript into the chat box:

```text
Continue in this existing session using this Context Bridge handoff:

<path-to-.context-bridge/exports/...md>

Read the handoff before acting...
```

Screenshot payloads embedded in native transcripts are not pasted into the handoff. Context Bridge keeps local image paths when available and replaces inline base64 image blobs with compact omission markers.

## Existing vs New Session

Use an existing session for short round trips where the original conversation is still coherent.

Use a new session when the old native chat is long, stale, noisy, or confused. The Context Bridge ledger remains the source of truth either way.

## Claude

For new Claude sessions, Context Bridge first tries to find and execute an installed Claude/Anthropic command in the current editor.

You can set `contextBridge.claudeOpenCommand` to the exact command id if your editor exposes one.

Context Bridge no longer opens the Claude Code URI by default because VS Code forks may hand `vscode://...` links to Microsoft VS Code instead of the current editor. If you want that external behavior, enable `contextBridge.allowExternalClaudeUri`.

The optional URI setting is:

```text
vscode://anthropic.claude-code/open
```

You can override it with `contextBridge.claudeUri`.

## Codex

Codex does not currently have a documented URI equivalent in this project. Context Bridge tries to find an installed VS Code command containing `codex` or `openai`; if that fails, it leaves the prompt on the clipboard and opens the handoff document.

You can set `contextBridge.codexOpenCommand` to the exact Codex command id if your installation exposes one.

## Development

```bash
npm install
npm run lint
```

Then open the repository in VS Code and press `F5` to launch an Extension Development Host. The repository includes `.vscode/launch.json`, so VS Code should open the Extension Development Host directly instead of asking you to select a debugger.

## Local VSIX Install

For normal use, package a VSIX:

```bash
npm run package:vscode
```

This writes:

```text
dist/context-bridge-0.1.0.vsix
```

Install it from the Extensions view:

1. Open Extensions.
2. Click the `...` menu.
3. Choose `Install from VSIX...`.
4. Select `dist/context-bridge-0.1.0.vsix`.

This is the best path before marketplace publication because it works like a normal extension install.

## VS Code Forks

Context Bridge uses the standard VSIX extension format and the public VS Code extension API. The local VSIX should install in VS Code-compatible editors that support VSIX extensions, including Cursor, Windsurf, and Google Antigravity.

If a fork does not expose the same Claude/Codex extension commands, Context Bridge still generates the handoff file and copies the prompt. The user can paste the prompt into the target agent manually.
