import type { EffortLevel } from "../types.js";

export const OPENCODE_MANAGED_AGENT = "the-dudes-managed";

export function openCodeEffortsFor(model: string): EffortLevel[] {
  const id = model.toLowerCase();
  if (/(^|\/)(gpt-|o\d)/.test(id)) return ["none", "low", "medium", "high"];
  if (id.includes("claude")) return ["none", "low", "medium", "high"];
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
  if (id.includes("glm-")) return { ...base, thinking: { type: "enabled" } };
  return base;
}
