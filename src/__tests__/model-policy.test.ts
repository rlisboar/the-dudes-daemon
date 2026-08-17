import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeThinkingEffort, codexEffort, contextLimitFor, grokSupportsXhigh,
  grokThinkingEffort, normalizeGrokEffort, providerModelParts, resolveContextLimit,
} from "../runners/model-policy.js";

test("provider/model parsing trims whitespace and removes only a terminal effort suffix", () => {
  assert.deepEqual(providerModelParts("  fireworks-ai/accounts/fireworks/models/glm-5p2:high  "), {
    providerID: "fireworks-ai", modelID: "accounts/fireworks/models/glm-5p2",
  });
  assert.deepEqual(providerModelParts("gemini-3-pro"), { providerID: "", modelID: "gemini-3-pro" });
});

test("context resolution honors explicit 1m, then catalog, known resolved model and fallback", () => {
  assert.equal(resolveContextLimit({ configuredModel: "sonnet[1m]", catalogLimit: 200_000 }), 1_000_000);
  assert.equal(resolveContextLimit({ configuredModel: "unknown", catalogLimit: 777_000 }), 777_000);
  assert.equal(resolveContextLimit({ configuredModel: "sonnet", resolvedModel: "claude-sonnet-4-5" }), 200_000);
  assert.equal(resolveContextLimit({ configuredModel: "sonnet", resolvedModel: "future-unknown" }), 1_000_000);
});

test("runner effort policies preserve provider-specific accepted levels", () => {
  assert.deepEqual(claudeThinkingEffort("low", true), { effort: "high", lifted: true });
  assert.deepEqual(claudeThinkingEffort("none", true), { effort: "none", lifted: false });
  assert.deepEqual(claudeThinkingEffort("medium", false), { effort: "medium", lifted: false });
  // Claude Code wire: high/xhigh/max passam intactos (não rebaixar pra high).
  assert.deepEqual(claudeThinkingEffort("high", false), { effort: "high", lifted: false });
  assert.deepEqual(claudeThinkingEffort("xhigh", false), { effort: "xhigh", lifted: false });
  assert.deepEqual(claudeThinkingEffort("max", false), { effort: "max", lifted: false });
  assert.deepEqual(claudeThinkingEffort("xhigh", true), { effort: "xhigh", lifted: false });
  assert.deepEqual(claudeThinkingEffort("max", true), { effort: "max", lifted: false });
  assert.deepEqual(claudeThinkingEffort(undefined, false), { effort: undefined, lifted: false });
  assert.deepEqual(claudeThinkingEffort(undefined, true), { effort: "high", lifted: true });
  assert.equal(codexEffort("max"), "xhigh");
  assert.equal(codexEffort("minimal"), "xhigh");
  assert.equal(codexEffort("high"), "high");
  // Grok wire legado (sem modelo / 4.5): low|medium|high. xhigh/max → high.
  assert.equal(grokThinkingEffort("minimal", true, false), "high");
  assert.equal(grokThinkingEffort("minimal", true, true), "low");
  assert.equal(grokThinkingEffort("xhigh", false, false), "high");
  assert.equal(grokThinkingEffort("max", false, false), "high");
  assert.equal(grokThinkingEffort("medium", false, false), "medium");
  assert.equal(grokThinkingEffort(undefined, false, false), undefined);
  // T-057: grok-4.6+ aceita xhigh no wire; 4.5 rebaixa.
  assert.equal(normalizeGrokEffort("xhigh", "grok-4.5"), "high");
  assert.equal(normalizeGrokEffort("xhigh", "grok-4.6"), "xhigh");
  assert.equal(normalizeGrokEffort("max", "grok-4.7"), "xhigh");
  assert.equal(grokThinkingEffort("xhigh", false, false, "grok-4.6"), "xhigh");
  assert.equal(grokThinkingEffort("xhigh", false, false, "grok-4.5"), "high");
  assert.equal(grokSupportsXhigh("grok-4.6"), true);
  assert.equal(grokSupportsXhigh("grok-4.5"), false);
  assert.equal(grokSupportsXhigh("grok-composer-2.5-fast"), false);
});

test("T-057: grok-4.N context 500k (explícito e futuro sem entrada)", () => {
  assert.equal(contextLimitFor("grok-4.5"), 500_000);
  assert.equal(contextLimitFor("grok-4.6"), 500_000);
  assert.equal(contextLimitFor("grok-4.7"), 500_000);
  assert.equal(contextLimitFor("xai/grok-4.6"), 500_000);
});

test("T-057: regressão grok-4.5 — context e effort idênticos ao pré-4.6", () => {
  // Agente ainda em 4.5: context 500k; xhigh degrada pra high (CLI legado).
  assert.equal(contextLimitFor("grok-4.5"), 500_000);
  assert.equal(normalizeGrokEffort("xhigh", "grok-4.5"), "high");
  assert.equal(normalizeGrokEffort("high", "grok-4.5"), "high");
  assert.equal(normalizeGrokEffort("medium", "grok-4.5"), "medium");
  assert.equal(normalizeGrokEffort("low", "grok-4.5"), "low");
  assert.equal(grokThinkingEffort("xhigh", false, false, "grok-4.5"), "high");
});
