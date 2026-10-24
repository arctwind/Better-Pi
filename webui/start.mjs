import path from "node:path";
import { pathToFileURL } from "node:url";
import { RpcConnection } from "./rpc.mjs";
import { WebRuntime } from "./runtime.mjs";
import { startServer } from "./server.mjs";

const [cliPath, ...args] = process.argv.slice(2);
if (!cliPath || args.some((arg) => ["--mode", "--print", "-p"].includes(arg) || arg.startsWith("--mode="))) {
  throw new Error("--webui cannot be combined with --mode or --print");
}
const packageDir = path.resolve(path.dirname(cliPath), "../..");
const { getAgentDir } = await import(pathToFileURL(path.join(packageDir, "dist/config.js")).href);
const rpc = new RpcConnection(cliPath, args);
let session;
let server;
let isStopping = false;
async function shutdown(code = 0) {
  if (isStopping) return;
  isStopping = true;
  await Promise.allSettled([server?.close(), session?.close(), rpc.close()]);
  process.exit(code);
}
rpc.on("diagnostic", (text) => process.stderr.write(text));
rpc.on("exit", ({ code, isStopping: isExpected }) => { if (!isExpected) void shutdown(code || 1); });
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
if (process.platform !== "win32") process.on("SIGHUP", () => void shutdown());
try {
  session = new WebRuntime(rpc, process.cwd(), { sessionManagerPath: path.join(packageDir, "dist/core/session-manager.js") });
  await session.start();
  server = await startServer(session, { markedPath: path.join(packageDir, "dist/core/export-html/vendor/marked.min.js"), agentDir: getAgentDir() });
  console.log(`\nPi · ${process.cwd()}\n${server.url}\n\nPress Ctrl+C to stop this instance.\n`);
} catch (error) {
  console.error(error.message);
  await shutdown(1);
}
