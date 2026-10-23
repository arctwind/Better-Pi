import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as view from "../public/view.js";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/^import[^\n]*\n/, "");
const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };

class Element {
  children = [];
  listeners = new Map();
  selectors = new Map();
  value = "";
  style = { setProperty() {} };
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  toggleAttribute() {}
  setSelectionRange() {}
  focus() {}
  scrollTo() {}
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith(".") && child.className?.split(" ").includes(selector.slice(1))) return child;
    }
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
    return this.selectors.get(selector);
  }
  querySelectorAll() { return []; }
}

function setup(initialDrafts = []) {
  const elements = new Map();
  const storage = new Map(initialDrafts);
  const getElementById = (id) => {
    if (!elements.has(id)) {
      const node = new Element();
      node.hidden = ["model-menu", "thinking-menu"].includes(id);
      elements.set(id, node);
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    ...view,
    document: {
      getElementById, createElement: () => new Element(), createElementNS: () => new Element(),
      createTextNode: (text) => ({ textContent: text }), addEventListener() {}, querySelectorAll: () => [],
      body: new Element(),
    },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    localStorage: { getItem: () => null },
    fetch: () => new Promise(() => {}),
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    setTimeout, clearTimeout,
  });
  vm.runInContext(app, context);
  const run = (code) => vm.runInContext(code, context);
  const renderControls = context.renderControls;
  run("scheduleRender = renderControls = renderSessions = scheduleSessions = updateSessionTitle = renderStats = () => {}; isConnected = true;");
  let revision = 0;
  const receive = (id, messages = []) => context.receive({ event: { type: "snapshot", snapshot: {
    revision: ++revision, cwd: "project", state: { sessionId: id }, messages, isOnline: true,
  } } });
  const setDraft = (text, images = []) => {
    getElementById("input").value = text;
    context.nextImages = structuredClone(images);
    run("images = nextImages; saveDraft();");
  };
  const draft = () => JSON.parse(run("JSON.stringify({ text: $('input').value, images })"));
  return { context, run, receive, setDraft, draft, storage, getElementById, renderControls };
}

test("editing a streamed user message uses its current entry id and content", async () => {
  const ui = setup();
  const streamed = { role: "user", timestamp: 1, content: "streamed" };
  ui.receive("A", [streamed]);
  const row = ui.context.renderUser({ key: view.messageId(streamed), user: streamed });
  const button = row.children[1].querySelector(".edit-button");
  ui.receive("A", [{ ...streamed, content: "saved", entryId: "user-entry" }]);
  button.disabled = false;
  button.listeners.get("click")();
  assert.equal(ui.run("editing"), "user-entry");
  assert.equal(ui.draft().text, "saved");
  const commands = [];
  ui.context.request = async (_path, input) => { commands.push(input); };
  ui.getElementById("send").disabled = false;
  await ui.context.submit();
  assert.equal(commands[0].type, "edit");
  assert.equal(commands[0].entryId, "user-entry");
});

test("runtime changes refresh the page even when the new snapshot has a lower revision", () => {
  const ui = setup();
  ui.receive("A");
  ui.run("state.runtimeId = 0; revision = 100; reloadCount = 0; reloadPage = () => { reloadCount++; };");
  ui.context.receive({ event: { type: "snapshot", snapshot: { revision: 1, runtimeId: 1 } } });
  assert.equal(ui.run("reloadCount"), 1);
});

