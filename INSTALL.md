# Installation Guide for AI Agents

Repository: [arctwind/Better-Pi](https://github.com/arctwind/Better-Pi).

## Versions and requirements

- Target Pi version: **0.87.1**. Some features depend on its internal APIs.
- Use Node.js 24. Pi provides runtime dependencies; do not run `npm install` in the plugin directory.
- Browser controls and screenshots support Windows only and require Chrome or Edge. Web search and page fetching require DeepSeek API credentials.
- Identify the installed copy by its tag or commit.

## Installation

1. Check `pi --version` and `node --version`. If Pi is missing or is not 0.87.1, say so and wait for the user's decision. Do not upgrade, downgrade, or reinstall Pi without their approval.
2. Ask whether the user wants to install their own fork or the upstream repository, and wait for the answer:
   - Fork: `pi install git:github.com/<user>/Better-Pi@<tag>`. Recommended when the user intends to change the code.
   - Upstream: `pi install git:github.com/arctwind/Better-Pi@<tag>`.

   Install the latest tag, not the default branch.
3. Check `pi list` and `.pi/agent/extensions/Better Pi` first. Only one copy may exist; an extensions copy plus a Pi package loads Better Pi twice and duplicates its tools. If another copy is present, ask the user before removing it.
4. Confirm the entry with `pi list`. Start Pi, or ask the user to run `/reload` in an existing session. Enable Better Pi through `pi config` if needed. The root `index.ts` loads all features; do not register feature directories separately.
5. Check for extension loading errors, the `/review` command, and the footer status display. Report the installation path, Pi version, and verification results. Clearly state anything you could not verify.

## Boundaries

- Install only the plugin. Preserve existing Pi settings, credentials, sessions, and other extensions.
- On a Pi version other than 0.87.1, modules can fail to load. Fixing compatibility is allowed with the user's approval; never bypass the load checks. After a fix, do not run `pi update --extensions`: it resets a git install to its tag and drops the fix.
- If DeepSeek credentials or a browser are missing, explain the requirements for those features. Do not write API keys or install a browser without permission.
- Launch the WebUI with `pi --webui`; see the [WebUI guide](webui/README.md). Launcher synchronization requires a valid Pi installation managed through `<agent-dir>/install/current-version`. Other installation layouts are left unchanged. Existing launchers not owned by Better Pi are preserved and reported; do not replace them without permission.
- Report errors with their specific cause.
