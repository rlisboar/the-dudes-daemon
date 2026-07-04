import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_CONTEXT_LIMITS,
  DEFAULT_CONTEXT_LIMIT,
  contextLimitFor,
  lookupContextLimit,
  contextTokensOf,
} from "../agent-runner.js";
import type { AgentUsage } from "../types.js";

/* ---------- contextLimitFor ---------- */

test("aliases atuais: sonnet/opus/opusplan = 1M, haiku = 200k", () => {
  assert.equal(contextLimitFor("sonnet"), 1_000_000);
  assert.equal(contextLimitFor("opus"), 1_000_000);
  assert.equal(contextLimitFor("opusplan"), 1_000_000);
  assert.equal(contextLimitFor("haiku"), 200_000);
});

test("IDs completos de gerações antigas ficam em 200k (CLI antigo resolve alias pra elas)", () => {
  assert.equal(contextLimitFor("claude-sonnet-4-5"), 200_000);
  assert.equal(contextLimitFor("claude-opus-4-5"), 200_000);
  assert.equal(contextLimitFor("claude-haiku-4-5"), 200_000);
  assert.equal(contextLimitFor("claude-sonnet-4-6"), 1_000_000);
  assert.equal(contextLimitFor("claude-opus-4-8"), 1_000_000);
});

test("sufixo [1m] é opt-in de 1M mesmo sem chave no mapa", () => {
  assert.equal(contextLimitFor("sonnet[1m]"), 1_000_000);
  assert.equal(contextLimitFor("opus[1m]"), 1_000_000);
  assert.equal(contextLimitFor("claude-fable-5[1m]"), 1_000_000);
  assert.equal(contextLimitFor("claude-sonnet-4-5[1m]"), 1_000_000);
});

test("IDs datados reportados pelo init caem pra chave sem data", () => {
  assert.equal(contextLimitFor("claude-sonnet-4-5-20250929"), 200_000);
  assert.equal(contextLimitFor("claude-opus-4-5-20251101"), 200_000);
  assert.equal(contextLimitFor("claude-haiku-4-5-20251001"), 200_000);
});

test("lookupContextLimit: desconhecido/ausente é undefined (não rebaixa config que resolve)", () => {
  assert.equal(lookupContextLimit("claude-modelo-novo-4-9"), undefined);
  assert.equal(lookupContextLimit("claude-modelo-novo-4-9-20990101"), undefined);
  assert.equal(lookupContextLimit(""), undefined);
  assert.equal(lookupContextLimit(undefined), undefined);
  assert.equal(lookupContextLimit("sonnet[1m]"), 1_000_000);
  assert.equal(lookupContextLimit("claude-sonnet-4-5-20250929"), 200_000);
});

test("[1m] combinado com sufixo :effort resolve pra 1M", () => {
  assert.equal(contextLimitFor("sonnet[1m]:high"), 1_000_000);
});

test("prefixo de provider do opencode cai pro model puro quando não há chave exata", () => {
  assert.equal(contextLimitFor("anthropic/claude-sonnet-5"), 1_000_000);
  assert.equal(contextLimitFor("anthropic/claude-haiku-4-5"), 200_000);
  assert.equal(contextLimitFor("google/gemini-2.5-pro"), 1_000_000);
  // chave exata com prefixo vence o fallback
  assert.equal(contextLimitFor("zai-coding-plan/glm-5.1"), 128_000);
  assert.equal(contextLimitFor("deepseek/deepseek-chat"), 128_000);
});

test("gerações pré-4-5 reportadas por CLIs antigos ficam em 200k", () => {
  assert.equal(contextLimitFor("claude-sonnet-4-20250514"), 200_000);
  assert.equal(contextLimitFor("claude-opus-4-1-20250805"), 200_000);
  assert.equal(contextLimitFor("claude-3-7-sonnet-20250219"), 200_000);
  assert.equal(contextLimitFor("claude-3-5-haiku-20241022"), 200_000);
});

test("sufixo legado :<effort> é removido antes do lookup", () => {
  assert.equal(contextLimitFor("sonnet:high"), 1_000_000);
  assert.equal(contextLimitFor("zai-coding-plan/glm-5.1:xhigh"), 128_000);
  assert.equal(contextLimitFor("deepseek/deepseek-v4-pro:max"), 200_000);
});

test("model ausente, vazio ou desconhecido cai no piso conservador", () => {
  assert.equal(contextLimitFor(undefined), DEFAULT_CONTEXT_LIMIT);
  assert.equal(contextLimitFor(""), DEFAULT_CONTEXT_LIMIT);
  assert.equal(contextLimitFor("   "), DEFAULT_CONTEXT_LIMIT);
  assert.equal(contextLimitFor("modelo-que-nao-existe"), DEFAULT_CONTEXT_LIMIT);
});

test("chaves herdadas de Object.prototype não vazam pelo lookup", () => {
  for (const evil of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    const limit = contextLimitFor(evil);
    assert.equal(typeof limit, "number", `${evil} devolveu não-número`);
    assert.equal(limit, DEFAULT_CONTEXT_LIMIT, `${evil} não caiu no piso`);
  }
});

test("todo valor do mapa é número finito positivo", () => {
  for (const [k, v] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    assert.ok(Number.isFinite(v) && v > 0, `${k} = ${v}`);
  }
});

/* ---------- contextTokensOf ---------- */

const usage = (input: number, cacheCreate = 0, cacheRead = 0): AgentUsage => ({
  input,
  output: 0,
  cacheCreate,
  cacheRead,
});

test("anthropic: input exclui cache — total é a soma das parcelas", () => {
  // sessão longa com prompt caching: input pequeno, cacheRead gigante
  assert.equal(contextTokensOf(usage(500, 2_000, 850_000), "anthropic"), 852_500);
  // primeiro turno: cacheCreate carrega o prompt inteiro
  assert.equal(contextTokensOf(usage(300, 40_000, 0), "anthropic"), 40_300);
});

test("inclusive: input já contém o cache lido", () => {
  assert.equal(contextTokensOf(usage(120_000, 0, 90_000), "inclusive"), 120_000);
});

test("auto: cache subconjunto do input ⇒ inclusivo; cache maior ⇒ soma", () => {
  // OpenAI-style (deepseek/zai): prompt_cache_hit ⊆ prompt_tokens
  assert.equal(contextTokensOf(usage(100_000, 0, 80_000), "auto"), 100_000);
  // Anthropic-style via opencode: cacheRead >> input
  assert.equal(contextTokensOf(usage(500, 0, 850_000), "auto"), 850_500);
  // cacheCreate grande no primeiro turno também força a soma
  assert.equal(contextTokensOf(usage(300, 40_000, 0), "auto"), 40_300);
});

test("delta zerado não move o contador", () => {
  assert.equal(contextTokensOf(usage(0, 0, 0), "anthropic"), 0);
  assert.equal(contextTokensOf(usage(0, 0, 0), "auto"), 0);
});
