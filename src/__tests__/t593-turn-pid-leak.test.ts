/**
 * T-593 — turnos abandonados por HARD recover acumulavam CLIs vivos.
 *
 * Defeito (medido no host do dono, 2026-09-16): o `close` TARDIO de um turno
 * já recuperado anulava `ocActiveProc` incondicionalmente (grok.ts:350) DEPOIS
 * de o drain ter posto um turno NOVO em voo. O hard recover seguinte chamava
 * `killProcess(null)` — no-op em process-lifecycle (`!processAlive(null)` →
 * return false) — e o CLI do turno novo sobrevivia. Resultado: 10 processos
 * `grok-custom/grok -p` vivos, um deles por 2h24m, sustentando a carga que
 * produzia a T-592.
 *
 * Harness: AgentRunner REAL + CLI stub executável que regista o argv de cada
 * spawn e NUNCA emite evento semântico (turno pendurado). As asserções são
 * sobre PIDs REAIS do SO — é o que o sintoma mede.
 *
 * Cleanup em TODO caminho: o stub vivo prende o stdout do filho e o timer do
 * `armHardTimeout` (12min, sem unref) prende o event loop — o teste PENDA se o
 * filho não for morto à mão (pitfall T-376/T-417).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { hangPhase, hangThresholds } from "../runners/turn-watchdog.js";
import { killPidTree, killProcess } from "../runners/process-lifecycle.js";
import { turnGateStats, _resetTurnGateForTest } from "../runners/turn-gate.js";

/** Stub: registra o argv e fica vivo para sempre, SEM emitir linha semântica —
 *  é o turno "quieto" que o watchdog via como hang. */
const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const dir = path.dirname(url.fileURLToPath(import.meta.url));
const flat = process.argv.slice(2).join(" ").replace(/[\\r\\n]+/g, " ");
fs.appendFileSync(path.join(dir, "argv.log"), flat + "\\n");
setInterval(() => {}, 1000);
`;

interface Harness {
  runner: AgentRunner;
  warns: string[];
  errors: string[];
  children: Array<{ kill: (s?: string) => boolean }>;
  argvLines(): string[];
  /** Todos os pids de turno já spawnados, na ordem. */
  spawnedPids: number[];
  diag(): string;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t593-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const warns: string[] = [];
  const errors: string[] = [];
  const cmd = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  const cliCommands = {
    claude: off, opencode: off, gemini: off, codex: off, crush: off, qwen: off,
    // runner real do sintoma: grok-custom (família grok)
    grok: off, "grok-custom": cmd, graphify: off, graphifyMcp: off,
  };
  const info = {
    id: `agent_t593_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t593", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "grok-custom", autoApprove: true, workspaceRoot: dir,
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (lvl: string, msg: string) => { if (lvl === "warn") warns.push(msg); },
    cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: (msg: string) => errors.push(msg), onHung: () => {},
    onSessionId: () => {}, onExit: () => {},
  } as never);
  const children: Harness["children"] = [];
  const spawnedPids: number[] = [];
  const harness: Harness = {
    runner, warns, errors, children, spawnedPids,
    argvLines: () => {
      try {
        return readFileSync(path.join(dir, "argv.log"), "utf8").split("\n").filter((l) => l.trim());
      } catch {
        return [];
      }
    },
    diag: () => {
      const a = runner as unknown as Record<string, any>;
      return `state=${a.currentState} busy=${a.messageSession.busy} ` +
        `queued=${a.messageSession.queuedCount()} gate=${JSON.stringify(turnGateStats())} ` +
        `argv=${harness.argvLines().length} pids=${JSON.stringify(spawnedPids)} ` +
        `warns=[${warns.join(" | ")}] errors=[${errors.join(" | ")}]`;
    },
  };
  return harness;
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const tick = (r: AgentRunner) => (r as unknown as { tickHangWatch: () => void }).tickHangWatch();

/** Sonda de pid REAL do SO — não o bookkeeping do ChildProcess. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(cond: () => boolean, what: string, h?: Harness, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what} :: ${h ? h.diag() : ""}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 250));

/** Cleanup exaustivo: o recover põe turnos NOVOS em voo pelo drain e esses não
 *  passam por `h.children` — mata por PID (rastreado pelo próprio runner e por
 *  tudo que já foi spawnado), senão o stub vivo prende os pipes do filho e o
 *  ARQUIVO de teste nunca sai do event loop (o suite inteiro pendura). */
async function cleanup(h: Harness): Promise<void> {
  const a = asAny(h.runner);
  const alvos = new Set<number>([
    ...(a.liveTurnPids as Set<number>),
    ...h.spawnedPids,
    ...(a.ocActiveProc?.pid ? [a.ocActiveProc.pid as number] : []),
  ]);
  for (const pid of alvos) killPidTree(pid, "SIGKILL");
  for (const p of h.children) killProcess(p as never, "SIGKILL");
  h.runner.stop();
  await settle();
  for (const pid of alvos) {
    await until(() => !pidAlive(pid), `cleanup do pid ${pid}`, h, 5_000);
  }
  _resetTurnGateForTest();
}

