import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, formatSize, getAgentDir, readStoredCredential, truncateHead, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactTool } from "./compact/tools.js";
import { rethrowAfterCleanup } from "./lib/errors.js";

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type WebDetails = Awaited<ReturnType<typeof searchWeb>>["details"] | Awaited<ReturnType<typeof fetchWeb>>["details"];

const BASE_URL = "https://api.deepseek.com/v1/tools";
const DEEPSEEK_PROVIDER = "deepseek";
const KEY_ENV = "DEEPSEEK_API_KEY";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TEXT_CHARS = 1200;
const MAX_URL_CHARS = 8192;
const MAX_OUTPUT_BYTES = 12 * 1024;
const MAX_OUTPUT_LINES = 200;

function resolveApiKey(): string {
	const fromEnv = process.env[KEY_ENV]?.trim();
	if (fromEnv) return fromEnv;
	const credential = readStoredCredential(DEEPSEEK_PROVIDER);
	const key = credential?.type === "api_key" ? credential.key?.trim() : undefined;
	if (!key) throw new Error("DeepSeek API key is not set. Set " + KEY_ENV + " or configure the " + DEEPSEEK_PROVIDER + " provider in Pi.");
	return key;
}

async function readResponseText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await rethrowAfterCleanup(new Error(`DeepSeek response exceeds ${MAX_RESPONSE_BYTES} bytes.`), () => reader.cancel());
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, bytes).toString("utf8");
}

async function requestWebApi(
	action: "search" | "fetch",
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const apiKey = resolveApiKey();
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(`${BASE_URL}/${action}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(params),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		let body: string;
		try { body = await readResponseText(response); }
		catch (error) { throw new Error(`DeepSeek ${action} failed (${response.status}); could not read the error response.`, { cause: error }); }
		throw new Error(`DeepSeek ${action} failed (${response.status}): ${body.slice(0, 300)}`);
	}
	const body = await readResponseText(response);
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		throw new Error("DeepSeek returned an invalid JSON response.");
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("DeepSeek returned an invalid response.");
	}
	return data as Record<string, unknown>;
}

interface SearchResult {
	title?: string;
	url?: string;
	siteName?: string;
	date?: string;
	text?: string;
}

function toText(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text.slice(0, maxChars) : undefined;
}

function parseResults(value: unknown, limit: number): SearchResult[] {
	if (!Array.isArray(value)) throw new Error("DeepSeek returned an invalid results field.");
	return value.slice(0, limit).map((item, index): SearchResult => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`DeepSeek returned an invalid search result at index ${index}.`);
		const result = item as Record<string, unknown>;
		if (typeof result.url !== "string" || !result.url.trim()) throw new Error(`DeepSeek search result ${index} has no URL.`);
		return {
			title: toText(result.title, 500),
			url: toText(result.url, 2000),
			siteName: toText(result.site_name, 200),
			date: toText(result.date, 10),
			text: toText(result.summary, MAX_TEXT_CHARS) ?? toText(result.content, MAX_TEXT_CHARS),
		};
	});
}

function formatResults(query: string, results: SearchResult[]): string {
	if (results.length === 0) {
		return `No results for "${query}".`;
	}

	const blocks = results.map((result, index) => {
		const lines = [`${index + 1}. ${result.title ?? "(untitled)"}`, result.url ?? ""];
		if (result.siteName) lines.push(`Site: ${result.siteName}`);
		if (result.date) lines.push(`Published: ${result.date}`);
		if (result.text) lines.push(`\n${result.text}`);
		return lines.filter(Boolean).join("\n");
	});

	return `Search results for "${query}":\n\n${blocks.join("\n\n---\n\n")}`;
}

async function searchWeb(query: string, numResults: number, signal?: AbortSignal) {
	const data = await requestWebApi("search", { query, count: numResults, need_content: true }, signal);
	const results = parseResults(data.results, numResults);
	return {
		content: [{ type: "text" as const, text: formatResults(query, results) }],
		details: { label: query, summary: results.length + " results", results },
	};
}

function parseUrl(raw: string): string {
	const value = raw.trim();
	if (value.length > MAX_URL_CHARS) throw new Error(`URL must not exceed ${MAX_URL_CHARS} characters.`);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported protocol "${url.protocol}" — only http and https are allowed.`);
	}
	if (url.username || url.password) throw new Error("URL credentials are not allowed.");
	if (url.href.length > MAX_URL_CHARS) throw new Error(`URL must not exceed ${MAX_URL_CHARS} characters.`);
	return url.href;
}

