# Better Pi

Better Pi adds tool output formatting, image attachments, browsing, and a local WebUI to Pi.

> Built for **Pi 0.87.1**. Other Pi versions need code fixes; see [Installation](#installation).

Suggestions are welcome as issues. Pull requests are not accepted.

## Features

- Compact tool output and footer stats for context usage, cache hits, generation speed, and session cost (`/currency` switches between USD and CNY)
- Image pasting, previews, attachment management, and DeepSeek image uploads
- Read-only code investigation with `explore` and reviews with `/review`
- Browser controls and screenshots (Windows)
- Web search and page fetching through DeepSeek
- A local [WebUI](webui/README.md) for chat, session management, and file diffs

## Web search

Web search and page fetching call DeepSeek's web tools API, so they only work when DeepSeek is available to Pi: sign in with `/login`, or set `DEEPSEEK_API_KEY`.

Other providers are not built in. Don't expect Better Pi to support them all; using one, such as Exa, means changing the request code in [web.ts](web.ts) yourself.

## Default behavior

Better Pi replaces Pi's system, style, and commit-convention prompt sections with the files in [system-prompt/](system-prompt/). The optional [boundaries prompt](system-prompt/boundaries.md) is disabled by default; `/jailbreak` toggles it.

It also skips startup version checks, excludes past thinking from compaction summaries, and adjusts mouse-wheel scrolling.

## Installation

Better Pi targets Pi 0.87.1. On another Pi version modules can fail to load: Better Pi refuses to start and Pi reports the failing module. The fix is code, and `pi update --extensions` wipes code fixes from a git install.

Pick one method. Two copies load Better Pi twice and duplicate its tools, so to switch, delete `~/.pi/agent/extensions/Better Pi` or run `pi remove git:github.com/arctwind/Better-Pi`. After installing, start Pi or run `/reload`; `pi config` enables or disables Better Pi, and `pi list` shows installed packages.

WebUI startup requires Pi's managed installation layout. See the [WebUI guide](webui/README.md#start).

### Your own fork (recommended)

Fork the repository, adapt it, and install the fork. Your changes and your update timing stay under your control.

```bash
pi install git:github.com/<you>/Better-Pi@v0.1.0
```

When upstream changes, ask an AI agent to review the new commits before adding them to your fork.

### Upstream repository

```bash
pi install git:github.com/arctwind/Better-Pi@v0.1.0
```

On a Pi version other than 0.87.1, fix the code first, then leave `pi update --extensions` alone: it resets the installed copy and drops the fix.

### Manual copy (offline)

Download the archive from [GitHub](https://github.com/arctwind/Better-Pi) and extract it into `~/.pi/agent/extensions/Better Pi` (Windows: `%USERPROFILE%\.pi\agent\extensions\Better Pi`). `index.ts` and `package.json` must sit directly inside `Better Pi`.

### Updates

`pi update --extensions` follows the default branch for an install without a ref. A tag or a full commit hash stays fixed. Short commit hashes break the update.

### Install with an AI agent

Send this prompt to your AI agent:

```text
Install Better Pi for my Pi setup.
Repository: https://github.com/arctwind/Better-Pi
Read INSTALL.md in the repository root, then follow its installation and verification instructions.
```

See [INSTALL.md](INSTALL.md) for the agent installation guide.

## Development checks

Use Node.js 24. Set `PI_PACKAGE_DIR` to the installed `@earendil-works/pi-coding-agent` directory containing its `package.json` and runtime dependencies. In PowerShell:

```powershell
$env:PI_PACKAGE_DIR = "C:\path\to\node_modules\@earendil-works\pi-coding-agent"
npm run check
npm test
```

Do not install Pi dependencies in this repository. Without a Pi installation, run `npm run test:standalone` for launcher, output handling, and WebUI tests only; this does not verify extension loading or Pi compatibility.

## Development note

Much of Better Pi was developed with AI assistance. Review the code before using it with sensitive data.

## License

Better Pi is licensed under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE). Third-party components retain their original licenses.
