import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage, type TextContent, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactTool } from "./compact/tools.js";
import { readBoundedText, truncateBytes } from "./lib/output.js";
import { isWithinDirectory } from "./lib/paths.js";

const TOOL_NAME = "explore";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const MAX_TASK_LENGTH = 4000;
const TASK_OUTPUT_CAP = 12 * 1024;
const MAX_EVENT_LINE_BYTES = 1024 * 1024;
const TASK_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const TRUNCATION_NOTICE = "\n\n[Truncated; ask for a narrower report.]";

const READ_ONLY_PROMPT = `You are a read-only code exploration agent. Investigate and report; never modify anything.

You can only use read, grep, find, and ls. You cannot run shell commands, edit files, or write files.

Guidelines:
- Locate relevant code with grep/find, then read only the line ranges you need.
- Do not attempt to modify, create, or delete anything.
- Return a report under 3000 characters with exact file paths and line numbers supporting each finding.
- Distinguish verified facts from inferences. State what you could not find or verify.
- Keep exploration details in this subprocess. Return only relevant file paths, line numbers, short code excerpts, and conclusions the main agent needs.`;

interface ExploreTask {
	task: string;
	cwd?: string;
}

interface ValidatedTask extends Required<ExploreTask> {
	root: string;
}

interface UsageStats extends Usage {
	turns: number;
}

interface ExploreResult {
	task: string;
	cwd: string;
	status: "done" | "failed";
	exitCode: number;
	output: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		totalTokens: 0,
		turns: 0,
	};
}

function registerExploreGuard(pi: ExtensionAPI, root: string): void {
	pi.on("tool_call", (event, ctx) => {
		if (!READ_ONLY_TOOLS.includes(event.toolName)) {
			return { block: true, reason: "Only read-only tools are allowed." };
		}
		const input = event.input as { path?: string };
		const raw = input.path ?? ".";
		if (typeof raw !== "string") return { block: true, reason: "Invalid path." };
		const value = raw.startsWith("@") ? raw.slice(1) : raw;
		const expanded = value === "~" ? homedir()
			: /^~[\\/]/.test(value) ? path.resolve(homedir(), value.slice(2)) : value;
		try {
			const target = fs.realpathSync(path.resolve(ctx.cwd, expanded));
			if (!isWithinDirectory(root, target)) {
				return { block: true, reason: "Path is outside the explore project root." };
			}
		} catch {
			return { block: true, reason: "Path cannot be resolved inside the explore project root." };
		}
	});
}

function validateTask(task: ExploreTask, cwd: string): ValidatedTask {
	if (!task.task.trim() || task.task.length > MAX_TASK_LENGTH) {
		throw new Error(`Explore task must contain 1-${MAX_TASK_LENGTH} characters.`);
	}
	const root = fs.realpathSync(cwd);
	const target = fs.realpathSync(path.resolve(cwd, task.cwd ?? "."));
	if (!isWithinDirectory(root, target) || !fs.statSync(target).isDirectory()) {
		throw new Error(`Explore cwd is outside the project root: ${task.cwd}`);
	}
	return { root, task: task.task.trim(), cwd: target };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	throw new Error("Cannot locate the Pi executable. Start Pi through its executable or CLI script.");
}

function parseMessage(line: string): { message: AssistantMessage; isFinal: boolean } | undefined {
	if (!line.trim()) return;
	const event: { type?: string; message?: AssistantMessage } | null = JSON.parse(line);
	if (!["message_end", "message_update"].includes(event?.type ?? "") || event?.message?.role !== "assistant") return;
	const message = event.message;
	if (!Array.isArray(message.content) || message.content.some(part =>
		!part || typeof part !== "object" || (part.type === "text" && typeof part.text !== "string"))) {
		throw new Error("Explore returned an invalid assistant message.");
	}
	return { message, isFinal: event.type === "message_end" };
}

async function readMessages(stream: Readable, accept: (message: AssistantMessage, isFinal: boolean) => void): Promise<void> {
	let parts: string[] = [];
	let bytes = 0;
	for await (const chunk of stream.setEncoding("utf8")) {
		const segments = (chunk as string).split("\n");
		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i];
			bytes += Buffer.byteLength(segment, "utf8");
			if (bytes > MAX_EVENT_LINE_BYTES) throw new Error("Explore event exceeds " + MAX_EVENT_LINE_BYTES + " bytes.");
			parts.push(segment);
			if (i === segments.length - 1) continue;
			const message = parseMessage(parts.join(""));
			if (message) accept(message.message, message.isFinal);
			parts = [];
			bytes = 0;
		}
	}
	const message = parseMessage(parts.join(""));
	if (message) accept(message.message, message.isFinal);
}

async function readStderr(stream: Readable): Promise<string> {
	return (await readBoundedText(stream, TASK_OUTPUT_CAP)).text;
}

