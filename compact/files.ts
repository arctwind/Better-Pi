import { mkdir, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ToolRenderContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { isWithinDirectory } from "../lib/paths.js";
import { loadPiDependency } from "../lib/dependencies.js";

const MAX_DIFF_BYTES = 256 * 1024;
const MAX_DIFF_TIME_MS = 25;
const MAX_DIFF_EDIT_LENGTH = 2000;

interface LineChanges {
	added: number;
	removed: number;
}

interface DiffLibrary {
	diffLines(previous: string, content: string, options: { timeout: number; maxEditLength: number }): { count: number; added?: boolean; removed?: boolean }[] | undefined;
}

interface FileRenderState {
	header?: Text;
}

function displayPath(path: string, cwd: string): string {
	let expanded = path.replace(/^@/, "").replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (expanded === "~") expanded = homedir();
	else if (/^~[/\\]/.test(expanded)) expanded = resolve(homedir(), expanded.slice(2));
	const absolutePath = resolve(cwd, expanded);
	const relativePath = relative(cwd, absolutePath);
	const isInside = isWithinDirectory(cwd, absolutePath);
	return (isInside ? relativePath || "." : absolutePath).split(sep).join("/");
}

function countChanges(diff: string): LineChanges {
	return {
		added: diff.match(/^\+/gm)?.length ?? 0,
		removed: diff.match(/^-/gm)?.length ?? 0,
	};
}

function countWriteChanges(previous: string, content: string): LineChanges | undefined {
	const parts = loadPiDependency<DiffLibrary>("diff").diffLines(previous, content, { timeout: MAX_DIFF_TIME_MS, maxEditLength: MAX_DIFF_EDIT_LENGTH });
	if (!parts) return undefined;
	const changes: LineChanges = { added: 0, removed: 0 };
	for (const part of parts) {
		if (part.added) changes.added += part.count;
		if (part.removed) changes.removed += part.count;
	}
	return changes;
}

function fileHeader(name: string, theme: Theme, context: ToolRenderContext<FileRenderState>): string {
	const rawPath = context.args.path ?? context.args.file_path;
	const path = typeof rawPath === "string" && rawPath ? displayPath(rawPath, context.cwd) : "";
	return `${theme.fg(context.isError ? "error" : "toolTitle", theme.bold(name))} ${theme.fg("accent", stripTerminalSequences(path))}`;
}

function fileRenderers(name: string) {
	return {
		renderShell: "default" as const,
		renderCall(_args: unknown, theme: Theme, context: ToolRenderContext<FileRenderState>) {
			const header = context.state.header ?? new Text("", 0, 0);
			header.setText(fileHeader(name, theme, context));
			context.state.header = header;
			return header;
		},
		renderResult(result: { details?: unknown }, _options: unknown, theme: Theme, context: ToolRenderContext<FileRenderState>) {
			let text = fileHeader(name, theme, context);
			if (!context.isError && !context.isPartial && name !== "read") {
				const details = result.details as { diff?: string; lineChanges?: LineChanges } | undefined;
				const changes = details?.lineChanges ?? (typeof details?.diff === "string" ? countChanges(details.diff) : undefined);
				if (changes) {
					text += ` ${theme.fg("toolDiffAdded", `+${changes.added}`)} ${theme.fg("toolDiffRemoved", `-${changes.removed}`)}`;
				}
			}
			context.state.header?.setText(text);
			return new Text("", 0, 0);
		},
	};
}

async function readPreviousContent(path: string): Promise<string | undefined> {
	let file;
	try { file = await open(path, "r"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
	try {
		const size = (await file.stat()).size;
		if (size > MAX_DIFF_BYTES) return undefined;
		const bytes = Buffer.alloc(size + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await file.read(bytes, length, bytes.length - length, null);
			if (result.bytesRead === 0) break;
			length += result.bytesRead;
		}
		return length === bytes.length ? undefined : bytes.toString("utf8", 0, length);
	} finally {
		await file.close();
	}
}

export default function compactFiles(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	pi.registerTool({ ...createReadToolDefinition(cwd), ...fileRenderers("read") });
	pi.registerTool({ ...createEditToolDefinition(cwd), ...fileRenderers("edit") });
	pi.registerTool({
		...createWriteToolDefinition(cwd),
		...fileRenderers("write"),
		async execute(toolCallId, args, signal, onUpdate, context) {
			let lineChanges: LineChanges | undefined;
			const write = createWriteToolDefinition(cwd, {
				operations: {
					async mkdir(path) {
						await mkdir(path, { recursive: true });
					},
					async writeFile(path, content) {
						const previous = Buffer.byteLength(content) <= MAX_DIFF_BYTES ? await readPreviousContent(path) : undefined;
						if (previous !== undefined) lineChanges = countWriteChanges(previous, content);
						signal?.throwIfAborted();
						await writeFile(path, content, "utf8");
					},
				},
			});
			const result = await write.execute(toolCallId, args, signal, onUpdate, context);
			return { ...result, details: { ...result.details, lineChanges } };
		},
	});
}
