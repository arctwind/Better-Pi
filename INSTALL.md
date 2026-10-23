# Installation Guide for AI Agents

Repository: [arctwind/Better-Pi](https://github.com/arctwind/Better-Pi).

## Versions and requirements

- Recommended Pi version: **0.87.1**. Some features depend on its internal APIs.
- Identify the installed copy by its commit or release tag.
- Use Node.js 24. Pi provides runtime dependencies; do not run `npm install` in the plugin directory.
- Browser controls and screenshots support Windows only and require Chrome or Edge. Web search and page fetching require DeepSeek API credentials.

## Installation

1. Check `pi --version` and `node --version`. If Pi is missing or requirements are unmet, report this to the user. Do not upgrade, downgrade, or reinstall Pi without their approval.
2. Download the plugin package from the repository above. Install it into `.pi/agent/extensions/Better Pi` under the user's home directory. On Windows, use `%USERPROFILE%\.pi\agent\extensions\Better Pi`. If `PI_CODING_AGENT_DIR` is set, use `extensions/Better Pi` inside that directory.
3. Preserve the complete directory structure. The installation directory must directly contain `index.ts`, `package.json`, and the feature directories, without an extra nested folder. If an installation already exists, inspect and preserve user changes before replacing files.
4. Start Pi, or ask the user to run `/reload` in an existing session. Enable Better Pi through `pi config` if needed. The root `index.ts` loads all features; do not register internal feature directories separately.
5. Check for extension loading errors, the `/review` command, and the footer status display. Report the installation path, Pi version, and verification results. Clearly state anything you could not verify.

## Boundaries

- Install only the plugin. Preserve existing Pi settings, credentials, sessions, and other extensions.
- If DeepSeek credentials or a browser are missing, explain the requirements for those features. Do not write API keys or install a browser without permission.
- Launch the WebUI with `pi --webui`; see the [WebUI guide](webui/README.md). Launcher synchronization requires a valid Pi installation managed through `<agent-dir>/install/current-version`. Other installation layouts are left unchanged. Existing launchers not owned by Better Pi are preserved and reported; do not replace them without permission.
- Report errors with their specific cause. Do not modify plugin source code to bypass compatibility checks.
