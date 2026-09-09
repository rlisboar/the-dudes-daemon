import test from "node:test";
import assert from "node:assert/strict";
import { grokSupportsXhigh, grokThinkingEffort, grokWireEfforts, normalizeGrokEffort } from "../runners/model-policy.js";
import { parseLineModelCatalog } from "../model-discovery.js";

test("grok-custom não degrada xhigh/max com qualquer model (T-162)", () => {
  // models arbitrários do dono (ex.: IDs custom) — xhigh universal
  assert.equal(normalizeGrokEffort("xhigh", "rezulto:rezulto/glm5.3-flash", "grok-custom"), "xhigh");
  assert.equal(normalizeGrokEffort("xhigh", "grok-4.5", "grok-custom"), "xhigh");
  assert.equal(normalizeGrokEffort("xhigh", "grok-composer-2.5-fast", "grok-custom"), "xhigh");
  // max → xhigh (não degrada pra high)
  assert.equal(normalizeGrokEffort("max", "grok-4.5", "grok-custom"), "xhigh");
});

test("grok oficial intacto: degrada por versão do model como na T-057 (T-162)", () => {
  assert.equal(normalizeGrokEffort("xhigh", "grok-4.5"), "high");
  assert.equal(normalizeGrokEffort("xhigh", "grok-4.6"), "xhigh");
  assert.equal(normalizeGrokEffort("xhigh", "grok-4.5", "grok"), "high");
  assert.equal(grokSupportsXhigh("grok-4.5", "grok"), false);
  assert.equal(grokSupportsXhigh("grok-4.6", "grok"), true);
  // runner desconhecido: sem mudança de comportamento
  assert.equal(normalizeGrokEffort("xhigh", "grok-4.5", "claude"), "high");
});

test("grokThinkingEffort com grok-custom passa xhigh (T-162)", () => {
  assert.equal(grokThinkingEffort("xhigh", false, false, "grok-4.5", "grok-custom"), "xhigh");
  assert.equal(grokThinkingEffort("xhigh", false, false, "grok-4.6", "grok-custom"), "xhigh");
  // lift de thinking continua idêntico: esforço fraco vira high
  assert.equal(grokThinkingEffort("minimal", true, false, "grok-4.6", "grok-custom"), "high");
  assert.equal(grokThinkingEffort(undefined, true, false, "grok-4.6", "grok-custom"), "high");
  // grok oficial: regressão zero
  assert.equal(grokThinkingEffort("xhigh", false, false, "grok-4.5"), "high");
});

test("grokWireEfforts inclui xhigh para grok-custom com qualquer model (T-162)", () => {
  assert.deepEqual(grokWireEfforts("grok-4.5", "grok-custom"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(grokWireEfforts("grok-4.5"), ["low", "medium", "high"]);
});

/* ---------- T-401: o catálogo vivo publica o mesmo conjunto que o wire aceita ---------- */

/** Mesma saída real do `grok-custom models` do fixture T-246 (T-401). */
const CATALOG = [
  "You are logged in with grok.com.",
  "",
  "Default model: rezulto:rezulto/glm5.3-flash",
  "",
  "Available models:",
  "  - grok-4.6",
  "  * rezulto:rezulto/glm5.3-flash (default)",
  "  - omlx:Qwen3.8-27B-MLX-oQ4e-mtp",
  "  - chatgpt-gpt-5.6-sol",
].join("\n");

test("T-401: catálogo do grok-custom publica xhigh em todo model (raiz do clamp da UI)", () => {
  const models = parseLineModelCatalog(CATALOG, "grok-custom");
  assert.equal(models.length, 4);
  for (const model of models) {
    assert.deepEqual(model.efforts, ["low", "medium", "high", "xhigh"], `${model.id} clampado`);
  }
});

test("T-401: o que o catálogo anuncia é o que o wire aceita — sem catálogo mais estreito que o normalizeGrokEffort", () => {
  // O bug T-401 era exatamente essa divergência: o seletor oferecia [low,medium,high]
  // porque o catálogo filtrava por versão, enquanto normalizeGrokEffort já aceitava
  // xhigh em qualquer model no grok-custom. effort anunciado tem de sobreviver ao wire.
  for (const model of parseLineModelCatalog(CATALOG, "grok-custom")) {
    for (const effort of model.efforts ?? []) {
      assert.equal(normalizeGrokEffort(effort, model.id, "grok-custom"), effort,
        `catálogo anuncia ${effort} para ${model.id} mas o wire degrada`);
    }
  }
});

test("T-401: catálogo do grok oficial mantém o filtro por versão (T-059 intacto)", () => {
  const byId = Object.fromEntries(parseLineModelCatalog(CATALOG, "grok").map((m) => [m.id, m.efforts]));
  assert.deepEqual(byId["grok-4.6"], ["low", "medium", "high", "xhigh"]);
  for (const id of ["rezulto:rezulto/glm5.3-flash", "omlx:Qwen3.8-27B-MLX-oQ4e-mtp", "chatgpt-gpt-5.6-sol"]) {
    assert.deepEqual(byId[id], ["low", "medium", "high"]);
    assert.equal(normalizeGrokEffort("xhigh", id, "grok"), "high", "xhigh não suportado → wire degrada p/ high");
  }
});
