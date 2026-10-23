import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSession, activeMessages, validatePrompt } from "../session.mjs";
import { RpcConnection } from "../rpc.mjs";
import { applyMessageEvent, groupMessages, isFinalComplete } from "../public/view.js";
import { startServer } from "../server.mjs";
import { WebRuntime } from "../runtime.mjs";

class FakeRpc extends EventEmitter {
  calls = [];
  state = { sessionId: "session-1", sessionFile: "/sessions/current.jsonl", isStreaming: false, isCompacting: false, thinkingLevel: "low", model: { id: "model", provider: "test" } };
  entries = [
    { id: "user", parentId: null, type: "message", message: { role: "user", content: "original", timestamp: 1 } },
    { id: "answer", parentId: "user", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2, stopReason: "stop" } },
    { id: "abandoned", parentId: "user", type: "message", message: { role: "assistant", content: [], timestamp: 3 } },
  ];
  leafId = "answer";
  stats = {
    sessionFile: "/sessions/current.jsonl", sessionId: "session-1",
    userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
    tokens: { input: 100, output: 20, cacheRead: 300, cacheWrite: 0, total: 420 },
    cost: 0.01, contextUsage: { tokens: 420, contextWindow: 200_000, percent: 0.21 },
  };
  async request(type, input = {}) {
    this.calls.push({ type, ...input });
    if (type === "get_state") return structuredClone(this.state);
    if (type === "get_entries") return structuredClone({ entries: this.entries, leafId: this.leafId });
    if (type === "get_available_models") return { models: [{ id: "model", provider: "test" }] };
    if (type === "get_available_thinking_levels") return { levels: ["off", "low"] };
    if (type === "get_commands") return { commands: [
      { name: "webui-reload", description: "Reload", source: "extension" },
      { name: "example", description: "Example", source: "extension", sourceInfo: { path: "/secret" } },
    ] };
    if (type === "get_session_stats") return structuredClone(this.stats);
    if (type === "fork") { this.leafId = null; this.state.sessionId = "forked"; return { cancelled: false }; }
    if (type === "new_session") { this.leafId = null; this.state.sessionId = "new"; return { cancelled: false }; }
    if (type === "switch_session") {
      this.state.sessionFile = input.sessionPath;
      this.state.sessionId = "session-2";
      this.leafId = null;
      return { cancelled: false };
    }
    if (type === "prompt") {
      if (input.message === "/webui-reload") return;
      this.lastPrompt = input;
    }
  }
  respond(response) { this.response = response; }
}

class FakeSessionManager {
  static sessions = [
    { id: "session-2", cwd: process.cwd(), path: "/sessions/previous.jsonl", name: "旧会话", firstMessage: "previous topic", created: new Date("2026-01-01"), modified: new Date("2026-01-02"), messageCount: 4, allMessagesText: "private transcript" },
    { id: "session-1", cwd: process.cwd(), path: "/sessions/current.jsonl", firstMessage: "(no messages)", created: new Date("2026-01-03"), modified: new Date("2026-01-04"), messageCount: 2, allMessagesText: "private transcript" },
  ];
  static async list() { return this.sessions.map((session) => ({ ...session })); }
}

async function setup() {
  const rpc = new FakeRpc();
  const session = new WebSession(rpc, process.cwd(), { SessionManager: FakeSessionManager });
  await session.refresh();
  rpc.calls.length = 0;
  return { rpc, session };
}

test("RPC preserves LF framing, Unicode, concurrent ids and failures", { timeout: 10_000 }, async () => {
  const rpc = new RpcConnection(fileURLToPath(new URL("./rpc-fixture.mjs", import.meta.url)), []);
  try {
    const values = ["汉字\u2028\u2029next", "two", "emoji 🐈"];
    assert.deepEqual(await Promise.all(values.map((value) => rpc.request("echo", { value }))), values);
    await assert.rejects(rpc.request("fail"), /rejected/);
    const ignored = rpc.request("ignore");
    const exited = once(rpc, "exit");
    const exitRequest = rpc.request("exit");
    await Promise.all([assert.rejects(ignored, /exited/), assert.rejects(exitRequest, /exited/), exited]);
  } finally { await rpc.close(); }
});

test("RPC closes stdin and terminates its child", { timeout: 10_000 }, async () => {
  const rpc = new RpcConnection(fileURLToPath(new URL("./rpc-fixture.mjs", import.meta.url)), []);
  assert.equal(await rpc.request("echo", { value: "ready" }), "ready");
  const exit = once(rpc, "exit");
  await rpc.close();
  assert.equal((await exit)[0].isStopping, true);
  await assert.rejects(rpc.request("echo"), /closed/);
});

