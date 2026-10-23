import { blocks, messageId, applyMessageEvent, groupMessages, finalMessage, isFinalComplete, activityItems, activityLabel, diffLines, linkTarget, findLinks, completionToken, turnStats, workSummary, sessionChanges } from "./view.js";

const $ = (id) => document.getElementById(id);
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_COMPOSER_HEIGHT = 320;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const thinkingNames = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const toolIcons = { bash: "terminal", shell: "terminal", powershell: "terminal", read: "file", write: "pencil", edit: "pencil", grep: "search", find: "search", ls: "folder", web: "globe" };
const LOCAL_COMMANDS = [
  { name: "new", description: "Start a new conversation", action: "new" },
  { name: "model", description: "Pick a model, or type provider/id", action: "model" },
  { name: "thinking", description: "Adjust the thinking level, or type a level name", action: "thinking" },
  { name: "compact", description: "Compact the current context, with optional instructions", action: "compact" },
  { name: "session", description: "Open the inspector for usage details", action: "session" },
  { name: "stop", description: "Stop the current generation", action: "stop" },
  { name: "resume", description: "Switch to an earlier session", action: "resume" },
  { name: "reload", description: "Reload the WebUI, extensions, skills, and settings", action: "reload" },
  { name: "help", description: "Show commands and input hints", action: "help" },
];
const RENDER_INTERVAL_MS = 50;
const ERROR_AUTO_HIDE_MS = 10_000;
const ERROR_FADE_MS = 180;
const WIDE_LAYOUT_QUERY = "(min-width: 1001px)";
const TWO_COLUMN_QUERY = "(min-width: 720px)";
const wideQuery = window.matchMedia(WIDE_LAYOUT_QUERY);
const twoColumnQuery = window.matchMedia(TWO_COLUMN_QUERY);
const isWideLayout = () => wideQuery.matches;
const openDetails = new Map();
const completedGroups = new Map();
const groupNodes = new Map();
const drafts = new Map();
const dialogDrafts = new Map();
let focusedDialogId;
let linkMenuPath;
const toolStartedAt = new Map();
const scrollArea = $("scroll-area");
let state;
let source;
let sessions = [];
let sessionsLoaded = false;
let sessionsRequestId = 0;
let sessionsTimer;
let isConnected = false;
let isSending = false;
let isChanging = false;
let isStopping = false;
let reloadCommandDraft;
let focusComposerAfterRender = false;
let isFollowing = true;
let hasUnread = false;
let isAutoScrolling = false;
let pendingSwitch = false;
let editing;
let savedDraft;
let images = [];
let commands = [];
let stats;
let renderTimer;
let lastRenderAt = 0;
let revision = -1;
let draftVersion = 0;
let draftKey;
let isFullRender = true;
let modelMenuIndex = 0;
let completion = { mode: null, items: [], index: 0, start: 0, end: 0, isLoading: false, error: "" };
let completionRequest = 0;
let completionTimer;
let fileAbort;
let isReloadingPage = false;
let restoredEditor;
let sessionQuery = "";
let resumeIndex = 0;
let sessionsError;
let errorState;
let errorTimer;
let errorToken = 0;
let isErrorClosing = false;
let retryState;
let statusStartedAt;
let lastAnnouncement;
let ticker;
let paletteIndex = 0;
let paletteReturnFocus;
let themeMode = "dark";
let isResumeOpen = false;
let isInspectorOpen = false;
let backdropTimer;
let pendingSessionEnter = false;
let sessionTransitionTimer;
const RELOAD_DRAFT_KEY = "pi-webui-reload-draft";

function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { }
}

async function withReloadDraftStore(action) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("pi-webui", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("reload-drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("reload-drafts", "readwrite");
      const request = action(transaction.objectStore("reload-drafts"));
      let value;
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Could not save the draft"));
    });
  } finally { database.close(); }
}

async function reloadPage() {
  if (isReloadingPage) return;
  isReloadingPage = true;
  try {
    if (reloadCommandDraft) clearCommandDraft(reloadCommandDraft);
    saveDraft();
    const key = sessionStorage.getItem(RELOAD_DRAFT_KEY) ?? crypto.randomUUID();
    const editor = editing ? { sessionId: state.state.sessionId, editing, savedDraft, text: $("input").value, images } : undefined;
    await withReloadDraftStore((store) => store.put({ drafts: [...drafts], editor }, key));
    sessionStorage.setItem(RELOAD_DRAFT_KEY, key);
    source?.close();
    location.reload();
  } catch (error) {
    isReloadingPage = false;
    showError(`Could not save the draft: ${error.message}`);
  }
}

async function restoreReloadDrafts() {
  const key = sessionStorage.getItem(RELOAD_DRAFT_KEY);
  if (!key) return;
  const saved = await withReloadDraftStore((store) => {
    const request = store.get(key);
    store.delete(key);
    return request;
  });
  sessionStorage.removeItem(RELOAD_DRAFT_KEY);
  for (const [id, draft] of saved?.drafts ?? []) drafts.set(id, draft);
  restoredEditor = saved?.editor;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function formatDuration(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function showError(error, tone) {
  clearTimeout(errorTimer);
  errorToken++;
  isErrorClosing = false;
  errorState = error ? { message: error.message ?? String(error), tone: tone ?? "error" } : undefined;
  renderError();
  renderStatus();
  if (!errorState) return;
  const token = errorToken;
  errorTimer = setTimeout(() => {
    if (token !== errorToken) return;
    isErrorClosing = true;
    renderError();
    errorTimer = setTimeout(() => {
      if (token !== errorToken) return;
      isErrorClosing = false;
      errorState = undefined;
      renderError();
      renderStatus();
    }, ERROR_FADE_MS);
    errorTimer.unref?.();
  }, ERROR_AUTO_HIDE_MS);
  errorTimer.unref?.();
}

function renderError() {
  const node = $("conversation-error");
  node.hidden = !errorState;
  node.classList.toggle("is-warning", errorState?.tone === "warning");
  node.classList.toggle("is-closing", isErrorClosing);
  $("conversation-error-text").textContent = errorState?.message ?? "";
}

function toast(message) {
  if (!message) return;
  const node = element("p", "toast", message);
  $("toasts").append(node);
  const timer = setTimeout(() => node.remove(), 4000);
  timer.unref?.();
}

async function request(path, input) {
  const response = await fetch(path, input === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Operation failed");
  return body;
}

function safeURL(value, isImage = false) {
  if (isImage) return /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value);
  try { return ["http:", "https:", "mailto:"].includes(new URL(value, location.origin).protocol); }
  catch { return false; }
}

function attachCopy(button, label, text) {
  button.addEventListener("click", async () => {
    if (!await copyText(text)) return toast("Copy failed");
    label.textContent = "Copied";
    button.classList.add("is-copied");
    setTimeout(() => { label.textContent = "Copy"; button.classList.remove("is-copied"); }, 1500);
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const helper = element("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    return copied;
  }
}

function codeBlock(text, label) {
  const wrapper = element("div", "code-block");
  const head = element("div", "code-head");
  head.append(element("span", "code-lang", label || "Code"));
  const copy = element("button", "copy-button", "Copy");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    if (!await copyText(text)) return toast("Copy failed");
    copy.textContent = "Copied";
    copy.classList.add("is-copied");
    setTimeout(() => { copy.textContent = "Copy"; copy.classList.remove("is-copied"); }, 1500);
  });
  head.append(copy);
  const pre = element("pre");
  pre.textContent = text;
  wrapper.append(head, pre);
  return wrapper;
}

function enhancePre(root) {
  for (const pre of [...root.querySelectorAll("pre")]) {
    if (pre.closest(".code-block")) continue;
    const language = pre.querySelector("code")?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1];
    pre.replaceWith(codeBlock(pre.textContent, language));
  }
}

function openPath(path, { useDefaultApp = false, mode = "open" } = {}) {
  const input = { path };
  if (useDefaultApp) input.app = "default";
  if (mode === "folder") input.mode = "folder";
  void request("/api/open", input).catch((error) => toast(error.message));
}

function openLinkMenu(x, y, path) {
  closePopovers();
  closeCompletion();
  linkMenuPath = path;
  const menu = $("link-menu");
  menu.hidden = false;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  menu.querySelector("button")?.focus({ preventScroll: true });
}

function closeLinkMenu() {
  if ($("link-menu").hidden) return;
  $("link-menu").hidden = true;
  linkMenuPath = undefined;
}

function configureLink(node, target) {
  if (target.path) {
    node.href = "#";
    node.title = `${target.path}\nCtrl/⌘ + click: open in the default app\nRight click: more ways to open`;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPath(target.path, { useDefaultApp: event.ctrlKey || event.metaKey });
    });
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openLinkMenu(event.clientX, event.clientY, target.path);
    });
  } else {
    node.href = target.href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
  }
}

function linkText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest("a, pre, .code-block")) continue;
    const code = node.parentElement.closest("code");
    const whole = code && linkTarget(code.textContent);
    const matches = whole ? [{ index: 0, text: node.textContent, target: whole }] : code ? [] : findLinks(node.textContent);
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      fragment.append(document.createTextNode(node.textContent.slice(offset, match.index)));
      const link = element("a", "content-link", match.text);
      configureLink(link, match.target);
      fragment.append(link);
      offset = match.index + match.text.length;
    }
    fragment.append(document.createTextNode(node.textContent.slice(offset)));
    node.replaceWith(fragment);
  }
}

