export function blocks(message) {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
}

export function messageId(message) {
  return `${message.role}:${message.toolCallId ?? message.timestamp}`;
}

export function applyMessageEvent(messages, event) {
  if (event.type === "message_start" || event.type === "message_end") {
    const index = messages.findIndex((item) => messageId(item) === messageId(event.message));
    if (index < 0) messages.push(event.message);
    else messages[index] = { entryId: messages[index].entryId, ...event.message };
  }
  if (event.type !== "message_update") return;
  const message = messages.findLast((item) => item.role === "assistant");
  if (!message) return;
  const update = event.assistantMessageEvent;
  const index = update.contentIndex;
  const kind = update.type.split("_")[0];
  if (kind === "text" || kind === "thinking") {
    const block = message.content[index] ??= { type: kind, [kind]: "" };
    if (update.type.endsWith("_delta")) block[kind] += update.delta;
    if (update.type.endsWith("_end")) block[kind] = update.content;
  } else if (update.type === "toolcall_start") {
    message.content[index] = { type: "toolCall", id: update.id, name: update.toolName, arguments: {} };
  } else if (update.type === "toolcall_delta") {
    const block = message.content[index];
    if (block) block.partialArguments = (block.partialArguments ?? "") + update.delta;
  } else if (update.type === "toolcall_end") message.content[index] = update.toolCall;
}

export function groupMessages(messages) {
  const groups = [];
  for (const message of messages) {
    if (message.role === "user") groups.push({ key: messageId(message), user: message, messages: [] });
    else if (["assistant", "toolResult"].includes(message.role)) {
      if (!groups.length) groups.push({ key: "initial", messages: [] });
      groups.at(-1).messages.push(message);
    }
  }
  return groups;
}

export function finalMessage(group) {
  const last = group.messages.findLast((message) => message.role === "assistant");
  if (!last || blocks(last).some((block) => block.type === "toolCall")) return undefined;
  return last;
}

export function isFinalComplete(group) {
  return finalMessage(group)?.stopReason === "stop";
}

export function activityItems(group) {
  const items = [];
  const final = finalMessage(group);
  let activity;
  for (const message of group.messages) {
    if (message.role !== "assistant") continue;
    for (const [index, block] of blocks(message).entries()) {
      if (block.type === "text" && message !== final && block.text.trim()) {
        activity = undefined;
        items.push({ type: "text", text: block.text });
      } else if (block.type === "toolCall" || block.type === "thinking") {
        if (!activity) {
          activity = { type: "activity", key: block.id ?? `${messageId(message)}:${index}`, tools: [], thoughts: [] };
          items.push(activity);
        }
        if (block.type === "toolCall") activity.tools.push(block);
        else if (block.thinking) activity.thoughts.push(block.thinking);
      }
    }
  }
  return items;
}

export function activityLabel(tools) {
  const names = new Set(tools.map((tool) => tool.name));
  const actions = [];
  if (["write", "edit"].some((name) => names.has(name))) actions.push("edited files");
  if (["bash", "powershell", "shell"].some((name) => names.has(name))) actions.push("ran commands");
  if (names.has("read")) actions.push("read files");
  if (["grep", "find", "ls"].some((name) => names.has(name))) actions.push("searched files");
  const label = actions.join(", ") || (tools.length ? "used tools" : "thinking");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function diffLines(diff) {
  if (typeof diff !== "string" || !diff) return [];
  let oldNumber = 0;
  let newNumber = 0;
  let isPatch = false;
  return diff.split("\n").flatMap((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      [oldNumber, newNumber] = hunk.slice(1).map(Number);
      isPatch = true;
      return [{ kind: " ", number: "", text: line }];
    }
    if (isPatch && /^[+\- ]/.test(line)) {
      const kind = line[0];
      const number = kind === "+" ? newNumber : oldNumber;
      if (kind !== "+") oldNumber++;
      if (kind !== "-") newNumber++;
      return [{ kind, number: String(number), text: line.slice(1) }];
    }
    if (/^(?:---|\+\+\+|Index:|={3,}|\\ No newline)/.test(line)) return [];
    const match = /^([+\- ])\s*(\d+) (.*)$/.exec(line);
    return [match ? { kind: match[1], number: match[2], text: match[3] } : { kind: " ", number: "", text: line.trim() }];
  });
}