test("active branch excludes abandoned messages and retains stable entry ids", () => {
  const rpc = new FakeRpc();
  assert.deepEqual(activeMessages(rpc.entries, "answer").map((message) => message.entryId), ["user", "answer"]);
});

test("invalid edits are rejected before forking; edited images accompany the new prompt", async () => {
  const { rpc, session } = await setup();
  await assert.rejects(session.execute({ type: "edit", entryId: "user", message: "", images: [] }));
  await assert.rejects(session.execute({ type: "edit", entryId: "abandoned", message: "change" }));
  assert.equal(rpc.calls.some((call) => call.type === "fork"), false);
  const images = [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }];
  await session.execute({ type: "edit", entryId: "user", message: "changed", images });
  assert.deepEqual(rpc.calls.filter((call) => ["fork", "prompt"].includes(call.type)), [
    { type: "fork", entryId: "user" }, { type: "prompt", message: "changed", images },
  ]);
  assert.equal(session.snapshot().state.sessionId, "forked");
});

test("refresh records session state when events arrive while it is in flight", async () => {
  const rpc = new FakeRpc();
  const session = new WebSession(rpc, process.cwd(), { SessionManager: FakeSessionManager });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const request = rpc.request.bind(rpc);
  rpc.request = async (type, input) => {
    const value = await request(type, input);
    if (type === "get_state") await gate;
    return value;
  };
  const refresh = session.refresh();
  rpc.emit("event", { type: "agent_start" });
  release();
  await refresh;
  assert.equal(session.snapshot().state.sessionId, "session-1");
  assert.equal(session.snapshot().messages.length, 2);
});

test("session listing exposes safe previews and marks the current session", async () => {
  const { session } = await setup();
  const sessions = await session.listSessions();
  assert.deepEqual(sessions.map((item) => item.id), ["session-2", "session-1"]);
  assert.equal(sessions[0].name, "旧会话");
  assert.equal(sessions[0].firstMessage, "previous topic");
  assert.equal(sessions[0].isCurrent, false);
  assert.equal(sessions[1].firstMessage, "");
  assert.equal(sessions[1].isCurrent, true);
  assert.equal("path" in sessions[0], false);
  assert.equal("allMessagesText" in sessions[0], false);
});

test("session switching resolves the path from the listed id and rejects invalid targets", async () => {
  const { rpc, session } = await setup();
  await assert.rejects(session.execute({ type: "switch_session", sessionId: "session-1" }), /current session/);
  await assert.rejects(session.execute({ type: "switch_session", sessionId: "missing" }), /not found/);
  assert.equal(rpc.calls.some((call) => call.type === "switch_session"), false);
  await session.execute({ type: "switch_session", sessionId: "session-2" });
  assert.deepEqual(rpc.calls.filter((call) => call.type === "switch_session"), [
    { type: "switch_session", sessionPath: "/sessions/previous.jsonl" },
  ]);
  assert.equal(session.snapshot().state.sessionId, "session-2");
});

test("appends use followUp and stop clears the queue before aborting", async () => {
  const { rpc, session } = await setup();
  await session.execute({ type: "prompt", message: "next" });
  assert.equal(rpc.lastPrompt.streamingBehavior, "followUp");
  await session.execute({ type: "stop" });
  assert.deepEqual(rpc.calls.slice(-2).map((call) => call.type), ["clear_queue", "abort"]);
});

test("busy sessions reject configuration changes and unsupported values cause no mutation", async () => {
  const { rpc, session } = await setup();
  await assert.rejects(session.execute({ type: "set_model", provider: "invalid", modelId: "model" }), /unavailable/);
  await assert.rejects(session.execute({ type: "set_thinking_level", level: "max" }), /not support/);
  rpc.state.isStreaming = true;
  await assert.rejects(session.execute({ type: "new_session" }), /wait for it to finish/);
  await assert.rejects(session.execute({ type: "switch_session", sessionId: "session-2" }), /wait for it to finish/);
  assert.equal(rpc.calls.some((call) => ["set_model", "set_thinking_level", "new_session", "switch_session"].includes(call.type)), false);
});

test("reload uses the extension command and preserves the current session", async () => {
  const { rpc, session } = await setup();
  await session.execute({ type: "reload" });
  assert.ok(rpc.calls.some((call) => call.type === "prompt" && call.message === "/webui-reload"));
  assert.equal(session.snapshot().messages.length, 2);
});

