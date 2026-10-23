import { test } from "node:test";
import assert from "node:assert/strict";
import { autoSessionTitle } from "../title.mjs";

test("uses the first sentence and strips a leading request", () => {
  assert.equal(
    autoSessionTitle("切换会话后，未发送的草稿有时会丢。帮我查一下保存逻辑。"),
    "切换会话后，未发送的草稿有时会丢",
  );
  assert.equal(autoSessionTitle("请修复登录页的 bug\n\n复现步骤：打开页面"), "修复登录页的 bug");
});

test("ignores greetings, commands and empty input", () => {
  assert.equal(autoSessionTitle("你好"), undefined);
  assert.equal(autoSessionTitle("  /resume  "), undefined);
  assert.equal(autoSessionTitle("   "), undefined);
});

test("removes code fences and file references", () => {
  assert.equal(autoSessionTitle("```js\nconst a = 1;\n```\n解释这段代码"), "解释这段代码");
  assert.equal(autoSessionTitle("@src/app.ts 修复这个"), "修复这个");
});

test("limits long titles", () => {
  const title = autoSessionTitle("a".repeat(40));
  assert.equal(title, `${"a".repeat(24)}…`);
});
