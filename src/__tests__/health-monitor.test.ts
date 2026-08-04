import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  _resetForTest, healthSnapshot, recentLogs, recordHang, recordHardRecover,
  recordLog, recordTurnEnd, recordTurnStart, recordWsRtt,
} from "../health-monitor.js";

const deps = { turnGate: { ativos: 1, fila: 0, max: 3 }, agentsRunning: 2, e2eeProjects: 1 };

beforeEach(() => _resetForTest());

test("contadores por runner e totais fecham", () => {
  recordTurnStart("grok"); recordTurnEnd("grok", 1200, true);
  recordTurnStart("grok"); recordTurnEnd("grok", 3400, false);
  recordTurnStart("gemini"); recordTurnEnd("gemini", 800, true);
  recordHang("grok"); recordHardRecover("grok");
  const h = healthSnapshot(deps);
  assert.deepEqual(h.turns, { started: 3, ok: 2, failed: 1, hardRecovers: 1, hangs: 1 });
  assert.equal(h.byRunner.grok!.failed, 1);
  assert.equal(h.byRunner.gemini!.ok, 1);
  assert.equal(h.agentsRunning, 2);
});

test("p50/p95 saem da janela de durações", () => {
  for (let i = 1; i <= 100; i++) { recordTurnStart("x"); recordTurnEnd("x", i * 100, true); }
  const h = healthSnapshot(deps);
  assert.equal(h.turnP50Ms, 5000);
  assert.equal(h.turnP95Ms, 9500);
});

test("ring de logs respeita o teto e preserva ordem", () => {
  for (let i = 0; i < 700; i++) recordLog("info", `linha ${i}`);
  const ultimas = recentLogs(600);
  assert.equal(ultimas.length, 600);
  assert.equal(ultimas[0]!.msg, "linha 100");
  assert.equal(ultimas.at(-1)!.msg, "linha 699");
  assert.equal(recentLogs(5).length, 5);
});

test("RTT: só valores finitos e não-negativos entram", () => {
  recordWsRtt(-5); recordWsRtt(NaN);
  assert.equal(healthSnapshot(deps).wsRttMs, null);
  recordWsRtt(42.7);
  assert.equal(healthSnapshot(deps).wsRttMs, 43);
});
