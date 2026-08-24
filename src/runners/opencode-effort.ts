import type { EffortLevel } from "../types.js";

export const OPENCODE_MANAGED_AGENT = "the-dudes-managed";

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

export function openCodeEffortsFor(model: string): EffortLevel[] {
  const id = model.toLowerCase();
  if (/(^|\/)(gpt-|o\d)/.test(id)) return ["none", "low", "medium", "high"];
  if (id.includes("claude")) return ["none", "low", "medium", "high"];
  if (glmOpenCodeUsesVariants(model)) return ["none", "low", "high", "max"];
  if (id.includes("glm-")) return ["none", "high"];
  return ["none"];
}

export function buildOpenCodeAgentConfig(model: string | undefined, effort: EffortLevel | undefined): Record<string, unknown> | undefined {
  if (!model) return undefined;
  const allowed = openCodeEffortsFor(model);
  const selected = effort && allowed.includes(effort) ? effort : allowed[0];
  const base: Record<string, unknown> = { description: "Managed The Dudes agent", mode: "primary", model };
  if (selected === "none") return base;
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