function markdown(text) {
  const container = element("div", "markdown");
  const template = document.createElement("template");
  template.innerHTML = window.marked.parse(text ?? "", { breaks: true });
  const allowed = new Set(["P", "BR", "STRONG", "EM", "DEL", "S", "CODE", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "A", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
  for (const node of [...template.content.querySelectorAll("*")]) {
    if (!allowed.has(node.tagName)) { node.replaceWith(document.createTextNode(node.textContent)); continue; }
    const target = node.tagName === "A" ? linkTarget(node.getAttribute("href")) : undefined;
    for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
    if (target) configureLink(node, target);
    else if (node.tagName === "A") node.replaceWith(document.createTextNode(node.textContent));
  }
  container.append(template.content);
  enhancePre(container);
  linkText(container);
  return container;
}

function disclosure(key, className, isOpen = false) {
  const details = element("details", className);
  details.open = openDetails.has(key) ? openDetails.get(key) : isOpen;
  const summary = element("summary");
  summary.addEventListener("click", (event) => {
    event.preventDefault();
    details.open = !details.open;
    openDetails.set(key, details.open);
  });
  details.append(summary);
  return details;
}

function openImage(url) {
  const viewer = $("image-viewer");
  viewer.querySelector("img").src = url;
  viewer.showModal();
}

function imageContent(content) {
  const row = element("div", "message-images");
  for (const block of content) {
    if (block.type !== "image") continue;
    const url = `data:${block.mimeType};base64,${block.data}`;
    if (!safeURL(url, true)) continue;
    const image = element("img");
    image.alt = "Message image";
    image.addEventListener("load", () => { if (isFollowing) scrollToBottom(); });
    image.src = url;
    const button = element("button", "message-image");
    button.type = "button";
    button.setAttribute("aria-label", "View image");
    button.append(image);
    button.addEventListener("click", () => openImage(url));
    row.append(button);
  }
  return row;
}

function renderUser(group) {
  const row = element("div", "user-row");
  const content = blocks(group.user);
  const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const bubble = element("div", "user-message", text);
  const timestamp = Number(group.user.timestamp);
  if (Number.isFinite(timestamp)) bubble.title = new Date(timestamp).toLocaleString();
  const pictures = imageContent(content);
  if (pictures.childElementCount) bubble.append(pictures);
  const actions = element("div", "user-actions");
  const copyLabel = element("span", "", "Copy");
  const copy = element("button", "copy-action");
  copy.type = "button";
  copy.title = "Copy this message";
  copy.append(icon("copy"), copyLabel);
  copy.hidden = !text;
  attachCopy(copy, copyLabel, text);
  const edit = element("button", "edit-button");
  edit.type = "button";
  edit.title = "Edit this message and continue from here";
  edit.append(icon("pencil"), document.createTextNode("Edit"));
  edit.hidden = editing === group.user.entryId;
  edit.disabled = !canChange() || !group.user.entryId || isSending || Boolean(editing);
  edit.addEventListener("click", () => {
    const message = state.messages.find((item) => messageId(item) === group.key);
    if (message?.entryId) beginEdit(message);
  });
  actions.append(copy, edit);
  row.append(bubble, actions);
  return row;
}

function renderDiff(diff, path) {
  const preview = codeBlock(diff, path?.split(/[/\\]/).at(-1) || "Diff");
  preview.classList.add("diff-block");
  const pre = preview.querySelector("pre");
  pre.replaceChildren(...diffLines(diff).map((line) => {
    const row = element("span", `diff-line${line.kind === "+" ? " is-added" : line.kind === "-" ? " is-removed" : ""}`);
    row.append(element("span", "diff-number", line.number), element("span", "diff-sign", line.kind), element("span", "diff-text", line.text || " "));
    return row;
  }));
  return preview;
}

function openDiff(path, diffs) {
  $("diff-title").textContent = path;
  const body = $("diff-body");
  const previews = diffs.filter((diff) => typeof diff === "string" && diff);
  if (previews.length) body.replaceChildren(...previews.map((diff) => renderDiff(diff, path)));
  else body.replaceChildren(element("p", "inspect-empty", "No diff to preview"));
  $("diff-dialog").showModal();
}

function renderTool(group, block) {
  const result = group.messages.find((message) => message.role === "toolResult" && message.toolCallId === block.id);
  const live = state.tools?.find((tool) => tool.toolCallId === block.id);
  const details = disclosure(`${group.key}:tool:${block.id}`, "step");
  const summary = details.querySelector("summary");
  summary.append(icon(toolIcons[block.name] ?? "tool"));
  const args = live?.args ?? block.arguments ?? {};
  const path = args.path ?? args.file_path;
  const output = result ?? live?.result ?? live?.partialResult;
  const isDone = Boolean(result || live?.type === "tool_execution_end");
  const isError = result?.isError || live?.isError;
  const isRunning = !isDone && state.state.isStreaming;
  const isWrite = ["write", "edit"].includes(block.name);
  const isShell = ["bash", "shell", "powershell"].includes(block.name);
  const verb = isWrite ? (isDone && !isError ? output?.details?.isNewFile ? "Created" : "Edited" : "Editing") : isShell ? (isDone && !isError ? "Ran" : "Running") : ({ read: "Read", grep: "Searched", find: "Found", ls: "Listed" }[block.name] ?? block.name);
  const title = element("span", "step-title");
  title.append(document.createTextNode(`${verb} `));
  if (path) {
    const file = element("a", "step-file", isWrite ? path.split(/[/\\]/).at(-1) : path);
    configureLink(file, { path });
    title.append(file);
  } else title.append(document.createTextNode(String(args.command ?? args.query ?? args.pattern ?? "").split("\n")[0]));
  summary.title = path ?? args.command ?? block.name;
  summary.append(title);
  const diff = !isError && (output?.details?.diff ?? output?.details?.patch);
  if (typeof diff === "string") {
    const lines = diffLines(diff);
    const counts = element("span", "step-counts");
    counts.append(element("span", "diff-added", `+${lines.filter((line) => line.kind === "+").length}`), element("span", "diff-removed", `-${lines.filter((line) => line.kind === "-").length}`));
    summary.append(counts);
  }
  if (isError || isRunning || !isDone) {
    summary.append(element("span", `step-state${isError ? " is-failed" : isRunning ? " is-running" : ""}`, isError ? "Failed" : isRunning ? "Running" : "Interrupted"));
  }
  if (isRunning) {
    const start = toolStartedAt.get(block.id);
    if (start) {
      const elapsed = element("span", "step-time js-elapsed");
      elapsed.dataset.start = String(start);
      elapsed.textContent = formatDuration(Date.now() - start);
      summary.append(elapsed);
    }
  }
  const body = element("div", "step-content");
  let isLoaded = false;
  const loadContent = () => {
    if (isLoaded) return;
    isLoaded = true;
    const content = output ? blocks(output) : [];
    const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    if (typeof diff === "string") body.append(diff ? renderDiff(diff, path) : element("p", "notice", "File content unchanged"));
    else if (isShell) body.append(codeBlock(`${block.name === "powershell" ? "PS>" : "$"} ${args.command ?? ""}${text ? `\n\n${text}` : ""}`, "Shell"));
    else {
      if (!path && !isWrite) body.append(codeBlock(block.partialArguments ?? JSON.stringify(args, null, 2), "Arguments"));
      if (text) body.append(codeBlock(text, "Output"));
      if (isWrite && !isError && typeof args.content === "string") body.append(codeBlock(args.content, path || "Content"));
    }
    const pictures = imageContent(content);
    if (pictures.childElementCount) body.append(pictures);
  };
  if (details.open) loadContent();
  details.addEventListener("toggle", () => { if (details.open) loadContent(); });
  details.append(body);
  return details;
}

function runningToolLabel(block, args) {
  const name = block.name;
  const path = args.path ?? args.file_path;
  if (["bash", "shell", "powershell"].includes(name)) {
    const command = String(args.command ?? "").split("\n")[0].trim();
    return command ? `Running ${command}` : "Running a command";
  }
  if (["write", "edit"].includes(name)) return path ? `Editing ${path.split(/[/\\]/).at(-1)}` : "Editing a file";
  if (name === "read") return path ? `Reading ${path.split(/[/\\]/).at(-1)}` : "Reading a file";
  if (["grep", "find", "ls"].includes(name)) {
    const query = args.query ?? args.pattern ?? path;
    return query ? `Searching ${query}` : "Searching files";
  }
  return `Calling ${name}`;
}

function liveTool(group) {
  const results = new Set(group.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId));
  let found;
  for (const message of group.messages) {
    if (message.role !== "assistant") continue;
    for (const block of blocks(message)) {
      if (block.type === "toolCall" && !results.has(block.id)) {
        const live = state.tools?.find((tool) => tool.toolCallId === block.id);
        found = { block, live };
      }
    }
  }
  return found;
}

function renderWork(group, isLive) {
  const items = activityItems(group);
  if (!items.length) return;
  const stats = turnStats(group);
  const live = isLive ? liveTool(group) : undefined;
  const details = disclosure(`${group.key}:work`, "work", isLive);
  details.classList.toggle("is-live", isLive);
  const summary = details.querySelector("summary");
  const stateLabel = element("span", "work-label");
  if (live) {
    const args = live.live?.args ?? live.block.arguments ?? {};
    stateLabel.textContent = runningToolLabel(live.block, args);
    const start = toolStartedAt.get(live.block.id) ?? statusStartedAt;
    if (start) {
      const elapsed = element("span", "work-time js-elapsed");
      elapsed.dataset.start = String(start);
      elapsed.textContent = formatDuration(Date.now() - start);
      summary.append(icon("tool"), stateLabel, elapsed);
    } else {
      summary.append(icon("tool"), stateLabel);
    }
    summary.classList.add("is-running");
  } else {
    stateLabel.textContent = workSummary(stats);
    summary.append(icon(stats.edit ? "pencil" : "sparkle"), stateLabel);
    if (stats.failed) summary.append(element("span", "work-failed", `${stats.failed} failed`));
  }
  const body = element("div", "work-body timeline");
  for (const item of items) {
    if (item.type === "text") {
      const text = markdown(item.text);
      text.classList.add("work-text");
      body.append(text);
      continue;
    }
    if (item.thoughts.length) {
      const thought = disclosure(`${group.key}:thinking:${item.key}`, "thought");
      const thoughtSummary = thought.querySelector("summary");
      thoughtSummary.append(icon("sparkle"), document.createTextNode("Thinking"));
      thought.append(element("div", "thinking-body", item.thoughts.join("\n\n")));
      body.append(thought);
    }
    for (const tool of item.tools) body.append(renderTool(group, tool));
  }
  details.append(body);
  return details;
}

function renderChangesCard(group) {
  const changes = sessionChanges(group.messages);
  if (!changes.length) return;
  const card = element("div", "changes-card");
  const head = element("div", "changes-head");
  head.append(element("span", "changes-title", `Changed ${changes.length} ${changes.length === 1 ? "file" : "files"} in this turn`));
  const totals = element("span", "changes-total");
  const added = changes.reduce((sum, file) => sum + file.added, 0);
  const removed = changes.reduce((sum, file) => sum + file.removed, 0);
  totals.append(element("span", "diff-added", `+${added}`), element("span", "diff-removed", `-${removed}`));
  head.append(totals);
  card.append(head);
  for (const file of changes) {
    const row = element("button", "change-row");
    row.type = "button";
    row.title = file.path;
    row.append(icon("file"), element("span", "change-path", file.path));
    row.append(element("span", "diff-added", `+${file.added}`), element("span", "diff-removed", `-${file.removed}`));
    row.addEventListener("click", () => openDiff(file.path, file.diffs));
    card.append(row);
  }
  return card;
}

function renderResponse(group, isLast) {
  const wrapper = element("section", "response");
  const final = finalMessage(group);
  const isComplete = isFinalComplete(group);
  if (isComplete && completedGroups.get(group.key) !== messageId(final)) {
    for (const key of openDetails.keys()) if (key.startsWith(`${group.key}:`) && (key.endsWith(":thinking") || key.includes(":thinking:"))) openDetails.set(key, false);
    if (openDetails.has(`${group.key}:work`)) openDetails.set(`${group.key}:work`, false);
    completedGroups.set(group.key, messageId(final));
  }
  const isLive = !isComplete && isLast;
  const work = renderWork(group, isLive);
  if (work) wrapper.append(work);
  const changes = renderChangesCard(group);
  let lastMarkdown;
  const finalText = final ? blocks(final).filter((block) => block.type === "text").map((block) => block.text).join("\n\n") : "";
  if (final) {
    for (const block of blocks(final)) {
      if (block.type !== "text") continue;
      lastMarkdown = markdown(block.text);
      wrapper.append(lastMarkdown);
    }
    if (final.errorMessage) wrapper.append(element("p", "failed", final.errorMessage));
    else if (final.stopReason === "aborted") wrapper.append(element("p", "notice", "Stopped"));
  }
  if (finalText) {
    const actions = element("div", "message-actions");
    const copy = element("button", "action-button");
    copy.type = "button";
    const label = element("span", "", "Copy");
    copy.append(icon("copy"), label);
    attachCopy(copy, label, finalText);
    actions.append(copy);
    wrapper.append(actions);
  }
  if (changes) wrapper.append(changes);
  if (isLast && state.state.isStreaming && !isComplete && lastMarkdown) {
    const caret = element("span", "stream-caret");
    const target = lastMarkdown.lastElementChild;
    if (target && ["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH"].includes(target.tagName)) target.append(caret);
    else lastMarkdown.append(caret);
  }
  if (isLast && state.state.isStreaming && !isComplete && !finalText && !work) {
    wrapper.append(element("div", "waiting", state.state.isCompacting ? "Compacting context" : "Working"));
  }
  return wrapper;
}

function canChange() {
  return Boolean(state && isConnected && state.isOnline && !state.state.isStreaming && !state.state.isCompacting && !isChanging && !isStopping && !pendingSwitch);
}

function modelOptions() {
  const choices = state?.models ?? [];
  const selected = state?.state.model;
  const options = [...choices];
  if (selected && !options.some((item) => item.id === selected.id && item.provider === selected.provider)) options.unshift(selected);
  return options;
}

function thinkingLevels() {
  return state?.levels ?? [];
}

function isChoicesLocked() {
  return !canChange() || isSending || Boolean(editing);
}

function renderControls() {
  const options = modelOptions();
  const selected = state?.state.model;
  const isLocked = isChoicesLocked();
  const modelName = selected?.name || selected?.id || "Model";
  $("model-name").textContent = modelName;
  $("model-button").title = isLocked ? "Model cannot be changed while a task is running" : selected ? `${modelName} · ${selected.provider}` : "Model";
  $("model-button").disabled = !state || !options.length;
  const levels = thinkingLevels();
  const selectedLevel = state?.state.thinkingLevel;
  const hasThinking = levels.length > 0 && (!selectedLevel || levels.includes(selectedLevel));
  const thinkingName = hasThinking ? (selectedLevel ? thinkingNames[selectedLevel] ?? selectedLevel : "Thinking") : "";
  $("thinking-name").textContent = thinkingName;
  $("thinking-name").hidden = !hasThinking;
  $("model-chip-sep").hidden = !hasThinking;
  $("panel-model").textContent = selected ? modelName : "—";
  $("panel-model").title = selected ? `${selected.provider}/${selected.id}` : "";
  $("panel-thinking").textContent = hasThinking ? (selectedLevel ? thinkingNames[selectedLevel] ?? selectedLevel : "Default") : "—";
  if (!isConnected || !state?.isOnline || isSending || isChanging || isStopping || pendingSwitch || state.state.isCompacting) closeCompletion();
  if (isResumeOpen) {
    const switchable = canSwitchSession();
    for (const item of $("resume-list").querySelectorAll(".resume-item")) item.disabled = !switchable;
  }
  const isRunning = state?.state.isStreaming || state?.state.isCompacting;
  $("stop").hidden = !isRunning;
  const stopText = isStopping ? "Stopping" : "Stop";
  $("stop").setAttribute("aria-label", stopText);
  $("stop").title = stopText;
  $("stop").disabled = !isConnected || isStopping || !state?.isOnline;
  const sendText = editing ? "Continue" : isRunning ? "Queue" : "Send";
  $("send").classList.toggle("is-append", isRunning && !editing);
  $("send-label").textContent = sendText;
  $("send").setAttribute("aria-label", editing ? "Send edit" : isRunning ? "Queue message" : "Send message");
  $("send").title = sendText;
  $("send").disabled = !state || !isConnected || !state.isOnline || isSending || isChanging || isStopping || pendingSwitch || state.state.isCompacting || (!$("input").value.trim() && !images.length);
  $("input").disabled = !isConnected || !state?.isOnline || isSending || pendingSwitch;
  $("input").placeholder = !state ? "Connecting…" : !state.isOnline ? "Pi exited. Restart it in the terminal." : !isConnected ? "Disconnected. Your draft is kept." : pendingSwitch ? "Switching sessions…" : isRunning ? "Queue a message…" : "Send a message…";
  $("cancel-edit").disabled = isSending;
  $("editing").hidden = !editing;
  if (!$("model-menu").hidden) renderModelMenu();
  renderStatus();
}

function fuzzyScore(query, text) {
  if (!query) return 0;
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  if (haystack.startsWith(needle)) return 1;
  if (haystack.includes(needle)) return 2;
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index++;
    if (index === needle.length) return 3;
  }
  return -1;
}

