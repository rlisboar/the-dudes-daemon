import type { CliRunner } from "../types.js";
import type { DropTarget } from "../privileges.js";

/** Vars do processo pai que o CLI do agente pode herdar. Nada além disto. */
export const AGENT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TERM", "USER", "LOGNAME"] as const;

/** Nunca passam ao agente, mesmo se listadas no passthrough. */
export const AGENT_ENV_NEVER = new Set([
  "THE_DUDES_DAEMON_TOKEN",
  "THE_DUDES_TOKEN",
  "THE_DUDES_ENCRYPTION_KEY",
  "THE_DUDES_AGENT_TOKEN",
]);

/** Lista opt-in no env do daemon: `THE_DUDES_AGENT_ENV_PASSTHROUGH=TZ,TMPDIR`. */
export const AGENT_ENV_PASSTHROUGH_VAR = "THE_DUDES_AGENT_ENV_PASSTHROUGH";

export interface BaseRunnerEnvInput {
  inherited: NodeJS.ProcessEnv;
  runner: CliRunner;
  agentId: string;
  agentName: string;
  orchestratorUrl: string;
  bridgeSocketPath?: string;
  claudeConfigDir?: string;
  opencodeConfigPath?: string;
  /** Extra keys a copiar de inherited (além da allowlist e do env var). */
  passthrough?: string[];
}

function parsePassthrough(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,:\s]+/).map((s) => s.trim()).filter(Boolean);
}

function pickInherited(inherited: NodeJS.ProcessEnv, extra: Iterable<string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keys = new Set<string>([...AGENT_ENV_ALLOWLIST, ...extra]);
  for (const key of keys) {
    if (AGENT_ENV_NEVER.has(key)) continue;
    const val = inherited[key];
    if (val !== undefined) env[key] = val;
  }
  return env;
}

export function buildBaseRunnerEnv(input: BaseRunnerEnvInput): NodeJS.ProcessEnv {
  const extra = [
    ...parsePassthrough(input.inherited[AGENT_ENV_PASSTHROUGH_VAR]),
    ...(input.passthrough ?? []),
  ];
  const env = pickInherited(input.inherited, extra);
  env.THE_DUDES_AGENT_ID = input.agentId;
  env.THE_DUDES_AGENT_NAME = input.agentName;
  env.THE_DUDES_ORCH_URL = input.orchestratorUrl;
  if (input.bridgeSocketPath) env.THE_DUDES_BRIDGE_SOCKET = input.bridgeSocketPath;
  if (input.runner === "claude" && input.claudeConfigDir) env.CLAUDE_CONFIG_DIR = input.claudeConfigDir;
  if (input.runner === "opencode" && input.opencodeConfigPath) env.OPENCODE_CONFIG = input.opencodeConfigPath;
  return env;
}

export function buildGeminiEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, GEMINI_CLI_TRUST_WORKSPACE: "true" };
}

export function buildBridgeAwareEnv(base: NodeJS.ProcessEnv, tokenFile: string, features: Record<string, string>): NodeJS.ProcessEnv {
  return { ...base, THE_DUDES_AGENT_TOKEN_FILE: tokenFile, ...features };
}

export function buildGrokEnv(input: {
  base: NodeJS.ProcessEnv;
  tokenFile: string;
  features: Record<string, string>;
  grokHome: string;
  dropTo?: DropTarget | null;
}): NodeJS.ProcessEnv {
  const env = buildBridgeAwareEnv(input.base, input.tokenFile, input.features);
  if (input.dropTo) {
    env.HOME = input.dropTo.home;
    env.USER = input.dropTo.user;
    env.LOGNAME = input.dropTo.user;
    if (input.dropTo.path) env.PATH = input.dropTo.path;
  }
  env.GROK_HOME = input.grokHome;
  env.GROK_DISABLE_AUTOUPDATER = "1";
  return env;
}
