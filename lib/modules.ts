import { inspect } from "node:util";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

interface Module {
	path: string;
	load(): Promise<{ default: ExtensionFactory }>;
}

export async function loadModules(pi: ExtensionAPI, modules: readonly Module[], disabled: ReadonlySet<string> = new Set()): Promise<void> {
	for (const { path, load } of modules) {
		if (disabled.has(path)) continue;
		let phase = "import failed";
		try {
			const module = await load();
			phase = "initialization failed";
			await module.default(pi);
		} catch (error) {
			throw new Error(`[${path}] ${phase}\n${inspect(error, { colors: false, depth: 5 })}`, { cause: error });
		}
	}
}
