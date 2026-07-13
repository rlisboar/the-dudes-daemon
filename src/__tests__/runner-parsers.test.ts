import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOneShotText } from "../runners/parsers.js";

test("Codex extracts only completed agent messages from mixed NDJSON", () => {
  const out = [
    JSON.stringify({ type: "thread.started" }),
    "provider noise",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
  ].join("\n");
  assert.equal(extractOneShotText(out, "codex"), "answer");
});

test("Gemini ignores user/tool events and malformed lines", () => {
  const out = `{bad}\n${JSON.stringify({ type: "message", role: "user", content: "secret" })}\n${JSON.stringify({ type: "message", role: "assistant", content: "safe" })}`;
  assert.equal(extractOneShotText(out, "gemini"), "safe");
});

test("OpenCode strips ANSI and extracts text parts", () => {
  const line = JSON.stringify({ type: "text", part: { text: "done" } });
  assert.equal(extractOneShotText(`\u001b[32m${line}\u001b[0m`, "opencode"), "done");
});

test("Grok supports pretty JSON, streaming NDJSON and error objects", () => {
  assert.equal(extractOneShotText(JSON.stringify({ text: "final", sessionId: "x" }, null, 2), "grok"), "final");
  assert.equal(extractOneShotText(`${JSON.stringify({ type: "text", data: "a" })}\n${JSON.stringify({ type: "text", data: "b" })}`, "grok"), "ab");
  assert.equal(extractOneShotText(JSON.stringify({ type: "error", message: "nope" }), "grok"), "");
});

test("Claude and Crush keep plain stdout", () => {
  assert.equal(extractOneShotText("  plain output  ", "claude"), "plain output");
  assert.equal(extractOneShotText("  crush output  ", "crush"), "crush output");
});