function renderModelMenu() {
  const list = $("model-list");
  const query = $("model-search").value.trim();
  const options = modelOptions();
  const selected = state?.state.model;
  const isLocked = isChoicesLocked();
  const matches = options.map((item) => ({ item, score: fuzzyScore(query, `${item.name || item.id} ${item.provider} ${item.id}`) }))
    .filter(({ score }) => query ? score >= 0 : true);
  if (query) matches.sort((left, right) => left.score - right.score);
  modelMenuIndex = Math.min(modelMenuIndex, Math.max(0, matches.length - 1));
  $("model-panel-count").textContent = `${options.length} ${options.length === 1 ? "model" : "models"}`;
  list.replaceChildren(...(matches.length ? matches.map(({ item }, index) => {
    const button = element("button", "model-item");
    button.type = "button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === modelMenuIndex));
    button.disabled = isLocked;
    if (index === modelMenuIndex) button.classList.add("is-selected");
    if (item.provider === selected?.provider && item.id === selected?.id) button.classList.add("is-current");
    const text = element("span", "model-item-text");
    text.append(element("span", "model-item-name", item.name || item.id));
    text.append(element("span", "model-item-provider", item.provider));
    button.append(text, icon("check"));
    button.addEventListener("click", () => chooseModel(item));
    return button;
  }) : [element("div", "popover-empty", "No matching models")]));
  list.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  renderThinkingMenu();
  $("model-lock").hidden = !isLocked;
}

function renderThinkingMenu() {
  const levels = thinkingLevels();
  const selected = state?.state.thinkingLevel;
  const isLocked = isChoicesLocked();
  const choices = THINKING_LEVELS.filter((level) => levels.includes(level));
  $("thinking-section").hidden = choices.length < 2;
  if ($("thinking-section").hidden) {
    $("thinking-levels").replaceChildren();
    return;
  }
  const name = (level) => thinkingNames[level] ?? level;
  const current = Math.max(0, choices.indexOf(selected));
  const range = element("input", "thinking-range");
  range.type = "range";
  range.min = "0";
  range.max = String(choices.length - 1);
  range.step = "1";
  range.value = String(current);
  range.disabled = isLocked;
  range.setAttribute("aria-label", "Thinking level");
  range.setAttribute("aria-valuetext", name(choices[current]));
  const setProgress = (index) => range.style.setProperty("--progress", `${(index / Math.max(1, choices.length - 1)) * 100}%`);
  setProgress(current);
  $("thinking-value").textContent = name(choices[current]);
  range.addEventListener("input", () => {
    const index = Number(range.value);
    $("thinking-value").textContent = name(choices[index]);
    range.setAttribute("aria-valuetext", name(choices[index]));
    setProgress(index);
  });
  range.addEventListener("change", () => {
    const level = choices[Number(range.value)];
    if (level === selected) return;
    closeModelMenu(true);
    void runChange({ type: "set_thinking_level", level });
  });
  const scale = element("div", "thinking-scale");
  scale.append(
    element("span", "thinking-scale-label", name(choices[0])),
    element("span", "thinking-scale-label", name(choices.at(-1))),
  );
  $("thinking-levels").replaceChildren(range, scale);
}

function openModelMenu(focusThinking = false) {
  if ($("model-button").disabled) return;
  closeAttachMenu();
  closeCompletion();
  $("model-search").value = "";
  const current = modelOptions().findIndex((item) => item.provider === state?.state.model?.provider && item.id === state?.state.model?.id);
  modelMenuIndex = Math.max(0, current);
  renderModelMenu();
  $("model-menu").hidden = false;
  $("model-button").setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    $("model-list").querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
    if (focusThinking) ($("thinking-levels").querySelector(".thinking-range:not(:disabled)") ?? $("model-search")).focus();
    else $("model-search").focus();
  });
}

function closeModelMenu(restoreFocus = false) {
  if ($("model-menu").hidden) return;
  $("model-menu").hidden = true;
  $("model-button").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("model-button").focus();
}

function openAttachMenu() {
  closeModelMenu();
  closeCompletion();
  $("attach-menu").hidden = false;
  $("attach-button").setAttribute("aria-expanded", "true");
}

function closeAttachMenu(restoreFocus = false) {
  if ($("attach-menu").hidden) return;
  $("attach-menu").hidden = true;
  $("attach-button").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("attach-button").focus();
}

function closePopovers(restoreFocus = false) {
  closeModelMenu(restoreFocus);
  closeAttachMenu(restoreFocus);
  closeLinkMenu();
}

function chooseModel(item) {
  closeModelMenu(true);
  if (item.provider === state?.state.model?.provider && item.id === state?.state.model?.id) return;
  void runChange({ type: "set_model", provider: item.provider, modelId: item.id });
}

