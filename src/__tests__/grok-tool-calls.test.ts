import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGrokChatToolCalls } from "../agent-runner.js";

/* Linha real capturada do chat_history.jsonl (grok CLI 0.2.93). */
const REAL_LINE = JSON.stringify({
  type: "assistant",
  content: "I'll list the files in the current directory.",
  model_id: "grok-4.5",
  tool_calls: [
    { id: "call-52ae4ba8-cc96-4a49-99d5-714dbd081276-0", name: "list_dir", arguments: "{\"target_directory\":\".\"}" },
  ],
});

test("linha assistant com tool_calls extrai id/name/input parseado", () => {
  const calls = parseGrokChatToolCalls(REAL_LINE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "call-52ae4ba8-cc96-4a49-99d5-714dbd081276-0");
  assert.equal(calls[0].name, "list_dir");
  assert.deepEqual(calls[0].input, { target_directory: "." });
});

test("múltiplas tool_calls na mesma linha", () => {
  const line = JSON.stringify({
    type: "assistant",
    tool_calls: [
      { id: "a", name: "read_file", arguments: "{\"path\":\"x\"}" },
      { id: "b", name: "bash", arguments: "{\"command\":\"ls\"}" },
    ],
  });
  const calls = parseGrokChatToolCalls(line);
  assert.deepEqual(calls.map((c) => c.id), ["a", "b"]);
  assert.deepEqual(calls[1].input, { command: "ls" });
});

test("arguments com JSON inválido embrulha em {raw} em vez de perder a call", () => {
  const line = JSON.stringify({
    type: "assistant",
    tool_calls: [{ id: "a", name: "bash", arguments: "{broken" }],
  });
  const calls = parseGrokChatToolCalls(line);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { raw: "{broken" });
});

test("arguments já-objeto passa direto (schema futuro)", () => {
  const line = JSON.stringify({
    type: "assistant",
    tool_calls: [{ id: "a", name: "bash", arguments: { command: "pwd" } }],
  });
  assert.deepEqual(parseGrokChatToolCalls(line)[0].input, { command: "pwd" });
});

test("linhas não-assistant, sem tool_calls, sem id ou corrompidas → []", () => {
  assert.deepEqual(parseGrokChatToolCalls(""), []);
  assert.deepEqual(parseGrokChatToolCalls("{not json \"tool_calls\""), []);
  assert.deepEqual(parseGrokChatToolCalls(JSON.stringify({ type: "user", content: "oi" })), []);
  assert.deepEqual(parseGrokChatToolCalls(JSON.stringify({ type: "tool_result", content: "x" })), []);
  // tool_calls presente mas em linha user: não emite
  assert.deepEqual(parseGrokChatToolCalls(JSON.stringify({ type: "user", tool_calls: [{ id: "a", name: "x", arguments: "{}" }] })), []);
  // call sem id é descartada (dedupe impossível)
  assert.deepEqual(parseGrokChatToolCalls(JSON.stringify({ type: "assistant", tool_calls: [{ name: "x", arguments: "{}" }] })), []);
});
