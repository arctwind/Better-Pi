import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";

export const CLIPBOARD_PATH_RE = /(?:[A-Za-z]:\\|\/)[^\r\n\t]*?pi-clipboard-[0-9a-fA-F-]+\.(?:png|jpe?g|webp|gif)/g;
export const CLIPBOARD_NAME_RE = /^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp|gif)$/i;
export const PLACEHOLDER_RE = /\[img-(\d+)\]/g;
export const IMAGE_ENTRY = "image-paste";
export const ATTACHMENTS_ENTRY = "image-paste-attachments";

export interface PastedImage {
	file?: string;
	preview?: string;
	message?: UserMessage;
	index?: number;
	content?: ImageContent;
}

export interface AttachmentReference {
	id: string;
	index: number;
}

export function isClipboardImage(file: string): boolean {
	if (!CLIPBOARD_NAME_RE.test(basename(file))) return false;
	try {
		const root = realpathSync(tmpdir());
		return realpathSync(dirname(file)) === root && lstatSync(file).isFile() &&
			realpathSync(file) === join(root, basename(file));
	} catch {
		return false;
	}
}

export function mimeTypeFor(file: string): string {
	switch (file.toLowerCase().split(".").pop()) {
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "webp": return "image/webp";
		case "gif": return "image/gif";
		default: return "image/png";
	}
}

export function imageIds(text: string): string[] {
	return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((match) => `img-${match[1]}`))];
}

export function messageText(message: UserMessage): string {
	return typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function messageImages(message: UserMessage): ImageContent[] {
	return typeof message.content === "string" ? [] : message.content.filter((part): part is ImageContent => part.type === "image");
}

export function messageKey(message: UserMessage): string {
	const hash = createHash("sha256").update(`${message.timestamp}:`);
	const content = typeof message.content === "string" ? [{ type: "text", text: message.content } as const] : message.content;
	for (const part of content) {
		const fields = part.type === "text" ? [part.type, part.text] : [part.type, part.mimeType, part.data];
		for (const field of fields) hash.update(`${field.length}:`).update(field);
	}
	return hash.digest("hex");
}

export function attachmentReferences(data: unknown): AttachmentReference[] | undefined {
	if (!Array.isArray(data) || !data.every((ref) => ref && typeof ref.id === "string" && /^img-\d+$/.test(ref.id) && Number.isSafeInteger(ref.index) && ref.index >= 0)) return undefined;
	return data;
}
