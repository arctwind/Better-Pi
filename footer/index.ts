import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateTokens, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isWithinDirectory } from "../lib/paths.js";
import { watchCompactionSetting } from "./settings.js";

const DEFAULT_CNY_RATE = 7.2;
const MIN_PADDING = 2;
const MIN_GENERATION_MS = 50;
const JAILBREAK_STATUS = "system-prompt:jailbreak";

interface Currency {
	code: string;
	symbol: string;
	rate(): number;
}

function readCnyRate(): number {
	const configured = Number(process.env.PI_CNY_RATE);
	return configured > 0 ? configured : DEFAULT_CNY_RATE;
}

const CURRENCIES: readonly Currency[] = [
	{ code: "usd", symbol: "$", rate: () => 1 },
	{ code: "cny", symbol: "¥", rate: readCnyRate },
];

interface SessionStats {
	speed?: number;
	cacheHitRate?: number;
	cost: number;
}

function collectStats(entries: readonly SessionEntry[]): SessionStats {
	const stats: SessionStats = { cost: 0 };

	const addUsage = (usage: { cost: { total: number } }) => {
		stats.cost += usage.cost.total;
	};

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			addUsage(message.usage);
			const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
			stats.cacheHitRate = inputTokens > 0 ? message.usage.cacheRead / inputTokens * 100 : undefined;

			const start = message.timestamp;
			const end = Date.parse(entry.timestamp);
			stats.speed = Number.isFinite(start) && Number.isFinite(end) && end > start
				? message.usage.output / ((end - start) / 1000)
				: undefined;

		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			const usage = (entry.message as ToolResultMessage).usage;
			if (usage) addUsage(usage);
		} else if (entry.type === "usage") {
			addUsage(entry.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsage(entry.usage);
		}
	}

	return stats;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function fitFooterStats(parts: string[], right: string, width: number, center = ""): { left: string; right: string; padding: string } {
	const centerWidth = visibleWidth(center);
	const centerColumn = Math.floor((width - centerWidth) / 2);
	const rightRoom = center ? Math.max(0, width - centerColumn - centerWidth - MIN_PADDING) : width;
	const fittedRight = truncateToWidth(right, rightRoom, "");
	const leftRoom = Math.max(0, center ? centerColumn - MIN_PADDING : width - visibleWidth(fittedRight) - MIN_PADDING);
	let left = "";
	for (const part of parts) {
		const candidate = left ? `${left} ${part}` : part;
		if (visibleWidth(candidate) > leftRoom) {
			if (!left) left = truncateToWidth(part, leftRoom, "");
			break;
		}
		left = candidate;
	}
	const padding = center
		? " ".repeat(Math.max(0, centerColumn - visibleWidth(left))) + center
			+ " ".repeat(Math.max(0, width - centerColumn - centerWidth - visibleWidth(fittedRight)))
		: " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(fittedRight)));
	return { left, right: fittedRight, padding };
}

function formatCwd(cwd: string): string {
	const home = os.homedir();
	const relative = path.relative(path.resolve(home), path.resolve(cwd));
	const isInsideHome = isWithinDirectory(path.resolve(home), path.resolve(cwd));
	if (!isInsideHome) return cwd;
	return relative === "" ? "~" : `~${path.sep}${relative}`;
}

interface TurnWindow {
	firstDeltaAt?: number;
	lastDeltaAt?: number;
}

