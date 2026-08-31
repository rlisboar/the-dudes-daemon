import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOcCatalogContextLimit } from "../model-discovery.js";
import { resolveContextLimit, DEFAULT_CONTEXT_LIMIT, contextLimitFor } from "../runners/model-policy.js";
import { ContextTracker } from "../runners/context-tracker.js";

/**
 * T-137 — janela de contexto imprecisa no runner opencode (500k → 200k).
 *
 * Causa-raiz (dono, 2026-08-31): info.model do agente é o DISPLAY NAME sem
 * prefixo `provider/` ("GLM-5.3-Flash (SGLang · 2× B300)"). Em
 * agent-runner.ts fetchOcCatalogLimit abortava em `if (!providerID || !modelID)`
 * → catalogLimit nunca era setado → resolveContextLimit caía no mapa estático
 * (sem entrada) → DEFAULT_CONTEXT_LIMIT (200k), enquanto o turno real rodava
 * o default do serve (`rezulto/glm5.3-flash`, limit.context = 491_520).
 *
 * Fix: resolveOcCatalogContextLimit resolve a janela pelos catálogos do
 * próprio CLI — (a) provider/modelo explícito, (b) match por display name,
 * (c) default do serve (/config.model). Fixtures abaixo usam os IDs reais
 * da config do dono (~/.config/opencode/opencode.jsonc).
 */

const AQUI = dirname(fileURLToPath(import.meta.url));

/** Config REAL do dono (~/.config/opencode/opencode.jsonc → /config/providers). */
const PROVIDERS_DONO = {
  providers: [
    {
      id: "rezulto",
      models: {
        "glm5.3-flash": {
          id: "rezulto/glm5.3-flash",
          name: "GLM-5.3-Flash (SGLang · 2× B300)",
          limit: { context: 491_520, input: 368_640, output: 65_536 },
        },
      },
    },
  ],
};
/** GET /config do serve — default efetivo. */
const CONFIG_DONO = { model: "rezulto/glm5.3-flash" };

const DISPLAY_DONO = "GLM-5.3-Flash (SGLang · 2× B300)";

/* ---------- A2: modelo do dono resolve a janela real (491_520, ~500k) ---------- */

test("T-137 A2: display name do dono (sem prefixo) resolve via name-match → 491_520", () => {
  const r = resolveOcCatalogContextLimit({
    configuredModel: DISPLAY_DONO,
    config: CONFIG_DONO,
    providers: PROVIDERS_DONO,
  });
  assert.deepEqual(r, { limit: 491_520, via: "display-name" });
});

test("T-137 A2: display name com sufixo :effort também resolve", () => {
  const r = resolveOcCatalogContextLimit({
    configuredModel: `${DISPLAY_DONO}:max`,
    config: CONFIG_DONO,
    providers: PROVIDERS_DONO,
  });
  assert.deepEqual(r, { limit: 491_520, via: "display-name" });
});

test("T-137 A2: sem name-match, o default do serve resolve (via serve-default)", () => {
  const r = resolveOcCatalogContextLimit({
    configuredModel: "GLM-5.3-Flash",
    config: CONFIG_DONO,
    providers: PROVIDERS_DONO,
  });
  assert.deepEqual(r, { limit: 491_520, via: "serve-default" });
});

test("T-137 A2: id com prefixo provider/ segue resolvendo direto (caminho antigo)", () => {
  const r = resolveOcCatalogContextLimit({
    configuredModel: "rezulto/glm5.3-flash",
    providers: PROVIDERS_DONO,
  });
  assert.deepEqual(r, { limit: 491_520, via: "provider-model" });
});

test("T-137 A2: cadeia completa — resolveContextLimit com catalogLimit vence o mapa/default", () => {
  // É o valor que ContextTracker.limit() retorna com o fix (não mais 200k).
  assert.equal(
    resolveContextLimit({ configuredModel: DISPLAY_DONO, catalogLimit: 491_520 }),
    491_520,
  );
});

test("T-137 A2: config ausente + sem name-match → undefined (fallback do mapa)", () => {
  const r = resolveOcCatalogContextLimit({
    configuredModel: "GLM-5.3-Flash",
    providers: PROVIDERS_DONO,
  });
  assert.equal(r, undefined);
});

/* ---------- A4: cadeia resolveContextLimit (todos os caminhos) ---------- */

test("T-137 A4: entrada no mapa (com prefixo) resolve pelo mapa", () => {
  assert.equal(resolveContextLimit({ configuredModel: "zai-coding-plan/glm-5.2" }), 1_000_000);
  assert.equal(resolveContextLimit({ configuredModel: "deepseek/deepseek-chat" }), 128_000);
});

test("T-137 A4: sufixo [1m] é 1M e vence tudo (opt-in explícito)", () => {
  assert.equal(resolveContextLimit({ configuredModel: "sonnet[1m]", catalogLimit: 491_520 }), 1_000_000);
});

test("T-137 A4: catálogo maior que o mapa vence", () => {
  assert.equal(
    resolveContextLimit({ configuredModel: "grok-4.5", resolvedModel: "grok-4.5", catalogLimit: 600_000 }),
    600_000,
  );
});

