import type { DiscoveredRunnerModel } from "./protocol.js";

/**
 * Inferência heurística de tiers quando o catálogo do CLI não manda metadata.
 * T-057: família `grok-4.N` (4.5, 4.6, 4.7…) trata como power-tier — não só 4.5.
 */
export function inferModelCapability(id: string): Pick<DiscoveredRunnerModel, "capabilityTier" | "speedTier" | "costTier"> {
  const value = id.toLowerCase();
  // grok-4.\d+ cobre 4.5/4.6/4.7…; deepseek-v4-pro / opus / sol / glm-5.2 = topo
  if (/(opus|\bpro\b|sol|glm-5\.2|grok-4\.\d+|deepseek-v4-pro)/.test(value)) {
    return { capabilityTier: 4, speedTier: 1, costTier: 3 };
  }
  if (/(sonnet|terra|glm-4\.7|flash-preview)/.test(value)) {
    return { capabilityTier: 3, speedTier: 2, costTier: 2 };
  }
  if (/(haiku|luna|flash-lite|air|fast|nano|mini)/.test(value)) {
    return { capabilityTier: 1, speedTier: 3, costTier: 1 };
  }
  return { capabilityTier: 2, speedTier: 2, costTier: 2 };
}

export function withModelCapability(model: DiscoveredRunnerModel): DiscoveredRunnerModel {
  return { ...model, ...inferModelCapability(model.id) };
}
