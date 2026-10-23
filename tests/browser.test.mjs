import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSession } from "../browser/browser.ts";
import { connect } from "../browser/cdp.ts";
import { describeBrowserCall } from "../browser/browser-tool.ts";

class FakeSocket extends EventTarget {
	static OPEN = 1;
	static latest;
	readyState = 1;
	constructor() {
		super();
		FakeSocket.latest = this;
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}
	send() {}
	message(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
	close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

test("malformed CDP messages reject pending commands and event waits immediately", async (t) => {
	const original = globalThis.WebSocket;
	globalThis.WebSocket = FakeSocket;
	t.after(() => { globalThis.WebSocket = original; });
	let closed = 0;
	const connection = await connect("ws://test", AbortSignal.timeout(2000), () => {}, () => closed++);
	const command = assert.rejects(connection.send("Page.enable"), /Invalid DevTools message/);
	const event = assert.rejects(connection.wait("Page.loadEventFired", "session", AbortSignal.timeout(2000)), /Invalid DevTools message/);
	FakeSocket.latest.message("invalid JSON");
	await Promise.all([command, event]);
	assert.equal(connection.isOpen(), false);
	assert.equal(closed, 1);
});

function failingBrowser(failCleanup = false) {
	const browser = new BrowserSession(process.cwd());
	const controller = new AbortController();
	const original = new Error("navigation cancelled");
	let cleaned = false;
	browser.connection = {
		isOpen: () => true,
		wait: async () => {},
		async send(method, _params, _session, signal) {
			if (method === "Target.createTarget") return { targetId: "new" };
			if (method === "Target.attachToTarget") return { sessionId: "attached" };
			if (method === "Page.navigate") { controller.abort(original); throw original; }
			if (method === "Target.closeTarget") {
				assert.ok(signal);
				assert.equal(signal.aborted, false);
				cleaned = true;
				if (failCleanup) throw new Error("close failed");
				return { success: true };
			}
			if (method === "Target.getTargets") return { targetInfos: [{ type: "page", targetId: "other", title: "other", url: "about:blank" }] };
			return {};
		},
	};
	return { browser, controller, original, wasCleaned: () => cleaned };
}

test("cancelled opens clean only their new tab using an independent signal", async () => {
	const { browser, controller, original, wasCleaned } = failingBrowser();
	await assert.rejects(browser.open("https://example.com", 1280, 900, controller.signal), (error) => error === original);
	assert.equal(wasCleaned(), true);
	assert.equal(browser.sessions.size, 0);
	assert.equal((await browser.list()).length, 1);
});

test("cleanup failure preserves the original navigation error", async () => {
	const { browser, original } = failingBrowser(true);
	await assert.rejects(browser.open("https://example.com", 1280, 900), (error) => {
		assert.equal(error.cause, original);
		assert.equal(error.errors[0], original);
		assert.match(error.message, /close failed/);
		return true;
	});
});

test("browser summaries support batches and incomplete streamed arguments", () => {
	assert.equal(describeBrowserCall({}), "");
	assert.equal(describeBrowserCall({ operations: [null, {}, { action: "close" }, { action: "open", url: "https://example.com" }] }), "close, open https://example.com");
});
