import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import systemPrompt from "../system-prompt/index.ts";
import footer from "../footer/index.ts";

const STATUS = "system-prompt:jailbreak";

function createSession(factory = systemPrompt) {
	const handlers = new Map();
	const commands = new Map();
	const statuses = new Map();
	const ctx = {
		ui: {
			setStatus(key, value) {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
			notify(message) { assert.fail(message); },
		},
	};
	factory({
		on(name, handler) { handlers.set(name, handler); },
		registerCommand(name, command) { commands.set(name, command); },
	});
	handlers.get("session_start")({}, ctx);
	return {
		statuses,
		toggle: () => commands.get("jailbreak").handler("", ctx),
		sections() {
			const event = { systemPromptOptions: { sections: { boundaries: "stale" } } };
			handlers.get("before_agent_start")(event, ctx);
			return event.systemPromptOptions.sections;
		},
	};
}

test("jailbreak defaults off, survives session replacement and reload, and clears stale boundaries", async () => {
	const first = createSession();
	assert.equal(first.statuses.has(STATUS), false);
	const initial = first.sections();
	assert.equal(initial.boundaries, undefined);
	for (const name of ["system_prompt", "style_prompt", "conventions"]) assert.ok(initial[name]);
	await first.toggle();
	try {
		assert.equal(first.statuses.get(STATUS), "J");
		assert.ok(first.sections().boundaries);
		const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(join(getPackageDir(), "dist/core/extensions/loader.js")).href);
		const file = new URL("../system-prompt/index.ts", import.meta.url);
		for (let pass = 0; pass < 2; pass++) {
			if (pass) clearExtensionCache();
			const loaded = await loadExtensions([fileURLToPath(file)], process.cwd());
			assert.deepEqual(loaded.errors, []);
			const extension = loaded.extensions[0];
			const statuses = new Map();
			const ctx = { ui: { setStatus(key, value) { statuses.set(key, value); }, notify(message) { assert.fail(message); } } };
			for (const handler of extension.handlers.get("session_start")) await handler({}, ctx);
			assert.equal(statuses.get(STATUS), "J");
			const event = { systemPromptOptions: { sections: {} } };
			for (const handler of extension.handlers.get("before_agent_start")) await handler(event, ctx);
			assert.ok(event.systemPromptOptions.sections.boundaries);
		}
		const next = createSession();
		assert.equal(next.statuses.get(STATUS), "J");
		await next.toggle();
		assert.equal(next.statuses.has(STATUS), false);
		assert.equal(next.sections().boundaries, undefined);
		assert.equal(createSession().statuses.has(STATUS), false);
	} finally {
		if (createSession().statuses.has(STATUS)) await first.toggle();
	}
});

test("footer centers J at every width and preserves other extension statuses", () => {
	const handlers = new Map();
	const statuses = new Map([["other", "other status"]]);
	let component;
	footer({ on(name, handler) { handlers.set(name, handler); } });
	const ctx = {
		mode: "tui",
		isProjectTrusted: () => false,
		model: { id: "模型-" + "long-model-name".repeat(10), contextWindow: 100000 },
		getContextUsage: () => ({ tokens: 1234, contextWindow: 100000, percent: 1.234 }),
		sessionManager: {
			getLeafId: () => "leaf",
			getBranch: () => [],
			getCwd: () => process.cwd(),
			getSessionName: () => undefined,
		},
		ui: {
			notify(message) { assert.fail(message); },
			setFooter(factory) {
				component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {
					onBranchChange: () => () => {},
					getAvailableProviderCount: () => 1,
					getGitBranch: () => undefined,
					getExtensionStatuses: () => statuses,
				});
			},
		},
	};
	handlers.get("session_start")({}, ctx);
	try {
		const original = component.render(120);
		assert.equal(original[1].includes("J"), false);
		assert.equal(original[2], "other status");
		statuses.set(STATUS, "J");
		for (let width = 1; width <= 160; width++) {
			const lines = component.render(width).map(stripTerminalSequences);
			assert.equal(visibleWidth(lines[1].split("J")[0]), Math.floor((width - 1) / 2));
			assert.equal(lines[1].split("J").length, 2);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `Overflow at width ${width}`);
		}
		assert.equal(component.render(120)[2], "other status");
		statuses.delete(STATUS);
		assert.deepEqual(component.render(120), original);
		statuses.clear();
		assert.equal(component.render(120).length, 2);
	} finally {
		component.dispose();
	}
});
