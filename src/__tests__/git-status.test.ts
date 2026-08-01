import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitPorcelain } from "../git-status.js";

test("preserva espaço inicial e não trunca o primeiro path", () => {
  assert.deepEqual(parseGitPorcelain(" M web/src/App.tsx\n M README.md\n"), [
    { status: " M", path: "web/src/App.tsx" },
    { status: " M", path: "README.md" },
  ]);
});

test("preserva estados staged, misto e untracked", () => {
  assert.deepEqual(parseGitPorcelain("M  staged.ts\nMM both.ts\n?? new.ts\n"), [
    { status: "M ", path: "staged.ts" },
    { status: "MM", path: "both.ts" },
    { status: "??", path: "new.ts" },
  ]);
});

test("aceita output vazio e CRLF", () => {
  assert.deepEqual(parseGitPorcelain(""), []);
  assert.deepEqual(parseGitPorcelain("A  one.ts\r\n"), [{ status: "A ", path: "one.ts" }]);
});
