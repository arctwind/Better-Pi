import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import deepseekFiles from "../deepseek-files.ts";

const directory = fileURLToPath(new URL("./", import.meta.url));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const model = {
	id: "deepseek-chat", name: "DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com/v1", input: ["text", "image"], reasoning: false,
	contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [{ role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }] });
let root;

before(async () => {
	root = await mkdtemp(join(directory, ".tmp-"));
	process.env.PI_CODING_AGENT_DIR = root;
});
after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	assert.equal(dirname(root), directory.replace(/[\\/]$/, ""));
	await rm(root, { recursive: true, force: true });
});

function provider() {
	let config;
	deepseekFiles({ on() {}, registerProvider(_name, value) { config = value; } });
	return config;
}

test("upload failures terminate preparation without issuing a chat request", async (t) => {
	const calls = [];
	const request = t.mock.method(globalThis, "fetch", async (url) => {
		calls.push(String(url));
		assert.match(String(url), /\/files$/);
		return new Response("upload failed", { status: 503 });
	});
	const events = [];
	for await (const event of provider().streamSimple(model, context, { apiKey: "failure-test", fetch: request, maxRetries: 0 })) events.push(event);
	assert.equal(events.at(-1).type, "error");
	assert.match(events.at(-1).error.errorMessage, /503/);
	assert.deepEqual(calls, ["https://api.deepseek.com/files"]);
});

test("successful uploads are reused and expired cache records are removed", async (t) => {
	const apiKey = "success-test";
	const scope = createHash("sha256").update(`Bearer ${apiKey}`).digest("hex");
	const cache = join(root, "cache", "deepseek-files", scope);
	await mkdir(cache, { recursive: true });
	const expired = join(cache, `${"0".repeat(64)}.json`);
	await writeFile(expired, JSON.stringify({ id: "file-api-expired", expiresAt: 1 }));
	let uploads = 0;
	let chats = 0;
	const request = t.mock.method(globalThis, "fetch", async (url, options) => {
		if (String(url).endsWith("/files")) {
			uploads++;
			return Response.json({ id: "file-api-test", expires_at: Date.now() / 1000 + 3600 });
		}
		chats++;
		const payload = JSON.parse(options.body);
		assert.deepEqual(payload.messages.at(-1).content, [{ type: "file", file_id: "file-api-test" }]);
		const chunks = [
			{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];
		return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	});
	const config = provider();
	for (let i = 0; i < 2; i++) {
		const events = [];
		for await (const event of config.streamSimple(model, context, { apiKey, fetch: request, maxRetries: 0 })) events.push(event);
		assert.equal(events.at(-1).type, "done");
	}
	assert.equal(uploads, 1);
	assert.equal(chats, 2);
	await assert.rejects(readFile(expired), { code: "ENOENT" });
});
