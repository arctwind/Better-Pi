import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { applyMessageEvent, messageId } from "./public/view.js";
import { listFiles } from "./files.mjs";
import { openLocalPath } from "./open.mjs";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 8;
export const MAX_TEXT_LENGTH = 200_000;
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const SESSION_NAME_LENGTH = 120;
const SESSION_PREVIEW_LENGTH = 160;

function summarizeText(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function publicCommands(commands) {
  return (commands ?? []).filter(({ name }) => name !== "webui-reload")
    .map(({ name, description, source, argumentHint }) => ({ name, description, source, argumentHint }));
}

function publicStats(stats) {
  if (!stats) return undefined;
  return {
    tokens: stats.tokens, cost: stats.cost, contextUsage: stats.contextUsage,
    userMessages: stats.userMessages, assistantMessages: stats.assistantMessages,
    toolCalls: stats.toolCalls, toolResults: stats.toolResults, totalMessages: stats.totalMessages,
  };
}

export function validatePrompt(input) {
  if (typeof input.message !== "string" || input.message.length > MAX_TEXT_LENGTH) throw new Error("Message is invalid or too long");
  const images = input.images ?? [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error(`A message can include at most ${MAX_IMAGES} images`);
  for (const image of images) {
    if (!image || image.type !== "image" || !IMAGE_TYPES.has(image.mimeType) || typeof image.data !== "string" ||
      image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
      image.data.length === 0 || Buffer.byteLength(image.data, "base64") > MAX_IMAGE_BYTES) {
      throw new Error("Invalid image. Use PNG, JPEG, WebP, or GIF, up to 10 MB each.");
    }
  }
  if (!input.message.trim() && !images.length) throw new Error("Enter a message or paste an image");
  return { message: input.message, images };
}

export function activeMessages(entries, leafId) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = [];
  const seen = new Set();
  for (let id = leafId; id; id = byId.get(id)?.parentId) {
    if (seen.has(id)) throw new Error("Invalid session branch data");
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) break;
    if (entry.type === "message") branch.push({ ...entry.message, entryId: entry.id });
  }
  return branch.reverse();
}

export class WebSession extends EventEmitter {
  #rpc;
  #messages = [];
  #state = {};
  #models = [];
  #levels = [];
  #commands = [];
  #stats;
  #queue = { steering: [], followUp: [] };
  #dialogs = new Map();
  #tools = new Map();
  #dialogTimers = new Map();
  #revision = 0;
  #isMutating = false;
  #isStopping = false;
  #isOnline = true;
  #error;
  #refreshPromise;
  #SessionManager;