test("reload replaces nested modules while preserving HTTP authentication, events and the Pi session", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(new URL("./reload-", import.meta.url));
  const rpc = new FakeRpc();
  const runtime = new WebRuntime(rpc, process.cwd(), { workerURL: pathToFileURL(join(root, "worker.mjs")) });
  let server;
  let reader;
  try {
    await mkdir(join(root, "public"));
    for (const file of ["worker.mjs", "session.mjs", "files.mjs", "open.mjs", "public/view.js"]) {
      await copyFile(new URL(`../${file}`, import.meta.url), join(root, file));
    }
    await writeFile(join(root, "files.mjs"), 'export async function listFiles() { return [{ path: "before" }]; }');
    await runtime.start();
    server = await startServer(runtime);
    const url = new URL(server.url);
    const auth = await fetch(`${url.origin}/api/auth`, {
      method: "POST", headers: { Origin: url.origin }, body: JSON.stringify({ token: url.hash.slice(1) }),
    });
    const cookie = auth.headers.get("set-cookie").split(";")[0];
    const headers = { Cookie: cookie, Origin: url.origin };
    const files = async () => (await fetch(`${url.origin}/api/files`, { headers })).json();
    const stream = await fetch(`${url.origin}/api/events`, { headers });
    reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"runtimeId":0/);
    assert.deepEqual(await files(), { entries: [{ path: "before" }] });

    await writeFile(join(root, "files.mjs"), 'export async function listFiles() { return [{ path: "after" }]; }');
    const response = await fetch(`${url.origin}/api/command`, { method: "POST", headers, body: JSON.stringify({ type: "reload" }) });
    assert.equal(response.status, 200);
    let updates = "";
    while (!updates.includes('"runtimeId":1')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      updates += new TextDecoder().decode(chunk.value);
    }
    assert.deepEqual(await files(), { entries: [{ path: "after" }] });
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.state.sessionId, "session-1");
    assert.equal(snapshot.messages.length, 2);
    assert.equal(rpc.calls.filter((call) => call.type === "prompt" && call.message === "/webui-reload").length, 1);
    assert.equal(rpc.listenerCount("event"), 1);
    assert.equal(rpc.listenerCount("exit"), 1);

    await writeFile(join(root, "files.mjs"), "invalid JavaScript!");
    await assert.rejects(runtime.execute({ type: "reload" }));
    assert.deepEqual(await files(), { entries: [{ path: "after" }] });
    assert.equal((await runtime.snapshot()).runtimeId, 1);
    assert.equal(rpc.calls.filter((call) => call.type === "prompt" && call.message === "/webui-reload").length, 1);
    assert.equal(rpc.listenerCount("event"), 1);
  } finally {
    await reader?.cancel();
    await server?.close();
    await runtime.close();
    assert.ok(root.startsWith(fileURLToPath(new URL("./", import.meta.url))));
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(rpc.listenerCount("event"), 0);
  assert.equal(rpc.listenerCount("exit"), 0);
});

test("snapshot restores streamed text, partial tools, queues and pending dialogs", async () => {
  const { rpc, session } = await setup();
  rpc.emit("event", { type: "agent_start" });
  rpc.emit("event", { type: "message_start", message: { role: "assistant", content: [], timestamp: 4 } });
  rpc.emit("event", { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "think" } });
  rpc.emit("event", { type: "tool_execution_update", toolCallId: "tool", partialResult: { content: [{ type: "text", text: "partial" }] } });
  rpc.emit("event", { type: "queue_update", steering: [], followUp: ["next"] });
  rpc.emit("event", { type: "extension_ui_request", id: "dialog", method: "confirm", title: "Continue?" });
  const snapshot = session.snapshot();
  assert.equal(snapshot.messages.at(-1).content[0].thinking, "think");
  assert.equal(snapshot.tools[0].partialResult.content[0].text, "partial");
  assert.deepEqual(snapshot.queue.followUp, ["next"]);
  assert.equal(snapshot.dialogs[0].id, "dialog");
  await session.execute({ type: "dialog_response", id: "dialog", confirmed: false });
  assert.equal(rpc.response.confirmed, false);
  assert.equal(session.snapshot().dialogs.length, 0);
});

test("stream reconstruction uses authoritative completions and only final text collapses work", () => {
  const messages = [{ role: "user", timestamp: 1, content: "question" }];
  applyMessageEvent(messages, { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } });
  applyMessageEvent(messages, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } });
  assert.equal(messages[1].content[0].text, "partial");
  applyMessageEvent(messages, { type: "message_end", message: { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }], stopReason: "toolUse" } });
  assert.equal(isFinalComplete(groupMessages(messages)[0]), false);
  applyMessageEvent(messages, { type: "message_end", message: { role: "assistant", timestamp: 3, content: [{ type: "thinking", thinking: "thought" }, { type: "text", text: "final" }], stopReason: "stop" } });
  assert.equal(isFinalComplete(groupMessages(messages)[0]), true);
});

