import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startServer } from "../webui/server.mjs";
import { errorMessage } from "../lib/errors.js";

export default function pluginManager(pi: ExtensionAPI): void {
	let server: ReturnType<typeof startServer> | undefined;
	pi.registerCommand("plugins", {
		description: "Open Better Pi plugin settings",
		handler: async (_args, ctx) => {
			try {
				server ??= startServer(undefined, { agentDir: getAgentDir() }).catch((error) => {
					server = undefined;
					throw error;
				});
				const { url } = await server;
				ctx.ui.notify(`Better Pi plugins: ${url}`, "info");
				const command = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "open" : "xdg-open";
				const args = process.platform === "win32"
					? ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `Start-Process -FilePath '${url}' -ErrorAction Stop`]
					: [url];
				const result = await pi.exec(command, args, { timeout: 10_000 });
				if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || "Could not open plugin settings in the browser.");
			} catch (error) {
				ctx.ui.notify(`Could not open plugin settings: ${errorMessage(error)}`, "error");
			}
		},
	});
	if (process.env.PI_WEBUI === "1") {
		pi.registerCommand("webui-reload", {
			description: "Reload Pi resources",
			handler: async (_args, ctx) => { await ctx.reload(); },
		});
	}
	pi.on("session_shutdown", async ({ reason }) => {
		if (reason !== "reload" && reason !== "quit") return;
		const running = server;
		server = undefined;
		if (running) await (await running).close();
	});
}
