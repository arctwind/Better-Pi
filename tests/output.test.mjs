import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { readBoundedText, runBoundedCommand, truncateBytes } from "../lib/output.ts";

test("UTF-8 limits include the notice and never split a character", () => {
	const source = "中😀文".repeat(20);
	for (let cap = 4; cap < 30; cap++) {
		const output = truncateBytes(source, cap, "...");
		assert.ok(Buffer.byteLength(output) <= cap);
		assert.ok(!output.includes("�"));
		assert.ok(output.endsWith("..."));
	}
	assert.throws(() => truncateBytes(source, 2, "..."), /limit/);
});

test("bounded collection drains all chunks and preserves UTF-8 boundaries", async () => {
	let consumed = 0;
	const bytes = Buffer.from("中😀文".repeat(200));
	const stream = Readable.from((function* () {
		for (const byte of bytes) { consumed++; yield Buffer.from([byte]); }
	})());
	const output = await readBoundedText(stream, 17);
	assert.equal(consumed, bytes.length);
	assert.equal(output.isTruncated, true);
	assert.ok(Buffer.byteLength(output.text) <= 17);
	assert.ok(!output.text.includes("�"));
});

test("commands cap output while reading both streams to completion", async () => {
	const result = await runBoundedCommand(process.execPath, ["-e", "process.stdout.write('中'.repeat(100000)); process.stderr.write('x'.repeat(100000))"], {
		cwd: process.cwd(), timeout: 5000, maxBytes: 1024,
	});
	assert.equal(result.code, 0);
	assert.equal(result.isTruncated, true);
	assert.ok(Buffer.byteLength(result.stdout) <= 1024);
	assert.equal(result.stderr.length, 1024);
});

test("commands terminate on timeout and reject pre-cancelled work", async () => {
	await assert.rejects(runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		cwd: process.cwd(), timeout: 100, maxBytes: 1024,
	}), { name: "TimeoutError" });
	const reason = new Error("cancelled");
	await assert.rejects(runBoundedCommand(process.execPath, [], {
		cwd: process.cwd(), timeout: 1000, maxBytes: 1024, signal: AbortSignal.abort(reason),
	}), (error) => error === reason);
});
