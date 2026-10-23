import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import compactBash from "./bash.js";
import compactFiles from "./files.js";

export default function compact(pi: ExtensionAPI): void {
	compactBash(pi);
	compactFiles(pi);
}
