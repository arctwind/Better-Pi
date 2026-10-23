// Better Pi launcher
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageName = "@earendil-works/pi-coding-agent";
const commandName = "pi";
function resolveManagedPiCliPath(installRoot) {
	const currentFile = path.join(installRoot, "current-version");
	let currentVersion;
	try {
		currentVersion = fs.readFileSync(currentFile, "utf8").trim();
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	if (!currentVersion || currentVersion === "." || currentVersion === ".." || !/^[0-9A-Za-z._+-]+$/.test(currentVersion)) {
		throw new Error(`Managed Pi version file is invalid: ${currentFile}`);
	}

	const releaseDir = path.join(installRoot, "releases", currentVersion);
	const packageDir = path.join(releaseDir, "node_modules", ...packageName.split("/"));
	const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
	if (packageJson.name !== packageName) throw new Error(`Managed Pi package is invalid: ${packageDir}`);
	const binPath = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.[commandName];
	if (typeof binPath !== "string" || !binPath) {
		throw new Error(`${packageName} does not declare a ${commandName} bin`);
	}
	const cliPath = path.resolve(packageDir, binPath);
	const cliRelative = path.relative(packageDir, cliPath);
	if (cliRelative.startsWith("..") || path.isAbsolute(cliRelative) || !fs.statSync(cliPath).isFile()) {
		throw new Error(`Managed Pi executable is invalid: ${cliPath}`);
	}
	return cliPath;
}

module.exports = { resolveManagedPiCliPath };

if (require.main === module) {
	const agentDir = path.dirname(__dirname);
	const installRoot = path.join(agentDir, "install");
	const cliPath = resolveManagedPiCliPath(installRoot);
	if (!cliPath) throw new Error(`Managed Pi version file is missing: ${path.join(installRoot, "current-version")}`);
	const args = process.argv.slice(2);
	const isWebUI = args.includes("--webui");
	const entryPath = isWebUI ? path.join(agentDir, "extensions", "Better Pi", "webui", "start.mjs") : cliPath;
	const entryArgs = isWebUI ? [cliPath, ...args.filter((arg) => arg !== "--webui")] : args;
	const result = spawnSync(process.execPath, [entryPath, ...entryArgs], {
		stdio: "inherit",
		env: { ...process.env, PI_MANAGED_INSTALL_ROOT: installRoot },
	});
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
}
