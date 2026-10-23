# Pi WebUI

## Start

The `--webui` launcher requires Pi's managed installation layout, including `<agent-dir>/install/current-version`. On startup and reload, Better Pi validates that installation before creating or updating its launcher at `<agent-dir>/bin/pi-launcher.js`. Other launchers are preserved and reported as conflicts. Other installation layouts are left unchanged and do not gain `--webui` support.

Run this command in your working directory:

```sh
pi --webui
```

Open the complete URL printed in the terminal. Each launch starts a separate server bound to `127.0.0.1` on a random port. Press Ctrl+C in the terminal to stop the server and its Pi process. Closing the browser tab does not stop them.

## Chat

- Enter sends a message; Shift+Enter adds a line.
- Type `/` for commands or `@` for files and directories. Quote paths containing spaces, such as `@"directory/file name"`.
- Paste, drag, or use `+` to attach PNG, JPEG, WebP, or GIF images, up to 8 per message and 10 MB each.
- Ctrl/⌘ + K opens the command palette. Use the input controls to choose a model and thinking level, and the inspector or palette to switch themes.

Expand tool calls and thinking to read their output. Select changed files to view diffs. Click file paths to open them, Ctrl/⌘ + click to use the default application, or right-click for more opening options.

## Sessions

Use `/new` to start a conversation and `/resume` to find and switch sessions. Unsent text is saved separately for each session. Image drafts stay in the current page; the WebUI reload action described below preserves them across its page reload.

Messages sent during a task are queued and run after it finishes. Stop clears the queue and cancels the task.

Editing an earlier message creates a branch before that message and preserves the original session. File changes already made are not rolled back.

## Reload

The command palette's WebUI reload action refreshes WebUI code and Pi extensions, skills, and settings while preserving the current session and text and image drafts. Changes to the launcher, HTTP server, or RPC connection require restarting the instance.

Refreshing the browser page reconnects to the running session and restores unsent text.

## Development

See [Development checks](../README.md#development-checks) for Pi dependency setup and the standalone test command.
