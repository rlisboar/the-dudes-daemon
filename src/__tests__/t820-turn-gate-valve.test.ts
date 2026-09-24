/**
 * T-820: o valve anti-deadlock do turn-gate tem de ficar ACIMA do MAIOR teto de
 * turno de todos os runners — não do maior tier de um runner só.
 *
 * Achado (T-812, histórico de prod): o valve era `QWEN_HARD_TIMEOUT_MS + 5min`
 * (70min) enquanto o cap legítimo do opencode já era 120min (T-776). Um turno
 * opencode longo e SAUDÁVEL perdia o slot aos 70min — log de "slot preso" falso
 * e o gate passando a admitir mais turnos simultâneos que
 * `THE_DUDES_MAX_CLI_TURNS` (294 liberações à força no log; a última 24/09
 * 04:36Z).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acquireTurnSlot,
  turnGateDebug,
  turnGateStats,
  TURN_GATE_MAX_HOLD_MS,
  _resetTurnGateForTest,
} from "../runners/turn-gate.js";
import {
  MAIOR_TETO_DE_TURNO_MS,
  OPENCODE_POST_CAP_MS,
  QWEN_HARD_TIMEOUT_MS,
  TETOS_DE_TURNO_MS,
  TETO_POR_RUNNER_GATEADO,
  VALVE_FOLGA_MS,
} from "../runners/turn-limits.js";
import { RUNNER_ADAPTERS } from "../runners/index.js";

const min = (ms: number) => `${ms / 60_000}min`;

test("T-820: todo runner que pega slot tem teto declarado — e só ele", () => {
  const perMessage = Object.entries(RUNNER_ADAPTERS)
    .filter(([, a]) => a.execution === "per-message")
    .map(([nome]) => nome)
    .sort();
  assert.deepEqual(
    Object.keys(TETO_POR_RUNNER_GATEADO).sort(),
    perMessage,
    "runner per-message novo tem de declarar teto (senão o valve fica curto em silêncio)",
  );
  for (const [nome, a] of Object.entries(RUNNER_ADAPTERS)) {
    if (a.execution !== "persistent") continue;
    assert.equal(nome in TETO_POR_RUNNER_GATEADO, false, `${nome} é persistente: não pega slot do gate`);
  }
});

test("T-820: valve deriva do MAIOR teto declarado e cobre TODOS eles", () => {
  assert.equal(
    TURN_GATE_MAX_HOLD_MS,
    MAIOR_TETO_DE_TURNO_MS + VALVE_FOLGA_MS,
    "derivação única: valve = maior teto + folga (sem literal solto)",
  );
  assert.equal(
    MAIOR_TETO_DE_TURNO_MS,
    Math.max(...Object.values(TETOS_DE_TURNO_MS)),
    "o 'maior' tem de ser o máximo REAL dos tetos declarados (sem drift)",
  );
  for (const [nome, teto] of Object.entries(TETOS_DE_TURNO_MS)) {
    assert.ok(
      TURN_GATE_MAX_HOLD_MS > teto,
      `valve (${min(TURN_GATE_MAX_HOLD_MS)}) tem de cobrir ${nome} (${min(teto)})`,
    );
  }
});

test("T-820: a derivação ANTIGA (só o tier do qwen) era curta para o opencode", () => {
  // Documenta o bug com números: 65min (backstop do qwen) + 5min de folga =
  // 70min < 120min do post-cap do opencode — todo turno opencode entre 70 e
  // 120min era liberado à força em pleno trabalho vivo.
  assert.equal(QWEN_HARD_TIMEOUT_MS + VALVE_FOLGA_MS, 70 * 60_000, "a fórmula antiga dava 70min");
  assert.ok(
    QWEN_HARD_TIMEOUT_MS + VALVE_FOLGA_MS < OPENCODE_POST_CAP_MS,
    "…e 70min NÃO cobre o post-cap de 120min do opencode",
  );
  assert.equal(TURN_GATE_MAX_HOLD_MS, 125 * 60_000, "valve atual: 120min do maior teto + 5min de folga");
});

test("T-820: turno opencode de 120min NÃO é liberado à força; a folga é que abre o valve", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    _resetTurnGateForTest();
    const max = turnGateStats().max;
    const soltar: Array<() => void> = [];
    for (let i = 0; i < max; i++) soltar.push(await acquireTurnSlot(`opencode:holder${i}`));
    assert.equal(turnGateDebug().pools.main.forced, 0, "nenhum turno liberado à força no começo");

    let entrou = false;
    const naFila = acquireTurnSlot("opencode:na-fila").then((r) => {
      entrou = true;
      return r;
    });

    // Pior caso legítimo medido (T-776): um run opencode seguiu 81min e o cap
    // declarado é 120min. Aos 120min o slot AINDA é do turno vivo.
    t.mock.timers.tick(OPENCODE_POST_CAP_MS);
    await Promise.resolve();
    assert.equal(
      turnGateDebug().pools.main.forced,
      0,
      "aos 120min nada foi liberado à força (era aqui que o valve de 70min furava)",
    );
    assert.equal(entrou, false, "o pool segue cheio: os turnos estão vivos");

    // Só passada a folga o valve abre — e aí sim conta como liberação à força.
    t.mock.timers.tick(VALVE_FOLGA_MS + 1);
    await naFila;
    assert.equal(entrou, true, "o valve abriu espaço para a fila");
    assert.equal(turnGateDebug().pools.main.forced, max, "cada holder liberado à força é contado");
  } finally {
    _resetTurnGateForTest();
    t.mock.timers.reset();
  }
});