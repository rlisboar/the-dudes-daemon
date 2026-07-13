import type { CliRunner } from "../types.js";
import type { ResolvedCliCommands } from "../cli-config.js";

export interface RunnerAdapter {
  readonly id: CliRunner;
  readonly execution: "persistent" | "per-message";
  readonly resumedSessionAlreadyHasSystemPrompt: boolean;
  acceptsSessionId(sessionId: string): boolean;
  command(commands: ResolvedCliCommands): string;
}

const UUID = /^[0-9a-f-]{36}$/i;

function adapter(
  id: CliRunner,
  execution: RunnerAdapter["execution"],
  acceptsSessionId: (sessionId: string) => boolean,
  resumedSessionAlreadyHasSystemPrompt = execution === "per-message",
): RunnerAdapter {
  return {
    id,
    execution,
    resumedSessionAlreadyHasSystemPrompt,
    acceptsSessionId,
    command: (commands) => commands[id].command,
  };
}

export const RUNNER_ADAPTERS: Readonly<Record<CliRunner, RunnerAdapter>> = {
  claude: adapter("claude", "persistent", (id) => UUID.test(id) && !id.startsWith("ses_"), false),
  opencode: adapter("opencode", "per-message", (id) => id.startsWith("ses_"), false),
  codex: adapter("codex", "per-message", (id) => !id.startsWith("ses_")),
  gemini: adapter("gemini", "per-message", (id) => id.trim().length > 0),
  crush: adapter("crush", "per-message", (id) => UUID.test(id)),
  grok: adapter("grok", "per-message", (id) => UUID.test(id)),
};

export function runnerAdapter(runner: CliRunner): RunnerAdapter {
  return RUNNER_ADAPTERS[runner];
}

export function compatibleSessionId(runner: CliRunner, sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  return runnerAdapter(runner).acceptsSessionId(sessionId) ? sessionId : undefined;
}

export function isPerMessageRunner(runner: CliRunner): boolean {
  return runnerAdapter(runner).execution === "per-message";
}
