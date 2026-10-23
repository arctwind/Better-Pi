import { test, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createWriteTracker } from "../changes.mjs";
import { openLocalPath, resolveOpenPath, resolveRevealPath } from "../open.mjs";

test("writes capture original content before overwrites and ignore failed or unreadable writes", async () => {
  const root = await mkdtemp(new URL("./temp-", import.meta.url));
  const calls = [];
  const tracker = createWriteTracker((before, after) => { calls.push([before, after]); return { diff: "preview" }; });
  const event = (path, content = "new\n") => ({ toolName: "write", toolCallId: path, input: { path, content } });
  try {
    await writeFile(join(root, "existing.txt"), "old\r\n");
    await tracker.capture(event("existing.txt"), root);
    await writeFile(join(root, "existing.txt"), "new\n");
    assert.deepEqual(tracker.finish(event("existing.txt")), { details: { diff: "preview", isNewFile: false } });
    assert.deepEqual(calls[0], ["old\n", "new\n"]);
    await tracker.capture(event("new.txt"), root);
    assert.equal(tracker.finish(event("new.txt")).details.isNewFile, true);
    assert.deepEqual(calls[1], ["", "new\n"]);
    await tracker.capture(event("failed.txt"), root);
    assert.equal(tracker.finish({ ...event("failed.txt"), isError: true }), undefined);
    await tracker.capture(event("."), root);
    assert.equal(tracker.finish(event(".")), undefined);
    assert.equal(tracker.finish(event("existing.txt")), undefined);
    assert.deepEqual(await resolveOpenPath("existing.txt", root), { target: join(root, "existing.txt"), isDirectory: false });
    await writeFile(join(root, "run.cmd"), "echo test");
    await assert.rejects(resolveOpenPath("run.cmd", root), /Executables/);
    assert.deepEqual(await resolveOpenPath("run.cmd", root, { allowExecutable: true }), { target: join(root, "run.cmd"), isDirectory: false });
    assert.deepEqual(await resolveRevealPath("existing.txt", root), { target: join(root, "existing.txt"), isDirectory: false });
    assert.deepEqual(await resolveRevealPath("missing.html", root), { target: root, isDirectory: true });
    assert.deepEqual(await resolveRevealPath(".", root), { target: root, isDirectory: true });
    await assert.rejects(resolveOpenPath("missing.html", root), /not found/);
    await assert.rejects(resolveOpenPath("\\\\server\\share\\file.txt", root), /Network/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows folder actions launch a visible Explorer window and report launch errors", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(new URL("./reveal-", import.meta.url));
  const calls = [];
  let launchError;
  const spawn = mock.method(childProcess, "spawn", (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => launchError ? child.emit("error", launchError) : child.emit("exit", 0));
    return child;
  });
  syncBuiltinESMExports();
  try {
    const file = join(root, "测试 file.txt");
    await writeFile(file, "test");
    await openLocalPath(file, root, { mode: "folder" });
    await openLocalPath(root, root, { mode: "folder" });
    await openLocalPath("missing.txt", root, { mode: "folder" });
    assert.deepEqual(calls.map(({ command, options }) => [command, options.windowsHide]), [
      ["explorer.exe", false], ["explorer.exe", false], ["explorer.exe", false],
    ]);
    assert.deepEqual(calls[0].args, [`/select,"${file}"`]);
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
    assert.deepEqual(calls[1].args, [root]);
    assert.deepEqual(calls[2].args, [root]);
    launchError = new Error("Explorer launch failed");
    await assert.rejects(openLocalPath(file, root, { mode: "folder" }), /Explorer launch failed/);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
