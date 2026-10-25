import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PLUGINS, readPluginSettings, savePluginSettings } from "../plugins/settings.mjs";

const MAX_BODY_BYTES = 112 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const PLUGIN_IDLE_TIMEOUT_MS = 300_000;
const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

async function readJSON(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJSON(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function isSameToken(value, token) {
  if (typeof value !== "string") return false;
  const bytes = Buffer.from(value);
  const expected = Buffer.from(token);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

export async function startServer(session, { markedPath, agentDir } = {}) {
  if (!session && !agentDir) throw new Error("Plugin settings require a Pi agent directory");
  const pluginPage = agentDir ? await readFile(new URL("../plugins/index.html", import.meta.url), "utf8") : undefined;
  const pluginPolicy = pluginPage && ["script", "style"].map((tag) => {
    const content = pluginPage.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))[1];
    return `${tag}-src 'sha256-${createHash("sha256").update(content.replace(/\r\n?/g, "\n")).digest("base64")}'`;
  }).join("; ");
  const token = randomBytes(32).toString("hex");
  const clients = new Set();
  const pluginClients = new Set();
  let origin;
  let cookieName;
  let idleTimer;
  let closing;
  const scheduleIdleClose = () => {
    if (session || closing || pluginClients.size) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { void close(); }, PLUGIN_IDLE_TIMEOUT_MS);
    idleTimer.unref();
  };
  const assets = new Map([
    ["/", [path.join(PUBLIC_DIR, "index.html"), "text/html"]],
    ["/app.js", [path.join(PUBLIC_DIR, "app.js"), "text/javascript"]],
    ["/view.js", [path.join(PUBLIC_DIR, "view.js"), "text/javascript"]],
    ["/style.css", [path.join(PUBLIC_DIR, "style.css"), "text/css"]],
    ["/marked.js", [markedPath, "text/javascript"]],
  ]);
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (request.headers.host !== new URL(origin).host) return sendJSON(response, 403, { error: "Invalid access address" });
      const pathname = new URL(request.url, origin).pathname;
      if (request.method === "POST" && request.headers.origin !== origin) return sendJSON(response, 403, { error: "Invalid request origin" });
      if (pathname === "/api/auth" && request.method === "POST") {
        const input = await readJSON(request, 1024);
        if (!isSameToken(input.token, token)) return sendJSON(response, 401, { error: "Open the full link shown in the terminal" });
        response.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return sendJSON(response, 200, { ok: true });
      }
      if (pathname.startsWith("/api/")) {
        const cookies = (request.headers.cookie ?? "").split(";").map((item) => item.trim());
        const cookie = cookies.find((item) => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
        if (!isSameToken(cookie, token)) return sendJSON(response, 401, { error: "Open the full link shown in the terminal" });
        if (pathname === "/api/plugins/events" && agentDir && request.method === "GET") {
          response.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
          response.write(": connected\n\n");
          pluginClients.add(response);
          clearTimeout(idleTimer);
          request.on("close", () => {
            pluginClients.delete(response);
            scheduleIdleClose();
          });
          return;
        }
        if (pathname === "/api/plugins" && agentDir) {
          if (request.method === "GET") return sendJSON(response, 200, { plugins: PLUGINS, ...await readPluginSettings(agentDir) });
          if (request.method === "POST") {
            await savePluginSettings(agentDir, await readJSON(request, 8192));
            return sendJSON(response, 200, { ok: true });
          }
        }
        if (!session) return sendJSON(response, 404, { error: "Unknown endpoint" });
        if (pathname === "/api/events" && request.method === "GET") {
          response.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
          const updates = [];
          const bufferUpdate = (update) => updates.push(update);
          session.on("update", bufferUpdate);
          try {
            const snapshot = await session.snapshot();
            response.write(`data: ${JSON.stringify({ event: { type: "snapshot", snapshot } })}\n\n`);
            for (const update of updates) {
              if (update.revision > snapshot.revision) response.write(`data: ${JSON.stringify(update)}\n\n`);
            }
          } finally { session.off("update", bufferUpdate); }
          clients.add(response);
          request.on("close", () => clients.delete(response));
          return;
        }
        if (pathname === "/api/snapshot" && request.method === "GET") return sendJSON(response, 200, await session.snapshot());
        if (pathname === "/api/open" && request.method === "POST") {
          const input = await readJSON(request, 8192);
          await session.openLocalPath(input.path, {
            useDefaultApp: input.app === "default",
            mode: input.mode === "folder" ? "folder" : "open",
          });
          return sendJSON(response, 200, { ok: true });
        }
        if (pathname === "/api/sessions" && request.method === "GET") return sendJSON(response, 200, { sessions: await session.listSessions() });
        if (pathname === "/api/files" && request.method === "GET") {
          const query = new URL(request.url, origin).searchParams.get("query") ?? "";
          if (query.length > 200) return sendJSON(response, 400, { error: "Query too long" });
          return sendJSON(response, 200, { entries: await session.listFiles(query) });
        }
        if (pathname === "/api/command" && request.method === "POST") {
          const input = await readJSON(request);
          await session.execute(input);
          return sendJSON(response, 200, { ok: true });
        }
        return sendJSON(response, 404, { error: "Unknown endpoint" });
      }
      if (pluginPage && request.method === "GET" && (pathname === "/plugins" || (!session && pathname === "/"))) {
        response.setHeader("Content-Security-Policy", `default-src 'none'; ${pluginPolicy}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(pluginPage);
        return;
      }
      const asset = assets.get(pathname);
      if (!session || request.method !== "GET" || !asset?.[0]) {
        response.writeHead(404); response.end(); return;
      }
      const body = await readFile(asset[0]);
      response.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8` });
      response.end(body);
    } catch (error) {
      if (!response.headersSent) sendJSON(response, 400, { error: error.message });
      else response.end();
    }
  });
  const broadcast = (update) => {
    const record = `data: ${JSON.stringify(update)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > MAX_CLIENT_BUFFER_BYTES) { client.destroy(); clients.delete(client); }
      else client.write(record);
    }
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = randomInt(49152, 65536);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      origin = `http://127.0.0.1:${port}`;
      cookieName = `pi_webui_${port}`;
      break;
    } catch (error) { if (error.code !== "EADDRINUSE" || attempt === 19) throw error; }
  }
  session?.on("update", broadcast);
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n");
    for (const client of pluginClients) client.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  function close() {
    if (closing) return closing;
    clearTimeout(idleTimer);
    clearInterval(heartbeat);
    session?.off("update", broadcast);
    for (const client of clients) client.end();
    clients.clear();
    for (const client of pluginClients) client.end();
    pluginClients.clear();
    closing = new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    return closing;
  }
  scheduleIdleClose();
  return {
    url: `${origin}/#${token}`,
    get closed() { return closing !== undefined; },
    close,
  };
}
