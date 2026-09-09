import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { discoverQwenSettings, parseCodexModelList, parseLineModelCatalog } from "../model-discovery.js";

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

/* ---------- T-401: catálogo vivo do grok-custom publica xhigh em todo model ---------- */

const XHIGH4 = ["low", "medium", "high", "xhigh"];

test("T-401: grok-custom publica [low,medium,high,xhigh] em TODOS os models do fixture T-246", () => {
  const models = parseLineModelCatalog(GROK_CUSTOM_MODELS_OUTPUT, "grok-custom");
  assert.equal(models.length, 10);
  for (const model of models) {
    assert.deepEqual(model.efforts, XHIGH4, `efforts de ${model.id} deve ser ${XHIGH4.join(",")}`);
  }
  // IDs citados nos critérios: nem grok, nem OpenAI, nem MLX, nem Z.ai herdam o filtro de versão.
  const byId = Object.fromEntries(models.map((m) => [m.id, m.efforts]));
  for (const id of [
    "rezulto:rezulto/glm5.3-flash",
    "grok-4.6",
    "chatgpt-gpt-5.6-sol",
    "omlx:Qwen3.8-27B-MLX-oQ4e-mtp",
  ]) {
    assert.deepEqual(byId[id], XHIGH4, `${id} sem xhigh no catálogo → a UI clampa`);
  }
});

test("T-401: só efforts muda — id/label/isDefault/tiers do fixture T-246 intactos", () => {
  const models = parseLineModelCatalog(GROK_CUSTOM_MODELS_OUTPUT, "grok-custom").map((model) => {
    const withoutEfforts: Record<string, unknown> = { ...model };
    delete withoutEfforts.efforts;
    return withoutEfforts;
  });
  assert.deepEqual(models, [
    { id: "grok-4.6", label: "grok-4.6", isDefault: undefined, capabilityTier: 4, speedTier: 1, costTier: 3 },
    { id: "rezulto:rezulto/glm5.3-flash", label: "rezulto:rezulto/glm5.3-flash", isDefault: true, capabilityTier: 2, speedTier: 2, costTier: 2 },
    { id: "omlx:Qwen3.8-27B-MLX-oQ4e-mtp", label: "omlx:Qwen3.8-27B-MLX-oQ4e-mtp", isDefault: undefined, capabilityTier: 2, speedTier: 2, costTier: 2 },
    { id: "rezulto-qwen:rezulto/qwen3.8-lite", label: "rezulto-qwen:rezulto/qwen3.8-lite", isDefault: undefined, capabilityTier: 2, speedTier: 2, costTier: 2 },
    { id: "chatgpt-gpt-5.6-sol", label: "chatgpt-gpt-5.6-sol", isDefault: undefined, capabilityTier: 4, speedTier: 1, costTier: 3 },
    { id: "chatgpt-gpt-5.6-terra", label: "chatgpt-gpt-5.6-terra", isDefault: undefined, capabilityTier: 3, speedTier: 2, costTier: 2 },
    { id: "chatgpt-gpt-5.6-luna", label: "chatgpt-gpt-5.6-luna", isDefault: undefined, capabilityTier: 1, speedTier: 3, costTier: 1 },
    { id: "chatgpt-gpt-5.5", label: "chatgpt-gpt-5.5", isDefault: undefined, capabilityTier: 2, speedTier: 2, costTier: 2 },
    { id: "chatgpt-gpt-5.4", label: "chatgpt-gpt-5.4", isDefault: undefined, capabilityTier: 2, speedTier: 2, costTier: 2 },
    { id: "chatgpt-gpt-5.4-mini", label: "chatgpt-gpt-5.4-mini", isDefault: undefined, capabilityTier: 1, speedTier: 3, costTier: 1 },
  ]);
});

test("T-401: mesmo fixture, runner diverso — grok oficial segue filtrado por versão do model (T-059)", () => {
  const output = "* grok-4.5\n* grok-4.6\n* rezulto:rezulto/glm5.3-flash\n";
  const official = Object.fromEntries(parseLineModelCatalog(output, "grok").map((m) => [m.id, m.efforts]));
  assert.deepEqual(official["grok-4.5"], ["low", "medium", "high"], "grok-4.5 oficial não ganha xhigh");
  assert.deepEqual(official["grok-4.6"], XHIGH4, "grok-4.6 oficial mantém xhigh");
  assert.deepEqual(official["rezulto:rezulto/glm5.3-flash"], ["low", "medium", "high"]);
  const custom = Object.fromEntries(parseLineModelCatalog(output, "grok-custom").map((m) => [m.id, m.efforts]));
  assert.deepEqual(custom["grok-4.5"], XHIGH4, "grok-custom aceita xhigh até no 4.5 (T-162)");
  assert.deepEqual(custom["grok-4.6"], XHIGH4);
  assert.deepEqual(custom["rezulto:rezulto/glm5.3-flash"], XHIGH4);
});

/* ── T-343: qwen — catálogo a partir do settings.json do dono ─────────── */

function writeTmpQwenSettings(name: string, obj: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), `qwen-cfg-${name}-`));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj));
  return file;
}

test("T-343 discoverQwenSettings: modelProviders do dono viram catálogo com default", () => {
  const file = writeTmpQwenSettings("ok", {
    model: { name: "rezulto/qwen3.8-flash", baseUrl: "https://x/v1" },
    modelProviders: {
      openai: [
        { id: "rezulto/qwen3.8-flash", name: "rezulto/qwen3.8-flash", baseUrl: "https://x/v1", generationConfig: { modalities: { image: true, video: true, audio: false } } },
        { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus", generationConfig: { modalities: ["text", "image"] } },
      ],
    },
  });
  const cat = discoverQwenSettings("/nonexistent-home", 1, file);
  assert.equal(cat.source, "cli-command");
  assert.deepEqual(cat.models.map((m) => m.id), ["rezulto/qwen3.8-flash", "qwen3-coder-plus"]);
  assert.equal(cat.models[0]!.isDefault, true);
  assert.equal(cat.models[1]!.isDefault, undefined);
  assert.equal(cat.models[0]!.label, "rezulto/qwen3.8-flash");
  assert.deepEqual(cat.models[0]!.inputModalities, ["image", "video"]);
  assert.deepEqual(cat.models[1]!.inputModalities, ["text", "image"]); // array também é aceite
  assert.deepEqual(cat.models[0]!.efforts, ["none", "low", "medium", "high", "xhigh", "max"]);
});

test("T-343 discoverQwenSettings: model.name sem provider entra como default (provider nativo)", () => {
  const file = writeTmpQwenSettings("nativ", { model: { name: "qwen3-max" } });
  const cat = discoverQwenSettings("/nonexistent-home", 1, file);
  assert.equal(cat.source, "cli-command");
  assert.deepEqual(cat.models.map((m) => [m.id, m.isDefault]), [["qwen3-max", true]]);
});

test("T-343 discoverQwenSettings: sem ficheiro / JSON podre / vazio → unsupported com erro legível", () => {
  const missing = discoverQwenSettings("/nonexistent-home", 1, "/nonexistent-home/.qwen/settings.json");
  assert.equal(missing.source, "unsupported");
  assert.ok(missing.error && missing.error.includes("settings.json"));
  const podre = discoverQwenSettings("/nonexistent-home", 1, writeTmpQwenSettings("podre", "{ isto não é json"));
  assert.equal(podre.source, "unsupported");
  assert.ok(podre.error);
  const vazio = discoverQwenSettings("/nonexistent-home", 1, writeTmpQwenSettings("vazio", { ui: {} }));
  assert.equal(vazio.source, "unsupported");
});
