import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPackageDir, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import betterPi from "../index.ts";

async function checkSyntax(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = new URL(entry.name, directory);
		if (entry.isDirectory()) await checkSyntax(new URL(`${entry.name}/`, directory));
		else if (entry.name.endsWith(".ts")) stripTypeScriptTypes(await readFile(path, "utf8"), { sourceUrl: path.href });
	}
}

await checkSyntax(new URL("../", import.meta.url));
const tools = new Map();
const commands = new Map();
const providers = new Map();
betterPi({
	on() {},
	registerTool(tool) { assert.ok(!tools.has(tool.name), `Duplicate tool: ${tool.name}`); tools.set(tool.name, tool); },
	registerCommand(name, command) { commands.set(name, command); },
	registerProvider(name, provider) { providers.set(name, provider); },
	registerMarkdownTransformer() {},
});
for (const name of ["read", "edit", "write", "bash", "explore", "web", "browser", "screenshot"]) assert.ok(tools.has(name), `Missing tool: ${name}`);
assert.ok(commands.has("review"));
assert.ok(commands.has("currency"));
assert.equal(providers.get("deepseek")?.api, "openai-completions");

const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(join(getPackageDir(), "dist/core/extensions/loader.js")).href);
const directory = fileURLToPath(new URL("../", import.meta.url));
initTheme("dark");
for (let pass = 0; pass < 2; pass++) {
	if (pass) clearExtensionCache();
	const loaded = await loadExtensions([join(directory, "index.ts")], directory);
	assert.deepEqual(loaded.errors, []);
	const registered = loaded.extensions[0].tools;
	for (const name of tools.keys()) assert.ok(registered.has(name), `Missing loaded tool: ${name}`);
	const tool = registered.get("web").definition;
	const component = new ToolExecutionComponent("web", "check", { action: "search", query: "search query" }, {}, tool, { requestRender() {} }, directory);
	component.updateResult({ content: [{ type: "text", text: "hidden response" }] });
	assert.deepEqual(component.render(120).map(stripTerminalSequences).map((line) => line.trim()).filter(Boolean), ["web search search query"]);
}
console.log(`Syntax, registration, loader reload and web display passed: ${directory}`);
