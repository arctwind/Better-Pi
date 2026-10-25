import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { getPackageDir, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { PLUGINS, savePluginSettings } from "../plugins/settings.mjs";
import pluginManager from "../plugins/index.ts";

test("saved settings apply on reload, restore process patches, and retain management with all plugins disabled", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(fileURLToPath(new URL("./.tmp-plugins-", import.meta.url)));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
  const previousWebUI = process.env.PI_WEBUI;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_SKIP_VERSION_CHECK = "original";
  t.after(async () => {
    await shutdown("quit");
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
    else process.env.PI_SKIP_VERSION_CHECK = previousVersionCheck;
    if (previousWebUI === undefined) delete process.env.PI_WEBUI;
    else process.env.PI_WEBUI = previousWebUI;
    await rm(root, { recursive: true, force: true });
  });
  const wheel = TuiAltScreen.prototype.getWheelScrollLines;
  const display = ToolExecutionComponent.prototype.updateDisplay;
  const { loadExtensionsCached, clearExtensionCache } = await import(pathToFileURL(join(getPackageDir(), "dist/core/extensions/loader.js")).href);
  let active;
  async function shutdown(reason) {
    for (const handler of active?.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason });
  }
  async function load(isReload = true) {
    if (isReload) clearExtensionCache();
    const result = await loadExtensionsCached([fileURLToPath(new URL("../index.ts", import.meta.url))], root);
    assert.deepEqual(result.errors, []);
    active = result.extensions[0];
    return active;
  }
  const enabled = await load();
  assert.ok(enabled.tools.has("web"));
  assert.ok(enabled.tools.has("browser"));
  assert.notEqual(TuiAltScreen.prototype.getWheelScrollLines, wheel);
  assert.notEqual(ToolExecutionComponent.prototype.updateDisplay, display);
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, "1");
  for (const reason of ["new", "resume", "fork"]) {
    await shutdown(reason);
    assert.equal(process.env.PI_SKIP_VERSION_CHECK, "original");
    assert.equal(TuiAltScreen.prototype.getWheelScrollLines, wheel);
    assert.equal(ToolExecutionComponent.prototype.updateDisplay, display);
    const replacement = await load(false);
    assert.deepEqual([...replacement.tools.keys()], [...enabled.tools.keys()]);
    assert.equal(process.env.PI_SKIP_VERSION_CHECK, "1");
    assert.notEqual(TuiAltScreen.prototype.getWheelScrollLines, wheel);
    assert.notEqual(ToolExecutionComponent.prototype.updateDisplay, display);
  }
  await savePluginSettings(root, { disabled: PLUGINS.map(({ path }) => path) });
  assert.ok(enabled.tools.has("web"));
  await shutdown("reload");
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, "original");
  assert.equal(TuiAltScreen.prototype.getWheelScrollLines, wheel);
  assert.equal(ToolExecutionComponent.prototype.updateDisplay, display);
  process.env.PI_WEBUI = "1";
  const disabled = await load();
  assert.equal(disabled.tools.size, 0);
  assert.deepEqual([...disabled.commands.keys()].sort(), ["plugins", "webui-reload"]);
  assert.deepEqual([...disabled.handlers.keys()], ["session_shutdown"]);
  await shutdown("reload");
  await savePluginSettings(root, { disabled: [] });
  const restored = await load();
  assert.deepEqual([...restored.tools.keys()], [...enabled.tools.keys()]);
  assert.ok(restored.commands.has("jailbreak"));
});

for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
  test(`manager reports browser failures, reuses its server, and closes it on ${reason}`, { timeout: 10_000 }, async () => {
    const commands = new Map();
    const handlers = new Map();
    const notifications = [];
    const launches = [];
    pluginManager({
      registerCommand(name, command) { commands.set(name, command); },
      on(name, handler) { handlers.set(name, handler); },
      async exec(command, args) { launches.push({ command, args }); return { code: 1, stderr: "browser unavailable", killed: false }; },
    });
    const ctx = { ui: { notify(message, type) { notifications.push({ message, type }); } } };
    try {
      await commands.get("plugins").handler("", ctx);
      await commands.get("plugins").handler("", ctx);
      assert.equal(launches.length, 2);
      const links = notifications.filter(({ type }) => type === "info").map(({ message }) => message.match(/http:\/\/\S+/)[0]);
      assert.equal(links.length, 2);
      assert.equal(links[0], links[1]);
      assert.equal(notifications.filter(({ type, message }) => type === "error" && message.includes("browser unavailable")).length, 2);
      assert.equal((await fetch(links[0])).status, 200);
      await handlers.get("session_shutdown")({ reason });
      await assert.rejects(fetch(links[0]));
    } finally { await handlers.get("session_shutdown")({ reason: "quit" }); }
  });
}

test("manager restarts settings after automatic shutdown", { timeout: 10_000 }, async (t) => {
  const commands = new Map();
  const handlers = new Map();
  const links = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pluginManager({
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, handler); },
    async exec() { return { code: 0, stderr: "", killed: false }; },
  });
  t.after(() => handlers.get("session_shutdown")({ reason: "quit" }));
  const ctx = { ui: { notify(message, type) {
    assert.equal(type, "info", message);
    links.push(message.match(/http:\/\/\S+/)[0]);
  } } };
  await commands.get("plugins").handler("", ctx);
  t.mock.timers.tick(300_000);
  await assert.rejects(fetch(links[0]));
  await commands.get("plugins").handler("", ctx);
  assert.equal(links.length, 2);
  assert.notEqual(links[0], links[1]);
  assert.equal((await fetch(links[1])).status, 200);
});
