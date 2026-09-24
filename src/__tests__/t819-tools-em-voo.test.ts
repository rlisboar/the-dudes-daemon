/**
 * T-819: `toolsInFlight` conta TOOLS ABERTAS (por id), não EVENTOS do stream.
 *
 * Achado (T-812, log de prod): o contador só somava em grok/gemini — o
 * `tool_call_update` terminal virava mais um "em voo" e o delta de argumentos
 * também, então 1 tool real virava centenas: `[hang:DAEMON] toolsInFlight=391
 * aberto há 601s (cli:grok)`. Com o contador grudado >0 o watchdog suspende
 * soft/hard e só reage no teto absoluto de tools (~10min) — o agente parece
 * mudo e o recover chega tarde (o HARD veio 7min depois, 07:28Z).
 */
import "./scratch-home.js";

import {test} from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import {AgentRunner} from "../agent-runner.js";
import {resolveCliCommands} from "../cli-config.js";
import {parseGrokStreamEvent} from "../runners/turn-parsers.js";
import {hangPhase, hangThresholds, toolsInFlightBlocksHang, toolsInFlightHardDue} from "../runners/turn-watchdog.js";

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;

function makeRunner(cliRunner: "gemini" | "codex" | "grok"): AgentRunner {
  const info = {
    id: `agent_t819_${cliRunner}_${process.pid}`, ownerUserId: "u", name: "t819", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner, autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: resolveCliCommands(), verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onExit: () => {},
  } as never);
  asAny(runner).drainOcQueue = () => {};
  return runner;
}

const accVazio = {addText: () => {}, onResult: () => {}, flush: () => {}};

test("T-819 (parser grok): delta não é tool nova e o update terminal é a CONCLUSÃO", () => {
  // Frames reais do headless (docs/spikes/t110: delta_chunk → tool_call →
  // tool_call_update input → tool_call_update completed), todos do MESMO id.
  const frames = [
    { type: "tool_call_delta_chunk", toolCallId: "c1", toolName: "read", rawInput: { path: "a" } },
    { type: "tool_call_delta_chunk", toolCallId: "c1", toolName: "read", rawInput: { path: "a" } },
    { type: "tool_call", toolCallId: "c1", toolName: "read", status: "pending", rawInput: { path: "a.ts" } },
    { type: "tool_call_update", toolCallId: "c1", title: "lendo", status: "in_progress" },
    { type: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { ok: true } },
  ];
  const tipos = frames
    .flatMap((f) => parseGrokStreamEvent(f))
    .map((e) => (e.type === "tool" ? (e.delta ? "delta" : "tool") : e.type));
  assert.deepEqual(
    tipos,
    ["delta", "delta", "tool", "tool", "tool_done"],
    "antes os 5 frames viravam 5 'em voo' e nada fechava",
  );
});

test("T-819: abrir é idempotente por id; fechar/esquecer recomputam", () => {
  const r = makeRunner("grok");
  const a = asAny(r);
  for (let i = 0; i < 40; i++) a.noteGrokToolInFlight("call-1");
  assert.equal(a.toolsInFlight, 1, "40 reemissões do MESMO id = 1 tool em voo");
  a.noteToolFechada("call-1");
  assert.equal(a.toolsInFlight, 0, "a conclusão fecha");
  assert.equal(a.toolsInFlightSince, null, "…e o relógio do in-flight zera");
  a.noteGrokToolInFlight("call-2");
  a.noteGrokToolInFlight("call-3");
  assert.equal(a.toolsInFlight, 2, "tools distintas contam separadas (paralelo)");
  a.noteToolFechada("call-9");
  assert.equal(a.toolsInFlight, 2, "fechamento de id desconhecido não desce abaixo do real");
  a.zerarToolsEmVoo();
  assert.equal(a.toolsInFlight, 0);
  assert.equal(a.toolsAbertas.size, 0, "o Set vai junto (senão a próxima abertura inflaria)");
});

