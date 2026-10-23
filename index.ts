import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import browser from "./browser/index.js";
import compact from "./compact/index.js";
import compactionThinking from "./compaction-thinking.js";
import deepseekFiles from "./deepseek-files.js";
import explore from "./explore.js";
import footer from "./footer/index.js";
import imagePaste from "./image-paste/index.js";
import review from "./review.js";
import skipVersionCheck from "./skip-version-check.js";
import systemPrompt from "./system-prompt/index.js";
import web from "./web.js";
import webui from "./webui/index.js";
import wheelInvert from "./wheel-invert.js";

export default function betterPi(pi: ExtensionAPI): void {
	compact(pi);
	deepseekFiles(pi);
	explore(pi);
	compactionThinking(pi);
	footer(pi);
	imagePaste(pi);
	review(pi);
	browser(pi);
	skipVersionCheck(pi);
	systemPrompt(pi);
	web(pi);
	webui(pi);
	wheelInvert(pi);
}
