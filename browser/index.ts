import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createReadToolDefinition, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactTool } from "../compact/tools.js";
import { BrowserSession, describeTab } from "./browser.js";
import createBrowserTool, { describeBrowserCall } from "./browser-tool.js";

export default function browserExtension(pi: ExtensionAPI): void {
	const cacheRoot = resolve(getAgentDir(), "cache");
	const browser = new BrowserSession(cacheRoot);
	pi.on("session_shutdown", () => browser.close());

	registerCompactTool(pi, createBrowserTool(browser), describeBrowserCall);

	registerCompactTool(pi, {
		name: "screenshot",
		label: "Screenshot",
		description: "Capture the current viewport of an existing browser tab and return an image you can see. With one tab open, call with {}. For multiple tabs, specify tabId from browser open/list. Captures the current page state without navigation, reload, server startup, or browser shutdown.",
		promptSnippet: "See the current browser tab",
		parameters: Type.Object({
			tabId: Type.Optional(Type.String({ description: "Tab to capture; optional when only one tab is open.", minLength: 1 })),
		}),
		executionMode: "sequential",
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.model && !ctx.model.input.includes("image")) throw new Error("The current model cannot view screenshots.");
			const { tab, data } = await browser.capture(params.tabId, signal);
			signal?.throwIfAborted();
			await mkdir(cacheRoot, { recursive: true });
			const directory = await mkdtemp(join(cacheRoot, "screenshot-"));
			try {
				const imagePath = join(directory, "screenshot.png");
				await writeFile(imagePath, Buffer.from(data, "base64"));
				const result = await createReadToolDefinition(ctx.cwd).execute(toolCallId, { path: imagePath }, signal, undefined, ctx);
				const images = result.content.filter((part) => part.type === "image");
				if (!images.length) throw new Error("The screenshot could not be loaded as an image.");
				return { content: [{ type: "text" as const, text: describeTab(tab) }, ...images], details: tab };
			} finally {
				if (dirname(resolve(directory)) !== cacheRoot) throw new Error("Invalid screenshot cleanup directory.");
				await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		},
	});
}
