import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const REFRESH_INTERVAL_MS = 2000;

async function readSettings(path: string): Promise<string | undefined> {
	try { return await readFile(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function watchCompactionSetting(ctx: ExtensionContext, update: (enabled: boolean | undefined) => void): () => void {
	let isDisposed = false;
	let isReading = false;
	let lastError: string | undefined;
	const refresh = async () => {
		if (isDisposed || isReading) return;
		isReading = true;
		try {
			const isProjectTrusted = ctx.isProjectTrusted();
			const [global, project] = await Promise.all([
				readSettings(join(getAgentDir(), "settings.json")),
				isProjectTrusted ? readSettings(join(ctx.cwd, ".pi", "settings.json")) : undefined,
			]);
			if (isDisposed) return;
			const settings = SettingsManager.fromStorage({ withLock(scope, read) { read(scope === "global" ? global : project); } }, { projectTrusted: isProjectTrusted });
			const errors = settings.drainErrors();
			if (errors.length) throw new AggregateError(errors.map((entry) => entry.error), errors.map((entry) => entry.error.message).join("; "));
			update(settings.getCompactionEnabled());
			lastError = undefined;
		} catch (error) {
			if (isDisposed) return;
			update(undefined);
			const message = error instanceof Error ? error.message : String(error);
			if (message !== lastError) ctx.ui.notify(`Cannot read compaction settings: ${message}`, "error");
			lastError = message;
		} finally {
			isReading = false;
		}
	};
	void refresh();
	const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
	timer.unref();
	return () => { isDisposed = true; clearInterval(timer); };
}
