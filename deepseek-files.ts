import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { rethrowAfterCleanup } from "./lib/errors.js";
import { loadPiDependency } from "./lib/dependencies.js";

const DEEPSEEK_ORIGIN = "https://api.deepseek.com";
const DEEPSEEK_PROVIDER = "deepseek";
const CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const FILE_LIFETIME_SECONDS = 20 * 60 * 60;
const EXPIRY_MARGIN_SECONDS = 5 * 60;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 100;
const MAX_EXPIRY_REFRESH_PASSES = 2;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

interface ContentPart {
	type: string;
	image_url?: { url: string };
}

interface ChatPayload {
	model: string;
	messages: { content?: string | ContentPart[] }[];
}

interface UploadedFile {
	id: string;
	expiresAt: number;
}

interface PreparedImage {
	part: ContentPart;
	mimeType: string;
	data: string;
	hash: string;
}

interface FileLock {
	lock(path: string, options: {
		realpath: boolean;
		stale: number;
		retries: number;
		onCompromised(error: Error): void;
	}): Promise<() => Promise<void>>;
}

async function acquireFileLock(path: string, controller: AbortController, signal: AbortSignal): Promise<() => Promise<void>> {
	const lockfile = loadPiDependency<FileLock>("proper-lockfile");
	while (true) {
		signal.throwIfAborted();
		try {
			return await lockfile.lock(path, {
				realpath: false,
				stale: LOCK_STALE_MS,
				retries: 0,
				onCompromised: (error) => controller.abort(error),
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
			await sleep(LOCK_RETRY_MS, undefined, { signal });
		}
	}
}

function isUsableFile(value: unknown): value is UploadedFile {
	if (!value || typeof value !== "object") return false;
	const file = value as UploadedFile;
	return typeof file.id === "string" && /^file-api-[A-Za-z0-9_-]+$/.test(file.id) &&
		Number.isFinite(file.expiresAt) && file.expiresAt > Date.now() / 1000 + EXPIRY_MARGIN_SECONDS;
}

async function readCachedFile(path: string): Promise<UploadedFile | undefined> {
	try {
		const file: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!file || typeof file !== "object" || !("id" in file) || typeof file.id !== "string" ||
			!/^file-api-[A-Za-z0-9_-]+$/.test(file.id) || !("expiresAt" in file) || typeof file.expiresAt !== "number" || !Number.isFinite(file.expiresAt)) {
			throw new Error(`Invalid DeepSeek cache record: ${path}`);
		}
		return isUsableFile(file) ? file : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function saveCachedFile(directory: string, path: string, file: UploadedFile): Promise<void> {
	await mkdir(directory, { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, JSON.stringify(file), { flag: "wx", mode: 0o600 });
		await rename(temporaryPath, path);
	} catch (error) {
		return rethrowAfterCleanup(error, () => rm(temporaryPath, { force: true }));
	}
}

async function uploadImage(data: string, mimeType: string, headers: Headers, signal?: AbortSignal): Promise<UploadedFile> {
	const body = new FormData();
	body.set("purpose", "user_data");
	body.set("expires_after[anchor]", "created_at");
	body.set("expires_after[seconds]", String(FILE_LIFETIME_SECONDS));
	body.set("file", new Blob([Buffer.from(data, "base64")], { type: mimeType }), `image.${mimeType.slice(6)}`);
	const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
	const response = await fetch(`${DEEPSEEK_ORIGIN}/files`, {
		method: "POST",
		headers,
		body,
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		await rethrowAfterCleanup(new Error(`DeepSeek image upload failed (HTTP ${response.status}).`), async () => { await response.body?.cancel(); });
	}
	const result = await response.json() as { id?: unknown; expires_at?: unknown };
	const file = { id: result.id, expiresAt: result.expires_at };
	if (!isUsableFile(file)) throw new Error("DeepSeek returned an invalid file ID or expiration time.");
	return file;
}

async function getUploadedFile(
	image: PreparedImage,
	directory: string,
	headers: Headers,
	files: Map<string, UploadedFile>,
	signal?: AbortSignal,
): Promise<UploadedFile> {
	signal?.throwIfAborted();
	const path = join(directory, `${image.hash}.json`);
	let file = files.get(path);
	if (isUsableFile(file)) return file;
	file = await readCachedFile(path);
	if (!file) {
		await mkdir(directory, { recursive: true });
		const controller = new AbortController();
		const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS + LOCK_STALE_MS);
		const operationSignal = AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])]);
		const release = await acquireFileLock(path, controller, operationSignal);
		try {
			operationSignal.throwIfAborted();
			file = await readCachedFile(path);
			if (!file) {
				file = await uploadImage(image.data, image.mimeType, headers, operationSignal);
				operationSignal.throwIfAborted();
				await saveCachedFile(directory, path, file);
			}
		} catch (error) {
			return rethrowAfterCleanup(error, release);
		}
		await release();
	}
	files.set(path, file);
	return file;
}

