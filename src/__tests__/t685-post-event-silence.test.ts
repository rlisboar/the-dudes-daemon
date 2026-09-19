/**
 * T-685 — watchdog matava turno VIVO pós-1º evento e sem tool em voo.
 *
 * Defeito (medido no host do dono, 2026-09-18): `effectiveHardMs()` só usava a
 * janela firstEventMs (T-593) em COLD START; depois do primeiro evento
 * semântico o hardMs seco de 120s (família grok) voltava a valer. O silêncio
 * real do MODELO entre eventos (runner grok-custom, effort xhigh, contexto
 * ~138k) estourava esse limiar com o turno vivo e 0 tool em voo — 11 kills da
 * classe em 120-124s no dia, cada kill descartando a sessão e re-enfileirando.
 *
 * Fix: teto PRÓPRIO pós-evento (postEventMs, 5min na família grok) — trava
 * real segue recolhida, no teto declarado, não aos 120s. O teto de tool
 * (toolsHardMs ~10min, T-240) e o deadProcMs (12s) NÃO mudam.
 *
 * Harness: AgentRunner REAL + tickHangWatch, drainOcQueue stubbado (padrão
 * T-240/T-662) e processo filho real para a sonda de liveness.
 */
import "./scratch-home.js";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { AgentRunner } from "../agent-runner.js";
import {
  effectiveHardMs,
  hangPhase,
  hangThresholds,
} from "../runners/turn-watchdog.js";

