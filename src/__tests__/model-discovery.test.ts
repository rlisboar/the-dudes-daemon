import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexModelList, parseLineModelCatalog } from "../model-discovery.js";

test("line catalogs parse plain model IDs and remove duplicates/noise", () => {
  assert.deepEqual(
    parseLineModelCatalog("provider/model-a\nprovider/model-a\ninvalid model\ngpt-5.6\n", "crush"),
    [
      { id: "provider/model-a", label: "provider/model-a", isDefault: undefined, capabilityTier: 2, speedTier: 2, costTier: 2 },
      { id: "gpt-5.6", label: "gpt-5.6", isDefault: undefined, capabilityTier: 2, speedTier: 2, costTier: 2 },
    ],
  );
});

test("OpenCode catalog publishes effort capabilities for each installed model", () => {
  assert.deepEqual(
    parseLineModelCatalog("zai-coding-plan/glm-5.2\nopenai/gpt-5\ndeepseek/deepseek-v4-pro\n", "opencode"),
    [
      { id: "zai-coding-plan/glm-5.2", label: "zai-coding-plan/glm-5.2", isDefault: undefined, efforts: ["none", "high"], capabilityTier: 4, speedTier: 1, costTier: 3 },
      { id: "openai/gpt-5", label: "openai/gpt-5", isDefault: undefined, efforts: ["none", "low", "medium", "high"], capabilityTier: 2, speedTier: 2, costTier: 2 },
      { id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro", isDefault: undefined, efforts: ["none"], capabilityTier: 4, speedTier: 1, costTier: 3 },
    ],
  );
});

test("Grok catalog recognizes its advertised default", () => {
  assert.deepEqual(
    parseLineModelCatalog("Default model: grok-build\n* grok-build (default)\n* grok-fast\n", "grok"),
    [
      { id: "grok-build", label: "grok-build", isDefault: true, capabilityTier: 2, speedTier: 2, costTier: 2 },
      { id: "grok-fast", label: "grok-fast", isDefault: undefined, capabilityTier: 1, speedTier: 3, costTier: 1 },
    ],
  );
});

test("Codex app-server catalog preserves capabilities and ignores hidden models", () => {
  const models = parseCodexModelList({
    result: {
      data: [
        {
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          description: "Power model",
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "xhigh" },
          ],
          inputModalities: ["text", "image"],
        },
        { model: "hidden-model", hidden: true },
        { model: "invalid model" },
        { model: "gpt-5.6-sol" },
      ],
    },
  });
  assert.deepEqual(models, [{
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    description: "Power model",
    isDefault: true,
    efforts: ["low", "xhigh"],
    inputModalities: ["text", "image"],
    capabilityTier: 4,
    speedTier: 1,
    costTier: 3,
  }]);
});

test("Codex parser tolerates malformed responses", () => {
  assert.deepEqual(parseCodexModelList(null), []);
  assert.deepEqual(parseCodexModelList({ result: { data: "nope" } }), []);
});
