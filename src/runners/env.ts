import type { CliRunner } from "../types.js";
import type { DropTarget } from "../privileges.js";

export interface BaseRunnerEnvInput {
  inherited: NodeJS.ProcessEnv;
  runner: CliRunner;
  agentId: string;
  agentName: string;
  orchestratorUrl: string;
  bridgeSocketPath?: string;
  claudeConfigDir?: string;
  opencodeConfigPath?: string;
}

export function buildBaseRunnerEnv(input: BaseRunnerEnvInput): NodeJS.ProcessEnv {
  const env = { ...input.inherited };
  for (const secret of ["THE_DUDES_DAEMON_TOKEN", "THE_DUDES_TOKEN", "THE_DUDES_ENCRYPTION_KEY"]) delete env[secret];
  delete env.CLAUDE_CONFIG_DIR;
  delete env.OPENCODE_CONFIG;
  env.THE_DUDES_AGENT_ID = input.agentId;
  env.THE_DUDES_AGENT_NAME = input.agentName;
  env.THE_DUDES_ORCH_URL = input.orchestratorUrl;
  if (input.bridgeSocketPath) env.THE_DUDES_BRIDGE_SOCKET = input.bridgeSocketPath;
  else delete env.THE_DUDES_BRIDGE_SOCKET;
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
