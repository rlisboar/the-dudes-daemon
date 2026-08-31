import test from "node:test";
import assert from "node:assert/strict";
import { grokSupportsXhigh, grokThinkingEffort, grokWireEfforts, normalizeGrokEffort } from "../runners/model-policy.js";

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