async function fetchWeb(rawUrl: string, signal?: AbortSignal) {
	const url = parseUrl(rawUrl);
	const data = await requestWebApi("fetch", { url }, signal);
	if (typeof data.title !== "string" || typeof data.content !== "string" || !data.content.trim()) {
		throw new Error("DeepSeek returned an invalid page: expected a title and non-empty Markdown content.");
	}
	const title = data.title.trim() || undefined;
	const text = data.content;
	const truncation = truncateHead(text, {
		maxLines: MAX_OUTPUT_LINES,
		maxBytes: MAX_OUTPUT_BYTES,
	});
	const details = {
		label: title ?? url,
		summary: formatSize(truncation.totalBytes) + (truncation.truncated ? " (truncated)" : ""),
		fullOutputPath: undefined as string | undefined,
		url,
		title,
		truncated: truncation.truncated,
		bytes: truncation.totalBytes,
		lines: truncation.totalLines,
	};
	let output = `URL: ${url}\n`;
	if (title) output += `Title: ${title}\n`;
	output += `\n${truncation.content}`;
	if (truncation.truncated) {
		const root = join(getAgentDir(), "cache", "web");
		await mkdir(root, { recursive: true });
		const dir = await mkdtemp(join(root, "fetch-"));
		const fullOutputPath = join(dir, "content.md");
		try { await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, text, "utf8")); }
		catch (error) { await rethrowAfterCleanup(error, () => rm(dir, { recursive: true, force: true })); }
		details.fullOutputPath = fullOutputPath;
		output += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		output += ` Full content saved to: ${fullOutputPath}]`;
	}
	return {
		content: [{ type: "text" as const, text: output }],
		details,
	};
}

const webTool = defineTool({
	name: "web",
	label: "Web",
	description: "Search the web or fetch a known HTTP(S) URL through DeepSeek APIs. Search returns titles, URLs, dates, and short summaries. Fetch returns the page as Markdown. Fetch output is limited to 200 lines or 12KB; larger Markdown is saved locally for targeted reading with read.",
	promptSnippet: "Search the web or read a URL",
	promptGuidelines: [
		"Use web with action search for external information; use action fetch to read a known URL. Search accepts DeepSeek operators such as site:, lang:, after:, and before:.",
		"When a page is truncated, use read on the returned local file to inspect relevant ranges instead of fetching it again.",
	],
	parameters: Type.Object({
		action: Type.Union([Type.Literal("search"), Type.Literal("fetch")]),
		query: Type.Optional(Type.String({ description: "Search query; required for search.", minLength: 1 })),
		url: Type.Optional(Type.String({ description: "Absolute HTTP(S) URL; required for fetch.", minLength: 1 })),
		numResults: Type.Optional(Type.Integer({ description: "Search result count; defaults to 5.", minimum: 1, maximum: MAX_NUM_RESULTS })),
	}),
	async execute(_toolCallId, params, signal): Promise<AgentToolResult<WebDetails>> {
		if (params.action === "search") {
			const query = params.query?.trim();
			const count = params.numResults ?? DEFAULT_NUM_RESULTS;
			if (!query) throw new Error("Search requires a non-empty query.");
			if (!Number.isInteger(count) || count < 1 || count > MAX_NUM_RESULTS) {
				throw new Error(`numResults must be an integer between 1 and ${MAX_NUM_RESULTS}.`);
			}
			return searchWeb(query, count, signal);
		}
		if (params.action === "fetch") {
			const url = params.url?.trim();
			if (!url) throw new Error("Fetch requires a URL.");
			return fetchWeb(url, signal);
		}
		throw new Error("Unknown web action.");
	},
});

export default function webExtension(pi: ExtensionAPI): void {
	registerCompactTool(pi, webTool, (args) => {
		if (args.action !== "search" && args.action !== "fetch") return "";
		const target = args.action === "search" ? args.query : args.url;
		return typeof target === "string" && target ? `${args.action} ${target}` : args.action;
	});
	pi.on("session_start", async () => {
		const root = join(getAgentDir(), "cache", "web");
		let entries;
		try { entries = await readdir(root, { withFileTypes: true }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^fetch-[A-Za-z0-9]+$/.test(entry.name)) continue;
			const directory = join(root, entry.name);
			if (Date.now() - (await stat(directory)).mtimeMs > OUTPUT_RETENTION_MS) await rm(directory, { recursive: true, force: true });
		}
	});
}