function formatTokens(value) {
  if (value === null || value === undefined) return "—";
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

function formatCost(value) {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function usageNumbers() {
  const tokens = stats?.tokens ?? {};
  const context = stats?.contextUsage;
  const promptTokens = (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
  const contextPercent = Number.isFinite(context?.percent) ? Math.max(0, Math.min(100, context.percent)) : null;
  const cacheRate = promptTokens > 0 ? Math.round(((tokens.cacheRead ?? 0) / promptTokens) * 100) : null;
  return { tokens, context, contextPercent, cacheRate, promptTokens };
}

function renderStats() {
  const ring = $("usage-ring");
  const { tokens, context, contextPercent, cacheRate, promptTokens } = usageNumbers();
  const hasUsage = (context?.tokens ?? 0) > 0 || promptTokens > 0 || (tokens.output ?? 0) > 0 || (stats?.cost ?? 0) > 0;
  ring.hidden = !state;
  ring.classList.toggle("is-high", contextPercent !== null && contextPercent >= 80 && contextPercent < 95);
  ring.classList.toggle("is-critical", contextPercent !== null && contextPercent >= 95);
  ring.style.setProperty("--usage", `${contextPercent ?? 0}%`);
  $("usage-percent").textContent = contextPercent === null ? "—" : `${Math.round(contextPercent)}%`;
  const usage = $("inspector-usage");
  if (!hasUsage) {
    usage.replaceChildren(element("p", "inspect-empty", "No usage data yet"));
    return;
  }
  const addRow = (label, value, hint) => {
    const line = element("div", "usage-row");
    line.append(element("span", "usage-label", label), element("span", "usage-value", value));
    usage.append(line);
    if (hint) usage.append(element("span", "usage-hint", hint));
  };
  usage.replaceChildren();
  addRow("context", contextPercent === null ? "—" : `${Math.round(contextPercent)}%`, context ? `${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)}` : "");
  if (contextPercent !== null) {
    const meter = element("div", "usage-meter");
    const fill = element("span", `usage-meter-fill${contextPercent >= 80 ? " is-high" : ""}`);
    fill.style.width = `${contextPercent}%`;
    meter.append(fill);
    usage.append(meter);
  }
  addRow("cache", cacheRate === null ? "—" : `${cacheRate}%`, cacheRate === null ? "" : `read ${formatTokens(tokens.cacheRead)} · write ${formatTokens(tokens.cacheWrite)}`);
  addRow("tokens", `${formatTokens(tokens.input)} / ${formatTokens(tokens.output)}`);
  addRow("cost", formatCost(stats.cost));
  if (contextPercent !== null && contextPercent >= 80) {
    const compact = element("button", "compact-button", "Compact context");
    compact.type = "button";
    compact.disabled = !canChange();
    compact.addEventListener("click", () => void runChange({ type: "compact" }));
    usage.append(element("p", "inspect-note", "Context is near its limit. Compacting lets this session continue."), compact);
  }
}

function renderInspectorChanges() {
  const list = $("inspector-changes");
  const changes = state ? sessionChanges(state.messages) : [];
  if (!changes.length) {
    list.replaceChildren(element("p", "inspect-empty", "No file changes in this session yet"));
    return;
  }
  const rows = changes.map((file) => {
    const button = element("button", "inspect-change");
    button.type = "button";
    button.title = file.path;
    button.append(icon("file"), element("span", "inspect-change-path", file.path));
    button.append(element("span", "diff-added", `+${file.added}`), element("span", "diff-removed", `-${file.removed}`));
    button.addEventListener("click", () => openDiff(file.path, file.diffs));
    return button;
  });
  list.replaceChildren(...rows);
}

function renderInspectorDialogs() {
  const section = $("inspector-dialogs");
  const pending = state?.dialogs ?? [];
  section.hidden = !pending.length;
  $("inspector-dialog-list").replaceChildren(...pending.map((dialog) => {
    const row = element("button", "inspect-dialog");
    row.type = "button";
    row.append(icon("alert"), element("span", "", dialog.title || "Needs your confirmation"));
    row.addEventListener("click", () => {
      if (!isWideLayout()) setInspector(false);
      $("dialog-list").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return row;
  }));
}

function renderInspector() {
  renderInspectorChanges();
  renderInspectorDialogs();
  renderStats();
}

function commandItems() {
  const remote = (state?.commands ?? []).map((command) => ({
    ...command,
    sourceLabel: command.source === "extension" ? "Extension" : command.source === "prompt" ? "Template" : command.source === "skill" ? "Skill" : "Command",
    action: null,
  }));
  const localNames = new Set(LOCAL_COMMANDS.map((command) => command.name));
  return [
    ...LOCAL_COMMANDS.map((command) => ({ ...command, sourceLabel: "Built-in" })),
    ...remote.filter((command) => !localNames.has(command.name)),
  ];
}

function clearComposer() {
  $("input").value = "";
  images = [];
  draftVersion++;
  if (draftKey) {
    drafts.delete(draftKey);
    sessionStorage.removeItem(draftKey);
  }
  resizeInput();
  renderImages();
  renderControls();
}

function showResumeError(error) {
  sessionsError = error ? error.message ?? String(error) : undefined;
  const node = $("resume-error");
  node.hidden = !sessionsError;
  node.textContent = sessionsError ?? "";
}

function selectResume(index) {
  const items = [...$("resume-list").querySelectorAll(".resume-item")];
  if (!items.length) return;
  resumeIndex = (index + items.length) % items.length;
  items.forEach((item, itemIndex) => {
    const selected = itemIndex === resumeIndex;
    item.classList.toggle("is-selected", selected);
    item.setAttribute("aria-selected", String(selected));
  });
  items[resumeIndex].scrollIntoView({ block: "nearest" });
}

function activateResume() {
  if (!canSwitchSession()) return;
  const item = $("resume-list").querySelectorAll(".resume-item")[resumeIndex];
  if (item?.dataset.sessionId) void switchSession(item.dataset.sessionId);
}

function openResume() {
  if (isResumeOpen) { $("resume-search").focus({ preventScroll: true }); return; }
  closePopovers();
  closeCompletion();
  isResumeOpen = true;
  $("resume").hidden = false;
  $("resume-search").value = "";
  sessionQuery = "";
  resumeIndex = 0;
  showResumeError(sessionsError);
  renderResume();
  loadSessions({ silent: true });
  requestAnimationFrame(() => $("resume-search").focus({ preventScroll: true }));
}

function closeResume(restoreFocus = false) {
  if (!isResumeOpen) return;
  isResumeOpen = false;
  $("resume").hidden = true;
  $("resume-search").value = "";
  sessionQuery = "";
  $("resume-list").replaceChildren();
  if (restoreFocus) $("input").focus({ preventScroll: true });
}

function setInspector(open) {
  isInspectorOpen = open;
  if (isWideLayout()) writePreference("pi-webui-inspector", open ? "open" : "closed");
  syncLayout();
  if (open) {
    renderInspector();
    $("inspector-close").focus({ preventScroll: true });
  } else $("usage-ring").focus({ preventScroll: true });
}

function toggleInspector() {
  setInspector(!isInspectorOpen);
}

function syncLayout() {
  document.body.classList.toggle("inspector-open", isInspectorOpen);
  $("inspector").toggleAttribute("inert", !isInspectorOpen);
  const backdrop = $("inspector-backdrop");
  const shouldShowBackdrop = isInspectorOpen && !wideQuery.matches;
  clearTimeout(backdropTimer);
  if (shouldShowBackdrop) {
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      if (isInspectorOpen && !wideQuery.matches) backdrop.classList.add("is-visible");
    });
  } else {
    backdrop.classList.remove("is-visible");
    backdropTimer = setTimeout(() => { backdrop.hidden = true; }, 300);
  }
  $("usage-ring").setAttribute("aria-expanded", String(isInspectorOpen));
}

function applyTheme() {
  const isLight = themeMode === "light";
  document.body.classList.toggle("theme-light", isLight);
  document.body.classList.toggle("theme-dark", !isLight);
  const labels = { light: "light", dark: "dark" };
  $("theme-toggle").title = `Theme: ${labels[themeMode]}`;
  $("theme-toggle").setAttribute("aria-label", `Switch theme, currently ${labels[themeMode]}`);
  const use = $("theme-toggle").querySelector("use");
  use?.setAttribute("href", themeMode === "light" ? "#i-sun" : "#i-moon");
  document.querySelector?.('meta[name="theme-color"]')?.setAttribute("content", isLight ? "#f4f0e6" : "#0c0d0f");
}

function cycleTheme() {
  const next = themeMode === "light" ? "dark" : "light";
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!document.startViewTransition || reduceMotion) {
    themeMode = next;
    writePreference("pi-webui-theme", themeMode);
    applyTheme();
    return;
  }
  const rect = $("theme-toggle").getBoundingClientRect();
  const isToggleVisible = isInspectorOpen && rect.width > 0 && rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight;
  const x = isToggleVisible ? rect.left + rect.width / 2 : window.innerWidth - 28;
  const y = isToggleVisible ? rect.top + rect.height / 2 : 28;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const root = document.documentElement;
  root.style.setProperty("--theme-x", `${x}px`);
  root.style.setProperty("--theme-y", `${y}px`);
  root.style.setProperty("--theme-radius", `${radius}px`);
  document.startViewTransition(() => {
    themeMode = next;
    writePreference("pi-webui-theme", themeMode);
    applyTheme();
  });
}

function runLocalAction(action) {
  if (action === "new") return void runChange({ type: "new_session" });
  if (action === "reload") return void runChange({ type: "reload" });
  if (action === "stop") return void runChange({ type: "stop" });
  if (action === "compact") return void runChange({ type: "compact" });
  if (action === "model") return openModelMenu();
  if (action === "thinking") return openModelMenu(true);
  if (action === "resume") return openResume();
  if (action === "session") {
    setInspector(true);
    return;
  }
  if (action === "help") {
    $("input").value = "/";
    $("input").setSelectionRange(1, 1);
    resizeInput();
    renderControls();
    updateCompletion();
    $("input").focus();
  }
}

function clearCommandDraft(commandDraft) {
  const draft = drafts.get(commandDraft.key);
  if (!draft || draft.text !== commandDraft.draft.text || draft.images.length !== commandDraft.draft.images.length ||
    draft.images.some((image, index) => image !== commandDraft.draft.images[index])) return;
  if (draftKey === commandDraft.key) clearComposer();
  else {
    drafts.delete(commandDraft.key);
    sessionStorage.removeItem(commandDraft.key);
  }
}

function runLocalCommand(value) {
  const match = /^\/([a-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(value.trim());
  if (!match) return false;
  const [, name, argument = ""] = match;
  const command = LOCAL_COMMANDS.find((item) => item.name === name);
  if (!command) return false;
  const argumentText = argument.trim();
  let input;
  if (name === "model" && argumentText) {
    const models = modelOptions();
    const model = models.find((item) => `${item.provider}/${item.id}` === argumentText)
      ?? models.find((item) => item.id === argumentText);
    if (!model) {
      showError("Model not found");
      return true;
    }
    input = { type: "set_model", provider: model.provider, modelId: model.id };
  } else if (name === "thinking" && argumentText) {
    const requested = argumentText.toLowerCase();
    const level = thinkingLevels().find((item) => item.toLowerCase() === requested || thinkingNames[item]?.toLowerCase() === requested);
    if (!level) {
      showError("This model does not support that thinking level");
      return true;
    }
    input = { type: "set_thinking_level", level };
  } else if (name === "compact") input = { type: "compact", ...(argumentText ? { instructions: argumentText } : {}) };
  else if (name === "new") input = { type: "new_session" };
  else if (name === "reload" || name === "stop") input = { type: name };
  else {
    clearComposer();
    runLocalAction(command.action);
    return true;
  }
  saveDraft();
  const commandDraft = { key: draftKey, draft: drafts.get(draftKey) };
  if (name === "reload") reloadCommandDraft = commandDraft;
  return runChange(input).then((isSuccessful) => {
    if (isSuccessful) clearCommandDraft(commandDraft);
    return true;
  }).finally(() => {
    if (reloadCommandDraft === commandDraft) reloadCommandDraft = undefined;
  });
}

function closeCompletion() {
  clearTimeout(completionTimer);
  fileAbort?.abort();
  fileAbort = undefined;
  completionRequest++;
  completion = { mode: null, items: [], index: 0, start: 0, end: 0, isLoading: false, error: "" };
  $("completion").hidden = true;
  $("completion-list").replaceChildren();
}

function updateCompletion() {
  const input = $("input");
  if (!state || input.disabled) return closeCompletion();
  const caret = input.selectionStart ?? input.value.length;
  const token = completionToken(input.value, caret);
  if (token?.mode === "command") {
    const query = token.query;
    const items = commandItems().map((item) => {
      const nameScore = fuzzyScore(query, item.name);
      const descriptionScore = fuzzyScore(query, item.description ?? "");
      return { item, score: nameScore >= 0 ? nameScore : descriptionScore >= 0 ? descriptionScore + 3 : -1 };
    })
      .filter(({ score }) => query ? score >= 0 : true)
      .sort((left, right) => left.score - right.score || (left.item.sourceLabel === "Built-in" ? 0 : 1) - (right.item.sourceLabel === "Built-in" ? 0 : 1) || left.item.name.localeCompare(right.item.name))
      .map(({ item }) => item);
    setCompletion("command", items, token.start, token.end);
    return;
  }
  if (token?.mode === "file") {
    const { query, start, end } = token;
    closePopovers();
    if (completion.mode === "file" && $("completion").hidden === false && start === completion.start && query === completion.query) return;
    setCompletion("file", [], start, end);
    completion.query = query;
    completion.isLoading = true;
    renderCompletion();
    clearTimeout(completionTimer);
    fileAbort?.abort();
    const requestId = ++completionRequest;
    const controller = new AbortController();
    fileAbort = controller;
    completionTimer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/files?query=${encodeURIComponent(query)}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not read files");
        if (requestId !== completionRequest || completion.mode !== "file") return;
        completion.items = body.entries ?? [];
        completion.isLoading = false;
        completion.error = "";
        completion.index = 0;
        renderCompletion();
      } catch (error) {
        if (error.name === "AbortError" || requestId !== completionRequest) return;
        completion.items = [];
        completion.isLoading = false;
        completion.error = error.message;
        renderCompletion();
      }
    }, 120);
    return;
  }
  closeCompletion();
}

function setCompletion(mode, items, start, end) {
  closeCompletion();
  closePopovers();
  completion = { mode, items, index: 0, start, end, isLoading: false, error: "" };
  renderCompletion();
}

function renderCompletion() {
  const node = $("completion");
  if (!completion.mode) { node.hidden = true; return; }
  node.hidden = false;
  const list = $("completion-list");
  if (completion.isLoading) {
    list.replaceChildren(element("div", "completion-loading", "Searching files…"));
    return;
  }
  if (completion.error) {
    list.replaceChildren(element("div", "completion-loading", completion.error));
    return;
  }
  if (!completion.items.length) {
    list.replaceChildren(element("div", "completion-loading", completion.mode === "command" ? "No matching commands" : "No matching files"));
    return;
  }
  list.replaceChildren(...completion.items.map((item, index) => {
    const button = element("button", `completion-item${completion.mode === "file" ? " is-file" : ""}`);
    button.type = "button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === completion.index));
    if (index === completion.index) button.classList.add("is-selected");
    const isFile = completion.mode === "file";
    button.append(icon(isFile ? (item.type === "dir" ? "folder" : "file") : (item.action ? "terminal" : "sparkle")));
    const text = element("span", "completion-text");
    text.append(element("span", "completion-label", isFile ? item.path : `/${item.name}${item.argumentHint ? ` ${item.argumentHint}` : ""}`));
    text.append(element("span", "completion-desc", isFile ? (item.type === "dir" ? "Folder" : "File") : item.description || item.name));
    button.append(text);
    if (!isFile && item.sourceLabel) button.append(element("span", "completion-badge", item.sourceLabel));
    button.addEventListener("pointerdown", (event) => { event.preventDefault(); acceptCompletion(index); });
    button.addEventListener("click", (event) => { if (event.detail === 0 && completion.mode) acceptCompletion(index); });
    return button;
  }));
  requestAnimationFrame(() => list.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" }));
}

function moveCompletion(delta) {
  if (!completion.items.length) return;
  completion.index = (completion.index + delta + completion.items.length) % completion.items.length;
  renderCompletion();
}

function acceptCompletion(index = completion.index) {
  const item = completion.items[index];
  if (!item) return;
  if (completion.mode === "command") {
    const input = $("input");
    const tail = input.value.slice(completion.end).replace(/^ /, "");
    closeCompletion();
    const value = `/${item.name} `;
    input.value = value + tail;
    input.setSelectionRange(value.length, value.length);
    resizeInput();
    saveDraft();
    renderControls();
    input.focus();
    return;
  }
  const input = $("input");
  const isDirectory = item.type === "dir";
  const isQuoted = /\s/.test(item.path) || input.value.slice(completion.start, completion.start + 2) === '@"';
  const inserted = isQuoted ? `@"${item.path}${isDirectory ? "/" : '" '}` : `@${item.path}${isDirectory ? "/" : " "}`;
  const value = input.value.slice(0, completion.start) + inserted + input.value.slice(completion.end);
  input.value = value;
  const caret = completion.start + inserted.length;
  input.setSelectionRange(caret, caret);
  resizeInput();
  saveDraft();
  renderControls();
  input.focus();
  if (isDirectory) {
    completion = { ...completion, start: completion.start, end: caret, index: 0 };
    updateCompletion();
  } else closeCompletion();
}

function renderQueue() {
  const queued = [...(state?.queue?.steering ?? []), ...(state?.queue?.followUp ?? [])];
  $("queue").hidden = !queued.length;
  $("queue").replaceChildren(...queued.map((item) => {
    const row = element("p", "queue-item");
    row.append(element("span", "queue-label", "Queued"));
    row.append(document.createTextNode(typeof item === "string" ? item : item.text ?? item.message ?? "Image message"));
    return row;
  }));
}

function historyTitle(session) {
  return session.name?.trim() || session.firstMessage?.trim() || "Empty session";
}

function historyPreview(session) {
  return session.name?.trim() && session.firstMessage?.trim() ? session.firstMessage.trim() : "";
}

function relativeTime(value) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor(Math.max(0, Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const date = new Date(time);
  const options = date.getFullYear() === new Date().getFullYear()
    ? { month: "numeric", day: "numeric" }
    : { year: "numeric", month: "numeric", day: "numeric" };
  return date.toLocaleDateString(undefined, options);
}

function renderResume() {
  const list = $("resume-list");
  const currentId = state?.state.sessionId;
  const query = sessionQuery.trim().toLowerCase();
  const filtered = sessions.filter((session) => session.id !== currentId)
    .filter((session) => !query || `${historyTitle(session)} ${historyPreview(session)}`.toLowerCase().includes(query))
    .sort((left, right) => new Date(right.modified).getTime() - new Date(left.modified).getTime());
  resumeIndex = Math.min(Math.max(resumeIndex, 0), Math.max(0, filtered.length - 1));
  if (!filtered.length) {
    const empty = element("div", "resume-empty");
    if (!sessionsLoaded) {
      empty.append(element("strong", "", "Loading sessions…"));
    } else if (query) {
      empty.append(element("strong", "", "No matching sessions"), element("span", "", "Try another search"));
    } else {
      empty.append(element("strong", "", "No other sessions"), element("span", "", "Type /new to start a conversation"));
    }
    list.replaceChildren(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  filtered.forEach((session, index) => {
    const button = element("button", `resume-item${index === resumeIndex ? " is-selected" : ""}`);
    button.type = "button";
    button.dataset.sessionId = session.id;
    button.dataset.index = String(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === resumeIndex));
    button.disabled = !canSwitchSession();
    const text = element("span", "resume-text");
    text.append(element("span", "resume-title", historyTitle(session)));
    const preview = historyPreview(session);
    if (preview) text.append(element("span", "resume-preview", preview));
    text.append(element("span", "resume-meta", relativeTime(session.modified)));
    button.append(text);
    button.addEventListener("click", () => void switchSession(session.id));
    button.addEventListener("mouseenter", () => selectResume(index));
    fragment.append(button);
  });
  list.replaceChildren(fragment);
  requestAnimationFrame(() => list.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" }));
}

function scheduleSessions(delay = 400) {
  clearTimeout(sessionsTimer);
  sessionsTimer = setTimeout(() => void loadSessions({ silent: true }), delay);
}

function currentSessionName() {
  const current = sessions.find((session) => session.id === state?.state.sessionId);
  const explicit = state?.state.sessionName?.trim() || current?.name?.trim();
  if (explicit) return explicit;
  const listed = current?.firstMessage?.trim();
  if (listed) return listed;
  const firstUser = state?.messages?.find((message) => message.role === "user");
  const text = firstUser ? blocks(firstUser).filter((block) => block.type === "text").map((block) => block.text).join(" ").replace(/\s+/g, " ").trim() : "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function updateSessionTitle() {
  if (!state) return;
  const projectName = state.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Pi";
  const sessionName = currentSessionName();
  const title = sessionName || (state.messages.length ? projectName : "New conversation");
  $("session-title").textContent = title;
  $("session-title").title = title;
  $("session-project").textContent = projectName;
  $("session-project").title = state.cwd;
  $("project-name").textContent = projectName;
  $("project-name").title = state.cwd;
  $("top-session").textContent = title;
  $("top-session").title = title;
  document.title = sessionName ? `${sessionName} · ${projectName}` : `${projectName} · Pi`;
}

async function loadSessions({ silent = false } = {}) {
  const requestId = ++sessionsRequestId;
  if (!silent && isResumeOpen) $("resume-list").setAttribute("aria-busy", "true");
  try {
    const { sessions: list } = await request("/api/sessions");
    if (requestId !== sessionsRequestId) return;
    sessions = Array.isArray(list) ? list : [];
    sessionsLoaded = true;
    showResumeError();
    updateSessionTitle();
    if (isResumeOpen) renderResume();
  } catch (error) {
    if (requestId === sessionsRequestId) {
      sessionsLoaded = true;
      showResumeError(error);
      if (isResumeOpen) renderResume();
    }
  } finally {
    if (requestId === sessionsRequestId && isResumeOpen) $("resume-list").setAttribute("aria-busy", "false");
  }
}

function canSwitchSession() {
  return Boolean(state) && canChange() && !isSending && !editing && !isChanging && !pendingSwitch;
}

async function switchSession(sessionId) {
  if (isChanging || pendingSwitch || sessionId === state?.state.sessionId) return;
  if (!canSwitchSession()) return;
  saveDraft();
  beginSessionTransition();
  closeResume(true);
  isChanging = true;
  pendingSwitch = true;
  renderControls();
  try {
    await request("/api/command", { type: "switch_session", sessionId });
  } catch (error) {
    pendingSwitch = false;
    endSessionTransition();
    showError(error);
  } finally {
    isChanging = false;
    focusComposerAfterRender = true;
    scheduleRender();
  }
}

function updateScrollButton() {
  const button = $("scroll-bottom");
  button.hidden = isFollowing;
  button.classList.toggle("has-unread", hasUnread);
  button.querySelector("span").textContent = hasUnread ? "New messages" : "Back to bottom";
}

function scrollToBottom(behavior = "auto") {
  if (behavior === "smooth") isAutoScrolling = true;
  scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior });
}

function beginSessionTransition() {
  const node = $("conversation");
  if (!node.childElementCount) return;
  node.classList.remove("is-session-entering");
  node.classList.add("is-session-leaving");
  clearTimeout(sessionTransitionTimer);
  sessionTransitionTimer = setTimeout(endSessionTransition, 1500);
}

function endSessionTransition() {
  clearTimeout(sessionTransitionTimer);
  $("conversation").classList.remove("is-session-leaving");
}

function playSessionEnter() {
  endSessionTransition();
  const node = $("conversation");
  if (!node.childElementCount) return;
  node.classList.remove("is-session-entering");
  void node.offsetWidth;
  node.classList.add("is-session-entering");
  node.addEventListener("animationend", () => node.classList.remove("is-session-entering"), { once: true });
}

function renderEmpty() {
  const empty = element("div", "empty");
  empty.append(element("h2", "empty-title", "What do you want to do?"));
  empty.append(element("p", "empty-hint", "Describe the task, or type / to see available commands."));
  return empty;
}

function renderRunHead(group, index) {
  const head = element("div", "run-head");
  head.append(element("span", "run-index", `turn ${String(index + 1).padStart(2, "0")}`));
  const timestamp = Number(group.user?.timestamp);
  if (Number.isFinite(timestamp)) {
    head.append(element("span", "run-time", new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })));
  }
  head.append(element("span", "run-rule"));
  return head;
}

function render() {
  lastRenderAt = performance.now();
  renderTimer = undefined;
  if (!state) { renderControls(); return; }
  updateSessionTitle();
  const wasFollowing = isFollowing;
  const heightBefore = scrollArea.scrollHeight;
  const groups = groupMessages(state.messages);
  if (isFullRender) { $("conversation").replaceChildren(); groupNodes.clear(); }
  if (!groups.length && !$("conversation").childElementCount) $("conversation").append(renderEmpty());
  if (groups.length && $("conversation").querySelector(".empty")) $("conversation").replaceChildren();
  const editingIndex = editing ? groups.findIndex((group) => group.user?.entryId === editing) : -1;
  groups.forEach((group, index) => {
    let root = groupNodes.get(group.key);
    if (!root) {
      if (!groupNodes.size) $("conversation").replaceChildren();
      root = element("div", "turn");
      groupNodes.set(group.key, root);
      $("conversation").append(root);
      if (group.user) {
        root.append(renderRunHead(group, index));
        root.append(renderUser(group));
      }
    }
    root.classList.toggle("is-editing", Boolean(editing && group.user?.entryId === editing));
    root.classList.toggle("is-faded", editingIndex >= 0 && index > editingIndex);
    const edit = root.querySelector(".edit-button");
    if (edit) {
      edit.hidden = editing === group.user.entryId;
      edit.disabled = !canChange() || !group.user.entryId || isSending || Boolean(editing);
    }
    const isLast = index === groups.length - 1;
    const isUnsettled = Boolean(root.querySelector(".waiting, .stream-caret"));
    if (isFullRender || !root.querySelector(".response") || isLast || isUnsettled) {
      const response = renderResponse(group, isLast);
      const previous = root.querySelector(".response");
      if (previous) previous.replaceWith(response); else root.append(response);
    }
  });
  isFullRender = false;
  if (pendingSessionEnter) {
    pendingSessionEnter = false;
    playSessionEnter();
  }
  if (wasFollowing) scrollToBottom();
  else if (scrollArea.scrollHeight > heightBefore + 4) hasUnread = true;
  updateScrollButton();
  renderControls();
  renderQueue();
  if (focusComposerAfterRender) {
    focusComposerAfterRender = false;
    $("input").focus({ preventScroll: true });
  }
  renderDialogs();
  renderInspector();
  renderStatus();
  renderError();
  updateDialogJump();
}

function scheduleRender() {
  if (renderTimer) return;
  const wait = Math.max(0, RENDER_INTERVAL_MS - (performance.now() - lastRenderAt));
  renderTimer = setTimeout(() => { renderTimer = undefined; render(); }, wait);
}

function formatStatusElapsed() {
  return statusStartedAt ? formatDuration(Date.now() - statusStartedAt) : "";
}

function computeStatus() {
  if (!isConnected) return { tone: "reconnecting", label: state ? "Reconnecting" : "Connecting" };
  if (!state) return { tone: "idle", label: "Syncing" };
  if (!state.isOnline) return { tone: "offline", label: "Exited" };
  if (retryState) return { tone: "retrying", label: "Retrying" };
  if ((state.dialogs ?? []).length) return { tone: "waiting", label: "Waiting for you" };
  if (state.state.isCompacting) return { tone: "busy", label: "Compacting" };
  if (state.state.isStreaming) return { tone: "busy", label: `Working${statusStartedAt ? ` · ${formatStatusElapsed()}` : ""}` };
  if (errorState) return { tone: "error", label: "Error" };
  return { tone: "idle", label: "Ready" };
}

function renderStatus() {
  const status = computeStatus();
  const pill = $("status-pill");
  pill.className = `status-pill is-${status.tone}`;
  $("status-label").textContent = status.label;
  const announcement = status.tone === "busy" ? (state?.state.isCompacting ? "Compacting" : "Working") : status.label;
  if (announcement !== lastAnnouncement) {
    lastAnnouncement = announcement;
    $("status-announcer").textContent = announcement;
  }
  const banner = $("retry-banner");
  banner.hidden = !retryState;
  if (retryState) $("retry-text").textContent = `Retrying (${retryState.attempt}/${retryState.maxAttempts}): ${retryState.message}`;
  const queueCount = (state?.queue?.steering?.length ?? 0) + (state?.queue?.followUp?.length ?? 0);
  const dialogCount = state?.dialogs?.length ?? 0;
  $("stat-queue").textContent = String(queueCount);
  $("stat-queue").classList.toggle("is-warn", queueCount > 0);
  $("stat-dialog").textContent = String(dialogCount);
  $("stat-dialog").classList.toggle("is-warn", dialogCount > 0);
  const isOnline = Boolean(isConnected && state?.isOnline);
  $("conn-state").classList.toggle("is-offline", !isOnline);
  $("conn-label").textContent = !isConnected ? "reconnecting" : !state ? "connecting" : state.isOnline ? (window.location?.host || "local") : "offline";
  $("foot-status").textContent = isOnline ? "connected" : isConnected ? "offline" : "reconnecting";
  $("foot-status").classList.toggle("is-offline", !isOnline);
}

function ensureTicker() {
  if (ticker || typeof setInterval !== "function") return;
  ticker = setInterval(() => {
    renderStatus();
    for (const node of document.querySelectorAll(".js-elapsed")) {
      const start = Number(node.dataset.start);
      if (Number.isFinite(start)) node.textContent = formatDuration(Date.now() - start);
    }
    if (!state?.state.isStreaming && !state.state.isCompacting) stopTicker();
  }, 1000);
  ticker.unref?.();
}

function stopTicker() {
  if (!ticker) return;
  clearInterval(ticker);
  ticker = undefined;
}

function receive(envelope) {
  const event = envelope.event;
  if (event.type === "snapshot") {
    const snapshot = event.snapshot;
    if (state && snapshot.runtimeId !== undefined && state.runtimeId !== snapshot.runtimeId) {
      void reloadPage();
      return;
    }
    const nextRevision = envelope.revision ?? snapshot.revision;
    if (nextRevision < revision) return;
    revision = nextRevision;
    const hadState = Boolean(state);
    const previousCount = state?.messages.length ?? 0;
    const isNewSession = state?.state.sessionId !== snapshot.state.sessionId;
    if (isNewSession) {
      pendingSessionEnter = hadState;
      saveDraft();
      pendingSwitch = false;
      editing = undefined;
      savedDraft = undefined;
      $("input").value = "";
      images = [];
      draftVersion++;
      openDetails.clear();
      completedGroups.clear();
      isFollowing = true;
      hasUnread = false;
      errorState = undefined;
      retryState = undefined;
      closePopovers();
      closeCompletion();
      closeResume(false);
      focusComposerAfterRender = hadState;
    }
    state = snapshot;
    state.dialogs ??= [];
    state.tools ??= [];
    state.queue ??= { steering: [], followUp: [] };
    commands = snapshot.commands ?? [];
    stats = snapshot.stats;
    isFullRender = !hadState || isNewSession || previousCount > snapshot.messages.length;
    if (state.state.isStreaming) {
      statusStartedAt ??= Date.now();
      ensureTicker();
    } else {
      statusStartedAt = undefined;
      stopTicker();
    }
    for (const tool of state.tools) if (!toolStartedAt.has(tool.toolCallId)) toolStartedAt.set(tool.toolCallId, Date.now());
    if (isNewSession) {
      draftKey = `pi-webui-draft:${snapshot.state.sessionId}`;
      loadDraft();
      if (restoredEditor?.sessionId === snapshot.state.sessionId) {
        ({ editing, savedDraft, images } = restoredEditor);
        $("input").value = restoredEditor.text;
      }
      restoredEditor = undefined;
      renderImages();
      resizeInput();
      scheduleSessions(250);
    }
    if (snapshot.error) showError(snapshot.error);
    syncLayout();
    scheduleRender();
    return;
  }
  if (!state || envelope.revision <= revision) return;
  revision = envelope.revision;
  applyMessageEvent(state.messages, event);
  if (event.type === "agent_start") {
    state.state.isStreaming = true;
    statusStartedAt = Date.now();
    errorState = undefined;
    ensureTicker();
  }
  if (event.type === "message_start") updateSessionTitle();
  if (event.type === "agent_settled") {
    state.state.isStreaming = false;
    statusStartedAt = undefined;
    retryState = undefined;
    stopTicker();
    scheduleSessions(600);
  }
  if (event.type === "compaction_start") state.state.isCompacting = true;
  if (event.type === "compaction_end") {
    state.state.isCompacting = false;
    isFullRender = true;
    if (event.errorMessage) showError(event.errorMessage);
  }
  if (event.type === "queue_update") state.queue = { steering: event.steering, followUp: event.followUp };
  if (event.type.startsWith("tool_execution_")) {
    if (event.type === "tool_execution_start") toolStartedAt.set(event.toolCallId, Date.now());
    const index = state.tools.findIndex((tool) => tool.toolCallId === event.toolCallId);
    if (index < 0) state.tools.push(event); else state.tools[index] = { ...state.tools[index], ...event };
  }
  if (event.type === "extension_error") showError(event.error);
  if (event.type === "connection_error") { showError(event.error); state.isOnline = false; }
  if (event.type === "auto_retry_start") {
    retryState = { attempt: event.attempt, maxAttempts: event.maxAttempts, message: event.errorMessage };
  }
  if (event.type === "auto_retry_end") {
    retryState = undefined;
    if (!event.success) showError(event.finalError);
  }
  if (event.type === "extension_ui_request") {
    if (["confirm", "select", "input", "editor"].includes(event.method)) {
      state.dialogs.push(event);
      renderStatus();
    }
    if (event.method === "notify") toast(event.message);
    if (event.method === "set_editor_text" && !editing && !$("input").value) {
      $("input").value = event.text ?? "";
      draftVersion++;
      resizeInput();
      saveDraft();
    }
  }
  if (event.type === "dialog_closed") {
    state.dialogs = state.dialogs.filter((item) => item.id !== event.id);
    dialogDrafts.delete(event.id);
  }
  renderStatus();
  scheduleRender();
}

function renderImages() {
  $("attachments").replaceChildren(...images.map((image, index) => {
    const chip = element("div", "attachment");
    const preview = element("img");
    preview.src = `data:${image.mimeType};base64,${image.data}`;
    preview.alt = `Image ${index + 1}`;
    const remove = element("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove image ${index + 1}`);
    remove.append(icon("x"));
    remove.disabled = isSending;
    remove.addEventListener("click", () => { images.splice(index, 1); draftVersion++; saveDraft(); renderImages(); renderControls(); });
    chip.append(preview, remove);
    return chip;
  }));
}

function resizeInput() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
}

function saveDraft() {
  if (editing || !draftKey) return;
  drafts.set(draftKey, { text: $("input").value, images: [...images] });
  sessionStorage.setItem(draftKey, $("input").value);
}

function loadDraft() {
  const saved = drafts.get(draftKey);
  $("input").value = saved?.text ?? sessionStorage.getItem(draftKey) ?? "";
  images = [...(saved?.images ?? [])];
}

function beginEdit(message) {
  if (!editing) {
    saveDraft();
    savedDraft = { text: $("input").value, images };
  }
  editing = message.entryId;
  $("input").value = blocks(message).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  images = blocks(message).filter((block) => block.type === "image").map((image) => ({ ...image }));
  draftVersion++;
  resizeInput();
  renderImages();
  renderControls();
  scheduleRender();
  $("input").focus({ preventScroll: true });
  $("input").setSelectionRange($("input").value.length, $("input").value.length);
}

function cancelEdit() {
  editing = undefined;
  $("input").value = savedDraft?.text ?? "";
  images = savedDraft?.images ?? [];
  savedDraft = undefined;
  draftVersion++;
  renderImages();
  renderControls();
  resizeInput();
  scheduleRender();
  saveDraft();
}

async function runChange(input) {
  const isStop = input.type === "stop";
  if (isStop ? isStopping : isChanging || isStopping) return false;
  const isSessionSwitch = input.type === "new_session";
  if (isStop) isStopping = true;
  else isChanging = true;
  if (isSessionSwitch) beginSessionTransition();
  closeResume(false);
  closePopovers();
  closeCompletion();
  showError();
  renderControls();
  try {
    await request("/api/command", input);
    scheduleSessions(250);
    return true;
  } catch (error) {
    if (isSessionSwitch) endSessionTransition();
    showError(error);
    return false;
  } finally {
    if (isStop) isStopping = false;
    else isChanging = false;
    scheduleRender();
  }
}

async function submit() {
  if ($("send").disabled) return;
  if (!editing) {
    const command = runLocalCommand($("input").value);
    if (command) return command;
  }
  closePopovers();
  closeCompletion();
  const input = { type: editing ? "edit" : "prompt", entryId: editing, message: $("input").value, images };
  const sentDraftKey = draftKey;
  isSending = true;
  isFollowing = true;
  hasUnread = false;
  showError();
  renderImages();
  renderControls();
  updateScrollButton();
  try {
    await request("/api/command", input);
    if (input.type === "edit") {
      if (editing === input.entryId) cancelEdit();
    } else {
      if (draftKey === sentDraftKey) clearComposer();
      else if (sentDraftKey) {
        drafts.delete(sentDraftKey);
        sessionStorage.removeItem(sentDraftKey);
      }
    }
    scrollToBottom("smooth");
  } catch (error) {
    if (input.type === "edit") {
      try {
        const snapshot = await request("/api/snapshot");
        receive({ event: { type: "snapshot", snapshot } });
      } catch (syncError) {
        error = new Error(`${error.message}\nCould not sync the conversation: ${syncError.message}`);
      }
      $("input").value = input.message;
      images = [...input.images];
      draftVersion++;
      saveDraft();
      resizeInput();
    }
    showError(error);
  }
  finally {
    isSending = false;
    renderImages();
    scheduleRender();
    $("input").focus();
  }
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image"));
    reader.onload = () => resolve({ type: "image", mimeType: file.type, data: reader.result.split(",")[1] });
    reader.readAsDataURL(file);
  });
}

