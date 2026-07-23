// Subset of types shared with the server. Keep shapes byte-compatible —
// these flow over the orchestrator WS as JSON.

import type { AgentRuntimeState, CliRunner, EffortLevel } from "@the-dudes/protocol";
export type { AgentRuntimeState, CliRunner, EffortLevel } from "@the-dudes/protocol";

export interface AgentUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface AgentRepoSpec {
  name: string;
  gitUrl: string;
  branch?: string;
}

export interface AgentInfo {
  id: string;
  ownerUserId: string;
  name: string;
  role: string;
  systemPrompt: string;
  hierarchyLevel?: number;
  managerAgentId?: string;
  team?: string;
  color: string;
  state: AgentRuntimeState;
  running: boolean;
  model?: string;
  effort?: EffortLevel;
  cliRunner?: CliRunner;
  planMode?: boolean;
  /** Custom CLAUDE_CONFIG_DIR. Empty/undefined → daemon uses "$HOME/.claude". */
  claudeConfigDir?: string;
  sessionId?: string;
  repo?: AgentRepoSpec;
  cwdOverride?: string;
  usage: AgentUsage;
  /** When true, daemon forwards Claude's extended-thinking blocks via onThinkingText.
   *  Resolved by the server (agent override ?? project default ?? false). */
  collectThinking?: boolean;
}

export interface ImageAttachment {
  mimeType: string;
  base64: string;
}

export interface RepoSummary {
  id: string;
  name: string;
  gitUrl: string;
  defaultBranch?: string;
}

/* ---------- AgentSkills v2 (mirrors server/src/types) ---------- */

export interface SkillFrontmatter {
  name: string;
  description: string;
  when?: string;
  version?: string;
  userInvocable?: boolean;
  commandDispatch?: "tool" | "shell" | null;
  disableModelInvocation?: boolean;
  allowedTools?: string[];
  metadata?: {
    requiresBinary?: string[];
    requiresEnv?: string[];
    requiresOs?: Array<"linux" | "macos" | "windows">;
    requiresConfig?: Record<string, unknown>;
  };
}

export type SkillSource =
  | "workspace"
  | "project-agents"
  | "personal-agents"
  | "openclaw-managed"
  | "bundled"
  | "extra";

export interface SkillDefinition {
  name: string;
  source: SkillSource;
  /** Origem do install — gravado pelo installer em `.installed-from.json`.
   *  Ausente pra skills criadas manualmente. */
  installedFrom?: { source: string; slug: string; installedAt?: string };
  path: string;
  frontmatter: SkillFrontmatter;
  body: string;
  contentHash: string;
}

/* ---------- MCP servers (Phase 1: discovery) ---------- */

export type MCPSource =
  | "workspace"
  | "claude-project"
  | "claude-global"
  | "codex"
  | "opencode"
  | "gemini"
  | "override";

export interface MCPDefinition {
  name: string;
  source: MCPSource;
  configPath: string;
  transport?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
}