test("automatic reload restores image drafts across sessions and an unfinished edit", async () => {
  for (const isEditing of [false, true]) {
    const saved = new Map();
    const configureStorage = (ui) => {
      ui.context.withReloadDraftStore = async (action) => action({
        put: (value, key) => { saved.set(key, structuredClone(value)); return key; },
        get: (key) => saved.get(key),
        delete: (key) => saved.delete(key),
      });
      ui.context.crypto = { randomUUID: () => "reload-tab" };
      ui.context.location = { reload() {} };
    };
    const before = setup();
    configureStorage(before);
    before.receive("B");
    before.setDraft("draft B", [image]);
    before.receive("A");
    before.setDraft("draft A", [image]);
    if (isEditing) {
      before.context.beginEdit({ role: "user", entryId: "entry", content: "old text" });
      before.setDraft("edited text", [image]);
    }
    await before.context.reloadPage();
    assert.equal(saved.size, 1);

    const after = setup([...before.storage]);
    configureStorage(after);
    await after.context.restoreReloadDrafts();
    after.receive("A");
    assert.deepEqual(after.draft(), { text: isEditing ? "edited text" : "draft A", images: [image] });
    if (isEditing) {
      assert.equal(after.run("editing"), "entry");
      after.context.cancelEdit();
      assert.deepEqual(after.draft(), { text: "draft A", images: [image] });
    }
    after.receive("B");
    assert.deepEqual(after.draft(), { text: "draft B", images: [image] });
    assert.equal(saved.size, 0);
    assert.equal(after.storage.has("pi-webui-reload-draft"), false);
  }
});

test("switching sessions restores each draft's text and images, including image removal", () => {
  const ui = setup();
  ui.receive("A");
  ui.setDraft("draft A", [image]);
  ui.run("pendingSwitch = true;");
  ui.receive("B");
  assert.deepEqual(ui.draft(), { text: "", images: [] });
  ui.setDraft("draft B");
  ui.run("pendingSwitch = true;");
  ui.receive("A");
  assert.deepEqual(ui.draft(), { text: "draft A", images: [image] });
  assert.equal(ui.storage.get("pi-webui-draft:A"), "draft A");
  ui.getElementById("attachments").children[0].children[1].listeners.get("click")();
  ui.receive("B");
  assert.deepEqual(ui.draft(), { text: "draft B", images: [] });
  ui.receive("A");
  assert.deepEqual(ui.draft(), { text: "draft A", images: [] });
});

test("session changes from another tab preserve the outgoing draft and load the destination", () => {
  const ui = setup([["pi-webui-draft:B", "stored B"]]);
  ui.receive("A");
  ui.setDraft("draft A", [image]);
  ui.receive("B");
  assert.deepEqual(ui.draft(), { text: "stored B", images: [] });
  ui.context.saveDraft();
  assert.equal(ui.storage.get("pi-webui-draft:B"), "stored B");
  ui.receive("A");
  assert.deepEqual(ui.draft(), { text: "draft A", images: [image] });
});

test("new sessions preserve the outgoing draft with either response and snapshot ordering", async () => {
  for (const isSnapshotFirst of [true, false]) {
    const ui = setup();
    ui.receive("A");
    ui.setDraft("draft A", [image]);
    ui.context.request = async () => { if (isSnapshotFirst) ui.receive("B"); };
    await ui.context.runChange({ type: "new_session" });
    if (!isSnapshotFirst) ui.receive("B");
    assert.deepEqual(ui.draft(), { text: "", images: [] });
    ui.receive("A");
    assert.deepEqual(ui.draft(), { text: "draft A", images: [image] });
  }
});

test("a session change during editing preserves the original draft and exits edit mode", () => {
  const ui = setup([["pi-webui-draft:B", "draft B"]]);
  ui.receive("A");
  ui.setDraft("draft A", [image]);
  ui.context.beginEdit({ role: "user", entryId: "entry", content: "old message" });
  ui.getElementById("input").value = "edited message";
  ui.receive("B");
  assert.equal(ui.run("editing"), undefined);
  assert.deepEqual(ui.draft(), { text: "draft B", images: [] });
  ui.receive("A");
  assert.deepEqual(ui.draft(), { text: "draft A", images: [image] });
});

test("a successful fork keeps the source draft in its original session", async () => {
  const ui = setup();
  ui.receive("A");
  ui.setDraft("draft A", [image]);
  ui.context.beginEdit({ role: "user", entryId: "entry", content: "old message" });
  ui.context.request = async () => { ui.receive("fork"); };
  ui.getElementById("send").disabled = false;
  await ui.context.submit();
  assert.equal(ui.run("editing"), undefined);
  assert.deepEqual(ui.draft(), { text: "", images: [] });
  ui.receive("A");
  assert.deepEqual(ui.draft(), { text: "draft A", images: [image] });
});