async function addImages(files) {
  if (!files.length || isSending || !isConnected) return;
  if (images.length + files.length > MAX_IMAGES) return showError(`A message can include at most ${MAX_IMAGES} images`);
  if (files.some((file) => !IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES)) return showError("Use PNG, JPEG, WebP, or GIF, up to 10 MB each");
  const version = draftVersion;
  try {
    const added = await Promise.all(files.map(readImage));
    if (version !== draftVersion) return showError("The input changed. Paste the image again.");
    images = [...images, ...added];
    draftVersion++;
    saveDraft();
    renderImages();
    renderControls();
  } catch (error) { showError(error); }
}

function renderDialogCard(dialog) {
  const card = element("article", "dialog-card");
  card.dataset.id = dialog.id;
  const head = element("div", "dialog-head");
  head.append(icon("alert"), element("span", "dialog-eyebrow", "Needs your confirmation"));
  card.append(head);
  card.append(element("h3", "dialog-title", dialog.title || "Pi"));
  if (dialog.message) card.append(element("p", "dialog-message", dialog.message));
  let textarea;
  if (["input", "editor"].includes(dialog.method)) {
    textarea = element("textarea", "dialog-input");
    textarea.rows = dialog.method === "editor" ? 6 : 3;
    textarea.placeholder = dialog.placeholder ?? "";
    textarea.value = dialogDrafts.get(dialog.id) ?? dialog.prefill ?? "";
    textarea.addEventListener("input", () => dialogDrafts.set(dialog.id, textarea.value));
    card.append(textarea);
  }
  if (dialog.method === "select") {
    const options = element("div", "dialog-options");
    for (const value of dialog.options ?? []) {
      const button = element("button", "dialog-option", value);
      button.type = "button";
      button.addEventListener("click", () => void answerDialog({ value }, dialog.id));
      options.append(button);
    }
    card.append(options);
  }
  const actions = element("div", "dialog-actions");
  const cancel = element("button", "dialog-cancel", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => void answerDialog({ cancelled: true }, dialog.id));
  actions.append(cancel);
  if (dialog.method !== "select") {
    const confirm = element("button", "dialog-confirm", "Confirm");
    confirm.type = "button";
    confirm.addEventListener("click", () => void answerDialog({ confirmed: true, value: textarea?.value ?? "" }, dialog.id));
    actions.append(confirm);
  }
  card.append(actions);
  return card;
}

