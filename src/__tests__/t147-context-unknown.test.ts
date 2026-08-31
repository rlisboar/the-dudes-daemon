import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ContextTracker } from "../runners/context-tracker.js";
import { DEFAULT_CONTEXT_LIMIT, resolveContextLimit, resolveContextLimitKnown } from "../runners/model-policy.js";
import { resolveOcCatalogContextLimit } from "../model-discovery.js";

/**
 * T-147 — contexto pré-uso: janela UNKNOWN em vez de fabricar 200k.
 *
 * Contrato congelado: contextLimit é UNKNOWN (0 explícito no payload de
 * usage) até existir fonte real — catálogo opencode resolvido, limitHint do
 * grok ou entrada do mapa estático. DEFAULT_CONTEXT_LIMIT (200k) é fallback
 * de CÁLCULO interno (auto-compact/pct), nunca valor exibido como real.
 *
 * Fixtures usam os IDs reais da config do dono (mesma da T-137):
 * provider `rezulto` → `glm5.3-flash`, limit.context = 491_520.
 */

const AQUI = dirname(fileURLToPath(import.meta.url));
const DISPLAY_DONO = "GLM-5.3-Flash (SGLang · 2× B300)";
const PROVIDERS_DONO = {
  providers: [
    {
      id: "rezulto",
      models: {
        "glm5.3-flash": {
          id: "rezulto/glm5.3-flash",
          name: DISPLAY_DONO,
          limit: { context: 491_520, input: 368_640, output: 65_536 },
        },
      },
    },
  ],
};

/** Wire idêntico ao do agent-runner.ts (constructor do ContextTracker). */
function trackerDoDono(usage: Array<[number, number | null]>): ContextTracker {
  return new ContextTracker({
    resolveLimit: (resolvedModel, catalogLimit) =>
      resolveContextLimit({ configuredModel: DISPLAY_DONO, resolvedModel, catalogLimit }),
    resolveLimitKnown: (resolvedModel, catalogLimit) =>
      resolveContextLimitKnown({ configuredModel: DISPLAY_DONO, resolvedModel, catalogLimit }),
    onUsage: (used, limit) => usage.push([used, limit]),
  });
}

/* ---------- A1: pré-uso, janela UNKNOWN (não 200k) ---------- */

test("T-147 A1: reset pré-uso expõe UNKNOWN (0), não o default 200k fabricado", () => {
  const usage: Array<[number, number | null]> = [];
  const tracker = trackerDoDono(usage);
  tracker.reset();
  assert.deepEqual(usage.at(-1), [0, 0], "payload pré-uso: limit 0 = UNKNOWN");
  assert.notEqual(usage.at(-1)![1], DEFAULT_CONTEXT_LIMIT, "200k não pode ser exposto como real");
});

test("T-147 A1: occupancy pré-catálogo também expõe UNKNOWN (0)", () => {
  const usage: Array<[number, number | null]> = [];
  const tracker = trackerDoDono(usage);
  tracker.reportOccupancy(5_000);
  assert.deepEqual(usage.at(-1), [5_000, 0], "uso pré-resolução: limit 0 = UNKNOWN");
});

test("T-147 A2 (contrato): DEFAULT 200k segue como fallback de CÁLCULO interno", () => {
  // tracker.limit() alimenta pct/auto-compact — o 200k continua lá dentro,
  // mas NUNCA vira o valor exposto no payload (testes acima).
  const usage: Array<[number, number | null]> = [];
  const tracker = trackerDoDono(usage);
  assert.equal(tracker.limit(), DEFAULT_CONTEXT_LIMIT);
  assert.equal(DEFAULT_CONTEXT_LIMIT, 200_000);
});

/* ---------- A2: pós-resolução, valor REAL propagado ---------- */

