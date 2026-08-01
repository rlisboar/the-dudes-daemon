import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexTurnEvent, parseCrushSessionMeta, parseGeminiTurnEvent, parseGrokStreamEvent, parseOpenCodeTurnEvent } from "../runners/turn-parsers.js";

test("Codex normalizes session, tool, text, usage and failures", () => {
  assert.deepEqual(parseCodexTurnEvent({ type: "thread.started", thread_id: "t1" }), [{ type: "session", sessionId: "t1" }]);
  assert.deepEqual(parseCodexTurnEvent({ type: "item.started", item: { type: "mcp_tool_call", tool: "send_message", arguments: { to: "B" } } }), [{ type: "tool", name: "send_message", input: { to: "B" } }]);
  assert.deepEqual(parseCodexTurnEvent({ type: "item.completed", item: { type: "agent_message", text: " ok " } }), [{ type: "text", text: "ok" }]);
  assert.deepEqual(parseCodexTurnEvent({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 } }), [{ type: "usage", input: 10, output: 2, cacheCreate: 0, cacheRead: 4, cumulative: false }]);
  assert.deepEqual(parseCodexTurnEvent({ type: "turn.failed", error: { message: "context full" } }), [{ type: "error", message: "context full" }]);
});

test("Gemini normalizes streamed text/tools and cumulative result stats", () => {
  assert.deepEqual(parseGeminiTurnEvent({ type: "message", role: "assistant", content: "chunk" }), [{ type: "text", text: "chunk" }]);
  assert.deepEqual(parseGeminiTurnEvent({ type: "tool_call", name: "read", args: { path: "a" } }), [{ type: "tool", name: "read", input: { path: "a" } }]);
  assert.deepEqual(parseGeminiTurnEvent({ type: "result", stats: { input_tokens: 20, output_tokens: 3, cached: 5 } }), [
    { type: "usage", input: 20, output: 3, cacheCreate: 0, cacheRead: 5, cumulative: true },
    { type: "result" },
  ]);
});

test("turn parsers reject malformed and unrelated provider events", () => {
  for (const value of [null, [], "text", {}, { type: "unknown" }]) {
    assert.deepEqual(parseCodexTurnEvent(value), []);
    assert.deepEqual(parseGeminiTurnEvent(value), []);
  }
});

test("OpenCode normalizes session, completed tools and step usage", () => {
  assert.deepEqual(parseOpenCodeTurnEvent({ type: "text", sessionID: "ses_1", part: { text: " hi " } }), [{ type: "session", sessionId: "ses_1" }, { type: "text", text: "hi" }]);
  assert.deepEqual(parseOpenCodeTurnEvent({ type: "tool_use", part: { tool: "read", state: { status: "completed", input: { path: "a" } } } }), [{ type: "tool", name: "read", input: { path: "a" } }]);
  assert.deepEqual(parseOpenCodeTurnEvent({ type: "tool", part: { state: { status: "pending" } } }), []);
  assert.deepEqual(parseOpenCodeTurnEvent({ type: "step_finish", part: { tokens: { input: 9, output: 2, cache: { write: 1, read: 3 } } } }), [{ type: "usage", input: 9, output: 2, cacheCreate: 1, cacheRead: 3, cumulative: false }]);
});

test("Grok normalizes stream chunks, final objects, sessions and errors", () => {
  assert.deepEqual(parseGrokStreamEvent({ type: "thought", data: "why" }), [{ type: "thought", text: "why" }]);
  assert.deepEqual(parseGrokStreamEvent({ type: "text", data: "hi" }), [{ type: "text", text: "hi" }]);
  assert.deepEqual(parseGrokStreamEvent({ type: "end", sessionId: "g1" }), [{ type: "session", sessionId: "g1" }, { type: "result" }]);
  assert.deepEqual(parseGrokStreamEvent({ text: "done", sessionId: "g2" }), [{ type: "text", text: "done" }, { type: "session", sessionId: "g2" }, { type: "result" }]);
  assert.deepEqual(parseGrokStreamEvent({ type: "error", message: "bad" }), [{ type: "error", message: "bad" }]);
});

test("Grok stream tool_call / tool_call_update → tool (estado thinking no runner)", () => {
  assert.deepEqual(
    parseGrokStreamEvent({
      type: "tool_call",
      toolCallId: "call_1",
      toolName: "read_file",
      status: "in_progress",
      rawInput: { path: "src/main.rs" },
    }),
    [{ type: "tool", name: "read_file", input: { path: "src/main.rs" }, id: "call_1" }],
  );
  assert.deepEqual(
    parseGrokStreamEvent({
      type: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      rawOutput: { lines: 42 },
    }),
    [{ type: "tool", name: "", input: {}, id: "call_1" }],
  );
  assert.deepEqual(
    parseGrokStreamEvent({
      type: "tool_call",
      toolName: "run_terminal_command",
      rawInput: { command: "ls" },
    }),
    [{ type: "tool", name: "run_terminal_command", input: { command: "ls" } }],
  );
});

test("Crush session metadata accepts nested and flat CLI shapes", () => {
  assert.deepEqual(parseCrushSessionMeta({ meta: { uuid: "c1", prompt_tokens: 10, completion_tokens: 4 } }), { sessionId: "c1", prompt: 10, completion: 4 });
  assert.deepEqual(parseCrushSessionMeta({ uuid: "c2" }), { sessionId: "c2", prompt: 0, completion: 0 });
  assert.deepEqual(parseCrushSessionMeta(null), { sessionId: undefined, prompt: 0, completion: 0 });
});
