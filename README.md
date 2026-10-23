# Better Pi

Better Pi adds tool output formatting, image attachments, browsing, and a local WebUI to Pi.

> Recommended for use with **Pi 0.87.1**.

Newer Pi versions may change APIs that Better Pi components depend on, causing a module to fail to load. Better Pi then refuses to start instead of running partially, and Pi shows the failing module with the error details. Send the complete error message to an AI agent to help fix the compatibility issue.

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

### Manual installation

Download the plugin package from [GitHub](https://github.com/arctwind/Better-Pi) and extract it into `~/.pi/agent/extensions/Better Pi` (on Windows, `%USERPROFILE%\.pi\agent\extensions\Better Pi`).

Make sure `index.ts` and `package.json` sit directly inside `Better Pi`. Start Pi or run `/reload`. If needed, enable Better Pi through `pi config`.

WebUI startup requires Pi's managed installation layout. See the [WebUI guide](webui/README.md#start) for launcher requirements and behavior.

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