function collectMessage(result: ExploreResult, message: AssistantMessage, isFinal: boolean): void {
	const textParts = message.content.filter((part): part is TextContent => part.type === "text");
	const hasToolCalls = message.content.some(part => part.type === "toolCall");
	const text = textParts.map(part => part.text).join("\n");
	if (!hasToolCalls && text) result.output = truncateBytes(text, TASK_OUTPUT_CAP, TRUNCATION_NOTICE);
	if (!isFinal) return;
	result.model = message.model;
	result.stopReason = message.stopReason;
	result.errorMessage = message.errorMessage || (message.stopReason === "length" ? "Explore reached its output limit." : undefined);
	result.usage.turns++;
	const usage = message.usage;
	if (!usage) return;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		result.usage[key] += usage[key] ?? 0;
		result.usage.cost[key] += usage.cost?.[key] ?? 0;
	}
	result.usage.totalTokens += usage.totalTokens ?? 0;
	result.usage.cost.total += usage.cost?.total ?? 0;
}

function failureText(result: ExploreResult): string {
	const reason = result.errorMessage || result.stderr.trim() || "Explore did not finish.";
	return result.output ? `${reason}\n\nPartial report:\n${result.output}` : reason;
}

async function runTask(
	input: ValidatedTask,
	defaults: DispatchDefaults,
	signal: AbortSignal | undefined,
): Promise<ExploreResult> {
	if (signal?.aborted) throw new Error("Explore task aborted");
	const result: ExploreResult = {
		task: input.task, cwd: input.cwd, status: "failed", exitCode: -1,
		output: "", stderr: "", usage: emptyUsage(),
	};
	const args = [
		"--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills",
		"--no-prompt-templates", "--no-context-files", "--no-approve",
		"--extension", path.join(import.meta.dirname, "explore.ts"),
		"--tools", READ_ONLY_TOOLS.join(","),
		"--append-system-prompt", READ_ONLY_PROMPT,
	];
	if (defaults.model) args.push("--model", defaults.model);
	if (defaults.thinkingLevel) args.push("--thinking", defaults.thinkingLevel);
	args.push("Task: " + input.task);
	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: input.cwd,
		env: { ...process.env, PI_EXPLORE_ROOT: input.root },
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let failure: string | undefined;
	let isAborted = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const terminate = (reason: string) => {
		if (failure !== undefined) return;
		failure = reason;
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		proc.kill("SIGTERM");
		killTimer = setTimeout(() => {
			if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
		}, KILL_GRACE_MS);
	};
	const onAbort = () => {
		if (failure !== undefined) return;
		isAborted = true;
		terminate("Explore task aborted");
	};
	const onStreamError = (error: unknown) => {
		terminate(error instanceof Error ? error.message : String(error));
		proc.stdout.destroy();
		proc.stderr.destroy();
	};
	const closed = new Promise<number | null>(resolve => {
		proc.on("error", error => { failure ??= error.message; });
		proc.once("close", resolve);
	});
	const timer = setTimeout(() => terminate("Timed out after " + TASK_TIMEOUT_MS / 1000 + "s"), TASK_TIMEOUT_MS);
	try {
		const messages = readMessages(proc.stdout, (message, isFinal) => collectMessage(result, message, isFinal)).catch(onStreamError);
		const stderr = readStderr(proc.stderr).catch(error => { onStreamError(error); return ""; });
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const [exitCode, , errorOutput] = await Promise.all([closed, messages, stderr]);
		if (isAborted) throw new Error("Explore task aborted");
		result.exitCode = exitCode ?? -1;
		result.stderr = errorOutput;
		result.errorMessage = failure ?? result.errorMessage;
		if (!result.errorMessage && exitCode === 0 && result.output && result.stopReason === "stop") result.status = "done";
		return result;
	} finally {
		clearTimeout(timer);
		clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
	}
}

export default function exploreExtension(pi: ExtensionAPI): void {
	const root = process.env.PI_EXPLORE_ROOT;
	if (root !== undefined) {
		registerExploreGuard(pi, fs.realpathSync(root));
		return;
	}
	registerCompactTool(pi, {
		name: TOOL_NAME,
		label: "Explore",
		description: "Investigate project code in an isolated read-only Pi process. Only a concise report with file paths, line numbers, and evidence returns to this conversation. Each call starts a fresh investigation; include the question and any relevant findings from earlier calls.",
		promptSnippet: "Explore project code without adding the full investigation to this conversation",
		promptGuidelines: [
			"Use explore when understanding project structure, tracing behavior, or gathering code evidence would require substantial reading. Call it again whenever another investigation is needed.",
			"Give each exploration a focused question. Use its file references for targeted reading when making changes; treat unverified conclusions as uncertain.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "What to investigate and report, including relevant context.", minLength: 1, maxLength: MAX_TASK_LENGTH }),
			cwd: Type.Optional(Type.String({ description: "Directory inside the session project root; defaults to the session cwd." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<ExploreResult>> {
			const task = validateTask(params, ctx.cwd);
			const result = await runTask(task, {
				model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : undefined,
				thinkingLevel: ctx.thinkingLevel,
			}, signal);
			const body = result.status === "done" ? result.output : failureText(result);
			return {
				content: [{ type: "text", text: truncateBytes("Explore " + result.status + ": " + result.task + "\n\n" + body, TASK_OUTPUT_CAP, TRUNCATION_NOTICE) }],
				details: result,
				usage: result.usage,
			};
		},
	});
}
