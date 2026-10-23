import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { registerCompactTool } from "../compact/tools.ts";
import compactFiles from "../compact/files.ts";
import imagePaste from "../image-paste/index.ts";
import { createImageStore } from "../image-paste/store.ts";
import { validateImageEditor } from "../image-paste/editor.ts";
import { watchCompactionSetting } from "../footer/settings.ts";
import explore from "../explore.ts";

const directory = fileURLToPath(new URL("./", import.meta.url));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
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

function extensionHarness() {
	const handlers = new Map();
	const tools = new Map();
	const entries = [];
	return {
		handlers, tools, entries,
		pi: {
			on(name, handler) { handlers.set(name, handler); },
			registerTool(tool) { tools.set(tool.name, tool); },
			registerMarkdownTransformer() {},
			appendEntry(type, data) { entries.push({ type, data }); },
		},
	};
}

test("compact installation is idempotent and restores image visibility after rendering errors", () => {
	const tools = [];
	registerCompactTool({ registerTool(tool) { tools.push(tool); } }, { name: "one" });
	const installed = ToolExecutionComponent.prototype.updateDisplay;
	registerCompactTool({ registerTool(tool) { tools.push(tool); } }, { name: "two" });
	assert.equal(ToolExecutionComponent.prototype.updateDisplay, installed);
	const state = ToolExecutionComponent.prototype[Symbol.for("better-pi.compact-tools")];
	const original = state.updateDisplay;
	state.updateDisplay = function () { assert.equal(this.showImages, false); throw new Error("render failed"); };
	const component = { showImages: true, toolDefinition: tools[1] };
	try {
		assert.throws(() => installed.call(component), /render failed/);
		assert.equal(component.showImages, true);
	} finally { state.updateDisplay = original; }
});

test("image stores isolate IDs, prepare historical previews, and remove them on reset", async () => {
	const store = createImageStore();
	const other = createImageStore();
	store.reserveIds("[img-1]");
	assert.equal(store.allocateId(), "img-2");
	assert.equal(other.allocateId(), "img-1");
	const image = { type: "image", mimeType: "image/png", data: Buffer.from("image").toString("base64") };
	const message = { role: "user", timestamp: 1, content: [{ type: "text", text: "[img-1]" }, image] };
	await store.restoreImages({
		ui: { getEditorText: () => "", notify(message) { assert.fail(message); } },
		sessionManager: { getBranch: () => [{ type: "message", message }] },
	});
	const url = store.imageUrl(store.images.get("img-1"));
	assert.equal(await readFile(new URL(url), "utf8"), "image");
	const original = join(root, "clipboard.png");
	await writeFile(original, "image");
	store.images.set("img-2", { file: original, content: image });
	await store.prepareImages({ ui: { notify(message) { assert.fail(message); } } });
	await rm(original);
	assert.equal(await readFile(new URL(store.imageUrl(store.images.get("img-2"))), "utf8"), "image");
	await store.resetImages();
	await assert.rejects(readFile(new URL(url)), { code: "ENOENT" });
	assert.equal(store.images.size, 0);
	validateImageEditor();
	assert.throws(() => validateImageEditor({}), /requires segment/);
});

test("message binding uses actual attachments without stale input queues", async () => {
	const { pi, handlers, entries } = extensionHarness();
	imagePaste(pi);
	const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
	const historic = { role: "user", timestamp: 1, content: [{ type: "text", text: "[img-1]" }, image] };
	const ctx = {
		mode: "json", ui: { getEditorText: () => "", notify(message) { assert.fail(message); } },
		sessionManager: { getEntries: () => [{ type: "message", message: historic }], getBranch: () => [{ type: "message", message: historic }] },
	};
	await handlers.get("session_start")({}, ctx);
	await handlers.get("input")({ text: "[img-1]", source: "interactive" }, ctx);
	const submitted = await handlers.get("input")({ text: "[img-1]", source: "interactive", images: [{ ...image, data: "b3RoZXI=" }] }, ctx);
	handlers.get("message_end")({ message: { role: "user", timestamp: 2, content: [{ type: "text", text: submitted.text }, ...submitted.images] } });
	assert.deepEqual(entries.at(-1).data.references, [{ id: "img-1", index: 1 }]);
	await handlers.get("session_shutdown")();
});

test("footer reads trusted project overrides and reports malformed settings", async () => {
	const cwd = join(root, "project");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(root, "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
	await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
	const notifications = [];
	const ctx = { cwd, isProjectTrusted: () => true, ui: { notify: (message) => notifications.push(message) } };
	async function readSetting() {
		let stop;
		try { return await new Promise((resolve) => { stop = watchCompactionSetting(ctx, resolve); }); }
		finally { stop(); }
	}
	assert.equal(await readSetting(), false);
	await writeFile(join(cwd, ".pi", "settings.json"), "{");
	assert.equal(await readSetting(), undefined);
	assert.equal(notifications.length, 1);
});

test("large writes omit unknown statistics and small writes retain exact changes", async () => {
	const { pi, tools } = extensionHarness();
	compactFiles(pi);
	const write = tools.get("write");
	const path = join(root, "large.txt");
	await writeFile(path, "old\n");
	const small = await write.execute("small", { path, content: "new\n" }, undefined, undefined, { cwd: root });
	assert.deepEqual(small.details.lineChanges, { added: 1, removed: 1 });
	const large = await write.execute("large", { path, content: "x".repeat(300 * 1024) }, undefined, undefined, { cwd: root });
	assert.equal(large.details.lineChanges, undefined);
	assert.equal((await readFile(path)).length, 300 * 1024);
	await writeFile(path, Array.from({ length: 3000 }, (_, index) => `old-${index}`).join("\n"));
	const expensive = await write.execute("expensive", { path, content: Array.from({ length: 3000 }, (_, index) => `new-${index}`).join("\n") }, undefined, undefined, { cwd: root });
	assert.equal(expensive.details.lineChanges, undefined);
});

test("explore retains length-limited reports and caps its complete response", async () => {
	const { pi, tools } = extensionHarness();
	explore(pi);
	const script = join(root, "explore.cjs");
	const message = { role: "assistant", model: "test", content: [{ type: "text", text: "部分报告".repeat(4000) }], stopReason: "length", usage: { cost: {} } };
	await writeFile(script, `console.log(${JSON.stringify(JSON.stringify({ type: "message_end", message }))})`);
	const previous = process.argv[1];
	process.argv[1] = script;
	try {
		const result = await tools.get("explore").execute("test", { task: "检查项目" }, undefined, undefined, { cwd: root });
		assert.equal(result.details.status, "failed");
		assert.match(result.content[0].text, /Partial report/);
		assert.match(result.content[0].text, /部分报告/);
		assert.ok(Buffer.byteLength(result.content[0].text) <= 12 * 1024);
	} finally { process.argv[1] = previous; }
});
