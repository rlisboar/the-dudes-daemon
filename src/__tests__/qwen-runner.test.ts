/**
 * Runner QWEN CODE (QwenLM/qwen-code, fork do Gemini CLI) — contrato medido
 * na CLI 0.23.0 (probe real: prompt via stdin + `--output-format stream-json`).
 * O parser é a superfície crítica: eventos JSONL estilo Claude com
 * session_id em todo evento, usage POR REQUEST (shape Anthropic) e o
 * `result` com usage ACUMULADO (ignorado p/ billing).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseQwenTurnEvent } from "../runners/turn-parsers.js";
import { extractOneShotText } from "../runners/parsers.js";
import { buildBaseRunnerEnv, buildQwenEnv } from "../runners/env.js";
import { qwenConfigContextLimit, DEFAULT_CONTEXT_LIMIT } from "../runners/model-policy.js";

const SID = "2ebf5fa4-a378-461b-bf5f-fb16545388e3";

test("qwen stream: init traz session_id e nada mais", () => {
  const ev = { type: "system", subtype: "init", uuid: SID, session_id: SID, cwd: "/tmp", tools: ["edit"], model: "qwen3-coder-plus", permission_mode: "yolo" };
  assert.deepEqual(parseQwenTurnEvent(ev), [{ type: "session", sessionId: SID }]);
});

test("qwen stream: assistant emite text/thinking/tool_use e usage por request", () => {
  const ev = {
    type: "assistant", session_id: SID,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "vou editar" },
        { type: "text", text: "ediando agora" },
        { type: "tool_use", id: "t1", name: "edit", input: { path: "a.ts" } },
      ],
      usage: { input_tokens: 26000, output_tokens: 127, cache_read_input_tokens: 4096, total_tokens: 26127 },
    },
  };
  const out = parseQwenTurnEvent(ev);
  assert.deepEqual(out[0], { type: "session", sessionId: SID });
  assert.deepEqual(out[1], { type: "thought", text: "vou editar" });
  assert.deepEqual(out[2], { type: "text", text: "ediando agora" });
  assert.deepEqual(out[3], { type: "tool", name: "edit", input: { path: "a.ts" }, id: "t1" });
  assert.deepEqual(out[4], { type: "usage", input: 26000, output: 127, cacheCreate: 0, cacheRead: 4096, cumulative: false });
});

test("qwen stream: usage zerado (parciais de streaming) NÃO vira billing", () => {
  const ev = { type: "assistant", session_id: SID, message: { content: [{ type: "thinking", thinking: "hm" }], usage: { input_tokens: 0, output_tokens: 0 } } };
  const out = parseQwenTurnEvent(ev).filter((e) => e.type === "usage");
  assert.deepEqual(out, []);
});

test("qwen stream: result = fim de turno (usage acumulado é ignorado)", () => {
  const ev = { type: "result", subtype: "success", session_id: SID, is_error: false, result: "pronto", usage: { input_tokens: 38129, output_tokens: 159 } };
  assert.deepEqual(parseQwenTurnEvent(ev), [{ type: "session", sessionId: SID }, { type: "result" }]);
});

test("qwen stream: stream_event/telemetria são ignorados", () => {
  assert.deepEqual(parseQwenTurnEvent({ type: "stream_event", event: { type: "goal_state" } }), []);
});

test("qwen one-shot (--output-format json): array único com result.result", () => {
  const arr = JSON.stringify([
    { type: "system", subtype: "init", session_id: SID },
    { type: "assistant", session_id: SID, message: { content: [{ type: "text", text: "parcial" }], usage: { input_tokens: 10, output_tokens: 2 } } },
    { type: "result", session_id: SID, is_error: false, result: "RESUMO FINAL", usage: { input_tokens: 100, output_tokens: 20 } },
  ]);
  assert.equal(extractOneShotText(arr, "qwen"), "RESUMO FINAL");
});

test("qwen one-shot: sem evento result, cai na junção dos textos assistant", () => {
  const arr = JSON.stringify([
    { type: "assistant", message: { content: [{ type: "text", text: "linha 1" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "linha 2" }] } },
  ]);
  assert.equal(extractOneShotText(arr, "qwen"), "linha 1\nlinha 2");
});

test("qwen env: QWEN_HOME por agente só para o runner qwen; yolo warning silenciado", () => {
  const base = { PATH: "/usr/bin" };
  const withQwen = buildBaseRunnerEnv({
    inherited: base, runner: "qwen", agentId: "a1", agentName: "A", orchestratorUrl: "https://o",
    qwenHome: "/tmp/agent/.qwen",
  });
  assert.equal(withQwen.QWEN_HOME, "/tmp/agent/.qwen");
  const claude = buildBaseRunnerEnv({ inherited: { ...base, QWEN_HOME: "stale" }, runner: "claude", agentId: "a1", agentName: "A", orchestratorUrl: "https://o" });
  assert.equal(claude.QWEN_HOME, undefined, "QWEN_HOME não vaza para outros runners");
  assert.equal(buildQwenEnv({}).QWEN_CODE_SUPPRESS_YOLO_WARNING, "1");
});

test("qwen janela: contextWindowSize do settings do dono vence; ausente = 200k real do CLI", () => {
  const mk = (win?: number) => ({
    modelProviders: { openai: [{ id: "rezulto/qwen3.8-flash", baseUrl: "https://x/v1", ...(win ? { generationConfig: { contextWindowSize: win } } : {}) }] },
  });
  assert.equal(qwenConfigContextLimit(mk(1_048_576), "rezulto/qwen3.8-flash"), 1_048_576);
  // sem contexto na config: o CLI opera com DEFAULT_TOKEN_LIMIT=200k — é a
  // janela REAL (não UNKNOWN), pois é com esse teto que ele comprime.
  assert.equal(qwenConfigContextLimit(mk(), "rezulto/qwen3.8-flash"), DEFAULT_CONTEXT_LIMIT);
  // dois providers sem match pro modelo: ambíguo → default (nunca escolher às cegas)
  const amb = { modelProviders: { a: [{ id: "x", generationConfig: { contextWindowSize: 1000 } }], b: [{ id: "y", generationConfig: { contextWindowSize: 2000 } }] } };
  assert.equal(qwenConfigContextLimit(amb, "z"), DEFAULT_CONTEXT_LIMIT);
  assert.equal(qwenConfigContextLimit({}, "qualquer"), DEFAULT_CONTEXT_LIMIT);
});
