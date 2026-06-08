# Context Bridge VS Code Extension

This package provides VS Code commands for using Context Bridge from extension-based Claude/Codex workflows.

## Commands

- `Context Bridge: Discover Claude Sessions`
- `Context Bridge: Discover Codex Sessions`
- `Context Bridge: Import Latest Claude Session`
- `Context Bridge: Import Latest Codex Session`
- `Context Bridge: Handoff to Existing Claude Session`
- `Context Bridge: Handoff to New Claude Session`
- `Context Bridge: Handoff to Existing Codex Session`
- `Context Bridge: Handoff to New Codex Session`
- `Context Bridge: Open Latest Handoff`
- `Context Bridge: Copy Latest Handoff Prompt`

## Intended Flow

Claude to Codex:

1. Run `Context Bridge: Handoff to Existing Codex Session` or `Context Bridge: Handoff to New Codex Session`.
2. Context Bridge imports the latest Claude native session for the workspace.
3. It captures a workspace snapshot.
4. It writes a deterministic handoff markdown file.
5. It copies a short prompt pointing to that handoff.
6. Paste the prompt into Codex.

Codex to Claude:

1. Run `Context Bridge: Handoff to Existing Claude Session` or `Context Bridge: Handoff to New Claude Session`.
2. Context Bridge imports the latest Codex native session for the workspace.
3. It captures a workspace snapshot.
4. It writes a deterministic handoff markdown file.
5. It copies a short prompt pointing to that handoff.
6. Paste the prompt into Claude.

## Development

Open this repository in VS Code, then press `F5` and choose `Extension Development Host`.

## Install Locally

From the repository root:

```bash
npm run package:vscode
```

Then install `dist/context-bridge-0.1.0.vsix` using the editor's `Install from VSIX...` command. This should work in VS Code-compatible forks such as Cursor, Windsurf, and Google Antigravity when they support VSIX installation.

In VS Code forks, Context Bridge avoids opening `vscode://...` links by default because those links may launch Microsoft VS Code. It tries editor commands first and otherwise leaves the handoff prompt copied for manual paste.
