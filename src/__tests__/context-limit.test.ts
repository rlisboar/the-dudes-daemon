import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_CONTEXT_LIMITS,
  DEFAULT_CONTEXT_LIMIT,
  CONTEXT_FULL_PATTERNS,
  RATE_LIMIT_TEXT_RE,
  contextLimitFor,
  lookupContextLimit,
  contextTokensOf,
  parseGrokContextSignals,
  grokSignalsPath,
  normalizeGrokCwd,
} from "../agent-runner.js";
import type { AgentUsage } from "../types.js";
import path from "node:path";

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
  assert.equal(contextLimitFor("zai-coding-plan/glm-5.1"), 200_000);
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
  assert.equal(contextLimitFor("zai-coding-plan/glm-5.1:xhigh"), 200_000);
  assert.equal(contextLimitFor("deepseek/deepseek-v4-pro:max"), 200_000);
});

test("modelos ativos fora do mapa antigo: glm-5.2 = 1M, gemini-3 GA = 1M", () => {
  // glm-5.2 lançou com 128k e depois ganhou 1M (models.dev/catálogo do
  // opencode) — o mapa acompanha; a fonte primária em runtime é o serve.
  assert.equal(contextLimitFor("zai-coding-plan/glm-5.2"), 1_000_000);
  assert.equal(contextLimitFor("zai-coding-plan/glm-5.2:high"), 1_000_000);
  assert.equal(contextLimitFor("glm-5.2"), 1_000_000);
  assert.equal(contextLimitFor("outro-provider/glm-5.2"), 1_000_000);
  // rodada 5 #9: variantes GA da geração 3 caíam no piso (200k numa janela 1M).
  assert.equal(contextLimitFor("gemini-3-pro"), 1_000_000);
  assert.equal(contextLimitFor("gemini-3-pro-preview"), 1_000_000);
  assert.equal(contextLimitFor("gemini-3-flash"), 1_000_000);
});

test("GLM via fireworks (modelID com barras internas) resolve pós-provider", () => {
  // "fireworks-ai/accounts/fireworks/routers/glm-5p2-fast": o fallback corta
  // no PRIMEIRO "/" e o resto é a chave exata do catálogo fireworks.
  assert.equal(contextLimitFor("fireworks-ai/accounts/fireworks/routers/glm-5p2-fast"), 1_048_575);
  assert.equal(contextLimitFor("fireworks-ai/accounts/fireworks/models/glm-5p2"), 1_048_575);
  assert.equal(contextLimitFor("fireworks-ai/accounts/fireworks/routers/glm-5p2-fast:high"), 1_048_575);
});

