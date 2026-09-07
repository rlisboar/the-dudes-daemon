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
  /** Qwen Code: config dir POR AGENTE (QWEN_HOME; auth do dono fica no
   *  ~/.qwen real — só o settings.json de MCP é isolado). */
  qwenHome?: string;
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
  if (input.runner === "qwen" && input.qwenHome) env.QWEN_HOME = input.qwenHome;
  return env;
}

/**
 * T-253: env do summarizer/shim (runCliText no summarizer-runner).
 * Mesmo contrato de buildBaseRunnerEnv — allowlist + passthrough opt-in
 * (THE_DUDES_AGENT_ENV_PASSTHROUGH). O histórico era `{ ...process.env }`
 * com 3 deletes: qualquer token/cloud key do daemon (API keys, tokens de
 * git/nuvem, DATABASE_URL…) ficava visível em /proc/<pid>/environ do CLI do
 * summarizer — prompt injection no agente que dispara o summarize podia
 * exfiltrar. Auth dos CLIs mora em HOME/config dir (cobertos pela allowlist),
 * então nada funcional se perde; keys via env usam o passthrough explícito.
 */
export function buildSummarizerEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return pickInherited(inherited, parsePassthrough(inherited[AGENT_ENV_PASSTHROUGH_VAR]));
}

export function buildGeminiEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, GEMINI_CLI_TRUST_WORKSPACE: "true" };
}

/** Qwen Code: silencia o aviso "yolo sem sandbox" (stderr) — o daemon roda o
 *  CLI headless deliberadamente. Auth/model vêm do ~/.qwen do user (QWEN_HOME
 *  por agente entra via buildBaseRunnerEnv quando há config dir isolado). */
export function buildQwenEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, QWEN_CODE_SUPPRESS_YOLO_WARNING: "1" };
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
  /** T-164: grok-custom gerencia o próprio home isolado (wrapper do dono) —
   *  setar GROK_HOME aqui sobrescreve o fallback "${GROK_HOME:-$HOME/.grok-custom}"
   *  do wrapper e o CLI sobe sem credenciais ("xAI rejected its API key"). */
  runner?: string;
}): NodeJS.ProcessEnv {
  const env = buildBridgeAwareEnv(input.base, input.tokenFile, input.features);
  if (input.dropTo) {
    env.HOME = input.dropTo.home;
    env.USER = input.dropTo.user;
    env.LOGNAME = input.dropTo.user;
    if (input.dropTo.path) env.PATH = input.dropTo.path;
  }
  if (input.runner !== "grok-custom") {
    env.GROK_HOME = input.grokHome;
  } else {
    // T-168 residual QA: não basta omitir o set — GROK_HOME herdado de
    // base/passthrough (ex. ~/.grok do daemon) vaza pro wrapper e anula
    // "${GROK_HOME:-$HOME/.grok-custom}".
    delete env.GROK_HOME;
  }
  env.GROK_DISABLE_AUTOUPDATER = "1";
  return env;
}
