/**
 * T-033: gate de self-update (dedup) + retrocompat de evento desconhecido.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSelfUpdateGate, dispatchOrchEvent } from "../self-update-gate.js";

test("release:available dispara check na hora (sem esperar intervalo)", async () => {
  let runs = 0;
  const gate = createSelfUpdateGate({
    enabled: () => true,
    run: async () => { runs++; },
  });
  const r = await gate.trigger("push abcdef");
  assert.equal(r, "started");
  assert.equal(runs, 1);
});

test("dedup: segundo trigger enquanto checando → skipped-inflight", async () => {
  // Barreira síncrona: o run só termina quando liberamos.
  let unlock!: () => void;
  const barrier = new Promise<void>((res) => { unlock = res; });
  let started = 0;
  const gate = createSelfUpdateGate({
    enabled: () => true,
    run: async () => {
      started++;
      await barrier;
    },
  });

  // Dispara e deixa o run pendurado na barreira
  const p1 = gate.trigger("push-1");
  // Cede o event loop até o run ter incrementado started
  while (started === 0) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(started, 1);
  assert.equal(gate.busy(), true);

  const r2 = await gate.trigger("push-2");
  assert.equal(r2, "skipped-inflight");
  assert.equal(started, 1, "não deve iniciar segundo run");

  unlock();
  assert.equal(await p1, "started");
  assert.equal(gate.busy(), false);

  const r3 = await gate.trigger("push-3");
  assert.equal(r3, "started");
  assert.equal(started, 2);
});

test("THE_DUDES_SELF_UPDATE=0 → skipped-disabled", async () => {
  const gate = createSelfUpdateGate({
    enabled: () => false,
    run: async () => { throw new Error("não deveria rodar"); },
  });
  assert.equal(await gate.trigger("push"), "skipped-disabled");
});

test("retrocompat: evento desconhecido é ignorado (daemon antigo)", () => {
  let selfUpdateCalls = 0;
  const handlers: Record<string, () => void> = {
    "daemon:welcome": () => {},
    // release:available AUSENTE — daemon pré-T-033
  };
  assert.equal(dispatchOrchEvent("release:available", handlers), "ignored");
  assert.equal(selfUpdateCalls, 0);

  // com handler (daemon novo)
  handlers["release:available"] = () => { selfUpdateCalls++; };
  assert.equal(dispatchOrchEvent("release:available", handlers), "handled");
  assert.equal(selfUpdateCalls, 1);

  // outro evento desconhecido
  assert.equal(dispatchOrchEvent("future:thing", handlers), "ignored");
});

test("ciclo horário permanece: trigger por reason=interval funciona igual", async () => {
  const reasons: string[] = [];
  const gate = createSelfUpdateGate({
    enabled: () => true,
    run: async () => {},
    log: (_l, m) => reasons.push(m),
  });
  await gate.trigger("interval-1h");
  await gate.trigger("push deadbeef");
  assert.ok(reasons.some((m) => m.includes("interval-1h")));
  assert.ok(reasons.some((m) => m.includes("push")));
});