test("[1m] com prefixo de provider resolve pra 1M direto", () => {
  assert.equal(contextLimitFor("anthropic/claude-sonnet-5[1m]"), 1_000_000);
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

/* ---------- CONTEXT_FULL_PATTERNS ---------- */

const matchesFull = (msg: string) => CONTEXT_FULL_PATTERNS.some((p) => p.test(msg));

test("banners reais de contexto cheio casam (inclusive ordem exceed→context)", () => {
  // Anthropic — a variante MAIS comum (input + max_tokens > janela):
  assert.ok(matchesFull("input length and `max_tokens` exceed context limit: 190510 + 21333 > 204698, decrease input length or max_tokens"));
  // codex:
  assert.ok(matchesFull("Your input exceeds the context window of this model. Please adjust your input and try again."));
  // Anthropic prompt sozinho acima do limite:
  assert.ok(matchesFull("prompt is too long: 210000 tokens > 200000 maximum"));
  // OpenAI-style (deepseek/zai via opencode serve):
  assert.ok(matchesFull("This model's maximum context length is 131072 tokens. However, you requested 140000 tokens. Please reduce the length of the messages."));
});

test("prosa comum não casa os padrões de contexto cheio", () => {
  assert.ok(!matchesFull("vou revisar a função de contexto do runner"));
  assert.ok(!matchesFull("o limite de contexto desse modelo é grande"));
  assert.ok(!matchesFull("deploy concluído com sucesso"));
});

test("precedência rate-limit: 429 TPM da Anthropic é rate limit, não contexto cheio", () => {
  // rodada 6: esse banner casa /maximum.{0,20}token/ — sem o pré-filtro de
  // RATE_LIMIT_TEXT_RE no checkContextFullError, rajada de 429 compactava
  // sessão saudável e 3 rajadas suspendiam a auto-compaction.
  const tpm429 = "This request would exceed your organization's rate limit of 80000 input tokens per minute. Please reduce the prompt length or the maximum tokens requested, or try again later.";
  assert.ok(RATE_LIMIT_TEXT_RE.test(tpm429), "429 TPM tem que casar como rate limit");
  assert.ok(matchesFull(tpm429), "sanidade: sem o pré-filtro ele casaria como contexto cheio");
  // Banners REAIS de contexto cheio não podem ser engolidos pelo pré-filtro:
  for (const banner of [
    "input length and `max_tokens` exceed context limit: 190510 + 21333 > 204698",
    "Your input exceeds the context window of this model.",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "This model's maximum context length is 131072 tokens. Please reduce the length of the messages.",
  ]) {
    assert.ok(!RATE_LIMIT_TEXT_RE.test(banner), `banner de contexto não pode casar rate limit: ${banner.slice(0, 50)}`);
  }
});

/* ---------- Grok signals.json (ocupação real da janela) ---------- */

test("parseGrokContextSignals: extrai used/limit/pct do signals.json", () => {
  const s = parseGrokContextSignals({
    contextTokensUsed: 351681,
    contextWindowTokens: 500000,
    contextWindowUsage: 70,
  });
  assert.deepEqual(s, {
    contextTokensUsed: 351681,
    contextWindowTokens: 500000,
    contextWindowUsage: 70,
  });
});

test("parseGrokContextSignals: rejeita inválido / incompleto", () => {
  assert.equal(parseGrokContextSignals(null), null);
  assert.equal(parseGrokContextSignals({}), null);
  assert.equal(parseGrokContextSignals({ contextTokensUsed: 100 }), null); // sem limit
  assert.equal(parseGrokContextSignals({ contextTokensUsed: -1, contextWindowTokens: 500000 }), null);
  // used=0 com limit válido é sessão vazia — aceita
  assert.deepEqual(
    parseGrokContextSignals({ contextTokensUsed: 0, contextWindowTokens: 500000 }),
    { contextTokensUsed: 0, contextWindowTokens: 500000, contextWindowUsage: 0 },
  );
});

test("grokSignalsPath: cwd encodeURIComponent + sessionId", () => {
  const cwd = "/Users/lisboa/Documents/eonf/projects/claudinhos";
  const p = grokSignalsPath("/home/u/.grok", cwd, "019f4807-25d0-7f11-b7b0-0dc73f5dcfef");
  assert.equal(
    p,
    path.join(
      "/home/u/.grok",
      "sessions",
      encodeURIComponent(cwd),
      "019f4807-25d0-7f11-b7b0-0dc73f5dcfef",
      "signals.json",
    ),
  );
  assert.ok(p.includes("%2FUsers%2F"));
});

test("grokSignalsPath: remove trailing slash (cwdOverride da UI)", () => {
  const a = grokSignalsPath("/home/u/.grok", "/Users/lisboa/Documents/eonf/claudinho/", "sid");
  const b = grokSignalsPath("/home/u/.grok", "/Users/lisboa/Documents/eonf/claudinho", "sid");
  assert.equal(a, b);
  assert.ok(!a.includes("claudinho%2F/"), a);
  assert.ok(a.includes(encodeURIComponent(normalizeGrokCwd("/Users/lisboa/Documents/eonf/claudinho"))));
});

test("normalizeGrokCwd: sem barra final", () => {
  assert.equal(normalizeGrokCwd("/Users/foo/bar/"), normalizeGrokCwd("/Users/foo/bar"));
  assert.ok(!normalizeGrokCwd("/Users/foo/bar/").endsWith("/"));
});