test("a delayed send response clears only the originating session's draft", async () => {
  const ui = setup([["pi-webui-draft:B", "draft B"]]);
  ui.receive("A");
  ui.setDraft("send A", [image]);
  let complete;
  ui.context.request = () => new Promise((resolve) => { complete = resolve; });
  ui.getElementById("send").disabled = false;
  const sent = ui.context.submit();
  ui.receive("B");
  complete();
  await sent;
  assert.deepEqual(ui.draft(), { text: "draft B", images: [] });
  ui.receive("A");
  assert.deepEqual(ui.draft(), { text: "", images: [] });
});

test("a sent draft does not return when revisiting its session", async () => {
  const ui = setup();
  ui.receive("A");
  ui.setDraft("send A", [image]);
  ui.context.request = async () => {};
  ui.getElementById("send").disabled = false;
  await ui.context.submit();
  ui.receive("B");
  ui.receive("A");
  assert.deepEqual(ui.draft(), { text: "", images: [] });
});

test("failed edits retain text and images in the fork with either snapshot ordering", async () => {
  for (const isSnapshotFirst of [true, false]) {
    const ui = setup();
    ui.receive("A");
    ui.setDraft("original draft");
    ui.context.beginEdit({ role: "user", entryId: "entry", content: "old message" });
    ui.setDraft("edited message", [image]);
    ui.context.request = async (path) => {
      if (path === "/api/snapshot") return {
        revision: 20, cwd: "project", state: { sessionId: "fork" }, messages: [], isOnline: true,
      };
      if (isSnapshotFirst) ui.receive("fork");
      throw new Error("prompt rejected");
    };
    ui.context.showError = () => {};
    ui.getElementById("send").disabled = false;
    await ui.context.submit();
    assert.equal(ui.run("editing"), undefined);
    assert.deepEqual(ui.draft(), { text: "edited message", images: [image] });
    assert.equal(ui.storage.get("pi-webui-draft:fork"), "edited message");
    assert.equal(ui.storage.get("pi-webui-draft:A"), "original draft");
    const commands = [];
    ui.context.request = async (_path, input) => { commands.push(input); };
    await ui.context.submit();
    assert.equal(commands[0].type, "prompt");
    assert.equal(commands[0].message, "edited message");
    assert.deepEqual(JSON.parse(JSON.stringify(commands[0].images)), [image]);
  }
});

test("an edit rejected before forking keeps edit mode and the original draft", async () => {
  const ui = setup();
  ui.receive("A");
  ui.setDraft("original draft");
  ui.context.beginEdit({ role: "user", entryId: "entry", content: "old message" });
  ui.setDraft("edited message", [image]);
  ui.context.request = async (path) => {
    if (path === "/api/snapshot") return JSON.parse(ui.run("JSON.stringify(state)"));
    throw new Error("fork rejected");
  };
  ui.context.showError = () => {};
  ui.getElementById("send").disabled = false;
  await ui.context.submit();
  assert.equal(ui.run("editing"), "entry");
  assert.deepEqual(ui.draft(), { text: "edited message", images: [image] });
  ui.context.cancelEdit();
  assert.deepEqual(ui.draft(), { text: "original draft", images: [] });
});

test("manual compaction can be stopped without releasing the other operation's lock", async () => {
  for (const isStopFirst of [true, false]) {
    const ui = setup();
    ui.receive("A");
    ui.run("state.state.isCompacting = true;");
    const pending = new Map();
    ui.context.request = (_path, input) => new Promise((resolve) => pending.set(input.type, resolve));
    const compact = ui.context.runChange({ type: "compact" });
    ui.renderControls();
    assert.equal(ui.getElementById("stop").hidden, false);
    assert.equal(ui.getElementById("stop").disabled, false);
    const stop = ui.context.runChange({ type: "stop" });
    ui.renderControls();
    assert.equal(ui.getElementById("stop").disabled, true);
    pending.get(isStopFirst ? "stop" : "compact")();
    await (isStopFirst ? stop : compact);
    assert.equal(ui.run(isStopFirst ? "isChanging" : "isStopping"), true);
    ui.renderControls();
    assert.equal(ui.getElementById("send").disabled, true);
    pending.get(isStopFirst ? "compact" : "stop")();
    await (isStopFirst ? compact : stop);
    assert.equal(ui.run("isChanging || isStopping"), false);
  }
});

