import { createBashToolDefinition, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";

export default function compactBash(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const settings = SettingsManager.create(cwd);
	const bash = createBashToolDefinition(cwd, {
		shellPath: settings.getShellPath(),
		commandPrefix: settings.getShellCommandPrefix(),
	});

	pi.registerTool({
		...bash,
		renderShell: "default",
		renderCall(args, theme, context) {
			const command = stripTerminalSequences(args.command ?? "").replace(/[\r\n\t]/g, " ").trim();
			const color = context.isError ? "error" : "toolTitle";
			return {
				invalidate() {},
				render(width) {
					if (width <= 0) return [];
					const preview = stripTerminalSequences(truncateToWidth(`$ ${command}`, width, "…"));
					return [theme.fg(color, preview)];
				},
			};
		},
		renderResult() {
			return new Text("", 0, 0);
		},
	});
}
