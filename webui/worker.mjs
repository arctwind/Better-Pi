import { EventEmitter } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { WebSession } from "./session.mjs";

const pending = new Map();
let nextId = 0;
const rpc = new EventEmitter();
rpc.request = (method, input) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  parentPort.postMessage({ type: "rpc_request", id, method, input });
});
rpc.respond = (input) => parentPort.postMessage({ type: "rpc_respond", input });

const { SessionManager } = workerData.sessionManagerPath ? await import(pathToFileURL(workerData.sessionManagerPath).href) : {};
const session = new WebSession(rpc, workerData.cwd, { SessionManager });
session.on("update", (update) => parentPort.postMessage({ type: "update", update }));
const methods = new Set(["snapshot", "refresh", "execute", "listSessions", "listFiles", "openLocalPath"]);

parentPort.on("message", async (message) => {
  if (message.type === "rpc_result") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  } else if (message.type === "event" || message.type === "exit") {
    rpc.emit(message.type, message.event);
  } else if (message.type === "call") {
    try {
      if (!methods.has(message.method)) throw new Error("Unsupported operation");
      const value = await session[message.method](...message.args);
      parentPort.postMessage({ type: "result", id: message.id, value });
    } catch (error) {
      parentPort.postMessage({ type: "result", id: message.id, error: error.message });
    }
  }
});
