import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import webui from "../webui/index.ts";

const directory = fileURLToPath(new URL("./", import.meta.url));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousWebUI = process.env.PI_WEBUI;
let root;

before(async () => {
	root = await mkdtemp(join(directory, ".tmp-launcher-hooks-"));
	process.env.PI_CODING_AGENT_DIR = root;
	delete process.env.PI_WEBUI;
});

after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousWebUI === undefined) delete process.env.PI_WEBUI;
	else process.env.PI_WEBUI = previousWebUI;
	assert.equal(dirname(root), directory.replace(/[\\/]$/, ""));
	await rm(root, { recursive: true, force: true });
});

function createExtension() {
	const handlers = new Map();
	const commands = new Map();
	webui({
		on(name, handler) { handlers.set(name, handler); },
		registerCommand(name, command) { commands.set(name, command); },
	});
	return { handlers, commands };
}

test("normal startup leaves unsupported installation layouts unchanged", async () => {
	const { handlers, commands } = createExtension();
	assert.deepEqual([...handlers.keys()], ["session_start"]);
	assert.equal(commands.size, 0);
	await handlers.get("session_start")({}, { hasUI: true, ui: { notify(message) { assert.fail(message); } } });
	await assert.rejects(stat(join(root, "bin")), { code: "ENOENT" });
});

test("launcher maintenance reports validation errors and leaves the target untouched", async () => {
	const agent = join(root, "invalid");
	await mkdir(join(agent, "install"), { recursive: true });
	await writeFile(join(agent, "install", "current-version"), "../outside");
	await mkdir(join(agent, "bin"));
	const target = join(agent, "bin", "pi-launcher.js");
	await writeFile(target, "custom launcher");
	const messages = [];
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		await createExtension().handlers.get("session_start")({}, {
			hasUI: true, ui: { notify: (message, type) => messages.push({ message, type }) },
		});
	} finally { process.env.PI_CODING_AGENT_DIR = root; }
	assert.equal(messages.length, 1);
	assert.equal(messages[0].type, "error");
	assert.match(messages[0].message, /Could not update the Pi launcher: Managed Pi version file is invalid/);
	assert.equal(await readFile(target, "utf8"), "custom launcher");
	assert.deepEqual(await readdir(join(agent, "bin")), ["pi-launcher.js"]);
});

test("WebUI mode registers its hooks alongside launcher maintenance", () => {
	process.env.PI_WEBUI = "1";
	try {
		const { handlers, commands } = createExtension();
		for (const name of ["session_start", "tool_call", "tool_result", "session_switch", "input"]) assert.ok(handlers.has(name));
		assert.ok(commands.has("webui-reload"));
	} finally { delete process.env.PI_WEBUI; }
});
