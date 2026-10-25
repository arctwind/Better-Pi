import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PLUGINS, readPluginSettings, savePluginSettings } from "../../plugins/settings.mjs";
import { startServer } from "../server.mjs";

async function temporaryDirectory(t) {
  const root = await mkdtemp(fileURLToPath(new URL("./.tmp-plugins-", import.meta.url)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function authenticate(server) {
  const url = new URL(server.url);
  const response = await fetch(`${url.origin}/api/auth`, {
    method: "POST", headers: { Origin: url.origin }, body: JSON.stringify({ token: url.hash.slice(1) }),
  });
  assert.equal(response.status, 200);
  return { origin: url.origin, headers: { Cookie: response.headers.get("set-cookie").split(";")[0], Origin: url.origin } };
}

test("settings default to enabled, persist, and reject invalid writes without changing the file", async (t) => {
  const root = await temporaryDirectory(t);
  assert.deepEqual(await readPluginSettings(root), { disabled: [] });
  const settings = { disabled: ["web.ts", "system-prompt/index.ts"] };
  await savePluginSettings(root, settings);
  assert.deepEqual(await readPluginSettings(root), settings);
  const before = await readFile(join(root, "better-pi.json"), "utf8");
  for (const value of [null, [], {}, { disabled: "web.ts" }, { disabled: ["../outside.ts"] }, { disabled: ["web.ts", "web.ts"] }]) {
    await assert.rejects(savePluginSettings(root, value), /Invalid Better Pi settings/);
    assert.equal(await readFile(join(root, "better-pi.json"), "utf8"), before);
  }
  await savePluginSettings(root, { disabled: [] });
  assert.deepEqual(await readPluginSettings(root), { disabled: [] });
  assert.deepEqual(await readdir(root), ["better-pi.json"]);
});

test("malformed settings are reported and failed saves clean up their temporary file", async (t) => {
  const root = await temporaryDirectory(t);
  const target = join(root, "better-pi.json");
  await writeFile(target, "{");
  await assert.rejects(readPluginSettings(root), /Cannot read .*better-pi\.json/);
  await rm(target);
  await mkdir(target);
  await assert.rejects(savePluginSettings(root, { disabled: [] }));
  assert.deepEqual(await readdir(root), ["better-pi.json"]);
});

test("standalone plugin settings require authentication, validate saves, and serve the single-file page", { timeout: 10_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  const server = await startServer(undefined, { agentDir: root });
  t.after(() => server.close());
  const origin = new URL(server.url).origin;
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /1%~10%/);
  assert.match(html, /or have no effect/);
  for (const tag of ["script", "style"]) {
    const content = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))[1];
    const hash = createHash("sha256").update(content.replace(/\r\n?/g, "\n")).digest("base64");
    assert.ok(page.headers.get("content-security-policy").includes(`${tag}-src 'sha256-${hash}'`));
  }
  assert.equal((await fetch(`${origin}/api/plugins`)).status, 401);
  const { headers } = await authenticate(server);
  const initial = await (await fetch(`${origin}/api/plugins`, { headers })).json();
  assert.deepEqual(initial, { plugins: PLUGINS, disabled: [] });
  const settings = { disabled: PLUGINS.map(({ path }) => path) };
  const post = (body, extra = {}) => fetch(`${origin}/api/plugins`, {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });
  assert.equal((await post(settings, { Origin: "https://example.com" })).status, 403);
  assert.deepEqual(await readPluginSettings(root), { disabled: [] });
  assert.equal((await post(settings)).status, 200);
  assert.deepEqual(await readPluginSettings(root), settings);
  assert.equal((await post({ disabled: ["unknown"] })).status, 400);
  assert.deepEqual(await readPluginSettings(root), settings);
  assert.equal((await fetch(`${origin}/api/snapshot`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/app.js`, { headers })).status, 404);
});

test("plugin CSP hashes match browser content when the page uses CRLF", { timeout: 10_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  const pluginPage = new URL("../../plugins/index.html", import.meta.url);
  const html = (await readFile(pluginPage, "utf8")).replace(/\r?\n/g, "\r\n");
  const originalReadFile = fs.readFile;
  t.mock.method(fs, "readFile", (file, ...args) =>
    file instanceof URL && file.href === pluginPage.href ? Promise.resolve(html) : originalReadFile(file, ...args));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const server = await startServer(undefined, { agentDir: root });
  t.after(() => server.close());
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), html);
  for (const tag of ["script", "style"]) {
    const content = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))[1];
    const hash = createHash("sha256").update(content.replace(/\r\n?/g, "\n")).digest("base64");
    assert.ok(page.headers.get("content-security-policy").includes(`${tag}-src 'sha256-${hash}'`));
  }
});

test("chat WebUI serves the same settings page and shares the saved configuration", { timeout: 10_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  const session = new EventEmitter();
  const server = await startServer(session, { agentDir: root });
  t.after(() => server.close());
  const { origin, headers } = await authenticate(server);
  const response = await fetch(`${origin}/plugins`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), await readFile(new URL("../../plugins/index.html", import.meta.url), "utf8"));
  await savePluginSettings(root, { disabled: ["webui/index.ts"] });
  assert.deepEqual((await (await fetch(`${origin}/api/plugins`, { headers })).json()).disabled, ["webui/index.ts"]);
});

test("unused standalone settings stop automatically and can be closed again", { timeout: 10_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = await startServer(undefined, { agentDir: root });
  t.after(() => server.close());
  assert.equal(server.closed, false);
  t.mock.timers.tick(300_000);
  assert.equal(server.closed, true);
  await server.close();
  await assert.rejects(fetch(server.url));
});

test("standalone settings stay online until the last page disconnects", { timeout: 10_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = await startServer(undefined, { agentDir: root });
  t.after(() => server.close());
  const { origin, headers } = await authenticate(server);
  assert.equal((await fetch(`${origin}/api/plugins/events`)).status, 401);
  const first = await fetch(`${origin}/api/plugins/events`, { headers });
  const second = await fetch(`${origin}/api/plugins/events`, { headers });
  t.mock.timers.tick(600_000);
  assert.equal(server.closed, false);
  await first.body.cancel();
  await delay(50);
  t.mock.timers.tick(600_000);
  assert.equal(server.closed, false);
  await second.body.cancel();
  await delay(50);
  t.mock.timers.tick(299_999);
  assert.equal(server.closed, false);
  t.mock.timers.tick(1);
  assert.equal(server.closed, true);
});

test("chat WebUI does not stop when its settings page disconnects", { timeout: 10_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = await startServer(new EventEmitter(), { agentDir: root });
  t.after(() => server.close());
  const { origin, headers } = await authenticate(server);
  const response = await fetch(`${origin}/api/plugins/events`, { headers });
  await response.body.cancel();
  await delay(50);
  t.mock.timers.tick(600_000);
  assert.equal(server.closed, false);
  assert.equal((await fetch(`${origin}/plugins`)).status, 200);
});
