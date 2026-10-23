import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

const KILL_GRACE_MS = 1000;

export function truncateBytes(text: string, cap: number, notice = ""): string {
	if (!Number.isInteger(cap) || cap < Buffer.byteLength(notice)) throw new Error("Invalid output byte limit.");
	const bytes = Buffer.from(text);
	if (bytes.length <= cap) return text;
	let end = cap - Buffer.byteLength(notice);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.toString("utf8", 0, end) + notice;
}

export async function readBoundedText(stream: Readable, cap: number): Promise<{ text: string; isTruncated: boolean }> {
	if (!Number.isInteger(cap) || cap < 0) throw new Error("Invalid output byte limit.");
	const chunks: Buffer[] = [];
	let bytes = 0;
	let isTruncated = false;
	for await (const value of stream) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		const remaining = cap + 1 - bytes;
		if (chunk.length > remaining) isTruncated = true;
		if (remaining <= 0) continue;
		const kept = chunk.subarray(0, remaining);
		chunks.push(kept);
		bytes += kept.length;
	}
	const text = Buffer.concat(chunks, bytes).toString("utf8");
	return { text: truncateBytes(text, cap), isTruncated: isTruncated || bytes > cap };
}

export async function runBoundedCommand(command: string, args: string[], options: {
	cwd: string;
	signal?: AbortSignal;
	timeout: number;
	maxBytes: number;
}): Promise<{ stdout: string; stderr: string; code: number | null; isTruncated: boolean }> {
	options.signal?.throwIfAborted();
	const signal = AbortSignal.any([AbortSignal.timeout(options.timeout), ...(options.signal ? [options.signal] : [])]);
	const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let failure: unknown;
	let isTerminating = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const terminate = () => {
		if (isTerminating || child.exitCode !== null || child.signalCode !== null) return;
		isTerminating = true;
		child.kill("SIGTERM");
		killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
	};
	const read = async (stream: Readable) => {
		try { return await readBoundedText(stream, options.maxBytes); }
		catch (error) { terminate(); throw error; }
	};
	const closed = new Promise<number | null>((resolve) => {
		child.once("error", (error) => { failure = error; });
		child.once("close", resolve);
	});
	signal.addEventListener("abort", terminate, { once: true });
	if (signal.aborted) terminate();
	try {
		const results = await Promise.allSettled([closed, read(child.stdout), read(child.stderr)]);
		signal.throwIfAborted();
		if (failure) throw failure;
		const [exit, output, error] = results;
		if (exit.status === "rejected") throw exit.reason;
		if (output.status === "rejected") throw output.reason;
		if (error.status === "rejected") throw error.reason;
		return { stdout: output.value.text, stderr: error.value.text, code: exit.value, isTruncated: output.value.isTruncated };
	} finally {
		signal.removeEventListener("abort", terminate);
		clearTimeout(killTimer);
	}
}