/** Turno em voo pelo drain real (pushUserMessage): o recover tem fila para
 *  drenar, e é o turno NOVO que o close tardio do morto ameaçava. */
async function spawnTurn(h: Harness, content: string): Promise<number> {
  const a = asAny(h.runner);
  const antes = h.argvLines().length;
  h.runner.pushUserMessage(content);
  await until(() => h.argvLines().length > antes, `spawn do turno ${h.spawnedPids.length + 1}`, h);
  // O stub grava o argv ANTES de o pai voltar do spawn e gravar `ocActiveProc`:
  // sob carga, esperar só o argv lia o campo ainda nulo (flaky medido com o
  // suite inteiro a correr). Espera as DUAS condições.
  await until(() => !!a.ocActiveProc?.pid, `proc do turno ${h.spawnedPids.length + 1}`, h);
  const proc = a.ocActiveProc;
  assert.ok(proc?.pid, `turno ${h.spawnedPids.length + 1} sem proc :: ${h.diag()}`);
  h.children.push(proc);
  h.spawnedPids.push(proc.pid);
  return proc.pid as number;
}

/** Recover real pelo tick + espera o turno NOVO spawnar; devolve o pid novo. */
async function recoverAndWaitNewTurn(h: Harness, label: string): Promise<number> {
  const a = asAny(h.runner);
  const pidMorto = h.spawnedPids.at(-1);
  const antes = h.argvLines().length;
  forceHard(h);
  assert.ok(
    h.warns.some((w) => w.includes("HARD recover")),
    `${label}: recover não correu :: ${h.diag()}`,
  );
  await until(
    () => h.argvLines().length > antes && !!a.ocActiveProc?.pid && a.ocActiveProc.pid !== pidMorto,
    `${label}: spawn do turno novo`,
    h,
  );
  const proc = a.ocActiveProc;
  assert.ok(proc?.pid, `${label}: turno novo sem proc :: ${h.diag()}`);
  assert.notEqual(proc.pid, pidMorto, `${label}: o turno novo tem de ter pid próprio`);
  h.children.push(proc);
  h.spawnedPids.push(proc.pid);
  return proc.pid as number;
}

/** Coloca o relógio do turno acima do hard e dispara o watchdog. `cold` = o
 *  turno ainda não emitiu nenhum evento semântico (janela firstEventMs). */
function forceHard(h: Harness, opts: { cold?: boolean; idleMs?: number } = {}): void {
  const a = asAny(h.runner);
  const hard = hangThresholds("grok-custom").hardMs;
  a.activityClock.lastActivityAt = Date.now() - (opts.idleMs ?? hard + 5_000);
  a.activityClock.firstEventAt = opts.cold ? null : Date.now() - 60_000;
  tick(h.runner);
}

/* ---------- critério 2: close tardio não neutraliza o kill do recover ---------- */

test("T-593 critério 2: após hard recover com close tardio já entregue, o pid antigo não está mais vivo", async () => {
  const h = makeHarness();
  const a = asAny(h.runner);
  _resetTurnGateForTest();
  try {
    const pid1 = await spawnTurn(h, "m1");
    // Fila atrás: o drain do recover põe um turno NOVO em voo (é ele que o
    // close tardio do morto apagava antes da fix).
    h.runner.pushUserMessage("m2");

    const pid2 = await recoverAndWaitNewTurn(h, "recover 1");

    // O close REAL do turno morto (SIGKILL do recover) aterra DEPOIS do turno
    // novo existir — é exatamente esta ordem que produzia o defeito.
    await settle();
    assert.equal(
      a.ocActiveProc?.pid,
      pid2,
      `close tardio do morto apagou o proc do turno novo :: ${h.diag()}`,
    );
    await until(() => !pidAlive(pid1), "morte do pid do turno morto", h);
    assert.equal(pidAlive(pid1), false, "pid do turno morto continua vivo");

    // 2º recover: agora tem de matar o turno novo de facto. Sem a fix o campo
    // estaria null e o kill seria no-op (process-lifecycle: !processAlive(null)).
    h.runner.pushUserMessage("m3");
    await recoverAndWaitNewTurn(h, "recover 2");
    await until(() => !pidAlive(pid2), "morte do pid do turno novo", h);

    assert.equal(pidAlive(pid2), false, "pid antigo sobreviveu ao hard recover (kill no-op)");
  } finally {
    await cleanup(h);
  }
});

/* ---------- critério 3: 3 hard recovers consecutivos → 1 processo vivo ---------- */