export default function (pi: ExtensionAPI) {
	let latestSpeed: number | undefined;
	let currentTurn: TurnWindow = {};
	let stopSettings: (() => void) | undefined;
	let requestRender: (() => void) | undefined;
	let cachedLeafId: string | null | undefined;
	let cachedStats: SessionStats | undefined;
	let cachedContextTokens: number | undefined;
	const resetStats = () => { cachedLeafId = undefined; cachedStats = undefined; cachedContextTokens = undefined; };
	let currency: Currency = CURRENCIES[0];

	pi.registerCommand("currency", {
		description: "Switch session cost currency (usd/cny)",
		handler: async (args, ctx) => {
			const code = args.trim().toLowerCase();
			if (!code) {
				const nextIndex = (CURRENCIES.findIndex((entry) => entry === currency) + 1) % CURRENCIES.length;
				currency = CURRENCIES[nextIndex];
			} else {
				const match = CURRENCIES.find((entry) => entry.code === code);
				if (!match) {
					ctx.ui.notify(`Unknown currency "${code}". Available: ${CURRENCIES.map((entry) => entry.code).join(", ")}.`, "error");
					return;
				}
				currency = match;
			}
			requestRender?.();
		},
	});

	pi.on("session_tree", () => {
		resetStats();
		latestSpeed = undefined;
		currentTurn = {};
		requestRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		stopSettings?.();
		if (ctx.mode !== "tui") return;

		latestSpeed = undefined;
		currentTurn = {};
		resetStats();

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribeBranch = footerData.onBranchChange(() => {
				resetStats();
				latestSpeed = undefined;
				currentTurn = {};
				tui.requestRender();
			});
			requestRender = () => tui.requestRender();
			let isAutoCompactEnabled: boolean | undefined;
			const stop = watchCompactionSetting(ctx, (enabled) => {
				if (isAutoCompactEnabled === enabled) return;
				isAutoCompactEnabled = enabled;
				tui.requestRender();
			});
			stopSettings = stop;

			const dim = (text: string) => theme.fg("dim", text);

			return {
				dispose() {
					stop();
					unsubscribeBranch();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const leafId = ctx.sessionManager.getLeafId();
					if (!cachedStats || cachedLeafId !== leafId) {
						cachedStats = collectStats(ctx.sessionManager.getBranch());
						cachedContextTokens = undefined;
						cachedLeafId = leafId;
					}
					const stats = cachedStats;
					const usage = ctx.getContextUsage();
					const model = ctx.model;

					const parts: string[] = [];
					const isEstimated = usage?.tokens === null;
					if (isEstimated && cachedContextTokens === undefined) {
						cachedContextTokens = ctx.sessionManager.buildSessionProjection().messages.reduce(
							(total, message) => total + (message.role === "system" ? 0 : estimateTokens(message)), 0,
						);
					}
					const usedTokens = usage?.tokens ?? (isEstimated ? cachedContextTokens : undefined);
					const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
					const percent = usage?.percent ?? (isEstimated && usedTokens != null && contextWindow > 0
						? usedTokens / contextWindow * 100 : undefined);
					const tokensText = usedTokens == null ? "?" : `${isEstimated ? "~" : ""}${formatTokens(usedTokens)}`;
					const auto = isAutoCompactEnabled ? " (auto)" : "";
					const percentText =
						percent == null
							? `ctx${tokensText}/${formatTokens(contextWindow)}${auto}`
							: `ctx${tokensText}/${formatTokens(contextWindow)} ${percent.toFixed(1)}%${auto}`;
					if (percent != null && percent > 90) parts.push(theme.fg("error", percentText));
					else if (percent != null && percent > 70) parts.push(theme.fg("warning", percentText));
					else parts.push(dim(percentText));

					if (stats.cacheHitRate !== undefined) parts.push(dim(`cache ${stats.cacheHitRate.toFixed(1)}%`));
					const speed = latestSpeed ?? stats.speed;
					if (speed !== undefined) parts.push(dim(`${speed.toFixed(1)}tok/s`));
					if (stats.cost > 0) parts.push(dim(`${currency.symbol}${(stats.cost * currency.rate()).toFixed(3)}`));

					const modelName = model?.id ?? "no-model";
					let rightSide = modelName;
					if (model?.reasoning) {
						const level = ctx.thinkingLevel ?? "off";
						rightSide = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && model) {
						const withProvider = `(${model.provider}) ${rightSide}`;
						if (visibleWidth(parts.join(" ")) + MIN_PADDING + visibleWidth(withProvider) <= width) {
							rightSide = withProvider;
						}
					}

					const statuses = footerData.getExtensionStatuses();
					const center = statuses.has(JAILBREAK_STATUS) && width > 0 ? theme.fg("accent", "J") : "";
					const layout = fitFooterStats(parts, rightSide, width, center);
					const statsLine = layout.left + layout.padding + dim(layout.right);

					let pwd = formatCwd(ctx.sessionManager.getCwd());
					const branch = footerData.getGitBranch();
					if (branch) pwd += ` (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd += ` • ${sessionName}`;

					const lines = [truncateToWidth(dim(pwd), width, dim("...")), statsLine];

					if (statuses.size > 0) {
						const statusLine = Array.from(statuses.entries())
							.filter(([key]) => key !== JAILBREAK_STATUS)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => text.replace(/[\r\n]+/g, " ").trim())
							.filter(Boolean)
							.join(" ");
						if (statusLine) lines.push(truncateToWidth(statusLine, width, dim("...")));
					}

					return lines;
				},
			};
		});
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") currentTurn = {};
	});

	pi.on("message_update", (event) => {
		if (!event.assistantMessageEvent.type.endsWith("_delta")) return;
		const now = Date.now();
		currentTurn.firstDeltaAt ??= now;
		currentTurn.lastDeltaAt = now;
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") {
			resetStats();
			const duration = (currentTurn.lastDeltaAt ?? 0) - (currentTurn.firstDeltaAt ?? 0);
			latestSpeed = duration >= MIN_GENERATION_MS
				? (event.message as AssistantMessage).usage.output / (duration / 1000)
				: undefined;
		}
		currentTurn = {};
		requestRender?.();
	});

	pi.on("session_compact", () => { resetStats(); requestRender?.(); });
	pi.on("session_shutdown", () => { stopSettings?.(); stopSettings = undefined; });
}
