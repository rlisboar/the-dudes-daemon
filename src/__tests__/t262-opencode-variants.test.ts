/**
 * T-262: catálogo do opencode deve publicar os variants REAIS do models.dev
 * (fonte: `opencode models --verbose`), não o regex fixo por família, e a
 * seleção deve chegar ao agente no campo canônico `variant` do schema.
 *
 * Fixture = saída BRUTA observada no opencode 1.18.29 do dono (bloco do
 * flashnext/rezulto/qwen3.8-flash + casos de borda sintéticos na mesma forma).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOpenCodeVerboseCatalog } from "../model-discovery.js";
import { buildOpenCodeAgentConfig, openCodeEffortsFor, parseOpenCodeModelVariants } from "../runners/opencode-effort.js";
import { buildOpenCodeMcpConfig } from "../runners/mcp-config.js";

const OWNER_MODEL = "flashnext/rezulto/qwen3.8-flash";

// Real (1.18.29): id solo + JSON pretty-printed; variants low/medium/xhigh.
const VERBOSE_FIXTURE = [
  OWNER_MODEL,
  JSON.stringify({
    id: "rezulto/qwen3.8-flash",
    providerID: "flashnext",
    name: "Qwen3.8-Flash (vLLM · 512k)",
    capabilities: { reasoning: true },
    options: { temperature: 1, reasoningEffort: "xhigh" },
    family: "qwen",
    variants: {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      xhigh: { reasoningEffort: "xhigh" },
    },
  }, null, 2),
  "opencode/big-pickle",
  JSON.stringify({ id: "big-pickle", providerID: "opencode", variants: {} }, null, 2),
  "openai/gpt-6",
  JSON.stringify({ id: "gpt-6", providerID: "openai", variants: { minimal: {}, low: {}, "ultra-super": {}, high: {} } }, null, 2),
  "quebrado/modelo-x",
  '{ "id": "modelo-x", "variants": { "low": {} } ', // bloco truncado → heurístico
].join("\n");

test("T-262: parse verbose — variants reais viram efforts; vazio → ['none']; nomes fora do wire filtrados; JSON quebrado → heurístico", () => {
  const models = parseOpenCodeVerboseCatalog(VERBOSE_FIXTURE);
  const byId = new Map(models.map((m) => [m.id, m]));

  // modelo do dono: exatamente os variants do /variants (com 'none' = default)
  assert.deepEqual(byId.get(OWNER_MODEL)?.efforts, ["none", "low", "medium", "xhigh"]);
  // sem variants → só 'none' (seletor some na UI)
  assert.deepEqual(byId.get("opencode/big-pickle")?.efforts, ["none"]);
  // nomes fora de EffortLevel (ultra-super) filtrados; ordem do JSON preservada
  assert.deepEqual(byId.get("openai/gpt-6")?.efforts, ["none", "minimal", "low", "high"]);
  // bloco truncado: modelo sobrevive com o heurístico por família
  assert.deepEqual(byId.get("quebrado/modelo-x")?.efforts, ["none"]);
});

test("T-262: registry alimenta o config builder — effort≠none gera `variant: <nome>` (schema opencode)", () => {
  parseOpenCodeVerboseCatalog(VERBOSE_FIXTURE); // popula o registry (processo único)

  assert.deepEqual(openCodeEffortsFor(OWNER_MODEL), ["none", "low", "medium", "xhigh"]);
  const cfg = buildOpenCodeAgentConfig(OWNER_MODEL, "xhigh");
  assert.deepEqual(cfg, {
    description: "Managed The Dudes agent", mode: "primary", model: OWNER_MODEL, variant: "xhigh",
  });
  // none → nenhum variant enviado (default do opencode)
  assert.ok(!("variant" in (buildOpenCodeAgentConfig(OWNER_MODEL, "none") ?? {})));
  // effort não listado → default (não inventa variant)
  assert.ok(!("variant" in (buildOpenCodeAgentConfig(OWNER_MODEL, "max") ?? {})));

  // o arquivo final do agente (OPENCODE_CONFIG) carrega o variant
  const built = buildOpenCodeMcpConfig(
    undefined,
    { command: "node", args: ["bridge.cjs"], env: {} },
    true,
    buildOpenCodeAgentConfig(OWNER_MODEL, "medium"),
  );
  const agent = (built.config as { agent: Record<string, Record<string, unknown>> }).agent["the-dudes-managed"];
  assert.equal(agent.variant, "medium");
});

test("T-262: sem registry (modelo não visto no scan) o heurístico legado segue valendo", () => {
  // modelo fora do fixture → openCodeVariantsFor undefined → mapeamento antigo
  assert.deepEqual(buildOpenCodeAgentConfig("openai/gpt-5", "high"), {
    description: "Managed The Dudes agent", mode: "primary", model: "openai/gpt-5", reasoningEffort: "high",
  });
});

test("T-262 r1 (QA): registry ADITIVO — scan não apaga modelos de fora do batch; remoção só por ausência confirmada; truncado preserva", () => {
  parseOpenCodeVerboseCatalog(VERBOSE_FIXTURE); // registra dono + gpt-6 + big-pickle

  // scan 2 cobre OUTRO provedor; o modelo do dono não está no batch → INTACTO
  parseOpenCodeVerboseCatalog(["zen/example", JSON.stringify({ variants: { low: {}, high: {} } }, null, 2)].join("\n"));
  assert.deepEqual(openCodeEffortsFor(OWNER_MODEL), ["none", "low", "medium", "xhigh"], "scan parcial não pode limpar variants de outros modelos");
  assert.deepEqual(openCodeEffortsFor("zen/example"), ["none", "low", "high"]);

  // scan 3: dono CONFIRMADO sem variants (JSON ok, `variants: {}`) → entrada
  // removida; o registro volta ao heurístico da família (qwen → ['none'])
  parseOpenCodeVerboseCatalog([OWNER_MODEL, JSON.stringify({ variants: {} }, null, 2)].join("\n"));
  assert.deepEqual(openCodeEffortsFor(OWNER_MODEL), ["none"]);
  // zen/example fora deste batch → permanece (additivity)
  assert.deepEqual(openCodeEffortsFor("zen/example"), ["none", "low", "high"]);

  // bloco TRUNCADO de zen/example → observação não confirmada → NÃO apaga
  parseOpenCodeVerboseCatalog(["zen/example", '{ "variants": { "max"', "extra/modelo-y", JSON.stringify({ variants: {} }, null, 2)].join("\n"));
  assert.deepEqual(openCodeEffortsFor("zen/example"), ["none", "low", "high"], "truncado não pode apagar o que já foi confirmado");
});

test("T-262 r1 (QA): timeout por run — --verbose não pode herdar/stampar o default", () => {
  // O contrato é estático (sem relógio no unit): runCommand aceita timeoutMs
  // e o ramo opencode passa OPENCODE_VERBOSE_TIMEOUT_MS < default. Fonte lida
  // direto para provar que a tentativa verbose tem teto PRÓPRIO.
  const src = readFileSync(new URL("../model-discovery.ts", import.meta.url), "utf8");
  assert.match(src, /function runCommand\([^)]*timeoutMs/);
  assert.match(src, /OPENCODE_VERBOSE_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(src, /\["models", "--verbose"\], this\.dropTo, OPENCODE_VERBOSE_TIMEOUT_MS/);
});

test("T-262: parseOpenCodeModelVariants — dedup, teto 8, não-objeto → []", () => {
  assert.deepEqual(parseOpenCodeModelVariants({ low: {}, low2: {} }), ["low"]);
  assert.deepEqual(parseOpenCodeModelVariants(null), []);
  assert.deepEqual(parseOpenCodeModelVariants([1, 2]), []);
  assert.equal(parseOpenCodeModelVariants(Object.fromEntries(
    ["minimal", "low", "medium", "high", "xhigh", "max"].map((k) => [k, {}]),
  )).length, 6);
});