test("T-819 gemini: N tools sequenciais não viram N 'em voo'", () => {
  const r = makeRunner("gemini");
  const a = asAny(r);
  a.messageSession.busy = true;
  a.setState("thinking");
  const epoch = a.messageSession.epoch;
  let maior = 0;
  for (let i = 0; i < 30; i++) {
    a.ingestGeminiLine({ type: "tool_call", name: "shell", args: { cmd: `p${i}` } }, epoch, accVazio);
    maior = Math.max(maior, a.toolsInFlight as number);
  }
  // O stream do gemini não traz tool_result: a tool NOVA fecha a anterior.
  assert.ok(maior <= 2, `contador devia ficar ~1, chegou a ${maior} (30 tools = 30 antes)`);
  assert.equal(a.toolsInFlight, 1, "a última segue em voo enquanto não fechar");
  a.ingestGeminiLine({ type: "result", stats: {} }, epoch, accVazio);
  assert.equal(a.toolsInFlight, 0, "o result do turno fecha tudo");
});

test("T-819 codex: in-flight por item id — reemissão não infla e o completed fecha", () => {
  const r = makeRunner("codex");
  const a = asAny(r);
  a.messageSession.busy = true;
  a.setState("thinking");
  const epoch = a.messageSession.epoch;
  const started = { type: "item.started", item: { id: "item-1", type: "command_execution", command: "sleep 600" } };
  for (let i = 0; i < 5; i++) a.handleCodexEvent(started, epoch);
  assert.equal(a.toolsInFlight, 1, "5 reemissões do mesmo item = 1 em voo");
  a.handleCodexEvent({ type: "item.started", item: { id: "item-2", type: "command_execution", command: "ls" } }, epoch);
  assert.equal(a.toolsInFlight, 2);
  a.handleCodexEvent({ type: "item.completed", item: { id: "item-1", type: "command_execution", status: "completed" } }, epoch);
  assert.equal(a.toolsInFlight, 1, "o item que concluiu sai do in-flight");
});

test("T-819: o contador honesto devolve o turno ao regime normal do watchdog", () => {
  const t = hangThresholds("grok");
  const cincoMin = 5 * 60_000;
  // Tool REAL e recente em voo bloqueia o hard (comportamento preservado: o
  // teto de tools existe para não matar build/suíte longa).
  assert.equal(toolsInFlightBlocksHang(1, cincoMin, t.toolsHardMs), true);
  // Sem tool em voo o bloqueio sai e o turno volta ao hard do runner — era
  // isto que o contador grudado tirava: com toolsInFlight=391 o hard de 120s
  // ficava suspenso e só o teto de DECORRIDOS…
  assert.equal(toolsInFlightBlocksHang(0, cincoMin, t.toolsHardMs), false);
  assert.equal(toolsInFlightHardDue(cincoMin, t), false, "5min < teto de tools (10min): o bloqueio ainda valeria");
  assert.equal(hangPhase(cincoMin, t), "hard", "grok pós-evento: 5min sem evento é hard normal");
});

test("T-819 review QA-A: codex — file_change/web_search (sem id) NÃO ficam em voo", () => {
  // Repro do QA-A: `file_change` e `web_search` chegam como `tool` SEM id (o
  // parser as trata como tool instantânea, sem item.completed par). Abrir com
  // chave sintética `sem-id:N` que ninguém fecha deixava 20 file_change + 10
  // web_search em 30 "em voo", e o HARD do codex ia de 12min para o teto de
  // tools (20min) — o watchdog ficava cego por 8min num turno travado.
  const r = makeRunner("codex");
  const a = asAny(r);
  a.messageSession.busy = true;
  a.setState("thinking");
  const epoch = a.messageSession.epoch;
  for (let i = 0; i < 20; i++) {
    a.handleCodexEvent({ type: "item.completed", item: { type: "file_change", changes: [{ path: `f${i}.ts` }] } }, epoch);
  }
  for (let i = 0; i < 10; i++) {
    a.handleCodexEvent({ type: "item.completed", item: { type: "web_search", query: `q${i}` } }, epoch);
  }
  assert.equal(a.toolsInFlight, 0, "tool instantânea não abre in-flight (era 30)");
  assert.equal(a.toolsInFlightSince, null, "e não deixa o relógio do in-flight vivo");
  // …e o que TEM id continua contando (a correção não pode desligar o contador).
  a.handleCodexEvent({ type: "item.started", item: { id: "it1", type: "command_execution", command: "sleep 600" } }, epoch);
  assert.equal(a.toolsInFlight, 1, "tool com id (started/completed) segue em voo");
  a.handleCodexEvent({ type: "item.completed", item: { id: "it1", type: "command_execution", status: "completed" } }, epoch);
  assert.equal(a.toolsInFlight, 0, "e o completed fecha");
});
