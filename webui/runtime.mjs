import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

const RUNTIME_TIMEOUT_MS = 90_000;

class RuntimeWorker extends EventEmitter {
  #worker;
  #rpc;
  #pending = new Map();
  #nextId = 0;
  #isClosed = false;
  #onEvent;
  #onExit;

  constructor(rpc, cwd, options) {
    super();
    this.#rpc = rpc;
    this.#worker = new Worker(options.workerURL ?? new URL("./worker.mjs", import.meta.url), {
      workerData: { cwd, sessionManagerPath: options.sessionManagerPath },
    });
    this.#onEvent = (event) => this.#worker.postMessage({ type: "event", event });
    this.#onExit = (event) => this.#worker.postMessage({ type: "exit", event });
    rpc.on("event", this.#onEvent);
    rpc.on("exit", this.#onExit);
    this.#worker.on("message", (message) => void this.#receive(message));
    this.#worker.on("error", (error) => this.#fail(error));
    this.#worker.on("exit", (code) => {
      if (!this.#isClosed) this.#fail(new Error(`WebUI worker exited (${code}). Reload and try again.`));
    });
  }

  async #receive(message) {
    if (message.type === "rpc_request") {
      let result;
      try { result = { value: await this.#rpc.request(message.method, message.input) }; }
      catch (error) { result = { error: error.message }; }
      if (!this.#isClosed) this.#worker.postMessage({ type: "rpc_result", id: message.id, ...result });
    } else if (message.type === "rpc_respond") {
      try { this.#rpc.respond(message.input); }
      catch (error) { this.emit("update", { event: { type: "connection_error", error: error.message } }); }
    } else if (message.type === "update") {
      this.emit("update", message.update);
    } else if (message.type === "result") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    }
  }

  #fail(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.emit("update", { event: { type: "connection_error", error: error.message } });
    void this.close();
  }

  call(method, ...args) {
    if (this.#isClosed) return Promise.reject(new Error("WebUI worker connection is closed"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("WebUI operation timed out"));
      }, RUNTIME_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timeout });
      this.#worker.postMessage({ type: "call", id, method, args });
    });
  }

  async close() {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#rpc.off("event", this.#onEvent);
    this.#rpc.off("exit", this.#onExit);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("WebUI worker connection is closed"));
    }
    this.#pending.clear();
    await this.#worker.terminate();
  }
}

export class WebRuntime extends EventEmitter {
  #rpc;
  #options;
  #active;
  #workers = new Set();
  #revision = 0;
  #generation = 0;
  #isReloading = false;
  #isClosed = false;

  constructor(rpc, cwd, options = {}) {
    super();
    this.#rpc = rpc;
    this.cwd = cwd;
    this.#options = options;
  }

  async #createWorker() {
    if (this.#isClosed) throw new Error("WebUI is closed");
    const worker = new RuntimeWorker(this.#rpc, this.cwd, this.#options);
    this.#workers.add(worker);
    worker.on("update", (update) => {
      if (worker === this.#active) this.#publish(update.event);
    });
    try {
      await worker.call("refresh");
      if (this.#isClosed) throw new Error("WebUI is closed");
      return worker;
    } catch (error) {
      this.#workers.delete(worker);
      await worker.close();
      throw error;
    }
  }

  #publish(event) {
    const revision = ++this.#revision;
    if (event.type === "snapshot") event.snapshot = { ...event.snapshot, revision, runtimeId: this.#generation };
    this.emit("update", { revision, event });
  }

  async start() {
    this.#active = await this.#createWorker();
    return this;
  }

  async snapshot() {
    const worker = this.#active;
    const snapshot = await worker.call("snapshot");
    if (worker !== this.#active) return this.snapshot();
    return { ...snapshot, revision: this.#revision, runtimeId: this.#generation };
  }

  listSessions() { return this.#active.call("listSessions"); }
  listFiles(query) { return this.#active.call("listFiles", query); }
  openLocalPath(path, options) { return this.#active.call("openLocalPath", path, options); }

  async execute(input) {
    if (this.#isReloading) throw new Error("Reloading. Try again in a moment.");
    if (input?.type !== "reload") return this.#active.call("execute", input);
    this.#isReloading = true;
    let next;
    try {
      next = await this.#createWorker();
      await this.#active.call("execute", input);
      await next.call("refresh");
      const snapshot = await next.call("snapshot");
      const previous = this.#active;
      this.#active = next;
      this.#generation++;
      this.#workers.delete(previous);
      await previous.close();
      this.#publish({ type: "snapshot", snapshot });
    } catch (error) {
      if (next && next !== this.#active) {
        this.#workers.delete(next);
        await next.close();
      }
      throw error;
    } finally { this.#isReloading = false; }
  }

  async close() {
    this.#isClosed = true;
    await Promise.all([...this.#workers].map((worker) => worker.close()));
    this.#workers.clear();
  }
}
