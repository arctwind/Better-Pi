import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { rethrowAfterCleanup } from "../lib/errors.js";

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const PORT_POLL_INTERVAL_MS = 50;
const MAX_ERROR_CHARS = 2000;
const PROFILE_PREFIX = "browser-";
const OWNER_FILE = "better-pi-owner.json";
const BROWSER_PROCESS = fileURLToPath(new URL("./browser-process.ps1", import.meta.url));

function findBrowser(): string {
	const locations = [
		[process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"],
		[process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"],
		[process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"],
		[process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"],
		[process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft/Edge/Application/msedge.exe"],
	];
	for (const [root, relative] of locations) if (root && relative && existsSync(join(root, relative))) return join(root, relative);
	throw new Error("Chrome or Edge was not found in its standard Windows installation locations.");
}

export class BrowserProcess {
	private readonly cacheRoot: string;
	private profile?: string;
	private child?: ChildProcess;
	private closing?: Promise<void>;

	constructor(cacheRoot: string) {
		this.cacheRoot = resolve(cacheRoot);
	}

	private async removeProfile(directory: string): Promise<void> {
		if (dirname(resolve(directory)) !== this.cacheRoot) throw new Error("Invalid browser cleanup directory.");
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}

	private async clearAbandonedProfiles(): Promise<void> {
		for (const entry of await readdir(this.cacheRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith(PROFILE_PREFIX)) continue;
			const directory = join(this.cacheRoot, entry.name);
			let owner: { pid?: unknown };
			try { owner = JSON.parse(await readFile(join(directory, OWNER_FILE), "utf8")); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (!Number.isSafeInteger(owner?.pid) || Number(owner.pid) <= 0) throw new Error(`Invalid browser owner: ${directory}`);
			try { process.kill(Number(owner.pid), 0); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				await this.removeProfile(directory);
			}
		}
	}

	async start(signal?: AbortSignal, onExit?: () => void): Promise<string> {
		signal?.throwIfAborted();
		await this.close();
		const browser = findBrowser();
		await mkdir(this.cacheRoot, { recursive: true });
		await this.clearAbandonedProfiles();
		this.profile = await mkdtemp(join(this.cacheRoot, PROFILE_PREFIX));
		const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", BROWSER_PROCESS], {
			windowsHide: true, stdio: ["pipe", "ignore", "pipe"],
			env: { ...process.env, PI_BROWSER_EXECUTABLE: browser, PI_BROWSER_PROFILE: this.profile },
		});
		this.child = child;
		let output = "";
		let failure: Error | undefined;
		child.stderr?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-MAX_ERROR_CHARS); });
		child.on("error", (error) => { failure = error; });
		child.on("exit", () => { failure ??= new Error(`Browser exited. ${output.trim()}`.trim()); onExit?.(); });
		const startup = AbortSignal.any([AbortSignal.timeout(STARTUP_TIMEOUT_MS), ...(signal ? [signal] : [])]);
		try {
			if (child.pid) await writeFile(join(this.profile, OWNER_FILE), JSON.stringify({ pid: child.pid }), { flag: "wx" });
			while (true) {
				startup.throwIfAborted();
				if (failure) throw failure;
				try {
					const [port, path] = (await readFile(join(this.profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
					if (port && path) return `ws://127.0.0.1:${port}${path}`;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "ENOENT" && code !== "EBUSY") throw error;
				}
				await delay(PORT_POLL_INTERVAL_MS, undefined, { signal: startup });
			}
		} catch (error) {
			return rethrowAfterCleanup(error, () => this.close());
		}
	}

	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closing = this.dispose();
		try { await this.closing; }
		finally { this.closing = undefined; }
	}

	private async dispose(): Promise<void> {
		const child = this.child;
		if (child?.pid && child.exitCode === null && child.signalCode === null) {
			await new Promise<void>((resolveExit, rejectExit) => {
				let deadline: ReturnType<typeof setTimeout> | undefined;
				const cleanup = () => { clearTimeout(timer); clearTimeout(deadline); child.removeListener("exit", onExit); };
				const onExit = () => { cleanup(); resolveExit(); };
				const timer = setTimeout(() => {
					deadline = setTimeout(() => { cleanup(); rejectExit(new Error("Browser process did not exit.")); }, SHUTDOWN_TIMEOUT_MS);
					execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: SHUTDOWN_TIMEOUT_MS }, (error) => {
						if (error && child.exitCode === null && child.signalCode === null) { cleanup(); rejectExit(error); }
					});
				}, SHUTDOWN_TIMEOUT_MS);
				child.once("exit", onExit);
				child.stdin?.end();
			});
		}
		this.child = undefined;
		if (this.profile) {
			await this.removeProfile(this.profile);
			this.profile = undefined;
		}
	}
}
