import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const COMMAND_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXTENSION_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));

export class RpcConnection extends EventEmitter {
  #child;
  #pending = new Map();
  #buffer = "";
  #isClosed = false;
  #isStopping = false;
  #closePromise;

  constructor(cliPath, args, options = {}) {
    super();
    this.#child = spawn(process.execPath, [cliPath, "--mode", "rpc", "-e", EXTENSION_PATH, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env, PI_WEBUI: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#read(chunk));
    this.#child.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString()));
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.on("error", (error) => this.#fail(error));
    this.#child.on("exit", (code, signal) => {
      this.#fail(new Error(`Pi exited (${signal ?? code})`));
      this.emit("exit", { code, signal, isStopping: this.#isStopping });
    });
  }

  #read(chunk) {
    this.#buffer += chunk;
    let end;
    while ((end = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, end).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(end + 1);
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { this.emit("diagnostic", "Pi returned invalid RPC data\n"); continue; }
      if (record.type === "response") {
        const pending = this.#pending.get(record.id);
        if (!pending) continue;
        this.#pending.delete(record.id);
        clearTimeout(pending.timeout);
        if (record.success) pending.resolve(record.data);
        else pending.reject(new Error(record.error || "Pi operation failed"));
      } else {
        this.emit("event", record);
      }
    }
  }

  #fail(error) {
    this.#isClosed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #write(record, onError) {
    if (this.#isClosed || this.#isStopping) throw new Error("Pi connection is closed");
    this.#child.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
      if (error) onError?.(error);
    });
  }

  request(type, fields = {}) {
    if (this.#isClosed || this.#isStopping) return Promise.reject(new Error("Pi connection is closed"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error(`Pi operation timed out: ${type}. Refresh to check the actual state, then try again.`)), COMMAND_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timeout });
      try { this.#write({ ...fields, type, id }, fail); }
      catch (error) { fail(error); }
    });
  }

  respond(fields) {
    this.#write({ ...fields, type: "extension_ui_response" });
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#isStopping = true;
    this.#closePromise = new Promise((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) return resolve();
      const timeout = setTimeout(() => this.#child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
      this.#child.once("exit", () => { clearTimeout(timeout); resolve(); });
      this.#child.stdin.end();
    });
    return this.#closePromise;
  }
}
