import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { describeTab, validateBrowserOpen, type BrowserSession, type BrowserTab } from "./browser.js";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 900;
const BROWSER_ACTIONS = ["open", "list", "reload", "close"] as const;
const actionSchema = Type.Union(BROWSER_ACTIONS.map((action) => Type.Literal(action)));
const operationFields = {
	url: Type.Optional(Type.String({ description: "URL to open; required for open.", minLength: 1 })),
	tabId: Type.Optional(Type.String({ description: "Existing tab ID. Omit only when exactly one tab is open.", minLength: 1 })),
	width: Type.Optional(Type.Integer({ description: "Viewport width for open; defaults to 1280.", minimum: 240, maximum: 3840 })),
	height: Type.Optional(Type.Integer({ description: "Viewport height for open; defaults to 900.", minimum: 240, maximum: 2160 })),
};

interface BrowserOperation {
	action: typeof BROWSER_ACTIONS[number];
	url?: string;
	tabId?: string;
	width?: number;
	height?: number;
}

interface BrowserInput extends Partial<BrowserOperation> {
	operations?: BrowserOperation[];
}

type BrowserOperations = Pick<BrowserSession, "open" | "list" | "reload" | "closeTab">;

function validateOperations(params: BrowserInput): BrowserOperation[] {
	if (params.operations !== undefined && [params.action, params.url, params.tabId, params.width, params.height].some((value) => value !== undefined)) {
		throw new Error("Use either operations or a single action, not both.");
	}
	const operations = params.operations ?? [params as BrowserOperation];
	if (!Array.isArray(operations) || operations.length === 0) throw new Error("operations must be a non-empty array.");
	for (const operation of operations) {
		if (!operation || !BROWSER_ACTIONS.includes(operation.action)) throw new Error("Unknown browser action.");
		if (operation.tabId !== undefined && (typeof operation.tabId !== "string" || !operation.tabId.trim())) throw new Error("tabId must not be empty.");
		if (operation.action === "open") {
			if (typeof operation.url !== "string" || !operation.url) throw new Error("browser open requires url.");
			if (operation.tabId !== undefined) throw new Error("browser open creates a new tab; omit tabId.");
			validateBrowserOpen(operation.url, operation.width ?? DEFAULT_WIDTH, operation.height ?? DEFAULT_HEIGHT);
		} else {
			if (operation.url !== undefined || operation.width !== undefined || operation.height !== undefined) throw new Error("url, width, and height are only available for browser open.");
			if (operation.action === "list" && operation.tabId !== undefined) throw new Error("browser list does not accept tabId.");
		}
	}
	return operations;
}

async function executeOperation(browser: BrowserOperations, operation: BrowserOperation, signal?: AbortSignal): Promise<BrowserTab[]> {
	signal?.throwIfAborted();
	switch (operation.action) {
		case "open": return [await browser.open(operation.url!, operation.width ?? DEFAULT_WIDTH, operation.height ?? DEFAULT_HEIGHT, signal)];
		case "list": return browser.list(signal);
		case "reload": return [await browser.reload(operation.tabId, signal)];
		case "close": return [await browser.closeTab(operation.tabId, signal)];
	}
}

function describeOperation(operation: BrowserOperation, tabs: BrowserTab[]): string {
	const text = tabs.map(describeTab).join("\n");
	return operation.action === "close" ? `Closed: ${text}` : text || "No browser tabs are open.";
}

export default function createBrowserTool(browser: BrowserOperations) {
	return defineTool({
		name: "browser",
		label: "Browser",
		description: "Open, list, reload, or close headless Chrome/Edge tabs. Use operations to perform multiple actions with independent parameters in one call, in array order. All parameters are validated before execution; a runtime failure stops the batch and reports completed operations. Use tabId from a previous call when multiple tabs are open. Tabs share an isolated browser profile. Open accepts HTTP(S) and absolute file: URLs. Does not start or stop development servers.",
		promptSnippet: "Open and reuse browser tabs, including multiple operations in one call",
		promptGuidelines: [
			"Combine known browser operations in one call using operations, for example {operations:[{action:'close',tabId:'a'},{action:'close',tabId:'b'}]}. Each item has its own parameters. Use a single action for one operation; do not mix it with operations.",
			"Use browser open with an existing page URL, then screenshot to view it. Reuse the returned tabId for reload, screenshot, and close. Use browser list to inspect current tabs. Batch results correspond to operation order. A later operation can omit tabId only if exactly one tab will be open at that point.",
			"Keep project server lifecycle separate from browser tools. Close tabs when no longer needed; Pi also cleans them up on exit, reload, or session replacement.",
		],
		parameters: Type.Object({
			action: Type.Optional(actionSchema),
			...operationFields,
			operations: Type.Optional(Type.Array(Type.Object({ action: actionSchema, ...operationFields }), { minItems: 1 })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const operations = validateOperations(params);
			const results: { action: BrowserOperation["action"]; tabs: BrowserTab[] }[] = [];
			const summaries: string[] = [];
			for (const [index, operation] of operations.entries()) {
				let tabs: BrowserTab[];
				try {
					tabs = await executeOperation(browser, operation, signal);
				} catch (error) {
					if (!params.operations) throw error;
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`Browser operation ${index + 1}/${operations.length} (${operation.action}) failed: ${message}\nCompleted operations:\n${summaries.join("\n") || "None."}\nRemaining operations were not run.`);
				}
				results.push({ action: operation.action, tabs });
				const summary = describeOperation(operation, tabs);
				summaries.push(params.operations ? `${index + 1}. ${operation.action}: ${summary}` : summary);
			}
			return {
				content: [{ type: "text", text: summaries.join("\n\n") }],
				details: params.operations ? { results } : { tabs: results[0].tabs },
			};
		},
	});
}

export function describeBrowserCall(args: Record<string, unknown>): string {
	const operations = Array.isArray(args.operations) ? args.operations : [args];
	return operations.flatMap((operation) => {
		if (!operation || typeof operation !== "object" || typeof operation.action !== "string") return [];
		return [operation.action === "open" && typeof operation.url === "string" ? `open ${operation.url}` : operation.action];
	}).join(", ");
}
