import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadModules } from "./lib/modules.js";
import pluginManager from "./plugins/index.js";
import { readPluginSettings } from "./plugins/settings.mjs";

export default async function betterPi(pi: ExtensionAPI): Promise<void> {
	const { disabled } = await readPluginSettings(getAgentDir());
	pluginManager(pi);
	await loadModules(pi, [
		{ path: "compact/index.ts", load: () => import("./compact/index.js") },
		{ path: "deepseek-files.ts", load: () => import("./deepseek-files.js") },
		{ path: "explore.ts", load: () => import("./explore.js") },
		{ path: "compaction-thinking.ts", load: () => import("./compaction-thinking.js") },
		{ path: "footer/index.ts", load: () => import("./footer/index.js") },
		{ path: "image-paste/index.ts", load: () => import("./image-paste/index.js") },
		{ path: "review.ts", load: () => import("./review.js") },
		{ path: "browser/index.ts", load: () => import("./browser/index.js") },
		{ path: "skip-version-check.ts", load: () => import("./skip-version-check.js") },
		{ path: "system-prompt/index.ts", load: () => import("./system-prompt/index.js") },
		{ path: "web.ts", load: () => import("./web.js") },
		{ path: "webui/index.ts", load: () => import("./webui/index.js") },
		{ path: "wheel-invert.ts", load: () => import("./wheel-invert.js") },
	], new Set(disabled));
}