test("streaming refreshes preserve command completions and pending file lookups", () => {
  const ui = setup();
  ui.receive("A");
  ui.run("state.state.isStreaming = true;");
  for (const mode of ["command", "file"]) {
    ui.context.nextMode = mode;
    ui.run("completion = { mode: nextMode, items: [], isLoading: nextMode === 'file' }; aborted = false; fileAbort = { abort() { aborted = true; } };");
    ui.renderControls();
    assert.equal(ui.run("completion.mode"), mode);
    assert.equal(ui.run("aborted"), false);
  }
});

test("invalid and failed local commands retain their text and attachments", async () => {
  for (const command of ["/model missing", "/thinking unsupported", "/compact keep decisions", "/new", "/reload"]) {
    const ui = setup();
    ui.receive("A");
    ui.setDraft(command, [image]);
    ui.context.showError = () => {};
    ui.context.request = async () => { throw new Error("request rejected"); };
    ui.getElementById("send").disabled = false;
    await ui.context.submit();
    assert.deepEqual(ui.draft(), { text: command, images: [image] });
    assert.equal(ui.storage.get("pi-webui-draft:A"), command);
  }
});

test("thinking level names match the displayed labels regardless of case", async () => {
  const ui = setup();
  ui.receive("A");
  ui.run("state.levels = ['low', 'xhigh', 'max'];");
  const commands = [];
  ui.context.request = async (_path, input) => { commands.push(input); };
  for (const [command, level] of [["/thinking Max", "max"], ["/thinking extra high", "xhigh"], ["/thinking low", "low"]]) {
    ui.setDraft(command);
    ui.getElementById("send").disabled = false;
    await ui.context.submit();
    assert.deepEqual(JSON.parse(JSON.stringify(commands.at(-1))), { type: "set_thinking_level", level });
  }
  assert.equal(commands.length, 3);
});

test("successful local commands clear only the submitted draft", async () => {
  for (const outcome of ["unchanged", "edited", "switched"]) {
    const ui = setup();
    ui.receive("A");
    ui.setDraft("/compact keep decisions", [image]);
    let complete;
    ui.context.request = () => new Promise((resolve) => { complete = resolve; });
    ui.getElementById("send").disabled = false;
    const sent = ui.context.submit();
    assert.deepEqual(ui.draft(), { text: "/compact keep decisions", images: [image] });
    if (outcome === "edited") ui.setDraft("new draft");
    if (outcome === "switched") { ui.receive("B"); ui.setDraft("draft B"); }
    complete();
    await sent;
    assert.deepEqual(ui.draft(), {
      text: outcome === "unchanged" ? "" : outcome === "edited" ? "new draft" : "draft B", images: [],
    });
    assert.equal(ui.storage.get("pi-webui-draft:A"), outcome === "edited" ? "new draft" : undefined);
  }
});

test("reload does not restore the successfully executed reload command as a draft", async () => {
  const ui = setup();
  ui.receive("A");
  ui.setDraft("/reload", [image]);
  let saved;
  ui.context.withReloadDraftStore = async (action) => action({ put: (value) => { saved = structuredClone(value); } });
  ui.context.crypto = { randomUUID: () => "reload-tab" };
  ui.context.location = { reload() {} };
  ui.context.request = async () => { await ui.context.reloadPage(); };
  ui.getElementById("send").disabled = false;
  await ui.context.submit();
  assert.equal(new Map(saved.drafts).get("pi-webui-draft:A").text, "");
  assert.deepEqual(new Map(saved.drafts).get("pi-webui-draft:A").images, []);
});

test("the file diff dialog renders every recorded edit separately", () => {
  const ui = setup();
  const rendered = [];
  ui.context.renderDiff = (diff) => { rendered.push(diff); return new Element(); };
  ui.getElementById("diff-dialog").showModal = () => {};
  ui.context.openDiff("a.txt", ["-1 A\n+1 B", "-1 B\n+1 C"]);
  assert.deepEqual(rendered, ["-1 A\n+1 B", "-1 B\n+1 C"]);
  assert.equal(ui.getElementById("diff-body").children.length, 2);
});
