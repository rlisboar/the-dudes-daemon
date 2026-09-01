import type { ResolvedCliCommands } from "./cli-config.js";
import { RUNNERS } from "@the-dudes/protocol";

/**
 * Runners sujeitos à runner policy do Dashboard (runner-policy:set).
 * T-187: lista derivada do RUNNER_CATALOG (@the-dudes/protocol) — a cópia
 * hardcoded aqui já esqueceu o grok-custom antes (T-157).
 */
export const POLICY_GATED_RUNNERS = RUNNERS;

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

/**
 * Listas de runners reportadas no daemon:hello (T-159: cobrem grok-custom —
 * mesmo universo da runner policy, sem lista hardcoded paralela).
 */
export function helloRunnerLists(cliCommands: ResolvedCliCommands): { availableRunners: PolicyRunner[]; installedRunners: PolicyRunner[] } {
  return {
    availableRunners: POLICY_GATED_RUNNERS.filter((runner) => cliCommands[runner].available),
    installedRunners: POLICY_GATED_RUNNERS.filter((runner) => cliCommands[runner].available),
  };
}
