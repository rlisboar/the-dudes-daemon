/**
 * T-055: falsos hangs — critérios de aceite do PM.
 *
 * Simula a forense: fila do turn-gate cheia → espera >hardMs NÃO hang;
 * pools separados; usage/plan = atividade; leader kill; bridge 25s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  acquireTurnSlot,
  turnGateStats,
  _resetTurnGateForTest,
} from "../runners/turn-gate.js";
import {
  createActivityClock,
  hangPhase,
  hangThresholds,
  touchActivityClock,
} from "../runners/turn-watchdog.js";
import { parseGrokStreamEvent } from "../runners/turn-parsers.js";
import { killGrokLeader } from "../runners/process-lifecycle.js";
import { BridgeRelay } from "../bridge-relay.js";

/** Espelha a política de tickHangWatch: queued/waitingTurnGate isenta hang. */
function wouldHardRecover(opts: {
  waitingTurnGate: boolean;
  state: string;
  idleMs: number;
  runner?: string;
}): boolean {
  if (opts.waitingTurnGate || opts.state === "queued") return false;
  return hangPhase(opts.idleMs, hangThresholds(opts.runner ?? "grok")) === "hard";
}

test("T-055 aceite: turno enfileirado >hardMs NÃO dispara hang (queued)", async () => {
  _resetTurnGateForTest();
  const t = hangThresholds("grok");
  const logs: string[] = [];
  const max = turnGateStats().max;
  const holds: Array<() => void> = [];
  for (let i = 0; i < max; i++) holds.push(await acquireTurnSlot(`ativo-${i}`, (l, m) => logs.push(`[${l}] ${m}`)));

  // 4º turno enfileira — como runGrokMessage com waitingTurnGate
  let waiterGranted = false;
  let releaseWaiter: (() => void) | null = null;
  const waiting = acquireTurnSlot("grok:queued-agent", (l, m) => logs.push(`[${l}] ${m}`)).then((r) => {
    waiterGranted = true;
    releaseWaiter = r;
    return r;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(waiterGranted, false);
  assert.ok(logs.some((l) => l.includes("aguardando slot")), `forense log: ${logs.join(" | ")}`);

  // Simula idle acima do teto EFETIVO enquanto queued (antes: hang falso).
  // T-685: pós-evento quem decide é o teto declarado (postEventMs), não o
  // limiar seco de 120s.
  const idleMs = (t.postEventMs ?? t.hardMs) + 5_000;
  assert.equal(
    wouldHardRecover({ waitingTurnGate: true, state: "queued", idleMs }),
    false,
    "ANTES da fix isto seria HARD; agora queued isenta",
  );
  assert.equal(
    wouldHardRecover({ waitingTurnGate: false, state: "thinking", idleMs }),
    true,
    "turno COM processo mudo ainda hard-recover (regressão)",
  );

  // Libera slot → waiter roda; relógio zera no spawn (simulado)
  holds[0]!();
  await waiting;
  assert.equal(waiterGranted, true);
  const clock = createActivityClock(Date.now()); // zera no spawn
  assert.equal(hangPhase(0, t), "ok");
  assert.equal(Date.now() - clock.lastActivityAt < 100, true);

  releaseWaiter?.();
  for (const h of holds.slice(1)) h();
  _resetTurnGateForTest();
});

test("T-055 aceite: 3 ativos + summarizer no bg → summarizer não ocupa main", async () => {
  _resetTurnGateForTest();
  const max = turnGateStats().max;
  assert.equal(max, 3);
  const main: Array<() => void> = [];
  for (let i = 0; i < max; i++) main.push(await acquireTurnSlot(`agent-${i}`));
  assert.equal(turnGateStats().ativos, 3);
  assert.equal(turnGateStats().fila, 0);

  // summarizer / brain ephemeral = pool bg
  const sum = await acquireTurnSlot("bg:grok", undefined, "bg");
  assert.equal(turnGateStats().ativos, 3, "main intacto com summarizer ativo");
  assert.equal(turnGateStats().bg.ativos, 1);
  assert.ok(turnGateStats().bg.max >= 1);

  // 4º agente titular AINDA enfileira (summarizer não liberou main)
  let fourth = false;
  const p4 = acquireTurnSlot("agent-4").then((r) => {
    fourth = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fourth, false);
  assert.equal(turnGateStats().fila, 1);

  sum(); // liberar summarizer não libera main
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fourth, false);

  main[0]!();
  const r4 = await p4;
  assert.equal(fourth, true);
  r4();
  for (const r of main.slice(1)) r();
  _resetTurnGateForTest();
});

test("T-055 aceite: stream só usage/plan por >softMs → sem soft hang", () => {
  const t = hangThresholds("grok");
  const clock = createActivityClock(0);
  // só usage/plan a cada 50s (sem text/tool)
  for (const ms of [50_000, 100_000, 150_000]) {
    const events = [
      ...parseGrokStreamEvent({ type: "usage", data: { input_tokens: 1, output_tokens: 1 } }),
      ...parseGrokStreamEvent({ type: "plan" }),
      ...parseGrokStreamEvent({ type: "unknown_progress", foo: 1 }),
    ];
    assert.ok(events.length >= 2, "usage/plan/unknown contam");
    // sawSemantic → touchActivity
    touchActivityClock(clock, ms);
  }
  const idleMs = 150_000 - clock.lastActivityAt;
  assert.equal(idleMs, 0);
  assert.equal(hangPhase(idleMs, t), "ok");
  // sem touch, softMs seria soft
  assert.equal(hangPhase(t.softMs, t), "soft");
});

test("T-055 aceite: HARD recover → killGrokLeader (mock sock)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "td-leader-"));
  const sock = path.join(dir, "leader.sock");
  writeFileSync(sock, "");
  // simula recoverHungTurn: kill client + leader
  const n = killGrokLeader(sock);
  assert.equal(typeof n, "number");
  assert.equal(existsSync(sock), false, "leader sock removido");
  assert.equal(killGrokLeader(undefined), 0);
  rmSync(dir, { recursive: true, force: true });
});

test("T-784: lsof vazio → fallback por argv --leader-socket mata o grupo e remove o sock", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "td-leader-"));
  const sock = path.join(dir, "leader.sock");
  writeFileSync(sock, "");
  const alvo = path.join(dir, "outro.sock");
  writeFileSync(alvo, "");
  const sinais: string[] = [];
  const origKill = process.kill;
  (process as any).kill = (pid: number, signal?: string) => {
    sinais.push(`${pid}:${signal}`);
    return true;
  };
  try {
    const mortos: number[] = [];
    const vias: string[] = [];
    const n = killGrokLeader(
      sock,
      // finder injetado: um leader deste sock + um de OUTRO sock (não pode morrer)
      (p) => (p === sock ? [42_000] : [42_001]),
      (pid, via) => { mortos.push(pid); vias.push(via); },
    );
    assert.equal(n, 1, "só o leader do sock pedido morre");
    assert.deepEqual(mortos, [42_000], "pid morto reportado via callback");
    assert.deepEqual(vias, ["argv"], "T-788 F3: fallback por argv é declarado no log");
    // kill de GRUPO (-pid), não individual
    assert.ok(sinais.includes("-42000:SIGKILL"), `esperava kill(-42000), tive ${sinais.join(",")}`);
    assert.ok(!sinais.some((s) => s.includes("42001")), "leader de outro sock não pode ser morto");
    assert.equal(existsSync(sock), false, "sock removido mesmo com lsof vazio");
    assert.equal(existsSync(alvo), true, "arquivo alheio intacto");
    // finder vazio: nenhum kill, sock ainda removido
    sinais.length = 0;
    const n2 = killGrokLeader(sock, () => []);
    assert.equal(n2, 0);
    assert.equal(sinais.length, 0);
    assert.equal(existsSync(sock), false);
  } finally {
    (process as any).kill = origKill;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-055 aceite: BridgeRelay timeout = 25s", () => {
  assert.equal(BridgeRelay.UPSTREAM_FETCH_TIMEOUT_MS, 25_000);
});

test("T-055 regressão: turno COM processo spawned mudo >teto pós-evento ainda hard (T-685)", () => {
  const t = hangThresholds("grok");
  const ceiling = t.postEventMs ?? t.hardMs;
  // T-685: o limiar seco de 120s deixou de matar pós-evento (vira soft);
  // o recolhimento segue no teto declarado.
  assert.equal(
    wouldHardRecover({ waitingTurnGate: false, state: "thinking", idleMs: t.hardMs + 1 }),
    false,
    "pós-evento aos 120s já não é hard (T-685)",
  );
  assert.equal(
    wouldHardRecover({
      waitingTurnGate: false,
      state: "thinking",
      idleMs: ceiling + 1,
    }),
    true,
    "no teto pós-evento o turno mudo ainda é recolhido",
  );
});

test("T-055: parse desconhecido com type string → atividade (não vazio)", () => {
  const ev = parseGrokStreamEvent({ type: "model_status", status: "ok" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0]?.type, "plan");
});
