import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ATTACHMENTS_ENTRY, IMAGE_ENTRY, imageIds, isClipboardImage, messageImages, messageKey, messageText, mimeTypeFor, PLACEHOLDER_RE, type AttachmentReference } from "./attachments.js";
import { ImagePasteEditor, validateImageEditor } from "./editor.js";
import { createImageStore } from "./store.js";

export default function (pi: ExtensionAPI): void {
	const store = createImageStore();
	const { images, resetImages, restoreImages, reserveIds, savedImage, imageUrl, bindImages } = store;
	pi.on("session_start", async (_event, ctx) => {
		await resetImages();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === IMAGE_ENTRY) {
				const id = (entry.data as { id?: unknown } | undefined)?.id;
				if (typeof id === "string" && /^img-\d+$/.test(id)) reserveIds(`[${id}]`);
			} else if (entry.type === "message" && entry.message.role === "user") reserveIds(messageText(entry.message));
		}
		await restoreImages(ctx);
		if (ctx.mode !== "tui") return;
		validateImageEditor();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new ImagePasteEditor(
			[tui, theme, keybindings, { embedWorkingStatus: true }],
			store,
			(id, file) => pi.appendEntry(IMAGE_ENTRY, { id, file }),
		));
	});
	pi.on("session_tree", (_event, ctx) => restoreImages(ctx));
	pi.on("session_shutdown", resetImages);
	pi.on("message_end", (event) => {
		if (event.message.role !== "user") return;
		const ids = imageIds(messageText(event.message)).filter((id) => images.has(id));
		const attached = messageImages(event.message);
		const references = ids.flatMap((id): AttachmentReference[] => {
			const image = savedImage(images.get(id)!);
			const index = image ? attached.findIndex((part) => part.mimeType === image.mimeType && part.data === image.data) : -1;
			return index < 0 ? [] : [{ id, index }];
		});
		if (ids.length === 0) return;
		pi.appendEntry(ATTACHMENTS_ENTRY, { messageKey: messageKey(event.message), references });
		bindImages(event.message, references);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const ids = imageIds(event.text).filter((id) => images.has(id));
		if (ids.length === 0) return { action: "continue" };
		const attached = [...(event.images ?? [])];
		const assets = new Map(ids.map((id) => [id, images.get(id)!]));
		const prepared = new Map<string, typeof attached[number]>();
		try {
			for (const id of ids) {
				const asset = assets.get(id)!;
				let image = savedImage(asset);
				if (!image) {
					if (!asset.file || !isClipboardImage(asset.file)) throw new Error(`[${id}] cannot be read. Paste the image again.`);
					image = { type: "image", data: (await readFile(asset.file)).toString("base64"), mimeType: mimeTypeFor(asset.file) };
				}
				if (!attached.some((part) => part.mimeType === image.mimeType && part.data === image.data)) attached.push(image);
				prepared.set(id, image);
			}
			if (ids.some((id) => images.get(id) !== assets.get(id))) throw new Error("The session for these images changed. Submit again.");
			for (const [id, image] of prepared) images.get(id)!.content = image;
			await store.prepareImages(ctx);
			if (ids.some((id) => images.get(id) !== assets.get(id))) throw new Error("The session for these images changed. Submit again.");
		} catch (error) {
			if (ids.every((id) => images.get(id) === assets.get(id))) ctx.ui.setEditorText(event.text);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return { action: "handled" };
		}
		return { action: "transform", text: event.text, images: attached };
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "user") return markdown;
		return markdown.replace(PLACEHOLDER_RE, (token, number) => {
			const asset = images.get(`img-${number}`);
			const url = asset && imageUrl(asset);
			return url ? `[img-${number}](${url})` : token;
		});
	});
}
