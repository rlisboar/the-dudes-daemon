import type { EffortLevel } from "../types.js";

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  opus: 1_000_000, opusplan: 1_000_000, haiku: 200_000,
  sonnet: 1_000_000, "claude-sonnet-5": 1_000_000, fable: 1_000_000, "claude-fable-5": 1_000_000,
  "claude-opus-4-8": 1_000_000, "claude-opus-4-7": 1_000_000, "claude-opus-4-6": 1_000_000,
  "claude-opus-4-5": 200_000, "claude-sonnet-4-6": 1_000_000, "claude-sonnet-4-5": 200_000,
  "claude-haiku-4-5": 200_000, "claude-opus-4-1": 200_000, "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000, "claude-3-7-sonnet": 200_000, "claude-3-5-sonnet": 200_000,
  "claude-3-5-haiku": 200_000,
  "gemini-3-pro": 1_000_000, "gemini-3-pro-preview": 1_000_000,
  "gemini-3-flash": 1_000_000, "gemini-3-flash-preview": 1_000_000,
  "gemini-3.1-flash-lite": 1_000_000, "gemini-3.1-flash-lite-preview": 1_000_000,
  "gemini-2.5-flash": 1_000_000, "gemini-2.5-flash-lite": 1_000_000, "gemini-2.5-pro": 1_000_000,
  // Codex CLI exposes a 272k runtime window for the 5.6 family. This is
  // intentionally different from the larger context advertised by the API.
  // T-245: a janela REAL reportada pelo codex (model_context_window no
  // rollout, event_msg token_count) é 272k − 5% de reserve = 258.400 — o
  // caminho codex do agent-runner promove esse valor a catalogLimit quando
  // o rollout está disponível; este mapa é só o fallback.
  "gpt-5.6": 272_000, "gpt-5.6-sol": 272_000, "gpt-5.6-terra": 272_000, "gpt-5.6-luna": 272_000,
  "gpt-5.5": 272_000, "gpt-5.4": 272_000, "gpt-5.4-mini": 272_000, "gpt-5.4-nano": 400_000,
  "gpt-5.3-codex": 400_000, "gpt-5.2-codex": 400_000, "gpt-5.2": 400_000,
  "gpt-5-codex": 400_000, "gpt-5": 400_000, "o4-mini": 200_000, o3: 200_000, "gpt-4.1": 1_000_000,
  "zai-coding-plan/glm-4.7": 204_800, "zai-coding-plan/glm-4.5-air": 131_072,
  "zai-coding-plan/glm-5-turbo": 200_000, "zai-coding-plan/glm-5.1": 200_000,
  "zai-coding-plan/glm-5.2": 1_000_000, "glm-5.2": 1_000_000,
  "accounts/fireworks/routers/glm-5p2-fast": 1_048_575,
  "accounts/fireworks/models/glm-5p2": 1_048_575,
  "deepseek/deepseek-v4-pro": 200_000, "deepseek/deepseek-v4-flash": 200_000,
  "deepseek/deepseek-chat": 128_000,
  // Grok 4.x family (docs xAI): 500k. IDs explícitos + fallback regex em lookup.
  "grok-4.5": 500_000, "grok-4.6": 500_000,
  "grok-build": 500_000, "grok-composer-2.5-fast": 500_000,
};

export const DEFAULT_CONTEXT_LIMIT = 200_000;
export const EFFORT_SUFFIX_RE = /:(off|minimal|none|low|medium|high|xhigh|max)$/;
const DATED_MODEL_ID_RE = /-\d{8}$/;

export function lookupContextLimit(model: string | undefined): number | undefined {
  const raw = model?.trim();
  if (!raw) return undefined;
  const base = raw.replace(EFFORT_SUFFIX_RE, "");
  if (base.endsWith("[1m]")) return 1_000_000;
  if (Object.hasOwn(MODEL_CONTEXT_LIMITS, base)) return MODEL_CONTEXT_LIMITS[base];
  const undated = base.replace(DATED_MODEL_ID_RE, "");
  if (undated !== base && Object.hasOwn(MODEL_CONTEXT_LIMITS, undated)) return MODEL_CONTEXT_LIMITS[undated];
  // T-057: grok-4.7, grok-4.10… sem entrada explícita ainda herdam 500k.
  if (/^grok-4\.\d+$/i.test(base) || /\/grok-4\.\d+$/i.test(base)) return 500_000;
  const slash = base.indexOf("/");
  return slash > 0 ? lookupContextLimit(base.slice(slash + 1)) : undefined;
}

export function contextLimitFor(model: string | undefined): number {
  return lookupContextLimit(model) ?? DEFAULT_CONTEXT_LIMIT;
}