test("T-137 A4: catálogo ausente → mapa estático", () => {
  assert.equal(resolveContextLimit({ configuredModel: "grok-4.5", resolvedModel: "grok-4.5" }), 500_000);
});

test("T-137 A4: modelo desconhecido → DEFAULT 200k documentado", () => {
  assert.equal(resolveContextLimit({ configuredModel: "modelo-desconhecido-xyz" }), DEFAULT_CONTEXT_LIMIT);
  assert.equal(DEFAULT_CONTEXT_LIMIT, 200_000);
});

/* ---------- A3: sem regressão — limitHint do grok e mapa inalterados ---------- */

test("T-137 A3: limitHint (grok) vence o mapeado quando MAIOR", () => {
  let visto: { used: number; limit: number } | null = null;
  const t = new ContextTracker({
    resolveLimit: (resolvedModel, catalogLimit) =>
      resolveContextLimit({ configuredModel: "grok-4.5", resolvedModel, catalogLimit }),
    onUsage: (used, limit) => (visto = { used, limit }),
  });
  // limitHint 600k > mapa 500k → hint vence
  t.reportOccupancy(100, 600_000);
  assert.equal(visto!.limit, 600_000);
  // limitHint 100k < mapa 500k → mapa vence (nunca rebaixa)
  t.reportOccupancy(100, 100_000);
  assert.equal(visto!.limit, 500_000);
});

test("T-137 A3: runner opencode SEM catálogo mantém o piso do mapa/default", () => {
  const t = new ContextTracker({
    resolveLimit: (resolvedModel, catalogLimit) =>
      resolveContextLimit({ configuredModel: DISPLAY_DONO, resolvedModel, catalogLimit }),
  });
  assert.equal(t.limit(), DEFAULT_CONTEXT_LIMIT);
});

test("T-137 A3: entradas do mapa claude/codex/grok inalteradas", () => {
  assert.equal(contextLimitFor("sonnet"), 1_000_000);
  assert.equal(contextLimitFor("haiku"), 200_000);
  assert.equal(contextLimitFor("gpt-5.6"), 272_000);
  assert.equal(contextLimitFor("grok-4.5"), 500_000);
});

/* ---------- robustez do resolvedor (armadilhas conhecidas) ---------- */

test("T-137: prefixo provider/ respeita o provider EXATO (não casa modelID igual alhures)", () => {
  const providers = {
    providers: [
      { id: "deepseek", models: { "glm-5.2": { limit: { context: 128_000 } } } },
      { id: "zai-coding-plan", models: { "glm-5.2": { limit: { context: 1_000_000 } } } },
    ],
  };
  assert.equal(
    resolveOcCatalogContextLimit({ configuredModel: "zai-coding-plan/glm-5.2", providers })?.limit,
    1_000_000,
  );
  assert.equal(
    resolveOcCatalogContextLimit({ configuredModel: "deepseek/glm-5.2", providers })?.limit,
    128_000,
  );
});

test("T-137: bare ID sem prefixo NÃO casa provider arbitrário — cai no default do serve", () => {
  // Caso exato do comentário antigo (glm-5.2 fireworks 1M vs deepseek 128k):
  // sem prefixo, o turno roda o DEFAULT — a janela tem que ser a do default.
  const providers = {
    providers: [
      { id: "fireworks-ai", models: { "glm-5.2": { limit: { context: 1_000_000 } } } },
      { id: "deepseek", models: { "deepseek-v4-flash": { limit: { context: 128_000 } } } },
    ],
  };
  const r = resolveOcCatalogContextLimit({
    configuredModel: "glm-5.2",
    config: { model: "deepseek/deepseek-v4-flash" },
    providers,
  });
  assert.deepEqual(r, { limit: 128_000, via: "serve-default" });
});

test("T-137: providers malformados / limit inválido → undefined (fallback seguro)", () => {
  assert.equal(resolveOcCatalogContextLimit({ configuredModel: "x/y", providers: {} }), undefined);
  assert.equal(resolveOcCatalogContextLimit({ configuredModel: "x/y" }), undefined);
  const semLimite = { providers: [{ id: "p", models: { m: { limit: { context: 0 } } } }] };
  assert.equal(resolveOcCatalogContextLimit({ configuredModel: "p/m", providers: semLimite }), undefined);
  const semCtx = { providers: [{ id: "p", models: { m: {} } }] };
  assert.equal(resolveOcCatalogContextLimit({ configuredModel: "p/m", providers: semCtx }), undefined);
});

/* ---------- wiring: fetchOcCatalogLimit usa o resolvedor novo ---------- */

test("T-137: fetchOcCatalogLimit cable no resolvedor de catálogo (guarda de wiring)", () => {
  const src = readFileSync(join(AQUI, "../agent-runner.ts"), "utf8");
  assert.ok(src.includes("resolveOcCatalogContextLimit"), "fetchOcCatalogLimit deve usar o resolvedor");
  assert.ok(src.includes('"/config"'), "deve consultar o /config (default do serve)");
  assert.ok(!src.includes("if (!providerID || !modelID) return;"), "early-return antigo removido");
});
