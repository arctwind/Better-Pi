import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { syncLauncher } from "../webui/launcher.ts";

const directory = fileURLToPath(new URL("./", import.meta.url));
const source = new URL("../webui/pi-launcher.cjs", import.meta.url);
let root;

before(async () => {
	root = await mkdtemp(join(directory, ".tmp-launcher-"));
});

after(async () => {
	assert.equal(dirname(root), directory.replace(/[\\/]$/, ""));
	await rm(root, { recursive: true, force: true });
});

async function createManagedInstall(agent, version = "1.0.0") {
	const install = join(agent, "install");
	const pkg = join(install, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	await mkdir(pkg, { recursive: true });
	await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "cli.cjs" } }));
	await writeFile(join(pkg, "cli.cjs"), `console.log(JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2), install: process.env.PI_MANAGED_INSTALL_ROOT }));`);
	await writeFile(join(install, "current-version"), version);
	return pkg;
}

test("managed installations create and update owned launchers without rewriting identical content", async () => {
	await createManagedInstall(root);
	const target = join(root, "bin", "pi-launcher.js");
	const expected = await readFile(source, "utf8");
	await syncLauncher(root);
	assert.equal(await readFile(target, "utf8"), expected);
	await writeFile(target, "// Better Pi launcher\n// outdated launcher\n");
	await syncLauncher(root);
	assert.equal(await readFile(target, "utf8"), expected);
	await utimes(target, new Date("2000-01-01"), new Date("2000-01-01"));
	const modified = (await stat(target)).mtimeMs;
	await syncLauncher(root);
	assert.equal((await stat(target)).mtimeMs, modified);
	assert.deepEqual(await readdir(join(root, "bin")), ["pi-launcher.js"]);
});

test("other installation layouts leave existing launchers and missing directories untouched", async () => {
	const agent = join(root, "unmanaged");
	await syncLauncher(agent);
	await assert.rejects(stat(agent), { code: "ENOENT" });
	await mkdir(join(agent, "bin"), { recursive: true });
	const target = join(agent, "bin", "pi-launcher.js");
	await writeFile(target, "custom launcher");
	await syncLauncher(agent);
	assert.equal(await readFile(target, "utf8"), "custom launcher");
	assert.deepEqual(await readdir(agent), ["bin"]);
});

test("managed installations preserve unknown launchers and report the conflict", async () => {
	const agent = join(root, "custom");
	await createManagedInstall(agent);
	await mkdir(join(agent, "bin"));
	const target = join(agent, "bin", "pi-launcher.js");
	await writeFile(target, "custom launcher");
	await assert.rejects(syncLauncher(agent), /not managed by Better Pi; left unchanged/);
	assert.equal(await readFile(target, "utf8"), "custom launcher");
	assert.deepEqual(await readdir(join(agent, "bin")), ["pi-launcher.js"]);
});

test("the known legacy launcher upgrades with either line ending but local edits are preserved", async () => {
	const agent = join(root, "legacy");
	await createManagedInstall(agent);
	await mkdir(join(agent, "bin"));
	const target = join(agent, "bin", "pi-launcher.js");
	const legacy = (await readFile(new URL("./fixtures/pi-launcher-legacy.cjs", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
	for (const content of [legacy, legacy.replace(/\n/g, "\r\n")]) {
		await writeFile(target, content);
		await syncLauncher(agent);
		assert.equal(await readFile(target, "utf8"), await readFile(source, "utf8"));
	}
	const edited = `${legacy}\n// local customization\n`;
	await writeFile(target, edited);
	await assert.rejects(syncLauncher(agent), /not managed by Better Pi/);
	assert.equal(await readFile(target, "utf8"), edited);
});

test("invalid managed installations fail before creating or replacing a launcher", async (t) => {
	for (const variant of ["version", "package", "bin", "missing-cli", "missing-package"]) {
		await t.test(variant, async () => {
			const agent = join(root, `invalid-${variant}`);
			const pkg = await createManagedInstall(agent);
			if (variant === "version") await writeFile(join(agent, "install", "current-version"), "../outside");
			if (variant === "package") await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "other-package", bin: "cli.cjs" }));
			if (variant === "bin") await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: "../outside.cjs" }));
			if (variant === "missing-cli") await rm(join(pkg, "cli.cjs"));
			if (variant === "missing-package") await rm(join(pkg, "package.json"));
			await assert.rejects(syncLauncher(agent));
			await assert.rejects(stat(join(agent, "bin")), { code: "ENOENT" });
			await mkdir(join(agent, "bin"));
			const target = join(agent, "bin", "pi-launcher.js");
			const current = "// Better Pi launcher\n// installed version\n";
			await writeFile(target, current);
			await assert.rejects(syncLauncher(agent));
			assert.equal(await readFile(target, "utf8"), current);
			assert.deepEqual(await readdir(join(agent, "bin")), ["pi-launcher.js"]);
		});
	}
});

test("launcher filesystem errors are propagated without replacing the target", async () => {
	const agent = join(root, "blocked");
	await createManagedInstall(agent);
	await mkdir(join(agent, "bin", "pi-launcher.js"), { recursive: true });
	await assert.rejects(syncLauncher(agent));
	assert.ok((await stat(join(agent, "bin", "pi-launcher.js"))).isDirectory());
	assert.deepEqual(await readdir(join(agent, "bin")), ["pi-launcher.js"]);
});

test("installed launcher follows the selected Pi version and routes WebUI arguments", async () => {
	const agent = join(root, "managed install");
	await createManagedInstall(agent);
	await createManagedInstall(agent, "2.0.0");
	await syncLauncher(agent);
	await writeFile(join(agent, "package.json"), JSON.stringify({ type: "commonjs" }));
	const install = join(agent, "install");
	const webui = join(agent, "extensions", "Better Pi", "webui");
	await mkdir(webui, { recursive: true });
	await writeFile(join(webui, "start.mjs"), "console.log(JSON.stringify({ args: process.argv.slice(2) }));");
	function run(args) {
		const result = spawnSync(process.execPath, [join(agent, "bin", "pi-launcher.js"), ...args], { encoding: "utf8", timeout: 10_000, windowsHide: true });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	}
	for (const version of ["1.0.0", "2.0.0"]) {
		await writeFile(join(install, "current-version"), version);
		assert.deepEqual(run(["--version"]), { version, args: ["--version"], install });
	}
	const routed = run(["--webui", "--session", "path with spaces"]);
	assert.equal(routed.args[0], join(install, "releases", "2.0.0", "node_modules", "@earendil-works", "pi-coding-agent", "cli.cjs"));
	assert.deepEqual(routed.args.slice(1), ["--session", "path with spaces"]);
});