/**
 * T-147: resolve a janela SEM fallback — undefined quando a única fonte
 * disponível é o default (modelo desconhecido pré-catálogo). É o que o
 * tracker expõe como UNKNOWN (0) no payload de usage.
 */
export function resolveContextLimitKnown(input: {
  configuredModel?: string;
  resolvedModel?: string;
  catalogLimit?: number;
}): number | undefined {
  const configured = (input.configuredModel || "").trim().replace(EFFORT_SUFFIX_RE, "");
  if (configured.endsWith("[1m]")) return 1_000_000;
  if (input.catalogLimit && input.catalogLimit > 0) return input.catalogLimit;
  return lookupContextLimit(input.resolvedModel) ?? lookupContextLimit(configured);
}

export function resolveContextLimit(input: {
  configuredModel?: string;
  resolvedModel?: string;
  catalogLimit?: number;
}): number {
  // T-147: o default 200k é fallback de CÁLCULO interno (auto-compact/pct),
  // nunca valor exibido como janela real do modelo.
  return resolveContextLimitKnown(input) ?? DEFAULT_CONTEXT_LIMIT;
}

export function providerModelParts(model: string | undefined): { providerID: string; modelID: string } {
  const raw = (model ?? "").trim().replace(EFFORT_SUFFIX_RE, "");
  const slash = raw.indexOf("/");
  return { providerID: slash > 0 ? raw.slice(0, slash) : "", modelID: slash > 0 ? raw.slice(slash + 1) : raw };
}

export function codexEffort(level: string): "low" | "medium" | "high" | "xhigh" {
  return level === "low" || level === "medium" || level === "high" || level === "xhigh" ? level : "xhigh";
}

export function claudeThinkingEffort(effort: EffortLevel | undefined, collectThinking: boolean): {
  effort: EffortLevel | undefined;
  lifted: boolean;
} {
  const lifted = collectThinking && (!effort || effort === "low" || effort === "medium");
  return { effort: lifted ? "high" : effort, lifted };
}

/**
 * Wire efforts Grok Build.
 * - grok-4.5 e pré-4.x (build/composer): low|medium|high — xhigh rejeitado pelo CLI.
 * - grok-4.6+ (API/docs 2026-08): low|medium|high|xhigh.
 * max → xhigh (4.6+) ou high (legado).
 */
export const GROK_WIRE_EFFORTS = ["low", "medium", "high"] as const;
export const GROK_WIRE_EFFORTS_XHIGH = ["low", "medium", "high", "xhigh"] as const;
export type GrokWireEffort = "low" | "medium" | "high" | "xhigh";

/** Minor version de `grok-4.N` ou null se não for família 4.x. */
export function grok4Minor(model?: string | null): number | null {
  const m = (model ?? "").trim().toLowerCase().replace(EFFORT_SUFFIX_RE, "");
  const bare = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
  const match = bare.match(/^grok-4\.(\d+)/);
  return match ? parseInt(match[1]!, 10) : null;
}

/**
 * grok-4.6 e posteriores aceitam xhigh no wire (CLI ≥0.2.118 / API).
 * T-162: runner grok-custom do dono aceita --effort xhigh com QUALQUER model
 * (binário custom grok 1.0.0-fcustom — provado empiricamente), então a
 * checagem por versão vale só pro grok oficial.
 */
export function grokSupportsXhigh(model?: string | null, runner?: string): boolean {
  if (runner === "grok-custom") return true;
  const minor = grok4Minor(model);
  return minor != null && minor >= 6;
}

export function grokWireEfforts(model?: string | null, runner?: string): readonly GrokWireEffort[] {
  return grokSupportsXhigh(model, runner) ? GROK_WIRE_EFFORTS_XHIGH : GROK_WIRE_EFFORTS;
}

export function normalizeGrokEffort(
  effort: string | undefined | null,
  model?: string | null,
  runner?: string,
): GrokWireEffort | undefined {
  if (!effort) return undefined;
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "none" || effort === "minimal" || effort === "off") return "low";
  if (effort === "xhigh" || effort === "max") {
    return grokSupportsXhigh(model, runner) ? "xhigh" : "high";
  }
  return "medium";
}

export function grokThinkingEffort(
  effort: EffortLevel | undefined,
  collectThinking: boolean,
  forCompact: boolean,
  model?: string | null,
  runner?: string,
): GrokWireEffort | undefined {
  // Com thinking coletado, sobe effort fraco pra high (mesmo padrão do claude).
  const lifted =
    !forCompact && collectThinking && (!effort || ["none", "minimal", "low", "medium"].includes(effort))
      ? "high"
      : effort;
  return normalizeGrokEffort(lifted, model, runner);
}