function renderDialogs() {
  const list = $("dialog-list");
  const pending = state?.dialogs ?? [];
  list.replaceChildren(...pending.map(renderDialogCard));
  document.body.classList.toggle("has-dialog", pending.length > 0);
  if (pending.length && pending[0].id !== focusedDialogId) {
    focusedDialogId = pending[0].id;
    requestAnimationFrame(() => {
      const card = list.querySelector(".dialog-card");
      if (!card) return;
      const field = card.querySelector("textarea");
      if (field) field.focus({ preventScroll: true });
      else {
        card.tabIndex = -1;
        card.focus({ preventScroll: true });
      }
    });
  }
  if (!pending.length) focusedDialogId = undefined;
  updateDialogJump();
  if (pending.length && !editing) {
    const scroll = scrollArea;
    const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    if (isFollowing || distance < 120) requestAnimationFrame(() => list.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }
}

function updateDialogJump() {
  const button = $("dialog-jump");
  const count = state?.dialogs?.length ?? 0;
  if (!count || !twoColumnQuery.matches) {
    button.hidden = true;
    return;
  }
  const card = $("dialog-list").querySelector(".dialog-card");
  const rect = card?.getBoundingClientRect?.();
  const isVisible = rect && rect.top < window.innerHeight - 150;
  button.hidden = Boolean(isVisible);
  button.querySelector("span").textContent = count === 1 ? "1 confirmation pending" : `${count} confirmations pending`;
}

async function answerDialog(answer, dialogId = state?.dialogs?.[0]?.id) {
  const dialog = state?.dialogs?.find((item) => item.id === dialogId);
  if (!dialog) return;
  try { await request("/api/command", { type: "dialog_response", id: dialog.id, ...answer }); }
  catch (error) { showError(error); }
}

function trapInspectorFocus(event) {
  if (event.key !== "Tab") return;
  const drawer = isInspectorOpen && !wideQuery.matches ? $("inspector") : undefined;
  if (!drawer) return;
  const nodes = [...drawer.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)")].filter((node) => node.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function paletteEntries() {
  const entries = [
    { id: "new", label: "New conversation", hint: "Action", icon: "plus", run: () => void runChange({ type: "new_session" }) },
    { id: "compact", label: "Compact context", hint: "Action", icon: "tool", run: () => void runChange({ type: "compact" }) },
    { id: "reload", label: "Reload WebUI", hint: "Action", icon: "refresh", run: () => void runChange({ type: "reload" }) },
    { id: "theme", label: `Theme: ${themeMode === "light" ? "light" : "dark"}`, hint: "Switch theme", icon: themeMode === "light" ? "sun" : "moon", run: cycleTheme },
    { id: "inspector", label: isInspectorOpen ? "Hide inspector" : "Show inspector", hint: "Layout", icon: "panel", run: toggleInspector },
  ];
  for (const session of sessions) {
    entries.push({ id: `session:${session.id}`, label: historyTitle(session), hint: "Switch session", icon: "message", run: () => void switchSession(session.id) });
  }
  for (const model of modelOptions()) {
    entries.push({ id: `model:${model.provider}/${model.id}`, label: model.name || model.id, hint: model.provider, icon: "sparkle", run: () => void runChange({ type: "set_model", provider: model.provider, modelId: model.id }) });
  }
  return entries;
}

function renderPalette() {
  const query = $("palette-input").value.trim();
  const entries = paletteEntries()
    .map((entry) => ({ entry, score: fuzzyScore(query, `${entry.label} ${entry.hint}`) }))
    .filter(({ score }) => query ? score >= 0 : true)
    .sort((left, right) => left.score - right.score);
  paletteIndex = Math.min(paletteIndex, Math.max(0, entries.length - 1));
  $("palette-list").replaceChildren(...(entries.length ? entries.map(({ entry }, index) => {
    const button = element("button", `palette-item${index === paletteIndex ? " is-selected" : ""}`);
    button.type = "button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === paletteIndex));
    button.append(icon(entry.icon), element("span", "palette-label", entry.label), element("span", "palette-hint", entry.hint));
    button.addEventListener("click", () => {
      closePalette();
      entry.run();
    });
    return button;
  }) : [element("div", "popover-empty", "No matching commands")]));
  requestAnimationFrame(() => $("palette-list").querySelector(".is-selected")?.scrollIntoView({ block: "nearest" }));
  return entries;
}

function openPalette() {
  if (!$("palette").hidden) return;
  closePopovers();
  closeResume(true);
  closeCompletion();
  paletteReturnFocus = document.activeElement;
  $("palette").hidden = false;
  $("palette-input").value = "";
  paletteIndex = 0;
  renderPalette();
  $("palette-input").focus();
}

function closePalette() {
  if ($("palette").hidden) return;
  $("palette").hidden = true;
  $("palette-list").replaceChildren();
  if (paletteReturnFocus instanceof HTMLElement) paletteReturnFocus.focus();
}

function insertToken(token) {
  const input = $("input");
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + token + input.value.slice(end);
  const caret = start + token.length;
  input.setSelectionRange(caret, caret);
  resizeInput();
  saveDraft();
  renderControls();
  input.focus();
  updateCompletion();
}

function handleLayoutChange() {
  const wide = wideQuery.matches;
  isInspectorOpen = wide && readPreference("pi-webui-inspector") !== "closed";
  syncLayout();
  renderInspector();
  scheduleRender();
}

function focusComposerFromTyping(event) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.length !== 1) return;
  if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  if (event.key === " " && event.target instanceof Element && event.target.closest("button, a, summary, [role='button'], [role='menuitem'], [role='option']")) return;
  if (!$("palette").hidden || isResumeOpen || !$("model-menu").hidden || !$("attach-menu").hidden || !$("link-menu").hidden || $("image-viewer").open || $("diff-dialog").open) return;
  const input = $("input");
  if (input.disabled) return;
  input.focus({ preventScroll: true });
}

