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
    parseLineModelCatalog("zai-coding-plan/glm-5.2\nzai-coding-plan/glm-5.3\nopenai/gpt-5\ndeepseek/deepseek-v4-pro\n", "opencode"),
    [
      { id: "zai-coding-plan/glm-5.2", label: "zai-coding-plan/glm-5.2", isDefault: undefined, efforts: ["none", "high"], capabilityTier: 4, speedTier: 1, costTier: 3 },
      { id: "zai-coding-plan/glm-5.3", label: "zai-coding-plan/glm-5.3", isDefault: undefined, efforts: ["none", "low", "high", "max"], capabilityTier: 2, speedTier: 2, costTier: 2 },
      { id: "openai/gpt-5", label: "openai/gpt-5", isDefault: undefined, efforts: ["none", "low", "medium", "high"], capabilityTier: 2, speedTier: 2, costTier: 2 },
      { id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro", isDefault: undefined, efforts: ["none"], capabilityTier: 4, speedTier: 1, costTier: 3 },
    ],
  );
});

test("Grok catalog recognizes its advertised default", () => {
  assert.deepEqual(
    parseLineModelCatalog("Default model: grok-build\n* grok-build (default)\n* grok-fast\n", "grok"),
    [
      { id: "grok-build", label: "grok-build", isDefault: true, efforts: ["low", "medium", "high"], capabilityTier: 2, speedTier: 2, costTier: 2 },
      { id: "grok-fast", label: "grok-fast", isDefault: undefined, efforts: ["low", "medium", "high"], capabilityTier: 1, speedTier: 3, costTier: 1 },
    ],
  );
});

test("Grok 4.6+ expõe xhigh no catálogo (raiz do T-059)", () => {
  const models = parseLineModelCatalog("* grok-4.5\n* grok-4.6\n", "grok");
  const byId = Object.fromEntries(models.map((m) => [m.id, m.efforts]));
  assert.deepEqual(byId["grok-4.5"], ["low", "medium", "high"]);
  assert.deepEqual(byId["grok-4.6"], ["low", "medium", "high", "xhigh"]);
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

/* ---------- T-246: grok-custom lista não-defaults com bullet "-" ---------- */

/** Fixture REAL do output de `grok-custom models` (binário do dono,
 *  ~/.local/bin/grok-custom — prova empírica do PM, 2026-09-04). */
const GROK_CUSTOM_MODELS_OUTPUT = `You are logged in with grok.com.

Default model: rezulto:rezulto/glm5.3-flash

Available models:
  - grok-4.6
  * rezulto:rezulto/glm5.3-flash (default)
  - omlx:Qwen3.8-27B-MLX-oQ4e-mtp
  - rezulto-qwen:rezulto/qwen3.8-lite
  - chatgpt-gpt-5.6-sol
  - chatgpt-gpt-5.6-terra
  - chatgpt-gpt-5.6-luna
  - chatgpt-gpt-5.5
  - chatgpt-gpt-5.4
  - chatgpt-gpt-5.4-mini
`;

test("T-246: fixture REAL do grok-custom — 10 modelos, default apenas no marcado com *", () => {
  const models = parseLineModelCatalog(GROK_CUSTOM_MODELS_OUTPUT, "grok-custom");
  assert.deepEqual(
    models.map((m) => m.id),
    [
      "grok-4.6",
      "rezulto:rezulto/glm5.3-flash",
      "omlx:Qwen3.8-27B-MLX-oQ4e-mtp",
      "rezulto-qwen:rezulto/qwen3.8-lite",
      "chatgpt-gpt-5.6-sol",
      "chatgpt-gpt-5.6-terra",
      "chatgpt-gpt-5.6-luna",
      "chatgpt-gpt-5.5",
      "chatgpt-gpt-5.4",
      "chatgpt-gpt-5.4-mini",
    ],
    "todos os 10 modelos (bullet - E *), não só o default",
  );
  assert.equal(models.filter((m) => m.isDefault).map((m) => m.id).join(","), "rezulto:rezulto/glm5.3-flash");
});

test("T-246: ruído do output (login, header, 'Available models:', vazias) não vira modelo", () => {
  const ids = parseLineModelCatalog(GROK_CUSTOM_MODELS_OUTPUT, "grok-custom").map((m) => m.id);
  assert.ok(!ids.some((id) => /available|logged|default model/i.test(id)), "nenhuma linha de ruído no catálogo");
  assert.equal(ids.length, 10);
});

test("T-246: retrocompat — formato antigo (todos com *) segue parseando igual", () => {
  const models = parseLineModelCatalog("Default model: grok-build\n* grok-build (default)\n* grok-fast\n", "grok-custom");
  assert.deepEqual(models.map((m) => [m.id, m.isDefault]), [["grok-build", true], ["grok-fast", undefined]]);
});
