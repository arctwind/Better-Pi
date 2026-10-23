import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { rethrowAfterCleanup } from "../lib/errors.js";

const { resolveManagedPiCliPath }: { resolveManagedPiCliPath(installRoot: string): string | undefined } = createRequire(import.meta.url)("./pi-launcher.cjs");
const LAUNCHER_MARKER = "// Better Pi launcher";
const LEGACY_LAUNCHER_SHA256 = "c82defd8292be6c7c5c54d2cf8ce519333551cbaf72c04f21b0c301557732305";

export async function syncLauncher(agentDir: string): Promise<void> {
	if (!resolveManagedPiCliPath(join(agentDir, "install"))) return;
	const source = await readFile(new URL("./pi-launcher.cjs", import.meta.url), "utf8");
	const directory = join(agentDir, "bin");
	const target = join(directory, "pi-launcher.js");
	let current: string | undefined;
	try {
		current = await readFile(target, "utf8");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (current === source) return;
	if (current !== undefined && current.split(/\r?\n/, 1)[0] !== LAUNCHER_MARKER &&
		createHash("sha256").update(current.replace(/\r\n/g, "\n")).digest("hex") !== LEGACY_LAUNCHER_SHA256) {
		throw new Error(`Existing launcher is not managed by Better Pi; left unchanged: ${target}`);
	}
	await mkdir(directory, { recursive: true });
	const temporary = join(directory, `.pi-launcher-${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, source, { flag: "wx" });
		await rename(temporary, target);
	} catch (error) {
		await rethrowAfterCleanup(error, () => rm(temporary, { force: true }));
	}
}