scrollArea.addEventListener("scroll", () => {
  closeLinkMenu();
  const distance = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
  const wasFollowing = isFollowing;
  if (distance < 120) { isFollowing = true; isAutoScrolling = false; }
  else if (!isAutoScrolling) isFollowing = false;
  if (isFollowing && !wasFollowing) hasUnread = false;
  updateScrollButton();
  updateDialogJump();
}, { passive: true });
scrollArea.addEventListener("wheel", () => { isAutoScrolling = false; }, { passive: true });
scrollArea.addEventListener("touchmove", () => { isAutoScrolling = false; }, { passive: true });

$("scroll-bottom").addEventListener("click", () => {
  isFollowing = true;
  hasUnread = false;
  updateScrollButton();
  scrollToBottom("smooth");
});

$("dialog-jump").addEventListener("click", () => {
  $("dialog-list").scrollIntoView({ behavior: "smooth", block: "center" });
});

$("input").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.items ?? [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  void addImages(files);
});
$("input").addEventListener("input", () => {
  resizeInput();
  saveDraft();
  renderControls();
  updateCompletion();
});
$("input").addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (completion.mode) {
    if (event.key === "ArrowDown") { event.preventDefault(); moveCompletion(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); moveCompletion(-1); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCompletion(); return; }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.isComposing)) {
      event.preventDefault();
      if (completion.items.length) acceptCompletion(); else closeCompletion();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); }
});
document.addEventListener("selectionchange", () => { if (document.activeElement === $("input") && !completion.isLoading) updateCompletion(); });
$("composer").addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  $("composer").classList.add("is-dragover");
});
$("composer").addEventListener("dragleave", (event) => {
  if (!$("composer").contains(event.relatedTarget)) $("composer").classList.remove("is-dragover");
});
$("composer").addEventListener("drop", (event) => {
  event.preventDefault();
  $("composer").classList.remove("is-dragover");
  void addImages([...event.dataTransfer.files].filter((file) => file.type.startsWith("image/")));
});
$("composer").addEventListener("submit", (event) => { event.preventDefault(); void submit(); });

