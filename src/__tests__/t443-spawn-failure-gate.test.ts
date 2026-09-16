/**
 * T-443 (M20): falha SÍNCRONA de spawn não pode segurar slot do gate nem
 * busy — 3 falhas bloqueavam o pool de gates por 15min para todos os agentes.
 */
import "./scratch-home.js";

import {test} from "node:test";
import assert from "node:assert/strict";

import os from "node:os";
import {AgentRunner} from "../agent-runner.js";
import {resolveCliCommands} from "../cli-config.js";
import {allRunnerSources} from "./_sources.js";

function makeRunner() {
  const errors: string[] = [];
  const states: string[] = [];
  const info = {
    id: "agent_t443", ownerUserId: "user_t443", name: "probe", role: "backend",
    systemPrompt: "", color: "#a78bfa", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const opts = {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "gemini", autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: resolveCliCommands(), verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: (s: string) => { states.push(s); },
    onAssistantText: () => true, onToolUse: () => {},
    onError: (m: string) => { errors.push(m); },
    onHung: () => {}, onExit: () => {},
  } as never;
  const runner = new AgentRunner(info, opts);
  const a = runner as unknown as Record<string, any>;
  let released = 0;
  let drained = 0;
  a.releaseActiveTurnSlot = () => { released++; };
  a.drainOcQueue = () => { drained++; };
  return { runner, a, errors, states, released: () => released, drained: () => drained };
}

test("T-443: failTurnSpawn libera slot, zera busy, limpa anexos e drena", () => {
  const { runner, a, errors, released, drained } = makeRunner();
  assert.ok(runner);
  a.messageSession.busy = true;
  a.waitingTurnGate = true;
  const epoch = a.messageSession.epoch;
  let cleaned = 0;
  const snap = a.messageSession.consumeFirstTurnIfNeeded();

  a.failTurnSpawn("gemini", new Error("setpriv não encontrado"), epoch, () => { cleaned++; }, snap);

  assert.equal(released(), 1, "slot do gate devolvido");
  assert.equal(a.messageSession.busy, false, "busy liberado");
  assert.equal(cleaned, 1, "anexos temporários limpos");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /gemini spawn falhou: setpriv não encontrado/);
  assert.equal(drained(), 1, "fila re-drenada (não trava até o próximo evento)");
  // firstTurn restaurado: o próximo turno não pode virar `--resume` da sessão
  // que clear/compact descartou.
  const next = a.messageSession.consumeFirstTurnIfNeeded();
  assert.equal(next.firstTurn, true, "firstTurn restaurado após falha de spawn");
});

test("T-443: spawn falho de runner NÃO registra activeTurnRelease preso", () => {
  const { a, released } = makeRunner();
  a.messageSession.busy = true;
  a.activeTurnRelease = () => { released(); };
  a.failTurnSpawn("qwen", new Error("x"), a.messageSession.epoch, () => {}, a.messageSession.consumeFirstTurnIfNeeded());
  assert.equal(released(), 1);
});

test("T-443 wiring: gemini/qwen/codex/crush têm catch em volta do spawnDropped", () => {
  const src = allRunnerSources(new URL("../agent-runner.ts", import.meta.url));
  for (const runner of ["gemini", "qwen", "codex", "crush"]) {
    assert.match(
      src,
      new RegExp(`catch \\(e\\) \\{\\s*(?:this|self)\\.failTurnSpawn\\("${runner}"`),
      `${runner}: catch em volta do spawn chama failTurnSpawn`,
    );
    const i = Math.max(src.lastIndexOf(`spawnDropped(this.runnerCommand("${runner}")`), src.lastIndexOf(`spawnDropped(self.runnerCommand("${runner}")`));
    assert.ok(i > 0, `spawn per-message do ${runner} existe`);
    const tryIdx = src.lastIndexOf("try {", i);
    assert.ok(tryIdx > 0 && i - tryIdx < 300, `${runner}: spawn dentro de try`);
  }
});