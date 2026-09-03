/**
 * T-240 — watchdog x falsos positivos: tool longa saudável não morre;
 * processo morto com busy morre rápido; sem tool comporta como hoje;
 * política de notificação agrega 1º attempt.
 *
 * Testes de tick usam AgentRunner REAL (padrão T-233) com processo filho
 * real (procAlive via kill(pid,0)).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import {
  HARD_RECOVER_SUMMARY_THRESHOLD,
  hangThresholds,
  hardRecoverNotifyPolicy,
  toolsInFlightHardDue,
} from "../runners/turn-watchdog.js";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";

function makeRunner(): { runner: AgentRunner; events: Array<{ soft: boolean; reason: string }>; errors: string[] } {
  const events: Array<{ soft: boolean; reason: string }> = [];
  const errors: string[] = [];
  const info = {
    id: "agent_t240", ownerUserId: "user_t240", name: "probe", role: "backend",
    systemPrompt: "", color: "#a78bfa", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const opts = {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "grok", autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: resolveCliCommands(), verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: (m: string) => { errors.push(m); },
    onHung: (h: { soft: boolean; reason: string }) => { events.push(h); },
    onExit: () => {},
  } as never;
  const runner = new AgentRunner(info, opts);
  // Hermeticidade: recoverHungTurn drena a fila no fim — sem o stub, o
  // re-enfileiramento spawnaria o CLI grok REAL no ambiente de teste.
  (runner as unknown as { drainOcQueue: () => void }).drainOcQueue = () => {};
  return { runner, events, errors };
}

function aliveChild(): ChildProcess {
  return spawn("sleep", ["120"], { stdio: "ignore" });
}

const tick = (r: AgentRunner) => (r as unknown as { tickHangWatch: () => void }).tickHangWatch();
const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;

test("T-240 thresholds: grok ganha teto absoluto de tool (~10min); demais runners mantêm 20min", () => {
  const g = hangThresholds("grok");
  const c = hangThresholds("claude");
  assert.equal(g.toolsHardMs, 10 * 60_000);
  assert.equal(g.hardMs, 120_000, "sem tool: hard segue ~120s (T-009 reinterpretado)");
  assert.equal(g.deadProcMs, 12_000);
  assert.equal(c.toolsHardMs, 20 * 60_000, "claude: comportamento atual preservado");
});

test("T-240 toolsInFlightHardDue: 5min grok NÃO venceu o teto; 11min venceu", () => {
  const g = hangThresholds("grok");
  assert.equal(toolsInFlightHardDue(5 * 60_000, g), false);
  assert.equal(toolsInFlightHardDue(11 * 60_000, g), true);
  assert.equal(toolsInFlightHardDue(21 * 60_000, hangThresholds("claude")), true);
});

test("T-240 (1): tool shell dormindo 5 min com processo VIVO → ZERO hard recover", () => {
  const { runner, events } = makeRunner();
  const child = aliveChild();
  after(() => { try { child.kill("SIGKILL"); } catch { /* */ } });
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.toolsInFlight = 1;
  a.toolsInFlightSince = Date.now() - 5 * 60_000; // tool longa saudável
  a.ocActiveProc = child;
  a.activityClock.lastActivityAt = Date.now() - 3 * 60_000; // idle > hardMs grok

  tick(runner);
  tick(runner);

  assert.equal(a.messageSession.busy, true, "turno saudável NÃO pode ser morto");
  assert.equal(a.toolsInFlight, 1, "tool in-flight preservada");
  assert.equal(events.length, 0, "nenhuma notificação de hard recover");
});

