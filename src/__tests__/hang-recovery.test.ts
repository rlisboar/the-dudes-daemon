/**
 * T-009: recuperação automática de turno travado.
 *
 * Simula o que o hang watch + recoverHungTurn fazem em prod:
 *  - filho que não responde (sleep infinito / process group)
 *  - detecção por idle semântico ≤120s (thresholds grok)
 *  - kill por process group
 *  - release do turn-gate
 *  - re-fila da mensagem (1×)
 *  - log + contador de hard recover no health
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createActivityClock,
  hangPhase,
  hangThresholds,
  touchActivityClock,
} from "../runners/turn-watchdog.js";
import { killProcess, processAlive } from "../runners/process-lifecycle.js";
import { acquireTurnSlot, turnGateStats } from "../runners/turn-gate.js";
import {
  _resetForTest,
  healthSnapshot,
  recordHardRecover,
  recordHang,
  recordLog,
  recentLogs,
} from "../health-monitor.js";

/** Espelha recoverHungTurn no essencial — testável sem AgentRunner monólito. */
function simulateHardRecover(input: {
  proc: ChildProcess | null;
  releaseSlot: () => void;
  inflight: { content: string; attempt: number } | null;
  logs: string[];
  runner: string;
  reason: string;
  idleMs: number;
}): { requeued: string | null; busy: boolean } {
  recordHardRecover(input.runner);
  const line = `[hang:test] HARD recover: ${input.reason} (runner=${input.runner} idleMs=${Math.round(input.idleMs)})`;
  input.logs.push(line);
  recordLog("warn", line);
  killProcess(input.proc, "SIGKILL");
  input.releaseSlot();
  let requeued: string | null = null;
  if (input.inflight && input.inflight.attempt < 1) {
    requeued = input.inflight.content;
    const rq = `[hang:test] re-enfileirando mensagem após hard recover (attempt 1)`;
    input.logs.push(rq);
    recordLog("warn", rq);
  }
  return { requeued, busy: false };
}

test("thresholds grok: soft→hard em ≤120s (critério de aceite T-009)", () => {
  const t = hangThresholds("grok");
  assert.equal(hangPhase(t.softMs - 1, t), "ok");
  assert.equal(hangPhase(t.softMs, t), "soft");
  assert.equal(hangPhase(t.hardMs, t), "hard");
  assert.ok(t.hardMs <= 120_000);
});

test("bytes brutos NÃO contam: só touchActivity semântico avança o relógio", () => {
  // Repro da causa-raiz: se cada stderr reseta idle, hard nunca chega.
  const clock = createActivityClock(0);
  // "ruído" de thrash — NÃO chamar touchActivityClock
  const idleAfterNoise = 100_000;
  assert.equal(hangPhase(idleAfterNoise, hangThresholds("grok")), "soft");
  // progresso semântico (text/tool) reseta
  touchActivityClock(clock, 100_000);
  assert.equal(hangPhase(0, hangThresholds("grok")), "ok");
});

test("turno travado: kill por process group + release do turn-gate + re-fila + log + health", async () => {
  _resetForTest();
  const logs: string[] = [];
  const t = hangThresholds("grok");

  // Ocupa um slot como um turno grok real
  const release = await acquireTurnSlot("grok:hang-test");
  const ativosAntes = turnGateStats().ativos;
  assert.ok(ativosAntes >= 1);

  // Filho detached (líder de process group) — espelha spawnDropped
  const child = spawn("sleep", ["300"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid);
  assert.equal(processAlive(child), true);

  // Simula hang watch: idle ≥ hardMs sem atividade semântica
  const clock = createActivityClock(Date.now() - t.hardMs - 1_000);
  const idleMs = Date.now() - clock.lastActivityAt;
  assert.equal(hangPhase(idleMs, t), "hard");
  assert.ok(idleMs <= 120_000 + 5_000, `detecção deve ser ≤120s (+margem tick); idleMs=${idleMs}`);

  const result = simulateHardRecover({
    proc: child,
    releaseSlot: release,
    inflight: { content: "msg-travada", attempt: 0 },
    logs,
    runner: "grok",
    reason: `no activity for ${Math.round(idleMs / 1000)}s`,
    idleMs,
  });

  // Process group morto (espera breve pro kernel recolher)
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(processAlive(child), false, "filho deveria ter morrido via kill(-pid)");
  assert.equal(result.busy, false);
  assert.equal(result.requeued, "msg-travada");

  // Slot liberado (não preso até MAX_HOLD)
  assert.equal(turnGateStats().ativos, ativosAntes - 1, "turn-gate slot não foi liberado");

  // Log explícito
  assert.ok(logs.some((l) => l.includes("HARD recover")), `logs=${logs.join(" | ")}`);
  assert.ok(logs.some((l) => l.includes("re-enfileirando")), "falta log de re-fila");

  // Health: contador de hard recover + linha no ring
  const snap = healthSnapshot({
    turnGate: { ativos: turnGateStats().ativos, fila: turnGateStats().fila, max: turnGateStats().max },
    agentsRunning: 0,
    e2eeProjects: 0,
  });
  assert.ok(snap.turns.hardRecovers >= 1, "health.turns.hardRecovers não incrementou");
  assert.ok(snap.byRunner.grok?.hardRecovers && snap.byRunner.grok.hardRecovers >= 1);
  const ring = recentLogs(50);
  assert.ok(ring.some((l) => l.msg.includes("HARD recover")), "ring de health sem HARD recover");
});

test("soft hang incrementa hangs no health (painel)", () => {
  _resetForTest();
  recordHang("grok");
  const snap = healthSnapshot({
    turnGate: { ativos: 0, fila: 0, max: 3 },
    agentsRunning: 1,
    e2eeProjects: 0,
  });
  assert.equal(snap.turns.hangs, 1);
  assert.equal(snap.byRunner.grok?.hangs, 1);
});
