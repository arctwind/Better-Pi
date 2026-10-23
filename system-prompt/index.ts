import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const JAILBREAK_STATE = Symbol.for("system-prompt.jailbreak");
const JAILBREAK_STATUS = "system-prompt:jailbreak";

const PROMPT_FILES = [
	{ filename: "system-prompt.md", section: "system_prompt" },
	{ filename: "style-prompt.md", section: "style_prompt" },
	{ filename: "conventions.md", section: "conventions" },
	{ filename: "boundaries.md", section: "boundaries" },
].map((prompt) => ({
	...prompt,
	path: fileURLToPath(new URL(`./${prompt.filename}`, import.meta.url)),
}));

export default function systemPromptExtension(pi: ExtensionAPI): void {
	const runtime: typeof process & { [JAILBREAK_STATE]?: { isEnabled: boolean } } = process;
	const state = runtime[JAILBREAK_STATE] ??= { isEnabled: false };
	const lastErrors = new Map<string, string>();

	pi.registerCommand("jailbreak", {
		description: "Toggle the boundaries prompt",
		handler: async (_args, ctx) => {
			state.isEnabled = !state.isEnabled;
			ctx.ui.setStatus(JAILBREAK_STATUS, state.isEnabled ? "J" : undefined);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(JAILBREAK_STATUS, state.isEnabled ? "J" : undefined);
	});

	pi.on("before_agent_start", (event, ctx) => {
		for (const { filename, section, path } of PROMPT_FILES) {
			if (section === "boundaries" && !state.isEnabled) {
				delete event.systemPromptOptions.sections[section];
				continue;
			}
			try {
				const content = readFileSync(path, "utf8").trim();
				if (content) {
					event.systemPromptOptions.sections[section] = content;
				} else {
					delete event.systemPromptOptions.sections[section];
				}
				lastErrors.delete(filename);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message !== lastErrors.get(filename)) {
					lastErrors.set(filename, message);
					ctx.ui.notify(`system-prompt: cannot read ${filename}: ${message}`, "error");
				}
				delete event.systemPromptOptions.sections[section];
			}
		}
	});
}
