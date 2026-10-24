import { ToolExecutionComponent, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";

const DISPLAY_STATE = Symbol.for("better-pi.compact-tools");

interface ToolDisplay {
	showImages: boolean;
	toolDefinition?: Pick<ToolDefinition, "renderResult">;
	updateDisplay(): void;
}

interface DisplayState {
	updateDisplay: ToolDisplay["updateDisplay"];
	hiddenResults: WeakSet<object>;
	isInstalled: boolean;
}

function hideResult() {
	return new Text("", 0, 0);
}

function hideResultImages(pi: ExtensionAPI): void {
	const prototype = ToolExecutionComponent.prototype as unknown as ToolDisplay & { [DISPLAY_STATE]?: DisplayState };
	if (typeof prototype.updateDisplay !== "function") throw new Error("Better Pi requires ToolExecutionComponent.updateDisplay.");
	const state = prototype[DISPLAY_STATE] ??= {
		updateDisplay: prototype.updateDisplay,
		hiddenResults: new WeakSet(),
		isInstalled: false,
	};
	state.hiddenResults.add(hideResult);
	if (state.isInstalled) return;
	if (typeof state.updateDisplay !== "function") throw new Error("Better Pi requires ToolExecutionComponent.updateDisplay.");
	const updateDisplay = function (this: ToolDisplay) {
		const showImages = this.showImages;
		if (this.toolDefinition?.renderResult && state.hiddenResults.has(this.toolDefinition.renderResult)) this.showImages = false;
		try {
			state.updateDisplay.call(this);
		} finally {
			this.showImages = showImages;
		}
	};
	prototype.updateDisplay = updateDisplay;
	state.isInstalled = true;
	pi.on("session_shutdown", ({ reason }) => {
		if (reason !== "reload" && reason !== "quit") return;
		if (prototype.updateDisplay === updateDisplay) prototype.updateDisplay = state.updateDisplay;
		state.isInstalled = false;
	});
}

export function registerCompactTool(pi: ExtensionAPI, tool: ToolDefinition, summary?: (args: Record<string, unknown>) => string): void {
	hideResultImages(pi);
	pi.registerTool({
		...tool,
		renderShell: "default",
		renderCall(args, theme, context) {
			let text = theme.fg(context.isError ? "error" : "toolTitle", theme.bold(tool.name));
			const description = summary?.(args);
			if (description) text += ` ${theme.fg("accent", stripTerminalSequences(description).replace(/[\r\n\t]/g, " "))}`;
			return new Text(text, 0, 0);
		},
		renderResult: hideResult,
	});
}
