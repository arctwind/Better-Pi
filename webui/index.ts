import { generateDiffString, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWriteTracker } from "./changes.mjs";
import { autoSessionTitle } from "./title.mjs";
import { errorMessage } from "../lib/errors.js";
import { syncLauncher } from "./launcher.js";

export default function webui(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await syncLauncher(getAgentDir());
    } catch (error) {
      const message = `Could not update the Pi launcher: ${errorMessage(error)}`;
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else console.error(message);
    }
  });
  if (process.env.PI_WEBUI !== "1") return;
  const writes = createWriteTracker(generateDiffString);
  pi.on("tool_call", (event, ctx) => writes.capture(event, ctx.cwd));
  pi.on("tool_result", (event) => writes.finish(event));
  pi.on("session_switch", () => writes.clear());
  pi.on("input", (event) => {
    if (event.source === "extension" || pi.getSessionName()?.trim()) return;
    const title = autoSessionTitle(event.text);
    if (title) pi.setSessionName(title);
  });
  pi.registerCommand("webui-reload", {
    description: "Reload Pi resources",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}
