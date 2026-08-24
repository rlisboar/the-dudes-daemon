import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenCodeAgentConfig, glmOpenCodeUsesVariants, openCodeEffortsFor } from "../runners/opencode-effort.js";

const base = { description: "Managed The Dudes agent", mode: "primary" };

test("OpenCode maps effort to provider-native agent options", () => {
  assert.deepEqual(openCodeEffortsFor("zai-coding-plan/glm-5.2"), ["none", "high"]);
  assert.deepEqual(buildOpenCodeAgentConfig("zai-coding-plan/glm-5.2", "high"), {
    ...base, model: "zai-coding-plan/glm-5.2", thinking: { type: "enabled" },
  });
  assert.deepEqual(buildOpenCodeAgentConfig("openai/gpt-5", "high"), {
    ...base, model: "openai/gpt-5", reasoningEffort: "high",
  });
  assert.deepEqual(buildOpenCodeAgentConfig("anthropic/claude-sonnet-4-6", "medium"), {
    ...base, model: "anthropic/claude-sonnet-4-6", thinking: { type: "enabled", budgetTokens: 16_384 },
  });
});

test("T-106 GLM-5.3+ usa agent.variant (Default=omitir); glm antigo inalterado", () => {
  assert.equal(glmOpenCodeUsesVariants("zai-coding-plan/glm-5.3"), true);
  assert.equal(glmOpenCodeUsesVariants("zai-coding-plan/glm-5.2"), false);
  assert.equal(glmOpenCodeUsesVariants("zai-coding-plan/glm-5.2-highspeed"), false);
  assert.equal(glmOpenCodeUsesVariants("zai-coding-plan/glm-5-turbo"), false);
  assert.equal(glmOpenCodeUsesVariants("zai-coding-plan/glm-4.7"), false);
  assert.deepEqual(openCodeEffortsFor("zai-coding-plan/glm-5.3"), ["none", "low", "high", "max"]);
  assert.deepEqual(buildOpenCodeAgentConfig("zai-coding-plan/glm-5.3", "max"), {
    ...base, model: "zai-coding-plan/glm-5.3", variant: "max",
  });
  assert.deepEqual(buildOpenCodeAgentConfig("zai-coding-plan/glm-5.3", "low"), {
    ...base, model: "zai-coding-plan/glm-5.3", variant: "low",
  });
  assert.deepEqual(buildOpenCodeAgentConfig("zai-coding-plan/glm-5.3", "none"), {
    ...base, model: "zai-coding-plan/glm-5.3",
  });
  assert.equal("thinking" in (buildOpenCodeAgentConfig("zai-coding-plan/glm-5.3", "max") ?? {}), false);
  assert.deepEqual(buildOpenCodeAgentConfig("zai-coding-plan/glm-5.2", "high")?.thinking, { type: "enabled" });
  assert.equal("variant" in (buildOpenCodeAgentConfig("zai-coding-plan/glm-5.2", "high") ?? {}), false);
  assert.deepEqual(buildOpenCodeAgentConfig("openai/gpt-5", "high"), {
    ...base, model: "openai/gpt-5", reasoningEffort: "high",
  });
  assert.deepEqual(buildOpenCodeAgentConfig("anthropic/claude-sonnet-4-6", "medium"), {
    ...base, model: "anthropic/claude-sonnet-4-6", thinking: { type: "enabled", budgetTokens: 16_384 },
  });
});
