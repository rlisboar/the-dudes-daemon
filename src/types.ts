// Tipos do daemon.
//
// T-423/R3 (M34): os tipos que já existiam no wire web↔server deixaram de ser
// redefinidos aqui — a fonte única é `@the-dudes/protocol/wire`. `AgentRepoSpec`
// é o nome histórico do daemon para `AgentRepo` (alias, mesmo shape); só
// `RepoSummary` segue local (não existe no wire).

export type { AgentRuntimeState, CliRunner, EffortLevel } from "@the-dudes/protocol";

export type {
  AgentInfo,
  AgentUsage,
  ImageAttachment,
  MCPDefinition,
  MCPSource,
  SkillDefinition,
  SkillFrontmatter,
  SkillSource,
} from "@the-dudes/protocol/wire";

/** Alias do wire — nome usado pelo daemon desde antes do pacote protocol. */
export type { AgentRepo as AgentRepoSpec } from "@the-dudes/protocol/wire";

/** Repo base do workspace (espelho de workspace:set) — daemon-only. */
export interface RepoSummary {
  id: string;
  name: string;
  gitUrl: string;
  defaultBranch?: string;
}