test("T-147 A2: catálogo do opencode com o ID real do dono → 491_520 propagado", () => {
  const catalogo = resolveOcCatalogContextLimit({
    configuredModel: DISPLAY_DONO,
    config: { model: "rezulto/glm5.3-flash" },
    providers: PROVIDERS_DONO,
  });
  assert.deepEqual(catalogo, { limit: 491_520, via: "display-name" });

  const usage: Array<[number, number | null]> = [];
  const tracker = trackerDoDono(usage);
  tracker.setCatalogLimit(catalogo!.limit);
  tracker.reset();
  assert.deepEqual(usage.at(-1), [0, 491_520], "pós-catálogo: janela real no payload");
  tracker.reportOccupancy(5_000);
  assert.deepEqual(usage.at(-1), [5_000, 491_520]);
});

/* ---------- A3: sem regressão — hint do grok, mapa, claude/codex ---------- */

test("T-147 A3: limitHint do grok vence o mapeado quando MAIOR", () => {
  const usage: Array<[number, number | null]> = [];
  const tracker = new ContextTracker({
    resolveLimit: (resolvedModel, catalogLimit) =>
      resolveContextLimit({ configuredModel: "grok-4.5", resolvedModel, catalogLimit }),
    resolveLimitKnown: (resolvedModel, catalogLimit) =>
      resolveContextLimitKnown({ configuredModel: "grok-4.5", resolvedModel, catalogLimit }),
    onUsage: (used, limit) => usage.push([used, limit]),
  });
  tracker.reportOccupancy(100, 600_000);
  assert.deepEqual(usage.at(-1), [100, 600_000], "hint real maior vence");
  tracker.reportOccupancy(200, 100_000);
  assert.deepEqual(usage.at(-1), [200, 500_000], "hint menor: mapa vence (500k)");
});

test("T-147 A3: modelo com entrada no mapa é REAL desde o início (reset)", () => {
  const usage: Array<[number, number | null]> = [];
  const tracker = new ContextTracker({
    resolveLimit: (resolvedModel, catalogLimit) =>
      resolveContextLimit({ configuredModel: "sonnet", resolvedModel, catalogLimit }),
    resolveLimitKnown: (resolvedModel, catalogLimit) =>
      resolveContextLimitKnown({ configuredModel: "sonnet", resolvedModel, catalogLimit }),
    onUsage: (used, limit) => usage.push([used, limit]),
  });
  tracker.reset();
  assert.deepEqual(usage.at(-1), [0, 1_000_000], "mapa estático vale desde o primeiro payload");
});

test("T-147 A3: claude/codex/mapa inalterados", () => {
  assert.equal(resolveContextLimit({ configuredModel: "sonnet" }), 1_000_000);
  assert.equal(resolveContextLimit({ configuredModel: "haiku" }), 200_000);
  assert.equal(resolveContextLimit({ configuredModel: "gpt-5.6" }), 272_000);
  assert.equal(resolveContextLimit({ configuredModel: "grok-4.5" }), 500_000);
});

/* ---------- compat: tracker sem resolveLimitKnown expõe como antes ---------- */

test("T-147: tracker sem resolveLimitKnown (uso legado/testes) emite o mapeado", () => {
  const usage: Array<[number, number | null]> = [];
  const tracker = new ContextTracker({
    resolveLimit: () => 100,
    onUsage: (used, limit) => usage.push([used, limit]),
  });
  tracker.reportOccupancy(85);
  assert.deepEqual(usage.at(-1), [85, 100]);
});

/* ---------- wiring ---------- */

test("T-147: agent-runner cable resolveLimitKnown; agent-host repassa limit sem fabricar", () => {
  const runner = readFileSync(join(AQUI, "../agent-runner.ts"), "utf8");
  assert.match(runner, /resolveLimitKnown: \(resolvedModel, catalogLimit\) => resolveContextLimitKnown/);
  assert.match(runner, /resolveContextLimitKnown\(\{[^}]*configuredModel: this\.info\.model/s);
  const host = readFileSync(join(AQUI, "../agent-host.ts"), "utf8");
  assert.match(host, /type: "agent:context", agentId: msg\.agent\.id, used, limit/, "payload repassa limit do tracker sem alteração");
});
