import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

export function createWriteTracker(generateDiff) {
  const originals = new Map();
  return {
    async capture(event, cwd) {
      if (event.toolName !== "write" || typeof event.input.path !== "string") return;
      const path = event.input.path.replace(/^@/, "").replace(/^~(?=[/\\]|$)/, homedir());
      try {
        const target = resolve(cwd, path);
        if ((await stat(target)).size > MAX_PREVIEW_BYTES) return;
        originals.set(event.toolCallId, { content: await readFile(target, "utf8"), isNewFile: false });
      } catch (error) {
        if (error.code === "ENOENT") originals.set(event.toolCallId, { content: "", isNewFile: true });
      }
    },
    finish(event) {
      const original = originals.get(event.toolCallId);
      originals.delete(event.toolCallId);
      if (event.toolName !== "write" || event.isError || original === undefined || typeof event.input.content !== "string") return;
      const normalize = (text) => text.replace(/\r\n/g, "\n");
      return { details: { ...event.details, ...generateDiff(normalize(original.content), normalize(event.input.content)), isNewFile: original.isNewFile } };
    },
    clear() { originals.clear(); },
  };
}
