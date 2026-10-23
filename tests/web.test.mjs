import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import web from "../web.ts";

const directory = fileURLToPath(new URL("./", import.meta.url));
const previous = { agent: process.env.PI_CODING_AGENT_DIR, key: process.env.DEEPSEEK_API_KEY };
let root;

before(async () => {
	root = await mkdtemp(join(directory, ".tmp-"));
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.DEEPSEEK_API_KEY = "test-key";
});
after(async () => {
	for (const [name, value] of [["PI_CODING_AGENT_DIR", previous.agent], ["DEEPSEEK_API_KEY", previous.key]]) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	assert.equal(dirname(root), directory.replace(/[\\/]$/, ""));
	await rm(root, { recursive: true, force: true });
});

function extension() {
	let tool;
	const handlers = new Map();
	web({ registerTool(value) { tool = value; }, on(name, handler) { handlers.set(name, handler); } });
	return { tool, handlers };
}

test("malformed search entries produce errors instead of disappearing", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ results: [null] }));
	await assert.rejects(extension().tool.execute("test", { action: "search", query: "test" }), /invalid search result/);
});

test("truncated fetches remain readable and only expired stored outputs are removed", async (t) => {
	const text = "content\n".repeat(1000);
	t.mock.method(globalThis, "fetch", async () => Response.json({ title: "test", content: text }));
	const { tool, handlers } = extension();
	const result = await tool.execute("test", { action: "fetch", url: "https://example.com" });
	assert.equal(result.details.truncated, true);
	assert.equal(await readFile(result.details.fullOutputPath, "utf8"), text);
	const old = join(root, "cache", "web", "fetch-expired");
	await mkdir(old);
	await writeFile(join(old, "content.md"), "old");
	const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
	await utimes(old, expired, expired);
	await handlers.get("session_start")();
	await assert.rejects(readFile(join(old, "content.md")), { code: "ENOENT" });
	assert.equal(await readFile(result.details.fullOutputPath, "utf8"), text);
});
