import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CLIPBOARD_PATH_RE, isClipboardImage, PLACEHOLDER_RE } from "./attachments.js";
import type { ImageStore } from "./store.js";

type Segment = (text: string, mode: "grapheme" | "word") => Iterable<Intl.SegmentData>;
interface EditorInternals {
	segment: Segment;
	setCursorCol(col: number): void;
}

function* segmentImages(text: string, mode: "grapheme" | "word", segment: Segment, store: ImageStore): Iterable<Intl.SegmentData> {
	let start = 0;
	for (const match of text.matchAll(PLACEHOLDER_RE)) {
		if (!store.images.has(`img-${match[1]}`)) continue;
		for (const part of segment(text.slice(start, match.index), mode)) {
			yield { ...part, index: start + part.index, input: text };
		}
		yield { segment: match[0], index: match.index, input: text, isWordLike: false };
		start = match.index + match[0].length;
	}
	for (const part of segment(text.slice(start), mode)) yield { ...part, index: start + part.index, input: text };
}

export class ImagePasteEditor extends CustomEditor {
	private readonly rememberImage: (id: string, file: string) => void;
	private readonly store: ImageStore;

	constructor(args: ConstructorParameters<typeof CustomEditor>, store: ImageStore, rememberImage: (id: string, file: string) => void) {
		super(...args);
		this.rememberImage = rememberImage;
		this.store = store;
		validateImageEditor(this);
		const editor = this as unknown as EditorInternals;
		const segment = editor.segment.bind(this);
		const setCursorCol = editor.setCursorCol.bind(this);
		editor.segment = (text, mode) => segmentImages(text, mode, segment, store);
		editor.setCursorCol = (col) => {
			const cursor = this.getCursor();
			const line = this.getLines()[cursor.line] ?? "";
			for (const match of line.matchAll(PLACEHOLDER_RE)) {
				const end = match.index + match[0].length;
					if (store.images.has(`img-${match[1]}`) && col > match.index && col < end) {
					col = col > cursor.col ? end : match.index;
					break;
				}
			}
			setCursorCol(col);
		};
	}

	override insertTextAtCursor(text: string): void {
		const files = new Set([...text.matchAll(CLIPBOARD_PATH_RE)].map((match) => match[0]).filter(isClipboardImage));
		this.store.reserveIds(this.getText());
		super.insertTextAtCursor(text.replace(CLIPBOARD_PATH_RE, (file) => {
			if (!files.has(file)) return file;
			const id = this.store.allocateId();
			this.rememberImage(id, file);
			this.store.images.set(id, { file });
			return `[${id}]`;
		}));
	}

	override render(width: number): string[] {
		return super.render(width).map((line) => line.replace(PLACEHOLDER_RE, (token, number) => {
			const asset = this.store.images.get(`img-${number}`);
			if (!asset) return token;
			const styled = `\x1b[36m${token}\x1b[39m`;
			const url = this.store.imageUrl(asset);
			return url && getCapabilities().hyperlinks ? hyperlink(styled, url) : styled;
		}));
	}
}

export function validateImageEditor(editor: object = CustomEditor.prototype): void {
	for (const name of ["segment", "setCursorCol", "getCursor", "getLines"]) {
		if (typeof Reflect.get(editor, name) !== "function") throw new Error(`Better Pi image editor requires ${name}().`);
	}
}
