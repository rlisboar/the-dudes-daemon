import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireTurnSlot, turnGateStats } from "../runners/turn-gate.js";

test("o gate limita a MAX_TURNS e a fila anda em ordem", async () => {
  const max = turnGateStats().max;
  const ordem: number[] = [];
  const releases: Array<() => void> = [];
  // ocupa todos os slots
  for (let i = 0; i < max; i++) releases.push(await acquireTurnSlot(`t${i}`));
  assert.equal(turnGateStats().ativos, max);
  // os próximos 2 esperam
  let quarto = false;
  let quinto = false;
  const p4 = acquireTurnSlot("t-extra-1").then((r) => { quarto = true; ordem.push(4); return r; });
  const p5 = acquireTurnSlot("t-extra-2").then((r) => { quinto = true; ordem.push(5); return r; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(quarto, false, "quarto turno passou com o gate cheio");
  assert.equal(turnGateStats().fila, 2);
  // libera um → só o quarto entra, em ordem
  releases[0]!();
  const r4 = await p4;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(quarto, true);
  assert.equal(quinto, false, "quinto furou a fila");
  r4();
  const r5 = await p5;
  assert.deepEqual(ordem, [4, 5]);
  // limpeza
  r5();
  for (const r of releases.slice(1)) r();
  assert.equal(turnGateStats().ativos, 0);
});

test("release é idempotente — resolve duplo não corrompe a contagem", async () => {
  const r = await acquireTurnSlot("dup");
  const antes = turnGateStats().ativos;
  r(); r(); r();
  assert.equal(turnGateStats().ativos, antes - 1);
});
