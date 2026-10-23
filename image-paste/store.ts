import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ATTACHMENTS_ENTRY, IMAGE_ENTRY, attachmentReferences, imageIds, isClipboardImage, messageImages, messageKey, messageText, PLACEHOLDER_RE, type AttachmentReference, type PastedImage } from "./attachments.js";

export function createImageStore() {
	const images = new Map<string, PastedImage>();
	const usedIds = new Set<number>();
	let previewDirectory: string | undefined;
	let nextId = 1;
	let generation = 0;
	let preparation = Promise.resolve();

	function reserveIds(text: string): void {
		for (const match of text.matchAll(PLACEHOLDER_RE)) usedIds.add(Number(match[1]));
	}

	function allocateId(): string {
		while (usedIds.has(nextId)) nextId++;
		usedIds.add(nextId);
		return `img-${nextId++}`;
	}

	async function clearPreviews(): Promise<void> {
		await preparation;
		if (!previewDirectory) return;
		const directory = previewDirectory;
		if (dirname(directory) !== join(getAgentDir(), "cache")) throw new Error("Invalid image preview directory.");
		await rm(directory, { recursive: true, force: true });
		if (previewDirectory === directory) previewDirectory = undefined;
	}

	async function resetImages(): Promise<void> {
		generation++;
		await clearPreviews();
		images.clear();
		usedIds.clear();
		nextId = 1;
	}

	function savedImage(asset: PastedImage): ImageContent | undefined {
		return asset.message && asset.index !== undefined ? messageImages(asset.message)[asset.index] : asset.content;
	}

	function imageUrl(asset: PastedImage): string | undefined {
		const file = asset.preview ?? asset.file;
		return file ? pathToFileURL(file).href : undefined;
	}

	function bindImages(message: UserMessage, references: AttachmentReference[]): void {
		const ids = new Set(imageIds(messageText(message)));
		const attached = messageImages(message);
		for (const ref of references) {
			if (!ids.has(ref.id) || !attached[ref.index]) continue;
			const asset = images.get(ref.id) ?? {};
			asset.message = message;
			asset.index = ref.index;
			asset.content = undefined;
			images.set(ref.id, asset);
		}
	}

	async function preparePreviews(ctx: ExtensionContext, revision: number): Promise<void> {
		for (const [id, asset] of images) {
			if (revision !== generation) return;
			if (asset.preview) continue;
			const image = savedImage(asset);
			if (!image) continue;
			try {
				const extension = image.mimeType.split("/")[1];
				if (!["png", "jpeg", "webp", "gif"].includes(extension)) throw new Error(`Unsupported preview type: ${image.mimeType}`);
				if (!previewDirectory) {
					const cacheRoot = join(getAgentDir(), "cache");
					await mkdir(cacheRoot, { recursive: true });
					previewDirectory = await mkdtemp(join(cacheRoot, "image-paste-"));
				}
				const file = join(previewDirectory, `${id}.${extension}`);
				await writeFile(file, Buffer.from(image.data, "base64"), { flag: "wx" });
				if (revision === generation) asset.preview = file;
			} catch (error) {
				ctx.ui.notify(`Cannot prepare preview for [${id}]: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
	}

	function prepareImages(ctx: ExtensionContext): Promise<void> {
		const revision = generation;
		preparation = preparation.then(() => preparePreviews(ctx, revision));
		return preparation;
	}

	async function restoreImages(ctx: ExtensionContext): Promise<void> {
		const revision = ++generation;
		const draftIds = new Set(imageIds(ctx.ui.getEditorText()));
		const drafts = [...images].filter(([id]) => draftIds.has(id));
		await clearPreviews();
		if (revision !== generation) return;
		images.clear();
		const entries = ctx.sessionManager.getBranch();
		const bindings = new Map<string, AttachmentReference[]>();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== ATTACHMENTS_ENTRY || Array.isArray(entry.data)) continue;
			const data = entry.data as { messageKey?: unknown; references?: unknown } | undefined;
			const references = attachmentReferences(data?.references);
			if (typeof data?.messageKey === "string" && references) bindings.set(data.messageKey, references);
		}
		let legacyReferences: AttachmentReference[] | undefined;
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === IMAGE_ENTRY) {
				const data = entry.data as { id?: unknown; file?: unknown } | undefined;
				if (typeof data?.id === "string" && /^img-\d+$/.test(data.id) && typeof data.file === "string") {
					usedIds.add(Number(data.id.slice(4)));
					images.set(data.id, { ...images.get(data.id), file: isClipboardImage(data.file) ? data.file : undefined });
				}
			} else if (entry.type === "custom" && entry.customType === ATTACHMENTS_ENTRY) {
				if (Array.isArray(entry.data)) legacyReferences = attachmentReferences(entry.data);
			} else if (entry.type === "message" && entry.message.role === "user") {
				const text = messageText(entry.message);
				reserveIds(text);
				const ids = imageIds(text);
				const references = ids.length > 0 ? bindings.get(messageKey(entry.message)) ?? (legacyReferences?.every((ref) => ids.includes(ref.id)) ? legacyReferences : undefined) : undefined;
				if (references) bindImages(entry.message, references);
				else if (!legacyReferences && ids.length === messageImages(entry.message).length) bindImages(entry.message, ids.map((id, index) => ({ id, index })));
				legacyReferences = undefined;
			}
		}
		for (const [id, asset] of drafts) if (!images.has(id)) images.set(id, { ...asset, preview: undefined });
		await prepareImages(ctx);
	}

	return { images, resetImages, restoreImages, reserveIds, allocateId, savedImage, imageUrl, bindImages, prepareImages };
}

export type ImageStore = ReturnType<typeof createImageStore>;
