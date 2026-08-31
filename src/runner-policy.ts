import type { ResolvedCliCommands } from "./cli-config.js";

/**
 * Runners sujeitos à runner policy do Dashboard (runner-policy:set).
 * T-157: grok-custom entra na lista — antes ficava sempre disponível
 * quando o binário existia, ignorando a policy.
 */
export const POLICY_GATED_RUNNERS = ["claude", "codex", "opencode", "gemini", "crush", "grok", "grok-custom"] as const;

export type PolicyRunner = (typeof POLICY_GATED_RUNNERS)[number];

export type InstalledRunnerAvailability = Record<PolicyRunner, boolean>;

/** Snapshot de disponibilidade instalada (binário presente) no boot. */
export function buildInstalledRunnerAvailability(cliCommands: ResolvedCliCommands): InstalledRunnerAvailability {
  return Object.fromEntries(
    POLICY_GATED_RUNNERS.map((runner) => [runner, cliCommands[runner].available]),
  ) as InstalledRunnerAvailability;
}

/**
 * Aplica a policy do server sobre os runners gateados: disponível = instalado && permitido.
 * Mutação in-place sobre cliCommands — mesmo padrão do handler anterior.
 */
export function applyRunnerPolicy(
  cliCommands: ResolvedCliCommands,
  installedRunnerAvailability: InstalledRunnerAvailability,
  allowedRunners: Iterable<string>,
): void {
  const allowed = new Set(allowedRunners);
  for (const runner of POLICY_GATED_RUNNERS) {
    cliCommands[runner].available = installedRunnerAvailability[runner] === true && allowed.has(runner);
  }
}