function makeRunner(): { runner: AgentRunner; events: Array<{ soft: boolean; reason: string }>; warns: string[] } {
  const events: Array<{ soft: boolean; reason: string }> = [];
  const warns: string[] = [];
  const info = {
    id: `agent_t685_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t685", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const opts = {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "grok-custom", autoApprove: true, workspaceRoot: os.tmpdir(),
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

function aliveChild(): ChildProcess {
  return spawn("sleep", ["300"], { stdio: "ignore" });
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const tick = (r: AgentRunner) => (r as unknown as { tickHangWatch: () => void }).tickHangWatch();
const hardWarns = (warns: string[]) => warns.filter((w) => w.includes("HARD recover"));

/* ---------- critério 2: silêncio do modelo pós-evento não mata ---------- */

test("T-685 critério 2: pós-1º-evento, sem tool, atividade a cada ~105s por ≥6min → ZERO hard recover", () => {
  const { runner, warns } = makeRunner();
  const child = aliveChild();
  after(() => { try { child.kill("SIGKILL"); } catch { /* */ } });
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = child;
  a.activityClock.firstEventAt = Date.now() - 30_000; // 1º evento já emitido

  // 6 ciclos de renovação a 105s = 630s simulados (≥6min), todos dentro do
  // teto pós-evento (300s) — pré-fix o limiar seco de 120s não disparava aqui,
  // mas a banda real de prod (120-124s) disparava; ver teste seguinte.
  const ciclos = 6;
  for (let i = 0; i < ciclos; i++) {
    a.activityClock.lastActivityAt = Date.now() - 105_000;
    tick(runner);
    assert.equal(a.messageSession.busy, true, `ciclo ${i + 1}: turno vivo não pode morrer`);
    assert.equal(hardWarns(warns).length, 0, `ciclo ${i + 1}: ${warns.join(" | ")}`);
  }
  assert.ok(ciclos * 105_000 >= 6 * 60_000, "cobertura simulada ≥6min");
});

test("T-685 critério 2 (banda medida): renovações a cada ~125s também não matam — discriminador vs pré-fix", () => {
  const { runner, warns } = makeRunner();
  const child = aliveChild();
  after(() => { try { child.kill("SIGKILL"); } catch { /* */ } });
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = child;
  a.activityClock.firstEventAt = Date.now() - 30_000;

  // 125s é a banda medida em prod (11 kills em 120-124s). Pré-fix: hard no
  // 1º tick; pós-fix: soft, turno segue.
  for (let i = 0; i < 4; i++) {
    a.activityClock.lastActivityAt = Date.now() - 125_000;
    tick(runner);
    assert.equal(a.messageSession.busy, true, `ciclo ${i + 1}: 125s de silêncio não pode matar`);
    assert.equal(hardWarns(warns).length, 0, `ciclo ${i + 1}: ${warns.join(" | ")}`);
  }
});

/* ---------- critério 3: trava real pós-evento ainda é recolhida ---------- */

test("T-685 critério 3: travamento real pós-1º-evento é recolhido no teto novo declarado (300s)", () => {
  const { runner, warns } = makeRunner();
  const child = aliveChild();
  after(() => { try { child.kill("SIGKILL"); } catch { /* */ } });
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = child;
  a.inflightPerMessage = { content: "msg", images: undefined, attempt: 0 };
  a.activityClock.firstEventAt = Date.now() - 400_000; // pós-evento

  const ceiling = hangThresholds("grok-custom").postEventMs;
  assert.equal(ceiling, 300_000, "teto pós-evento declarado no card");

  // 125s: já passou dos 120s antigos, ainda NÃO mata
  a.activityClock.lastActivityAt = Date.now() - 125_000;
  tick(runner);
  assert.equal(a.messageSession.busy, true, "125s pós-evento não mata mais");
  assert.equal(hardWarns(warns).length, 0);

  // No teto declarado: recolhe de verdade
  a.activityClock.lastActivityAt = Date.now() - (ceiling! + 5_000);
  tick(runner);
  assert.equal(a.messageSession.busy, false, "trava real recolhida no teto novo");
  assert.ok(hardWarns(warns).some((w) => w.includes("no activity for")), warns.join(" | "));
  assert.equal(a.inflightPerMessage?.attempt, 1, "mensagem re-enfileirada 1×");
});

/* ---------- critério 4: processo MORTO continua rápido (deadProcMs) ---------- */

test("T-685 critério 4: processo MORTO com busy pós-evento → hard ≤15s (deadProcMs intacto)", async () => {
  const { runner, warns } = makeRunner();
  const dead = spawn("true", { stdio: "ignore" });
  await new Promise((r) => dead.once("exit", () => r(null)));
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = dead;
  a.activityClock.firstEventAt = Date.now() - 60_000;
  a.activityClock.lastActivityAt = Date.now() - 3_000; // idle curto: quem decide é a morte

  const started = Date.now();
  tick(runner); // arma deadSince
  a.activityClock.deadSince = Date.now() - 13_000; // deadProcMs=12s já vencido
  tick(runner); // recover

  assert.ok(Date.now() - started < 15_000, "detecção de proc morto segue ≤15s");
  assert.equal(a.messageSession.busy, false, "turno morto recuperado");
  assert.ok(warns.some((w) => w.includes("process dead")), warns.join(" | "));
});

/* ---------- critério 5: tool em voo mantém toolsHardMs (T-240) ---------- */

test("T-685 critério 5: com tool em voo o teto segue toolsHardMs (~10min) e o pós-evento não o encurta", () => {
  const { runner, warns } = makeRunner();
  const child = aliveChild();
  after(() => { try { child.kill("SIGKILL"); } catch { /* */ } });
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = child;
  a.activityClock.firstEventAt = Date.now() - 60_000;
  a.toolsInFlight = 1;
  a.toolsInFlightSince = Date.now() - 5 * 60_000; // tool longa saudável
  a.activityClock.lastActivityAt = Date.now() - 6 * 60_000; // silêncio > teto pós-evento

  tick(runner);
  tick(runner);
  assert.equal(a.messageSession.busy, true, "tool viva protege (T-240 sem regressão)");
  assert.equal(a.toolsInFlight, 1, "tool in-flight preservada");
  assert.equal(hardWarns(warns).length, 0);

  // Passado o teto absoluto de tool: reavalia e recolhe (tool_result perdido)
  a.toolsInFlightSince = Date.now() - (hangThresholds("grok-custom").toolsHardMs + 60_000);
  tick(runner);
  assert.ok(warns.some((w) => w.includes("reavaliando hang")), warns.join(" | "));
  assert.equal(a.messageSession.busy, false, "silêncio ≥ teto pós-evento com tool vencida → recolhe");
});

/* ---------- unidade: teto declarado e sem regressão nos demais runners ---------- */

test("T-685 unidade: postEventMs declarado (grok 5min); cold start T-593 intacto; demais runners sem mudança", () => {
  const g = hangThresholds("grok-custom");
  assert.equal(g.postEventMs, 5 * 60_000, "teto pós-evento declarado");
  assert.equal(g.firstEventMs, 5 * 60_000, "cold start (T-593) intacto");
  assert.ok(g.softMs < g.hardMs, "soft < hard");
  assert.ok(g.hardMs < g.postEventMs!, "teto pós-evento acima do piso");
  assert.ok(g.postEventMs! < g.toolsHardMs, "teto de tool segue acima do pós-evento");

  // pós-evento: 121s vira soft; hard só no teto
  assert.equal(hangPhase(121_000, g, false), "soft");
  assert.equal(hangPhase(g.postEventMs!, g, false), "hard");
  assert.equal(effectiveHardMs(g, false), 300_000);

  // cold start inalterado (T-593)
  assert.equal(hangPhase(121_000, g, true), "soft");
  assert.equal(hangPhase(g.firstEventMs!, g, true), "hard");
  assert.equal(effectiveHardMs(g, true), 300_000);

  // demais runners: sem postEventMs → hardMs seco preservado
  for (const r of ["qwen", "claude", "opencode", "codex", "crush", "gemini"]) {
    const o = hangThresholds(r);
    assert.equal(o.postEventMs, undefined, `${r} sem teto pós-evento`);
    assert.equal(hangPhase(o.hardMs, o, false), "hard", `${r} mantém o hard seco`);
  }
});