document.addEventListener("keydown", (event) => {
  focusComposerFromTyping(event);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if ($("palette").hidden) openPalette(); else closePalette();
    return;
  }
  trapInspectorFocus(event);
  if (event.key !== "Escape") return;
  if (!$("palette").hidden) { event.preventDefault(); closePalette(); return; }
  if (!$("link-menu").hidden) { event.preventDefault(); closeLinkMenu(); return; }
  if (completion.mode) { event.preventDefault(); closeCompletion(); return; }
  if (!$("model-menu").hidden || !$("attach-menu").hidden) {
    event.preventDefault();
    closePopovers(true);
    return;
  }
  if (isResumeOpen) { event.preventDefault(); closeResume(true); return; }
  if (isInspectorOpen && !wideQuery.matches) { event.preventDefault(); setInspector(false); return; }
  if (!editing || $("image-viewer").open || $("diff-dialog").open) return;
  event.preventDefault();
  cancelEdit();
});
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("#link-menu")) return;
  closeLinkMenu();
  if (!event.target.closest(".popover-anchor")) closePopovers();
  if (!event.target.closest("#completion") && event.target !== $("input")) closeCompletion();
  if (isResumeOpen && !event.target.closest("#resume")) closeResume(false);
});

window.addEventListener("resize", resizeInput);
window.addEventListener("resize", closeLinkMenu);
window.addEventListener("beforeunload", () => { source?.close(); saveDraft(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && isConnected) scheduleSessions(0); });
$("resume-close").addEventListener("click", () => closeResume(true));
$("resume-search").addEventListener("input", () => {
  sessionQuery = $("resume-search").value;
  resumeIndex = 0;
  renderResume();
});
$("resume").addEventListener("keydown", (event) => {
  if (event.isComposing || event.target.closest("#resume-close")) return;
  if (event.key === "ArrowDown") { event.preventDefault(); selectResume(resumeIndex + 1); return; }
  if (event.key === "ArrowUp") { event.preventDefault(); selectResume(resumeIndex - 1); return; }
  if (event.key === "Enter") { event.preventDefault(); activateResume(); }
});
$("theme-toggle").addEventListener("click", cycleTheme);
$("inspector-close").addEventListener("click", () => setInspector(false));
$("inspector-backdrop").addEventListener("click", () => setInspector(false));
$("usage-ring").addEventListener("click", toggleInspector);

$("image-viewer").addEventListener("click", (event) => {
  if (event.target === $("image-viewer") || event.target.closest(".viewer-close")) $("image-viewer").close();
});
$("image-viewer").addEventListener("close", () => $("image-viewer").querySelector("img").removeAttribute("src"));
$("diff-dialog").querySelector(".dialog-close").addEventListener("click", () => $("diff-dialog").close());
$("diff-dialog").addEventListener("click", (event) => { if (event.target === $("diff-dialog")) $("diff-dialog").close(); });

$("cancel-edit").addEventListener("click", cancelEdit);
$("stop").addEventListener("click", () => void runChange({ type: "stop" }));
$("model-button").addEventListener("click", () => {
  if ($("model-menu").hidden) openModelMenu(); else closeModelMenu(true);
});
$("attach-button").addEventListener("click", () => {
  if ($("attach-menu").hidden) openAttachMenu(); else closeAttachMenu(true);
});
$("attach-menu").addEventListener("click", (event) => {
  const action = event.target.closest("[data-insert]")?.dataset.insert;
  if (!action) return;
  closeAttachMenu();
  if (action === "image") $("image-input").click();
  else insertToken(action === "file" ? "@" : "/");
});
$("link-menu").addEventListener("click", (event) => {
  const action = event.target.closest("[data-link-action]")?.dataset.linkAction;
  if (!action || !linkMenuPath) return;
  const path = linkMenuPath;
  closeLinkMenu();
  if (action === "folder") openPath(path, { mode: "folder" });
  else openPath(path, { useDefaultApp: true });
});
$("image-input").addEventListener("change", () => {
  void addImages([...$("image-input").files]);
  $("image-input").value = "";
});
$("model-search").addEventListener("input", () => { modelMenuIndex = 0; renderModelMenu(); });
$("model-search").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); modelMenuIndex++; renderModelMenu(); return; }
  if (event.key === "ArrowUp") { event.preventDefault(); modelMenuIndex = Math.max(0, modelMenuIndex - 1); renderModelMenu(); return; }
  if (event.key === "Escape") { event.preventDefault(); closeModelMenu(true); return; }
  if (event.key === "Enter") {
    event.preventDefault();
    $("model-list").querySelectorAll(".model-item")[modelMenuIndex]?.click();
  }
});
$("error-copy").addEventListener("click", () => { if (errorState) void copyText(errorState.message); });
$("error-close").addEventListener("click", () => showError());
$("palette-input").addEventListener("input", () => { paletteIndex = 0; renderPalette(); });
$("palette-input").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); paletteIndex++; renderPalette(); return; }
  if (event.key === "ArrowUp") { event.preventDefault(); paletteIndex = Math.max(0, paletteIndex - 1); renderPalette(); return; }
  if (event.key === "Enter") {
    event.preventDefault();
    $("palette-list").querySelectorAll(".palette-item")[paletteIndex]?.click();
    return;
  }
  if (event.key === "Escape") { event.preventDefault(); closePalette(); }
});
$("palette").addEventListener("pointerdown", (event) => { if (event.target === $("palette")) closePalette(); });
twoColumnQuery.addEventListener("change", handleLayoutChange);
wideQuery.addEventListener("change", handleLayoutChange);

async function connect() {
  isInspectorOpen = isWideLayout() && readPreference("pi-webui-inspector") !== "closed";
  syncLayout();
  renderControls();
  try {
    await restoreReloadDrafts();
    const token = location.hash.slice(1);
    if (token) {
      await request("/api/auth", { token });
      history.replaceState(null, "", location.pathname);
    }
    await request("/api/snapshot");
    void loadSessions();
    source = new EventSource("/api/events");
    source.onopen = () => { isConnected = true; renderStatus(); scheduleRender(); };
    source.onmessage = (event) => {
      try { receive(JSON.parse(event.data)); }
      catch (error) { showError(`Could not read the conversation: ${error.message}`); }
    };
    source.onerror = () => { isConnected = false; renderStatus(); renderControls(); };
  } catch (error) { showError(error); }
}

themeMode = readPreference("pi-webui-theme") === "light" ? "light" : "dark";
applyTheme();
syncLayout();
void connect();
