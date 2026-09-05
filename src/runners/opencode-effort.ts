import type { EffortLevel } from "../types.js";

export const OPENCODE_MANAGED_AGENT = "the-dudes-managed";

/** Nomes aceitos no wire (protocol EffortLevel). Variants do models.dev fora
 *  deste conjunto são ignorados — melhor esconder um esforço exótico do que
 *  quebrar o schema em todo spawn. (T-262) */
const OPENCODE_EFFORT_NAMES = new Set<string>(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Registry dos variants REAIS por modelo, preenchido pelo discovery a partir
 * de `opencode models --verbose` (T-262). Os variants do models.dev definem o
 * que o `/variants` do opencode expõe; a UI deve mostrar exatamente isso.
 * Processo único (daemon) — discovery roda no hello e nos scans; um miss aqui
 * só degrada ao heurístico estático antigo (comportamento pré-T-262).
 */
const realVariantsByModel = new Map<string, EffortLevel[]>();

/**
 * T-262 (retrabalho r1 — QA): ADITIVO, nunca clear() global. Cada batch de
 * scan atualiza apenas os modelos que ele realmente observou:
 *  - variants confirmados → set (sobrescreve o antigo);
 *  - ausência CONFIRMADA (JSON parseado com `variants: {}`) → delete;
 *  - modelos fora do batch (scan parcial, provedor filtrado, scan de outro
 *    runner) → INTACTOS. O clear() global perdia variants aprendidos sempre
 *    que um scan não cobria todos os modelos.
 * Teto brando: o catálogo do opencode (~438 modelos) fica muito abaixo; o
 * eviction LRU só protege de churn anômalo.
 */
export function registerOpenCodeVariants(models: Array<{ id: string; variants: EffortLevel[] }>): void {
  for (const model of models) {
    const key = model.id.toLowerCase();
    if (model.variants.length > 0) realVariantsByModel.set(key, model.variants);
    else realVariantsByModel.delete(key);
  }
  while (realVariantsByModel.size > 4_000) {
    const oldest = realVariantsByModel.keys().next();
    if (oldest.done) break;
    realVariantsByModel.delete(oldest.value);
  }
}

export function openCodeVariantsFor(model: string): EffortLevel[] | undefined {
  return realVariantsByModel.get(model.toLowerCase());
}

/** Extraindo os nomes de variant do objeto `variants` do models.dev
 *  (`{ "xhigh": { reasoningEffort: "xhigh" }, ... }`). Ordem do JSON é
 *  preservada; "none" é o default implícito (nenhum variant enviado). */
export function parseOpenCodeModelVariants(raw: unknown): EffortLevel[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: EffortLevel[] = [];
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!OPENCODE_EFFORT_NAMES.has(key)) continue;
    const name = key as EffortLevel;
    if (!out.includes(name)) out.push(name);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * GLM-5.3+ no opencode local (1.18.22): catálogo zai-coding-plan/glm-5.3 tem
 * reasoning_options effort [low, high, max]; o TUI mostra Default + esses.
 * Campo REAL no AgentConfig: `variant` (schema opencode.ai/config.json).
 * glm-5.2 e anteriores continuam no toggle thinking:{type:enabled}.
 */
export function glmOpenCodeUsesVariants(model: string): boolean {
  const m = model.toLowerCase().match(/(?:^|\/)glm-(\d+)(?:\.(\d+))?/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = m[2] != null ? Number(m[2]) : 0;
  return major > 5 || (major === 5 && minor >= 3);
}

/** Heurístico estático por família (pré-T-262) — último recurso quando não
 *  há variants reais confirmados. Exportado p/ o parser distinguir
 *  "confirmado sem variants" (aqui) de "truncado/desconhecido"
 *  (openCodeEffortsFor, que aproveita o último conhecimento do registry). */
export function openCodeHeuristicEffortsFor(model: string): EffortLevel[] {
  const id = model.toLowerCase();
  if (/(^|\/)(gpt-|o\d)/.test(id)) return ["none", "low", "medium", "high"];
  if (id.includes("claude")) return ["none", "low", "medium", "high"];
  if (glmOpenCodeUsesVariants(model)) return ["none", "low", "high", "max"];
  if (id.includes("glm-")) return ["none", "high"];
  return ["none"];
}

export function openCodeEffortsFor(model: string): EffortLevel[] {
  // T-262: variants REAIS do models.dev (`opencode models --verbose`) vencem
  // o heurístico — é exatamente o que o /variants do opencode aceita. Sem
  // registry (modelo digitado à mão / discovery ainda não rodou), cai no
  // mapeamento estático por família (comportamento histórico, não-regressão).
  const real = openCodeVariantsFor(model);
  if (real && real.length > 0) return ["none", ...real];
  return openCodeHeuristicEffortsFor(model);
}

export function buildOpenCodeAgentConfig(model: string | undefined, effort: EffortLevel | undefined): Record<string, unknown> | undefined {
  if (!model) return undefined;
  const allowed = openCodeEffortsFor(model);
  const selected = effort && allowed.includes(effort) ? effort : allowed[0];
  const base: Record<string, unknown> = { description: "Managed The Dudes agent", mode: "primary", model };
  if (selected === "none") return base;
  // T-262: modelo com variants reais → campo canônico do schema opencode,
  // `variant: <nome>` (o opencode aplica os overrides do models.dev e o TUI
  // mostra o mesmo em /variants). Vale p/ qualquer provider — ex.: o
  // rezulto/qwen3.8-flash do dono expõe low/medium/xhigh via reasoningEffort,
  // mas o AGENTE só precisa nomear o variant.
  if (openCodeVariantsFor(model)?.includes(selected)) return { ...base, variant: selected };
  const id = model.toLowerCase();
  if (/(^|\/)(gpt-|o\d)/.test(id)) return { ...base, reasoningEffort: selected };
  if (id.includes("claude")) {
    const budgetTokens = { low: 4_096, medium: 16_384, high: 32_768 }[selected as "low" | "medium" | "high"];
    return { ...base, thinking: { type: "enabled", budgetTokens } };
  }
  if (glmOpenCodeUsesVariants(model)) return { ...base, variant: selected };
  if (id.includes("glm-")) return { ...base, thinking: { type: "enabled" } };
  return base;
}
