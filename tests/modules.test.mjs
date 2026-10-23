import assert from "node:assert/strict";
import test from "node:test";
import { loadModules } from "../lib/modules.ts";

function createPi() {
	const handlers = new Map();
	return {
		handlers,
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => list.splice(list.indexOf(handler), 1);
		},
	};
}

test("import failure stops the remaining modules", async () => {
	const pi = createPi();
	const calls = [];
	await assert.rejects(
		loadModules(pi, [
			{ path: "import.ts", load: () => import("node:better-pi-missing-dependency") },
			{ path: "healthy.ts", load: async () => ({ default() { calls.push("initialized"); } }) },
		]),
		(error) => {
			assert.match(error.message, /\[import\.ts\] import failed/);
			assert.match(error.message, /ERR_UNKNOWN_BUILTIN_MODULE/);
			assert.ok(error.cause instanceof Error);
			return true;
		},
	);
	assert.deepEqual(calls, []);
	assert.equal(pi.handlers.size, 0);
});

test("sync initialization failure names the module and keeps the cause", async () => {
	const pi = createPi();
	const calls = [];
	await assert.rejects(
		loadModules(pi, [
			{ path: "sync.ts", load: async () => ({ default() { throw new Error("API changed", { cause: new Error("missing method") }); } }) },
			{ path: "healthy.ts", load: async () => ({ default() { calls.push("initialized"); } }) },
		]),
		(error) => {
			assert.match(error.message, /\[sync\.ts\] initialization failed/);
			assert.match(error.message, /API changed/);
			assert.match(error.message, /missing method/);
			assert.equal(error.cause.message, "API changed");
			return true;
		},
	);
	assert.deepEqual(calls, []);
});

test("async initialization failure is reported", async () => {
	const pi = createPi();
	await assert.rejects(
		loadModules(pi, [{ path: "async.ts", load: async () => ({ async default() { await Promise.resolve(); throw "async init failed"; } }) }]),
		/\[async\.ts\] initialization failed[\s\S]*async init failed/,
	);
});

test("healthy modules initialize in order", async () => {
	const pi = createPi();
	const calls = [];
	await loadModules(pi, [
		{ path: "first.ts", load: async () => ({ default(received) {
			assert.equal(received, pi);
			calls.push("first");
			received.on("session_start", () => {});
		} }) },
		{ path: "second.ts", load: async () => ({ default() { calls.push("second"); } }) },
	]);
	assert.deepEqual(calls, ["first", "second"]);
	assert.equal(pi.handlers.get("session_start").length, 1);
});
