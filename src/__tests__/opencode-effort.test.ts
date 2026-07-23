import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenCodeAgentConfig, openCodeEffortsFor } from "../runners/opencode-effort.js";

test("OpenCode maps effort to provider-native agent options", () => {
  assert.deepEqual(openCodeEffortsFor("zai-coding-plan/glm-5.2"), ["none", "high"]);
  assert.deepEqual(buildOpenCodeAgentConfig("zai-coding-plan/glm-5.2", "high"), {
    description: "Managed The Dudes agent", mode: "primary", model: "zai-coding-plan/glm-5.2", thinking: { type: "enabled" },
  });
  assert.deepEqual(buildOpenCodeAgentConfig("openai/gpt-5", "high"), {
    description: "Managed The Dudes agent", mode: "primary", model: "openai/gpt-5", reasoningEffort: "high",
  });
  assert.deepEqual(buildOpenCodeAgentConfig("anthropic/claude-sonnet-4-6", "medium"), {
    description: "Managed The Dudes agent", mode: "primary", model: "anthropic/claude-sonnet-4-6", thinking: { type: "enabled", budgetTokens: 16_384 },
  });
});
