import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFileCache, listFiles } from "../files.mjs";

test("file mentions return relative files and directories while skipping dependency folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-webui-files-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "src", "app.js"), "");
    await writeFile(join(root, "package.json"), "");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "");

    const matches = await listFiles(root, "app");
    assert.deepEqual(matches, [{ path: "src/app.js", type: "file" }]);
    const everything = await listFiles(root, "");
    assert.ok(everything.some((entry) => entry.path === "package.json" && entry.type === "file"));
    assert.ok(everything.some((entry) => entry.path === "src" && entry.type === "dir"));
    assert.equal(everything.some((entry) => entry.path.includes("node_modules")), false);
  } finally {
    clearFileCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("file mention ordering prefers exact and basename matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-webui-files-"));
  try {
    await mkdir(join(root, "docs", "app"), { recursive: true });
    await writeFile(join(root, "app.js"), "");
    await writeFile(join(root, "docs", "app", "index.js"), "");
    const matches = await listFiles(root, "app.js");
    assert.equal(matches[0].path, "app.js");
  } finally {
    clearFileCache();
    await rm(root, { recursive: true, force: true });
  }
});
