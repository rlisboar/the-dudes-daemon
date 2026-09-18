/**
 * T-662 — o health do daemon expõe `turns.hardRecoversNotified`, que conta
 * APENAS os hard recovers que a política decidiu avisar (summary|immediate).
 * Supressões (1º attempt de hang abaixo do limiar; backstop de lifetime)
 * incrementam o contador cru mas NÃO o notificado — é ele que o banner do
 * web usa (fim do spam de "1 hard recover" por evento suprimido).
 *
 * Harness leve (padrão T-240): AgentRunner REAL com tickHangWatch e fila
 * drenada stubbada — sem CLI real.
 */
import "./scratch-home.js";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { AgentRunner } from "../agent-runner.js";
import { _resetForTest, healthSnapshot } from "../health-monitor.js";
import { QWEN_TURN_LIFETIME_MS } from "../runners/turn-watchdog.js";

const deps = { turnGate: { ativos: 0, fila: 0, max: 3 }, agentsRunning: 0, e2eeProjects: 0 };

function makeRunner(cliRunner = "grok"): { runner: AgentRunner; events: Array<{ soft: boolean; reason: string }>; warns: string[] } {
  const events: Array<{ soft: boolean; reason: string }> = [];
  const warns: string[] = [];
  const info = {
    id: `agent_t662_${process.pid}`, ownerUserId: "u", name: "t662", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const opts = {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner, autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: {}, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (lvl: string, msg: string) => { if (lvl === "warn") warns.push(msg); },
    cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: (h: { soft: boolean; reason: string }) => { events.push(h); }, onExit: () => {},
  } as never;
  const runner = new AgentRunner(info, opts);
  (runner as unknown as { drainOcQueue: () => void }).drainOcQueue = () => {};
  return { runner, events, warns };
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const tick = (r: AgentRunner) => (r as unknown as { tickHangWatch: () => void }).tickHangWatch();
const snap = () => healthSnapshot(deps).turns;

beforeEach(() => _resetForTest());

/* ---------- C1: suppress NÃO incrementa o notificado ---------- */

test("T-662 (C1): hang de 1º attempt suprimido → cru sobe, notificado fica parado", () => {
  const { runner, events, warns } = makeRunner();
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = null;
  a.inflightPerMessage = { content: "msg", images: undefined, attempt: 0 };
  a.activityClock.lastActivityAt = Date.now() - 121_000; // > hardMs grok
  a.activityClock.firstEventAt = Date.now() - 130_000; // fora do cold start (T-593)

  tick(runner);

  assert.equal(a.messageSession.busy, false, "turno morto recuperado");
  assert.ok(warns.some((w) => w.includes("notificação suprimida")), `esperava supressão: ${warns.join(" | ")}`);
  assert.equal(events.length, 0, "supressão não notifica");
  assert.equal(snap().hardRecovers, 1, "contador cru conta o recover");
  assert.equal(snap().hardRecoversNotified, 0, "T-662: supressão NÃO incrementa o notificado");
});

/* ---------- C1: summary incrementa 1× ---------- */

test("T-662 (C1): 3º evento de 1º attempt na janela (summary) incrementa o notificado 1×", () => {
  const { runner, events } = makeRunner();
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = null;
  a.inflightPerMessage = { content: "msg", images: undefined, attempt: 0 };
  a.activityClock.lastActivityAt = Date.now() - 121_000;
  a.activityClock.firstEventAt = Date.now() - 130_000;
  a.hardRecoverTimes = [Date.now() - 60_000, Date.now() - 30_000]; // 2 eventos anteriores na janela

  tick(runner);

  assert.equal(events.length, 1, "1 resumo agregado");
  assert.match(events[0]!.reason, /3 hard recovers \(1º attempt\)/);
  assert.equal(snap().hardRecovers, 1);
  assert.equal(snap().hardRecoversNotified, 1, "T-662: summary incrementa o notificado");
});

/* ---------- C1: immediate (attempt≥1) incrementa ---------- */

test("T-662 (C1): attempt≥1 (immediate) incrementa o notificado na hora", () => {
  const { runner, events } = makeRunner();
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = null;
  a.inflightPerMessage = { content: "msg", images: undefined, attempt: 1 };
  a.activityClock.lastActivityAt = Date.now() - 121_000;
  a.activityClock.firstEventAt = Date.now() - 130_000;

  tick(runner);

  assert.equal(events.length, 1, "attempt≥1 notifica na hora");
  assert.equal(snap().hardRecovers, 1);
  assert.equal(snap().hardRecoversNotified, 1, "T-662: immediate incrementa o notificado");
});

/* ---------- C1: lifetime — backstop suprimido; re-corte notifica ---------- */

test("T-662 (C1): lifetime 1º attempt suprime (notificado parado); re-corte attempt≥1 notifica", () => {
  const { runner, events, warns } = makeRunner("qwen");
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = null;
  a.inflightPerMessage = { content: "msg", images: undefined, attempt: 0 };
  a.activityClock.lastActivityAt = Date.now();
  a.activityClock.firstEventAt = Date.now() - 60_000;
  a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_MS + 1_000);

  tick(runner); // 1º corte por teto: backstop esperado → suppress

  assert.ok(warns.some((w) => w.includes("HARD recover: turn lifetime")), `esperava corte por lifetime: ${warns.join(" | ")}`);
  assert.equal(snap().hardRecovers, 1);
  assert.equal(snap().hardRecoversNotified, 0, "T-662: backstop de lifetime NÃO incrementa o notificado");
  assert.equal(events.length, 0, "1º attempt de lifetime silencioso");
  assert.equal(a.inflightPerMessage?.attempt, 1, "mensagem re-enfileirada");

  // Re-corte do MESMO turno já re-enfileirado (attempt≥1) → immediate
  a.messageSession.busy = true;
  a.ocActiveProc = null;
  a.activityClock.lastActivityAt = Date.now();
  a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_MS + 1_000);

  tick(runner);

  assert.ok(events.some((r) => r.reason.startsWith("[lifetime]")), `notificação imediata de lifetime: ${events.map((e) => e.reason).join(" | ")}`);
  assert.equal(snap().hardRecovers, 2);
  assert.equal(snap().hardRecoversNotified, 1, "T-662: attempt≥1 de lifetime incrementa o notificado");
});