export function linkTarget(value) {
  if (typeof value !== "string" || /[\x00-\x1f]/.test(value)) return;
  const text = value.trim();
  if (/^(?:https?:\/\/|mailto:)/i.test(text)) {
    try { return { href: new URL(text).href }; } catch { return; }
  }
  if (/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:[/?#]|$)/i.test(text)) return { href: `http://${text}` };
  if (/^file:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.hostname && url.hostname !== "localhost") return;
      let path = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      return { path };
    } catch { return; }
  }
  if (/^(?:[a-z]:[/\\]|\/(?!\/)|\.{1,2}[/\\]|~[/\\])/i.test(text) || /^[\w@.\-]+(?:[/\\][\w@. \-]+)*\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?$/i.test(text)) {
    return { path: text.replace(/(?::\d+){1,2}$/, "") };
  }
}

export function findLinks(text) {
  const pattern = /https?:\/\/[^\s<>`"'，。；！？]+|(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:[/\?#][^\s<>`"'，。；！？]*)?|file:\/\/[^\s<>`"'，。；！？]+|[a-z]:[/\\][^\s<>`"'，。；！？]+|(?:\.{1,2}\/|~\/|\/(?!\/))[\w@.\-/]+/gi;
  return [...text.matchAll(pattern)].flatMap((match) => {
    const value = match[0].replace(/[),.;，。；）]+$/, "");
    const target = linkTarget(value);
    return target ? [{ index: match.index, text: value, target }] : [];
  });
}

const READ_TOOLS = new Set(["read"]);
const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "shell", "powershell"]);

export function turnStats(group) {
  const results = new Map(group.messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
  const stats = { tools: 0, read: 0, search: 0, edit: 0, command: 0, other: 0, failed: 0 };
  for (const message of group.messages) {
    if (message.role !== "assistant") continue;
    for (const block of blocks(message)) {
      if (block.type !== "toolCall") continue;
      stats.tools++;
      if (READ_TOOLS.has(block.name)) stats.read++;
      else if (SEARCH_TOOLS.has(block.name)) stats.search++;
      else if (EDIT_TOOLS.has(block.name)) stats.edit++;
      else if (SHELL_TOOLS.has(block.name)) stats.command++;
      else stats.other++;
      if (results.get(block.id)?.isError) stats.failed++;
    }
  }
  return stats;
}

export function workSummary(stats) {
  const count = (value, noun) => `${value} ${noun}${value === 1 ? "" : "s"}`;
  const parts = [];
  if (stats.read) parts.push(`Read ${count(stats.read, "file")}`);
  if (stats.search) parts.push(`Searched ${count(stats.search, "place")}`);
  if (stats.edit) parts.push(`Edited ${count(stats.edit, "file")}`);
  if (stats.command) parts.push(`Ran ${count(stats.command, "command")}`);
  if (stats.other) parts.push(count(stats.other, "tool"));
  return parts.join(" · ") || (stats.tools ? "Used tools" : "Thinking");
}

export function sessionChanges(messages) {
  const results = new Map(messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
  const files = new Map();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of blocks(message)) {
      if (block.type !== "toolCall" || !EDIT_TOOLS.has(block.name)) continue;
      const args = block.arguments ?? {};
      const path = args.path ?? args.file_path;
      if (typeof path !== "string" || !path) continue;
      const result = results.get(block.id);
      if (!result || result.isError) continue;
      const diff = result?.details?.diff ?? result?.details?.patch;
      const lines = diffLines(diff);
      const record = files.get(path) ?? { path, added: 0, removed: 0, edits: 0, diffs: [] };
      record.edits++;
      record.added += lines.filter((line) => line.kind === "+").length;
      record.removed += lines.filter((line) => line.kind === "-").length;
      if (typeof diff === "string" && diff) record.diffs.push(diff);
      files.set(path, record);
    }
  }
  return [...files.values()];
}

export function completionToken(text, caret = text.length) {
  const head = text.slice(0, caret);
  const slash = /^\/([^\s]*)$/.exec(head);
  if (slash) return { mode: "command", query: slash[1], start: 0, end: caret + (text.slice(caret).match(/^[^\s]*/)?.[0].length ?? 0) };
  const file = /(?:^|\s)@(?:"([^"\n]*)|([^\s"\n]*))$/.exec(head);
  if (!file) return;
  const query = file[1] ?? file[2];
  const tail = text.slice(caret).match(file[1] !== undefined ? /^[^"\n]*"?/ : /^[^\s]*/)?.[0] ?? "";
  return { mode: "file", query, start: caret - query.length - (file[1] !== undefined ? 2 : 1), end: caret + tail.length };
}