test("image validation accepts image-only prompts and rejects unsupported or malformed content", () => {
  assert.equal(validatePrompt({ message: "", images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }).images.length, 1);
  for (const data of ["", "invalid", "a===", "<svg>"]) {
    assert.throws(() => validatePrompt({ message: "image", images: [{ type: "image", mimeType: "image/png", data }] }));
  }
  assert.throws(() => validatePrompt({ message: "image", images: [{ type: "image", mimeType: "image/svg+xml", data: "aGVsbG8=" }] }));
});

test("HTTP requires per-instance authentication and matching origins; SSE reconnect begins with a snapshot", { timeout: 10_000 }, async () => {
  const { session } = await setup();
  const server = await startServer(session);
  const url = new URL(server.url);
  const origin = url.origin;
  const streamAbort = new AbortController();
  try {
    assert.ok(Number(url.port) >= 49152);
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
    assert.equal((await fetch(`${origin}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${origin}/api/files?query=package`)).status, 401);
    assert.equal((await fetch(`${origin}/api/auth`, { method: "POST", headers: { Origin: "https://example.com" }, body: JSON.stringify({ token: url.hash.slice(1) }) })).status, 403);
    const auth = await fetch(`${origin}/api/auth`, { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ token: url.hash.slice(1) }) });
    const cookie = auth.headers.get("set-cookie").split(";")[0];
    assert.equal(auth.status, 200);
    const snapshot = await fetch(`${origin}/api/snapshot`, { headers: { Cookie: cookie } });
    assert.equal((await snapshot.json()).messages.length, 2);
    const sessions = await fetch(`${origin}/api/sessions`, { headers: { Cookie: cookie } });
    assert.equal(sessions.status, 200);
    assert.equal((await sessions.json()).sessions.length, 2);
    const files = await fetch(`${origin}/api/files?query=package`, { headers: { Cookie: cookie } });
    assert.equal(files.status, 200);
    assert.ok((await files.json()).entries.some((entry) => entry.path === "package.json"));
    const opens = [];
    session.openLocalPath = async (path, options) => { opens.push({ path, options }); };
    const openDefault = await fetch(`${origin}/api/open`, { method: "POST", headers: { Cookie: cookie, Origin: origin }, body: JSON.stringify({ path: "package.json", app: "default" }) });
    assert.equal(openDefault.status, 200);
    const openFolder = await fetch(`${origin}/api/open`, { method: "POST", headers: { Cookie: cookie, Origin: origin }, body: JSON.stringify({ path: "run.cmd", mode: "folder" }) });
    assert.equal(openFolder.status, 200);
    assert.deepEqual(opens, [
      { path: "package.json", options: { useDefaultApp: true, mode: "open" } },
      { path: "run.cmd", options: { useDefaultApp: false, mode: "folder" } },
    ]);
    const stream = await fetch(`${origin}/api/events`, { headers: { Cookie: cookie }, signal: streamAbort.signal });
    const reader = stream.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"type":"snapshot"/);
    await reader.cancel();
    const rejected = await fetch(`${origin}/api/command`, { method: "POST", headers: { Cookie: cookie, Origin: "https://example.com" }, body: JSON.stringify({ type: "new_session" }) });
    assert.equal(rejected.status, 403);
  } finally { streamAbort.abort(); await server.close(); }
});

test("session snapshots expose usage and commands without private paths", async () => {
  const { session } = await setup();
  const snapshot = session.snapshot();
  assert.equal(snapshot.stats.contextUsage.percent, 0.21);
  assert.equal(snapshot.stats.tokens.cacheRead, 300);
  assert.equal("sessionFile" in snapshot.stats, false);
  assert.deepEqual(snapshot.commands, [{ name: "example", description: "Example", source: "extension", argumentHint: undefined }]);
});

test("compact sends instructions through RPC and refreshes the session", async () => {
  const { rpc, session } = await setup();
  await session.execute({ type: "compact", instructions: "  keep decisions  " });
  assert.deepEqual(rpc.calls.filter((call) => call.type === "compact"), [{ type: "compact", customInstructions: "keep decisions" }]);
  assert.ok(rpc.calls.some((call) => call.type === "get_session_stats"));
});