test("T-240 (2): processo MORTO com busy=true (e tool in-flight) → hard ≤15s, sem notificação individual (1º attempt)", async () => {
  const { runner, events, errors } = makeRunner();
  const dead = spawn("true", { stdio: "ignore" });
  // Determinístico: espera o processo MORRER de verdade (zombie responde a
  // kill(pid,0) → procAlive true; sem await o tick corrido via o alive).
  await new Promise((r) => dead.once("exit", () => r(null)));
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.toolsInFlight = 1;
  a.toolsInFlightSince = Date.now() - 5 * 60_000;
  a.ocActiveProc = dead;
  a.inflightPerMessage = { content: "msg", images: undefined, attempt: 0 };
  a.activityClock.lastActivityAt = Date.now() - 130_000;

  const started = Date.now();
  tick(runner); // arma deadSince = now
  a.activityClock.deadSince = Date.now() - 13_000; // deadProcMs=12s já vencido
  tick(runner); // hard recover

  const elapsed = Date.now() - started;
  assert.equal(a.messageSession.busy, false, "turno morto deve ser recuperado");
  assert.ok(elapsed < 15_000, `hard deve acontecer ≤15s (levou ${elapsed}ms)`);
  assert.equal(events.length, 0, "1º attempt não notifica individualmente (agregação)");
  assert.equal(errors.length, 0, "1º attempt não notifica individualmente (agregação)");
  assert.equal(a.inflightPerMessage?.attempt, 1, "mensagem re-enfileirada (attempt 1)");
});

test("T-240 (3): loop sem tool (sem eventos, sem processo) → hard ~120s como hoje", () => {
  const { runner, events } = makeRunner();
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.toolsInFlight = 0;
  a.ocActiveProc = null;
  a.inflightPerMessage = { content: "msg", images: undefined, attempt: 0 };
  a.activityClock.lastActivityAt = Date.now() - 121_000; // > hardMs grok (120s)

  tick(runner);

  assert.equal(a.messageSession.busy, false, "trava sem tool segue hard ~120s");
  assert.equal(events.length, 0, "1º attempt: suprimido pela política de notificação");
  assert.ok(a.hardRecoverTimes.length === 1, "evento registrado na janela de agregação");
});

test("T-240 (4): política — 1º attempt suprime; ≥3 na janela vira 1 resumo; attempt≥1 notifica na hora", () => {
  assert.equal(HARD_RECOVER_SUMMARY_THRESHOLD, 3);
  assert.equal(hardRecoverNotifyPolicy(0, 1), "suppress");
  assert.equal(hardRecoverNotifyPolicy(0, 2), "suppress");
  assert.equal(hardRecoverNotifyPolicy(0, 3), "summary");
  assert.equal(hardRecoverNotifyPolicy(0, 5), "summary");
  assert.equal(hardRecoverNotifyPolicy(1, 1), "immediate");
  assert.equal(hardRecoverNotifyPolicy(2, 5), "immediate");
});

test("T-240 (4b): agregação end-to-end — 3º evento de 1º attempt na janela emite 1 resumo", () => {
  const { runner, events, errors } = makeRunner();
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = null;
  a.inflightPerMessage = { content: "msg", images: undefined, attempt: 0 };
  a.activityClock.lastActivityAt = Date.now() - 121_000;
  // janela já com 2 eventos de 1º attempt (sem resumo emitido)
  a.hardRecoverTimes = [Date.now() - 60_000, Date.now() - 30_000];

  tick(runner);

  assert.equal(a.messageSession.busy, false);
  assert.equal(events.length, 1, "agregação: 1 resumo, não 3 notificações");
  assert.match(events[0]!.reason, /3 hard recovers \(1º attempt\) na última hora/);
  assert.equal(errors.length, 1);
  assert.deepEqual(a.hardRecoverTimes, [], "janela reiniciada após o resumo");
});

test("T-240 (4c): attempt≥1 (retry esgotado/re-enfileirado antes) notifica individualmente", () => {
  const { runner, events } = makeRunner();
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = null;
  a.inflightPerMessage = { content: "msg", images: undefined, attempt: 1 };
  a.activityClock.lastActivityAt = Date.now() - 121_000;

  tick(runner);

  assert.equal(a.messageSession.busy, false);
  assert.equal(events.length, 1, "attempt≥1 notifica na hora");
  assert.match(events[0]!.reason, /retry esgotado/);
});
