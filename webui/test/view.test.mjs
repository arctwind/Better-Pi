import { test } from "node:test";
import assert from "node:assert/strict";
import { activityItems, activityLabel, completionToken, diffLines, findLinks, linkTarget, sessionChanges, turnStats, workSummary } from "../public/view.js";

test("activity groups combine repeated thinking and tools while keeping commentary between groups", () => {
  const edit = { type: "toolCall", id: "edit", name: "edit" };
  const shell = { type: "toolCall", id: "shell", name: "bash" };
  const group = { messages: [
    { role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "first" }, edit] },
    { role: "toolResult", toolCallId: "edit", content: "done" },
    { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "second" }, shell] },
    { role: "assistant", timestamp: 3, content: [{ type: "text", text: "Progress" }] },
    { role: "assistant", timestamp: 4, content: [edit] },
    { role: "assistant", timestamp: 5, content: [{ type: "text", text: "Final" }], stopReason: "stop" },
  ] };
  const items = activityItems(group);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0].thoughts, ["first", "second"]);
  assert.deepEqual(items[0].tools, [edit, shell]);
  assert.equal(activityLabel(items[0].tools), "Edited files, ran commands");
  assert.deepEqual(items[1], { type: "text", text: "Progress" });
  assert.deepEqual(items[2].tools, [edit]);
});

test("unified patches count changed lines without counting headers", () => {
  const lines = diffLines("--- a/app.js\n+++ b/app.js\n@@ -3,2 +3,3 @@\n-old\n+new\n+extra\n context\n");
  assert.equal(lines.filter((line) => line.kind === "+").length, 2);
  assert.equal(lines.filter((line) => line.kind === "-").length, 1);
  assert.deepEqual(lines[2], { kind: "+", number: "3", text: "new" });
});

test("Pi numbered diffs retain blank lines, context and exact change counts", () => {
  const lines = diffLines("  8 before\n- 9 old\n+ 9 new\n+10 \n    ...\n 14 after");
  assert.equal(lines.filter((line) => line.kind === "+").length, 2);
  assert.equal(lines.filter((line) => line.kind === "-").length, 1);
  assert.deepEqual(lines[3], { kind: "+", number: "10", text: "" });
  assert.equal(lines[4].number, "");
});

test("links distinguish local files from websites and reject executable URL schemes", () => {
  assert.deepEqual(linkTarget("E:/workspace/Remotion/index.html"), { path: "E:/workspace/Remotion/index.html" });
  assert.deepEqual(linkTarget("src/app.js:12:3"), { path: "src/app.js" });
  assert.deepEqual(linkTarget("file:///E:/My%20Project/index.html"), { path: "E:/My Project/index.html" });
  assert.deepEqual(linkTarget("localhost:3000/preview"), { href: "http://localhost:3000/preview" });
  assert.deepEqual(linkTarget("http://127.0.0.1:8080"), { href: "http://127.0.0.1:8080/" });
  for (const value of ["javascript:alert(1)", "data:text/html,test", "file://remote/share/a.txt", "node app.js"]) assert.equal(linkTarget(value), undefined);
  const links = findLinks("页面：E:/workspace/Remotion/index.html，预览 localhost:3000。文档 https://example.com/docs。");
  assert.deepEqual(links.map((link) => link.text), ["E:/workspace/Remotion/index.html", "localhost:3000", "https://example.com/docs"]);
});

test("turn changes aggregate edits per file and count diff lines", () => {
  const edit = (id, path) => ({ type: "toolCall", id, name: "edit", arguments: { path } });
  const result = (id, diff) => ({ role: "toolResult", toolCallId: id, content: "ok", details: { diff } });
  const group = { messages: [
    { role: "assistant", content: [edit("a", "src/app.js")] },
    result("a", "- 1 old\n+ 1 new\n+ 2 extra"),
    { role: "assistant", content: [edit("b", "src/style.css")] },
    result("b", "- 4 old\n+ 4 new"),
    { role: "assistant", content: [edit("c", "src/app.js"), { type: "toolCall", id: "d", name: "read", arguments: { path: "src/app.js" } }] },
    result("c", "+ 9 added"),
    { role: "toolResult", toolCallId: "d", content: "text", isError: true },
  ] };
  assert.deepEqual(sessionChanges(group.messages).map((file) => ({ path: file.path, added: file.added, removed: file.removed, edits: file.edits })), [
    { path: "src/app.js", added: 3, removed: 1, edits: 2 },
    { path: "src/style.css", added: 1, removed: 1, edits: 1 },
  ]);
  assert.deepEqual(sessionChanges(group.messages)[0].diffs, ["- 1 old\n+ 1 new\n+ 2 extra", "+ 9 added"]);
  const stats = turnStats(group);
  assert.equal(stats.edit, 3);
  assert.equal(stats.read, 1);
  assert.equal(stats.failed, 1);
  assert.equal(workSummary(stats), "Read 1 file · Edited 3 files");
});

test("change summaries exclude pending and failed writes and preserve every successful diff", () => {
  const call = (id) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "write", arguments: { path: "a.txt" } }] });
  const result = (id, diff, isError = false) => ({ role: "toolResult", toolCallId: id, details: { diff }, isError });
  assert.deepEqual(sessionChanges([call("pending"), call("failed"), result("failed", "+1 never written", true)]), []);
  const diffs = ["--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-A\n+B", "-1 B\n+1 A"];
  const [file] = sessionChanges([call("a"), result("a", diffs[0]), call("b"), result("b", diffs[1])]);
  assert.deepEqual(file, { path: "a.txt", added: 2, removed: 2, edits: 2, diffs });
  assert.equal(file.diffs.flatMap(diffLines).filter((line) => line.kind === "+").length, file.added);
});

test("completion handles quoted paths and replaces the entire token at the cursor", () => {
  assert.deepEqual(completionToken("/mod other", 3), { mode: "command", query: "mo", start: 0, end: 4 });
  assert.deepEqual(completionToken('查看 @"Better Pi/re'), { mode: "file", query: "Better Pi/re", start: 3, end: 17 });
  assert.deepEqual(completionToken("查看 @src/app.js 后续", 7), { mode: "file", query: "src", start: 3, end: 14 });
  assert.equal(completionToken("你好 /model"), undefined);
  assert.equal(completionToken("mail@example.com"), undefined);
});