  constructor(rpc, cwd, { SessionManager } = {}) {
    super();
    this.#rpc = rpc;
    this.cwd = cwd;
    this.#SessionManager = SessionManager;
    rpc.on("event", (event) => this.#onEvent(event));
    rpc.on("exit", ({ isStopping }) => {
      this.#isOnline = false;
      if (!isStopping) this.#publish({ type: "connection_error", error: "Pi exited. Restart it in the terminal." });
    });
  }

  #publish(event) {
    this.#revision++;
    this.emit("update", { revision: this.#revision, event });
  }

  #resetSession() {
    this.#messages = [];
    this.#tools.clear();
    this.#queue = { steering: [], followUp: [] };
    this.#stats = undefined;
    for (const timer of this.#dialogTimers.values()) clearTimeout(timer);
    this.#dialogTimers.clear();
    this.#dialogs.clear();
    this.#error = undefined;
  }

  async listSessions() {
    if (!this.#SessionManager) return [];
    const sessionDir = this.#state.sessionFile ? dirname(this.#state.sessionFile) : undefined;
    const sessions = await this.#SessionManager.list(this.cwd, sessionDir);
    return sessions.map((session) => ({
      id: session.id,
      name: summarizeText(session.name, SESSION_NAME_LENGTH),
      firstMessage: session.firstMessage === "(no messages)" ? "" : summarizeText(session.firstMessage, SESSION_PREVIEW_LENGTH),
      modified: session.modified instanceof Date && !Number.isNaN(session.modified.getTime()) ? session.modified.toISOString() : undefined,
      messageCount: session.messageCount,
      isCurrent: session.id === this.#state.sessionId,
    }));
  }

  listFiles(query) { return listFiles(this.cwd, query); }
  openLocalPath(path, options) { return openLocalPath(path, this.cwd, options); }

  #onEvent(event) {
    applyMessageEvent(this.#messages, event);
    if (event.type.startsWith("tool_execution_")) {
      this.#tools.set(event.toolCallId, { ...this.#tools.get(event.toolCallId), ...event });
    }
    if (event.type === "agent_start") { this.#state.isStreaming = true; this.#error = undefined; }
    if (event.type === "agent_settled") this.#state.isStreaming = false;
    if (event.type === "compaction_start") this.#state.isCompacting = true;
    if (event.type === "compaction_end") this.#state.isCompacting = false;
    if (event.type === "thinking_level_changed") this.#state.thinkingLevel = event.level;
    if (event.type === "queue_update") this.#queue = { steering: event.steering, followUp: event.followUp };
    if (event.type === "extension_error") this.#error = event.error;
    if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
      this.#dialogs.set(event.id, event);
      if (event.timeout) {
        const timer = setTimeout(() => {
          this.#dialogs.delete(event.id);
          this.#dialogTimers.delete(event.id);
          this.#publish({ type: "dialog_closed", id: event.id });
        }, event.timeout);
        timer.unref();
        this.#dialogTimers.set(event.id, timer);
      }
    }
    this.#publish(event);
    if (event.type === "agent_settled" || event.type === "compaction_end") {
      this.refresh().catch((error) => this.#publish({ type: "connection_error", error: error.message }));
    }
  }

  snapshot() {
    return {
      revision: this.#revision, cwd: this.cwd, state: this.#state, messages: this.#messages,
      models: this.#models.map(({ id, name, provider, input }) => ({ id, name, provider, input })),
      levels: this.#levels, commands: this.#commands, stats: this.#stats,
      queue: this.#queue, dialogs: [...this.#dialogs.values()],
      tools: [...this.#tools.values()],
      isOnline: this.#isOnline, error: this.#error,
    };
  }

  refresh() {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#refresh().finally(() => { this.#refreshPromise = undefined; });
    return this.#refreshPromise;
  }

  async #refresh() {
    const revision = this.#revision;
    const [state, history, catalog, thinking, commands, stats] = await Promise.all([
      this.#rpc.request("get_state"), this.#rpc.request("get_entries"),
      this.#rpc.request("get_available_models"), this.#rpc.request("get_available_thinking_levels"),
      this.#rpc.request("get_commands"), this.#rpc.request("get_session_stats"),
    ]);
    const messages = activeMessages(history.entries, history.leafId);
    this.#state = revision === this.#revision ? state : await this.#rpc.request("get_state");
    if (revision === this.#revision || this.#messages.length === 0) {
      this.#messages = messages;
    } else {
      const entries = new Map(messages.map((item) => [messageId(item), item.entryId]));
      for (const message of this.#messages) message.entryId = entries.get(messageId(message));
    }
    this.#models = catalog.models;
    this.#levels = thinking.levels;
    this.#commands = publicCommands(commands?.commands);
    this.#stats = publicStats(stats);
    this.#publish({ type: "snapshot", snapshot: this.snapshot() });
    return this.snapshot();
  }

  async execute(input) {
    if (!input || typeof input.type !== "string") throw new Error("Invalid operation");
    if (!this.#isOnline) throw new Error("Pi connection is closed");
    if (input.type === "dialog_response") {
      const dialog = this.#dialogs.get(input.id);
      if (!dialog) throw new Error("This request has already finished");
      if (!input.cancelled && dialog.method === "select" && !dialog.options.includes(input.value)) throw new Error("Invalid option");
      if (!input.cancelled && ["input", "editor"].includes(dialog.method) && typeof input.value !== "string") throw new Error("Invalid input");
      this.#rpc.respond({ id: input.id, value: input.value, confirmed: input.confirmed === true, cancelled: input.cancelled === true });
      this.#dialogs.delete(input.id);
      clearTimeout(this.#dialogTimers.get(input.id));
      this.#dialogTimers.delete(input.id);
      this.#publish({ type: "dialog_closed", id: input.id });
      return;
    }
    if (input.type === "stop") {
      if (this.#isStopping) throw new Error("Stopping");
      this.#isStopping = true;
      try { await this.#rpc.request("clear_queue"); await this.#rpc.request("abort"); }
      finally { this.#isStopping = false; }
      return;
    }
    if (this.#isMutating || this.#isStopping) throw new Error("The previous operation is still running");
    this.#isMutating = true;
    try {
      await this.#execute(input);
    } finally { this.#isMutating = false; }
  }

  async #execute(input) {
    if (input.type === "prompt") {
      const prompt = validatePrompt(input);
      if (this.#state.isCompacting) throw new Error("Wait for the context compaction to finish");
      await this.#rpc.request("prompt", { ...prompt, streamingBehavior: "followUp" });
      return;
    }
    const supported = ["edit", "new_session", "switch_session", "reload", "set_model", "set_thinking_level", "compact"];
    if (!supported.includes(input.type)) throw new Error("Unsupported operation");
    const state = await this.#rpc.request("get_state");
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount) throw new Error("Stop the current task first, or wait for it to finish");
    if (this.#refreshPromise) await this.#refreshPromise;
    if (input.type === "edit") {
      const prompt = validatePrompt(input);
      if (typeof input.entryId !== "string" || !input.entryId) throw new Error("Invalid message ID");
      const message = this.#messages.find((item) => item.entryId === input.entryId && item.role === "user");
      if (!message) throw new Error("Message not found. Refresh and try again.");
      const result = await this.#rpc.request("fork", { entryId: input.entryId });
      if (result.cancelled) throw new Error("Editing the conversation was cancelled");
      this.#resetSession();
      await this.refresh();
      await this.#rpc.request("prompt", prompt);
      return;
    }
    if (input.type === "new_session") {
      const result = await this.#rpc.request("new_session");
      if (result.cancelled) throw new Error("New conversation cancelled");
      this.#resetSession();
    }
    if (input.type === "switch_session") {
      if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 200) throw new Error("Invalid session ID");
      if (input.sessionId === state.sessionId) throw new Error("This is already the current session");
      if (!this.#SessionManager) throw new Error("The session list is not available here");
      const sessionDir = state.sessionFile ? dirname(state.sessionFile) : undefined;
      const sessions = await this.#SessionManager.list(this.cwd, sessionDir);
      const target = sessions.find((session) => session.id === input.sessionId);
      if (!target) throw new Error("Session not found");
      const result = await this.#rpc.request("switch_session", { sessionPath: target.path });
      if (result.cancelled) throw new Error("Switching sessions was cancelled");
      this.#resetSession();
    }
    if (input.type === "reload") {
      const commands = await this.#rpc.request("get_commands");
      if (!commands.commands.some((item) => item.name === "webui-reload")) throw new Error("The webui extension is not loaded, so reload is unavailable");
      this.#error = undefined;
      await this.#rpc.request("prompt", { message: "/webui-reload" });
      if (this.#error) throw new Error(this.#error);
    }
    if (input.type === "compact") {
      if (input.instructions !== undefined && typeof input.instructions !== "string") throw new Error("Invalid compaction instructions");
      const instructions = input.instructions?.trim().slice(0, 4000);
      await this.#rpc.request("compact", instructions ? { customInstructions: instructions } : {});
    }
    if (input.type === "set_model") {
      if (!this.#models.some((model) => model.provider === input.provider && model.id === input.modelId)) throw new Error("Model unavailable");
      await this.#rpc.request("set_model", { provider: input.provider, modelId: input.modelId });
    }
    if (input.type === "set_thinking_level") {
      if (!this.#levels.includes(input.level)) throw new Error("This model does not support that thinking level");
      await this.#rpc.request("set_thinking_level", { level: input.level });
    }
    await this.refresh();
  }
}
