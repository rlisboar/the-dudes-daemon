/**
 * T-776: o POST síncrono do opencode não pode medir o turno inteiro pelo
 * socket (ele fica mudo; quem streama é o /event). O timeout do POST vira
 * OCIOSIDADE medida pela atividade do agente, com cap absoluto.
 * Aqui: ociosidade corta quando o agente para; progresso renova até o cap;
 * resposta normal resolve.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { OPENCODE_POST_CAP_MS, OPENCODE_TURN_TIMEOUT_MS } from "../agent-runner.js";
import { hangThresholds } from "../runners/turn-watchdog.js";
import { requestJson } from "../runners/opencode-transport.js";

function slowServer(delayMs: number, respond = true) {
  const server = http.createServer((_req, res) => {
    if (!respond) return; // segura para sempre
    setTimeout(() => { res.setHeader("content-type", "application/json"); res.end("{}"); }, delayMs);
  });
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

test("T-776: sem evento do agente, corta por OCIOSIDADE (não pelo turno inteiro)", async () => {
  const s = await slowServer(10_000, false);
  try {
    const parado = Date.now() - 5_000; // último evento 5s atrás
    await assert.rejects(
      requestJson(s.base, "/x", "POST", {}, 30_000, { idleTimeoutMs: 300, totalTimeoutMs: 60_000, activity: () => parado }),
      /sem evento do agente/,
    );
  } finally { await s.close(); }
});

test("T-776: com progresso o POST renova e só morre no CAP absoluto", async () => {
  const s = await slowServer(10_000, false);
  try {
    const t0 = Date.now();
    await assert.rejects(
      requestJson(s.base, "/x", "POST", {}, 30_000, { idleTimeoutMs: 400, totalTimeoutMs: 900, activity: () => Date.now() }),
      /cap absoluto/,
    );
    assert.ok(Date.now() - t0 >= 800, "viveu até o cap, sem ser cortado pela ociosidade");
  } finally { await s.close(); }
});

test("T-776: relógio anterior ao POST não conta como ociosidade deste turno", async () => {
  // T-796: o tick do detector é 250ms. Com servidor de 80ms a resposta chegava
  // ANTES do 1º tick e o caso era vacamente verde (passava até com
  // `marco = activity()`, sem o Math.max). 600ms garante >= 2 ticks: no código
  // antigo o POST morria em ~273ms por causa do relógio de 31min.
  const s = await slowServer(600);
  try {
    const velho = Date.now() - 31 * 60_000;
    const out = await requestJson(s.base, "/x", "POST", {}, 30_000, {
      idleTimeoutMs: 30 * 60_000,
      totalTimeoutMs: 60_000,
      activity: () => velho,
    });
    assert.deepEqual(out, {});
  } finally { await s.close(); }
});

test("T-776: resposta normal resolve antes de qualquer corte", async () => {
  const s = await slowServer(120);
  try {
    const out = await requestJson(s.base, "/x", "POST", {}, 30_000, { idleTimeoutMs: 300, totalTimeoutMs: 1_000, activity: () => Date.now() });
    assert.deepEqual(out, {});
  } finally { await s.close(); }
});

test("T-776: números derivados do medido (6 mortes no teto de 30min; pior run 81min)", () => {
  assert.equal(OPENCODE_TURN_TIMEOUT_MS, 30 * 60_000, "ociosidade segue 30min");
  assert.equal(OPENCODE_POST_CAP_MS, 120 * 60_000, "cap cobre o pior run medido (81min) com folga");
  assert.ok(OPENCODE_POST_CAP_MS > 90 * 60_000, ">= 90min (pior observado + margem)");
  assert.ok(OPENCODE_TURN_TIMEOUT_MS > hangThresholds("opencode").toolsHardMs, "ociosidade acima do toolsHard (T-750 mantido)");
});