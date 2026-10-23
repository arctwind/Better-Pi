import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { registerCompactTool } from "./compact/tools.js";
import { rethrowAfterCleanup } from "./lib/errors.js";
import { runBoundedCommand, truncateBytes } from "./lib/output.js";

const COMMAND_NAME = "review";
const REVIEW_REQUEST = "Review my uncommitted changes";
const GIT_TOOL_NAME = "review_git";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", GIT_TOOL_NAME]);
const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 12 * 1024;
const TRUNCATION_NOTICE = "\n\n[Output truncated. Use paths to inspect a smaller set of files.]";
const GIT_OPERATIONS = {
	status: ["status", "--short", "--untracked-files=all", "--ignore-submodules=all"],
	unstaged: ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"],
	staged: ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"],
};

const DEFAULT_SCOPE = "all uncommitted changes in the current workspace (staged, unstaged, and untracked files)";

const REVIEW_PROMPT = `You are reviewing code now. This is a read-only review.

Scope: {{scope}}
Start with the review_git status operation to confirm the changed files, then read the relevant diffs with staged and unstaged, and read the files. Read untracked files directly. If nothing is uncommitted, say so and stop.

Read-only constraints:
- Use only read, grep, find, ls, and review_git to read files, search code, and inspect Git changes.
- Do not modify, create, or delete files. Do not run Git writes, install dependencies, build artifacts, or any command that changes the workspace or system state.
- Report problems only; do not fix them. These constraints apply to this review only. The user may ask for fixes afterwards; follow the new instructions then.

Method:
- Understand the intent of the change first, then read the change itself plus its callers, callees, and context.
- Check correctness, boundaries and exceptions, state and concurrency, error handling, resource release, performance, security, compatibility, and regression risk.
- Do not run tests, type checks, or other project scripts. When something cannot be verified by static reading, state the basis and the limitation.
- Report only problems with evidence that can be located. Do not report subjective style preferences or guesses.

Report format:
Each problem takes two lines. The first line is severity and title; the second starts with a file link. For example:

[P2] Save confirmation appears before the write finishes
[editor.ts (line 33)](/E:/example-project/src/editor.ts:33) The success message shows before the save completes, so a failed write misleads the user. Show the confirmation after the save succeeds and report the write error.

- Link text is only the file name and line number. When different directories hold files with the same name, use the shortest distinguishable relative path. Link to an absolute path (Windows paths in /E:/... form) ending in :line.
- Cover the problem, trigger condition, impact, and suggested fix in at most three sentences.
- Severities: P0 data loss, security hole, or crash; P1 clear functional error; P2 boundary condition or experience issue; P3 minor issue.
- Order problems from highest to lowest severity, with one blank line between them.
- Do not restate the changes. Do not output a summary, praise, or a checklist.

When nothing is wrong, output only the reviewed scope (files and main checks) and "No problems found".

Write the report in English.`;

function buildReviewPrompt(scope: string): string {
	return REVIEW_PROMPT.replace("{{scope}}", scope || DEFAULT_SCOPE);
}

function buildReviewRequest(scope: string): string {
	return scope ? `${REVIEW_REQUEST}: ${scope}` : `${REVIEW_REQUEST}.`;
}

function hasConversation(entries: SessionEntry[]): boolean {
	return entries.some((entry) => entry.type === "message" && entry.message.role !== "system");
}

export default function reviewExtension(pi: ExtensionAPI): void {
	let isReviewing = false;
	let pendingPrompt: string | undefined;
	let toolsBeforeReview: string[] | undefined;

	const restoreTools = (): void => {
		if (toolsBeforeReview) pi.setActiveTools(toolsBeforeReview);
		toolsBeforeReview = undefined;
	};

	const endReview = (): void => {
		isReviewing = false;
		pendingPrompt = undefined;
		restoreTools();
	};

	const registerGitTool = (): void => {
		registerCompactTool(pi, {
			name: GIT_TOOL_NAME,
			label: "Review Git",
			description: "Read uncommitted Git changes: status lists changed files, staged shows the index diff, unstaged shows the working-tree diff. Optional paths are literal repository-relative file paths.",
			parameters: Type.Object({
				operation: Type.Union([Type.Literal("status"), Type.Literal("staged"), Type.Literal("unstaged")]),
				paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			}),
			async execute(_toolCallId, { operation, paths = [] }, signal, _onUpdate, ctx) {
				if (!isReviewing) throw new Error("This tool is only available during a review.");
				if (!Object.hasOwn(GIT_OPERATIONS, operation)) throw new Error("Unsupported Git operation.");
				if (paths.some((path) => !path || path.includes("\0"))) throw new Error("Invalid Git path.");
				signal?.throwIfAborted();
				const result = await runBoundedCommand("git", [
					"--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false",
					...GIT_OPERATIONS[operation], "--", ...paths.map((path) => `:(literal)${path}`),
				], { cwd: ctx.cwd, signal, timeout: GIT_TIMEOUT_MS, maxBytes: MAX_OUTPUT_BYTES });
				if (result.code !== 0) {
					throw new Error(result.stderr || "Git could not read the changes.");
				}
				const text = result.isTruncated
					? truncateBytes(result.stdout, MAX_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE)) + TRUNCATION_NOTICE
					: result.stdout || "No changes.";
				return { content: [{ type: "text", text }], details: { truncated: result.isTruncated } };
			},
		});
	};

	pi.registerCommand(COMMAND_NAME, {
		description: "Review uncommitted changes (read-only)",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("A task is still running. Start the review after it finishes.", "warning");
				return;
			}

			if (hasConversation(ctx.sessionManager.getBranch())) {
				ctx.ui.notify("/review only works in a new session. Run /new first.", "warning");
				return;
			}

			const scope = args.trim();
			const activeTools = toolsBeforeReview ?? pi.getActiveTools();
			isReviewing = true;
			pendingPrompt = buildReviewPrompt(scope);
			toolsBeforeReview = activeTools;

			try {
				registerGitTool();
				pi.setActiveTools(pi.getAllTools().map((tool) => tool.name).filter((name) => READ_ONLY_TOOLS.has(name)));
				pi.sendUserMessage(buildReviewRequest(scope));
			} catch (error) {
				await rethrowAfterCleanup(error, endReview);
			}
		},
	});

	pi.on("before_agent_start", () => {
		if (!pendingPrompt) return;
		const content = pendingPrompt;
		pendingPrompt = undefined;
		return { message: { customType: "review-mode", content, display: false } };
	});

	pi.on("tool_call", (event) => {
		if (!isReviewing) return;

		if (!READ_ONLY_TOOLS.has(event.toolName)) {
			return { block: true, reason: "Review mode is read-only. Report the problem instead of changing files." };
		}
	});

	pi.on("agent_end", () => {
		if (isReviewing) endReview();
	});

	pi.on("session_shutdown", () => {
		if (isReviewing) endReview();
	});
}
