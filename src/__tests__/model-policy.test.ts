import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeThinkingEffort, codexEffort, grokThinkingEffort,
  providerModelParts, resolveContextLimit,
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
  assert.equal(codexEffort("max"), "xhigh");
  assert.equal(codexEffort("minimal"), "xhigh");
  assert.equal(codexEffort("high"), "high");
  // Grok wire: only low|medium|high. xhigh/max → high; none/minimal → low (or high when lifted).
  assert.equal(grokThinkingEffort("minimal", true, false), "high");
  assert.equal(grokThinkingEffort("minimal", true, true), "low");
  assert.equal(grokThinkingEffort("xhigh", false, false), "high");
  assert.equal(grokThinkingEffort("max", false, false), "high");
  assert.equal(grokThinkingEffort("medium", false, false), "medium");
  assert.equal(grokThinkingEffort(undefined, false, false), undefined);
});