export default function deepseekFiles(pi: ExtensionAPI): void {
	const files = new Map<string, UploadedFile>();
	const api = openAICompletionsApi();
	let lastSweepAt = 0;
	pi.on("session_shutdown", () => files.clear());
	async function preparePayload(payload: ChatPayload, model: Model<Api>, options?: SimpleStreamOptions): Promise<ChatPayload> {
		const parts = payload.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
		const images = parts.filter((part) => part.type === "image_url" && part.image_url?.url.startsWith("data:"));
		if (images.length === 0) return payload;
		const decoded: PreparedImage[] = images.map((part) => {
			const match = IMAGE_DATA_URL.exec(part.image_url!.url);
			if (!match) throw new Error("DeepSeek Files API requires a PNG, JPEG, GIF or WebP base64 image.");
			const [, mimeType, data] = match;
			const bytes = Buffer.byteLength(data, "base64");
			if (bytes === 0 || bytes > MAX_FILE_BYTES) throw new Error("DeepSeek image exceeds the 64 MiB upload limit.");
			return { part, mimeType, data, hash: createHash("sha256").update(data, "base64").digest("hex") };
		});
		const baseUrl = new URL(model.baseUrl);
		if (baseUrl.origin !== DEEPSEEK_ORIGIN || !/^\/(?:v1\/?)?$/.test(baseUrl.pathname)) {
			throw new Error("DeepSeek Files API requires the official api.deepseek.com endpoint.");
		}
		const headers = new Headers();
		for (const [name, value] of Object.entries({ ...model.headers, ...options?.headers })) {
			if (value !== null) headers.set(name, value);
		}
		if (!headers.has("authorization") && options?.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
		if (!headers.has("authorization")) throw new Error("DeepSeek API key is not configured.");
		headers.delete("content-type");
		headers.delete("content-length");
		const scope = createHash("sha256").update(headers.get("authorization")!).digest("hex");
		const cacheRoot = join(getAgentDir(), "cache", "deepseek-files");
		const directory = join(cacheRoot, scope);
		const uniqueImages = [...new Map(decoded.map((image) => [image.hash, image])).values()];
		const resolved = new Map<string, UploadedFile>();
		const signal = options?.signal;
		for (const [path, file] of files) if (!isUsableFile(file)) files.delete(path);
		if (Date.now() - lastSweepAt >= CACHE_SWEEP_INTERVAL_MS) {
			await clearExpiredCache(cacheRoot, signal);
			lastSweepAt = Date.now();
		}
		for (let pass = 0; pass <= MAX_EXPIRY_REFRESH_PASSES; pass++) {
			for (const image of uniqueImages) {
				if (!isUsableFile(resolved.get(image.hash))) {
					resolved.set(image.hash, await getUploadedFile(image, directory, headers, files, signal));
				}
			}
			if ([...resolved.values()].every(isUsableFile)) break;
		}
		signal?.throwIfAborted();
		if (![...resolved.values()].every(isUsableFile)) {
			throw new Error("DeepSeek files expired while preparing the request. Please retry.");
		}
		const replacements = new Map(decoded.map((image) => [image.part, {
			type: "file" as const,
			file_id: resolved.get(image.hash)!.id,
		}]));
		return {
			...payload,
			messages: payload.messages.map((message) => Array.isArray(message.content)
				? { ...message, content: message.content.map((part) => replacements.get(part) ?? part) }
				: message),
		};
	}

	pi.registerProvider(DEEPSEEK_PROVIDER, {
		api: "openai-completions",
		streamSimple(model, context, options) {
			return api.streamSimple(model, context, {
				...options,
				async onPayload(original, requestModel) {
					const transformed = await options?.onPayload?.(original, requestModel);
					const payload = (transformed === undefined ? original : transformed) as ChatPayload;
					if (!payload || payload.model !== model.id || !Array.isArray(payload.messages)) return transformed;
					return preparePayload(payload, model, options);
				},
			});
		},
	});
}

async function clearExpiredFiles(directory: string, signal?: AbortSignal): Promise<void> {
	let names: string[];
	try { names = await readdir(directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const name of names) {
		if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
		signal?.throwIfAborted();
		const path = join(directory, name);
		if (await readCachedFile(path)) continue;
		const controller = new AbortController();
		const cleanup = AbortSignal.any([AbortSignal.timeout(LOCK_STALE_MS), ...(signal ? [signal] : []), controller.signal]);
		const release = await acquireFileLock(path, controller, cleanup);
		try {
			if (!(await readCachedFile(path))) await rm(path, { force: true });
		} catch (error) {
			await rethrowAfterCleanup(error, release);
		}
		await release();
	}
}

async function clearExpiredCache(root: string, signal?: AbortSignal): Promise<void> {
	let entries;
	try { entries = await readdir(root, { withFileTypes: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) await clearExpiredFiles(join(root, entry.name), signal);
	}
}