test("T-593 critério 3: 3 hard recovers consecutivos no mesmo agente deixam exatamente 1 processo vivo", async () => {
  const h = makeHarness();
  const a = asAny(h.runner);
  _resetTurnGateForTest();
  try {
    await spawnTurn(h, "m1");
    // Fila para cada recover ter o que drenar.
    h.runner.pushUserMessage("m2");
    h.runner.pushUserMessage("m3");
    h.runner.pushUserMessage("m4");

    for (let i = 1; i <= 3; i++) {
      const pidMorto = h.spawnedPids.at(-1)!;
      await recoverAndWaitNewTurn(h, `recover ${i}`);
      // Espera o pid morto sair do SO antes da próxima rodada.
      await until(() => !pidAlive(pidMorto), `morte do pid do turno ${i}`, h);
    }

    const vivos = h.spawnedPids.filter((p) => pidAlive(p));
    assert.equal(
      vivos.length,
      1,
      `esperado 1 CLI vivo para o agente, medido ${vivos.length} (pids ${JSON.stringify(h.spawnedPids)})`,
    );
    // O sobrevivente é o turno mais recente, e é o único rastreado.
    assert.equal(vivos[0], h.spawnedPids.at(-1), "o sobrevivente tem de ser o turno mais novo");
    assert.deepEqual([...a.liveTurnPids], [h.spawnedPids.at(-1)], "só o turno vivo segue rastreado");
    assert.equal(turnGateStats().ativos, 1, "exatamente 1 slot do turn-gate ocupado");
  } finally {
    await cleanup(h);
  }
});

/* ---------- extra: o stop() não deixa o turno abandonado vivo ---------- */

test("T-593: stop() mata o turno abandonado mesmo com ocActiveProc já anulado", async () => {
  const h = makeHarness();
  const a = asAny(h.runner);
  _resetTurnGateForTest();
  try {
    const pid1 = await spawnTurn(h, "m1");
    // Estado do defeito: a referência do turno vivo já foi anulada por um close
    // tardio e só o rastreio de pids sabe que ele existe.
    a.ocActiveProc = null;
    const antes = [...(a.liveTurnPids as Set<number>)];
    h.runner.stop();
    console.error(`[debug] stop(): pid=${pid1} tracked=${JSON.stringify(antes)} depois=${JSON.stringify([...(a.liveTurnPids as Set<number>)])} alive=${pidAlive(pid1)} diag=${h.diag()}`);
    await until(() => !pidAlive(pid1), "morte do turno abandonado no stop()", h);
    assert.equal(pidAlive(pid1), false, "stop() deixou o CLI abandonado vivo");
  } finally {
    await cleanup(h);
  }
});

/* ---------- critério 4: turno ainda em cold start não é morto ---------- */

test("T-593 critério 4: turno que ainda não emitiu evento (cold start) NÃO é morto aos 120s", async () => {
  const h = makeHarness();
  const a = asAny(h.runner);
  _resetTurnGateForTest();
  try {
    const pid1 = await spawnTurn(h, "m1");
    await settle();

    // 125s de silêncio sem NENHUM evento semântico — o limiar seco de 120s
    // matava aqui (121 de 124 hard recovers de prod caíram neste ponto).
    forceHard(h, { cold: true, idleMs: 125_000 });
    assert.equal(
      h.warns.some((w) => w.includes("HARD recover")),
      false,
      `cold start não pode hard-recover aos 125s: ${h.warns.join(" | ")}`,
    );
    assert.equal(h.spawnedPids.length, 1, "nenhum turno novo: o turno original segue vivo");
    assert.equal(pidAlive(pid1), true, "o turno em cold start continua vivo");

    // Mesmo idle, mas já com primeiro evento emitido → volta ao hardMs (sem
    // regressão: turno que emitiu e ficou quieto continua sendo recolhido).
    a.activityClock.firstEventAt = Date.now() - 300_000;
    a.activityClock.lastActivityAt = Date.now() - 125_000;
    tick(h.runner);
    assert.ok(h.warns.some((w) => w.includes("HARD recover")), "turno já iniciado e quieto tem de ser recolhido aos 120s");
    await until(() => !pidAlive(pid1), "morte do turno recolhido", h);
  } finally {
    await cleanup(h);
  }
});

/* ---------- unidade: o limiar é condicional, não um hardMs maior ---------- */

test("T-593: effectiveHardMs só vale em cold start; sem janela o comportamento anterior é preservado", () => {
  const t = hangThresholds("grok-custom");
  assert.ok(t.firstEventMs && t.firstEventMs > t.hardMs, "família grok tem janela de cold start");

  // cold start: 121s ainda não mata (é o que os 121/124 hard recovers de prod
// mediam), e o aviso soft continua saindo aos 60s
  assert.equal(hangPhase(t.hardMs + 1_000, t, true), "soft");
  assert.equal(hangPhase(t.softMs, t, true), "soft");
  assert.equal(hangPhase(t.softMs - 1_000, t, true), "ok");
  assert.equal(hangPhase(t.firstEventMs, t, true), "hard");
  // já emitiu: volta ao limiar seco
  assert.equal(hangPhase(t.hardMs + 1_000, t, false), "hard");
  // default (3º arg omitido) = comportamento anterior à T-593
  assert.equal(hangPhase(t.hardMs + 1_000, t), "hard");

  // runners sem firstEventMs não mudam de comportamento
  for (const r of ["qwen", "gemini", "codex", "crush", "opencode", "claude"]) {
    const o = hangThresholds(r);
    assert.equal(o.firstEventMs, undefined, `${r} não tem janela declarada`);
    assert.equal(hangPhase(o.hardMs + 1_000, o, true), "hard", `${r} mantém o hard seco`);
  }
});