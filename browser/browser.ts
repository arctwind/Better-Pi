import { rethrowAfterCleanup } from "../lib/errors.js";
import { connect, record, stringField, type CdpConnection } from "./cdp.js";
import { BrowserProcess } from "./process.js";

const OPERATION_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 2000;

export interface BrowserTab {
	tabId: string;
	url: string;
	title: string;
}

export function describeTab(tab: BrowserTab): string {
	return `${tab.tabId} | ${tab.title || "Untitled"} | ${tab.url}`;
}

export function validateBrowserOpen(url: string, width: number, height: number): URL {
	const address = new URL(url);
	if (!["http:", "https:", "file:"].includes(address.protocol)) throw new Error("Browser URL must use http, https, or file.");
	for (const [value, name, minimum, maximum] of [[width, "width", 240, 3840], [height, "height", 240, 2160]] as const) {
		if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
	}
	return address;
}

export class BrowserSession {
	private readonly process: BrowserProcess;
	private connection?: CdpConnection;
	private readonly sessions = new Map<string, string>();
	private closing?: Promise<void>;

	constructor(cacheRoot: string) {
		this.process = new BrowserProcess(cacheRoot);
	}

	private async start(signal?: AbortSignal): Promise<boolean> {
		signal?.throwIfAborted();
		if (this.connection?.isOpen()) return false;
		await this.close();
		try {
			const endpoint = await this.process.start(signal, () => this.connection?.close());
			const startup = AbortSignal.any([AbortSignal.timeout(OPERATION_TIMEOUT_MS), ...(signal ? [signal] : [])]);
			this.connection = await connect(endpoint, startup, (message) => {
				if (message.method !== "Target.detachedFromTarget" && message.method !== "Target.targetDestroyed") return;
				const params = record(message.params);
				for (const [tabId, sessionId] of this.sessions) {
					if (tabId === params.targetId || sessionId === params.sessionId) this.sessions.delete(tabId);
				}
			}, () => this.sessions.clear());
			await this.connection.send("Target.setDiscoverTargets", { discover: true }, undefined, startup);
			return true;
		} catch (error) {
			return rethrowAfterCleanup(error, () => this.close());
		}
	}

	async list(signal?: AbortSignal): Promise<BrowserTab[]> {
		signal?.throwIfAborted();
		if (!this.connection?.isOpen()) { await this.close(); return []; }
		const targets = record(await this.connection.send("Target.getTargets", {}, undefined, signal)).targetInfos;
		if (!Array.isArray(targets)) throw new Error("DevTools did not return a tab list.");
		return targets.filter((target) => record(target).type === "page").map((target) => ({
			tabId: stringField(target, "targetId"), url: stringField(target, "url"), title: stringField(target, "title"),
		}));
	}

	private async select(tabId?: string, signal?: AbortSignal): Promise<BrowserTab> {
		if (tabId !== undefined && !tabId.trim()) throw new Error("tabId must not be empty.");
		const tabs = await this.list(signal);
		if (tabId !== undefined) {
			const tab = tabs.find((item) => item.tabId === tabId);
			if (!tab) throw new Error(`Browser tab not found: ${tabId}. Use browser list to see open tabs.`);
			return tab;
		}
		if (!tabs.length) throw new Error("No browser tabs are open. Use browser open with a URL first.");
		if (tabs.length > 1) throw new Error("More than one browser tab is open. Use browser list and specify tabId.");
		return tabs[0];
	}

	private async attach(tab: BrowserTab, signal?: AbortSignal): Promise<string> {
		const existing = this.sessions.get(tab.tabId);
		if (existing) return existing;
		const sessionId = stringField(await this.connection!.send("Target.attachToTarget", { targetId: tab.tabId, flatten: true }, undefined, signal), "sessionId");
		await this.connection!.send("Page.enable", {}, sessionId, signal);
		this.sessions.set(tab.tabId, sessionId);
		return sessionId;
	}

	private async load(tab: BrowserTab, method: "Page.navigate" | "Page.reload", params: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		const sessionId = await this.attach(tab, signal);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("The page did not finish loading within 15 seconds.")), OPERATION_TIMEOUT_MS);
		const loading = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const loaded = this.connection!.wait("Page.loadEventFired", sessionId, loading);
		void loaded.catch(() => {});
		try {
			const result = record(await this.connection!.send(method, params, sessionId, loading));
			if (typeof result.errorText === "string" && result.errorText) throw new Error(`Could not open page: ${result.errorText}`);
			if (method === "Page.reload" || result.loaderId) await loaded;
		} catch (error) {
			await rethrowAfterCleanup(error, async () => {
				if (method === "Page.reload" && this.connection?.isOpen()) {
					await this.connection.send("Page.stopLoading", {}, sessionId, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
				}
			});
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}

	async open(url: string, width: number, height: number, signal?: AbortSignal): Promise<BrowserTab> {
		const address = validateBrowserOpen(url, width, height);
		const isNew = await this.start(signal);
		let tab: BrowserTab | undefined;
		try {
			tab = isNew ? (await this.list(signal)).find((item) => item.url === "about:blank") : undefined;
			if (!tab) {
				const tabId = stringField(await this.connection!.send("Target.createTarget", { url: "about:blank" }, undefined, signal), "targetId");
				tab = { tabId, url: "about:blank", title: "" };
			}
			const sessionId = await this.attach(tab, signal);
			await this.connection!.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId, signal);
			await this.load(tab, "Page.navigate", { url: address.href }, signal);
			return await this.select(tab.tabId, signal);
		} catch (error) {
			return rethrowAfterCleanup(error, async () => {
				if (isNew) { await this.close(); return; }
				if (tab && this.connection?.isOpen()) {
					const cleanup = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
					const result = record(await this.connection.send("Target.closeTarget", { targetId: tab.tabId }, undefined, cleanup));
					if (result.success !== true) throw new Error(`Could not close browser tab: ${tab.tabId}`);
					this.sessions.delete(tab.tabId);
					if (!(await this.list(cleanup)).length) await this.close();
				}
			});
		}
	}

	async reload(tabId?: string, signal?: AbortSignal): Promise<BrowserTab> {
		const tab = await this.select(tabId, signal);
		await this.load(tab, "Page.reload", {}, signal);
		return this.select(tab.tabId, signal);
	}

	async capture(tabId?: string, signal?: AbortSignal): Promise<{ tab: BrowserTab; data: string }> {
		const tab = await this.select(tabId, signal);
		const sessionId = await this.attach(tab, signal);
		const result = await this.connection!.send("Page.captureScreenshot", { format: "png" }, sessionId, signal);
		return { tab, data: stringField(result, "data") };
	}

	async closeTab(tabId?: string, signal?: AbortSignal): Promise<BrowserTab> {
		const tab = await this.select(tabId, signal);
		const result = record(await this.connection!.send("Target.closeTarget", { targetId: tab.tabId }, undefined, signal));
		if (result.success !== true) throw new Error(`Could not close browser tab: ${tab.tabId}`);
		this.sessions.delete(tab.tabId);
		if (!(await this.list(signal)).length) await this.close();
		return tab;
	}

	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closing = this.dispose();
		try { await this.closing; }
		finally { this.closing = undefined; }
	}

	private async dispose(): Promise<void> {
		this.connection?.close();
		this.connection = undefined;
		this.sessions.clear();
		await this.process.close();
	}
}
