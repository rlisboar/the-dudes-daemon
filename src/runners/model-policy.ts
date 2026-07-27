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
  "grok-4.5": 500_000, "grok-build": 500_000, "grok-composer-2.5-fast": 500_000,
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
  const slash = base.indexOf("/");
  return slash > 0 ? lookupContextLimit(base.slice(slash + 1)) : undefined;
}

export function contextLimitFor(model: string | undefined): number {
  return lookupContextLimit(model) ?? DEFAULT_CONTEXT_LIMIT;
}

export function resolveContextLimit(input: {
  configuredModel?: string;
  resolvedModel?: string;
  catalogLimit?: number;
}): number {
  const configured = (input.configuredModel || "").trim().replace(EFFORT_SUFFIX_RE, "");
  if (configured.endsWith("[1m]")) return 1_000_000;
  if (input.catalogLimit && input.catalogLimit > 0) return input.catalogLimit;
  return lookupContextLimit(input.resolvedModel) ?? contextLimitFor(configured);
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

/** Wire levels do Grok Build (CLI 0.2.x / grok-4.5): só `low|medium|high`.
 *  none/minimal/xhigh/max existem no union multi-runner mas o CLI rejeita
 *  (`unknown effort level 'xhigh'; use one of: high, medium, low`). */
export const GROK_WIRE_EFFORTS = ["low", "medium", "high"] as const;
export type GrokWireEffort = (typeof GROK_WIRE_EFFORTS)[number];

export function normalizeGrokEffort(effort: string | undefined | null): GrokWireEffort | undefined {
  if (!effort) return undefined;
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "none" || effort === "minimal" || effort === "off") return "low";
  if (effort === "xhigh" || effort === "max") return "high";
  return "medium";
}

export function grokThinkingEffort(
  effort: EffortLevel | undefined,
  collectThinking: boolean,
  forCompact: boolean,
): GrokWireEffort | undefined {
  // Com thinking coletado, sobe effort fraco pra high (mesmo padrão do claude).
  const lifted =
    !forCompact && collectThinking && (!effort || ["none", "minimal", "low", "medium"].includes(effort))
      ? "high"
      : effort;
  return normalizeGrokEffort(lifted);
}
