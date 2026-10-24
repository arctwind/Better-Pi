import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PLUGINS = [
  { path: "compact/index.ts", name: "Compact output", description: "Compact file and shell tool output." },
  { path: "deepseek-files.ts", name: "DeepSeek images", description: "Upload image attachments for DeepSeek." },
  { path: "explore.ts", name: "Explore", description: "Read-only code investigation." },
  { path: "compaction-thinking.ts", name: "Compaction thinking", description: "Exclude past thinking from compaction summaries." },
  { path: "footer/index.ts", name: "Footer", description: "Context, cache, speed, and cost statistics." },
  { path: "image-paste/index.ts", name: "Image attachments", description: "Paste images and manage attachment references in Pi." },
  { path: "review.ts", name: "Review", description: "Code reviews with /review." },
  { path: "browser/index.ts", name: "Browser", description: "Browser controls and screenshots." },
  { path: "skip-version-check.ts", name: "Skip version checks", description: "Skip Pi's startup version checks." },
  { path: "system-prompt/index.ts", name: "system-prompt", description: "Replace Pi's system, style, and commit prompts; provide /jailbreak." },
  { path: "web.ts", name: "Web search", description: "Web search and page fetching through DeepSeek." },
  { path: "webui/index.ts", name: "WebUI integration", description: "Track file changes and automatically name WebUI sessions." },
  { path: "wheel-invert.ts", name: "Mouse wheel", description: "Adjust scrolling speed and Alt + wheel behavior." },
];

const SETTINGS_FILE = "better-pi.json";
const PLUGIN_PATHS = new Set(PLUGINS.map(({ path }) => path));

function validateSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "disabled") || !Array.isArray(value.disabled) ||
      value.disabled.some((path) => typeof path !== "string" || !PLUGIN_PATHS.has(path)) ||
      new Set(value.disabled).size !== value.disabled.length) {
    throw new Error("Invalid Better Pi settings: expected a disabled array of known plugin paths.");
  }
  return { disabled: [...value.disabled] };
}

export async function readPluginSettings(agentDir) {
  const target = join(agentDir, SETTINGS_FILE);
  let content;
  try { content = await readFile(target, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return { disabled: [] };
    throw error;
  }
  try { return validateSettings(JSON.parse(content)); }
  catch (error) { throw new Error(`Cannot read ${target}: ${error.message}`, { cause: error }); }
}

export async function savePluginSettings(agentDir, value) {
  const settings = validateSettings(value);
  await mkdir(agentDir, { recursive: true });
  const target = join(agentDir, SETTINGS_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    try { await rm(temporary, { force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `${error.message}; cleanup failed: ${cleanupError.message}`); }
    throw error;
  }
}
