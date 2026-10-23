import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const runtime = process.env.PI_PACKAGE_DIR ? pathToFileURL(join(process.env.PI_PACKAGE_DIR, "package.json")).href : import.meta.url;
const project = new URL("../", import.meta.url).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("@earendil-works/")) return nextResolve(specifier, { ...context, parentURL: runtime });
		if (/^\.{1,2}\//.test(specifier) && specifier.endsWith(".js") && context.parentURL?.startsWith(project)) {
			const source = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
			if (existsSync(source)) return nextResolve(source.href, context);
		}
		return nextResolve(specifier, context);
	},
});
