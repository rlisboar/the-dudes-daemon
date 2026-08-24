/**
 * Daemon ↔ Orchestrator wire protocol.
 *
 * The daemon connects to /ws/daemon with a Bearer token. After auth, it
 * exchanges these JSON messages with the orchestrator.
 */

import type {
  AgentInfo,
  AgentRepoSpec,
  AgentRuntimeState,
  AgentUsage,
  ImageAttachment,
  MCPDefinition,
  RepoSummary,
  SkillDefinition,
} from "./types.js";

/* ---------- handshake / heartbeat ---------- */

export interface DaemonHello {
  type: "daemon:hello";
  name: string;
  os: string;
  hostname: string;
  version: string;
  /** Versão do protocolo de fio (WIRE_PROTOCOL_VERSION). O server compara com
   *  a dele: igual = compatíveis; ausente = daemon antigo. */
  protocolVersion?: number;
  /** SPKI base64 of the daemon's RSA-OAEP-2048 public key. Web clients
   *  use this to wrap project keys for end-to-end transport without the
   *  server seeing the symmetric key. */
  cryptoPublicKey?: string;
  /** SHA-256 hex da imagem carregada no boot (não re-lê o arquivo após self-update). */
  binaryHash?: string;
  /** Epoch injetado no bundle (DAEMON_BUILD_TS da imagem em execução). */
  buildTs?: number;
  /** Arquivo novo no disco; processo ainda na imagem antiga (restart pendente). */
  updatePending?: boolean;
  /** State recovery: maior seq de msg outbound vista antes do disconnect
   *  anterior. Server replay buffer das msgs com seq > resumeFromSeq.
   *  0/ausente = primeira conn ou buffer expirou. */
  resumeFromSeq?: number;
  /** CLIs resolvidos como executáveis neste daemon. */
  availableRunners?: Array<"claude" | "codex" | "opencode" | "gemini" | "crush" | "grok">;
  /** Disponibilidade do graphify (build) e graphify-mcp (serve) no PATH do daemon. */
  graphify?: { cli: boolean; mcp: boolean };
  /** CLIs instalados (espelho de availableRunners) p/ a UI do mapa. */
  installedRunners?: Array<"claude" | "codex" | "opencode" | "gemini" | "crush" | "grok">;
}

export interface ProjectE2eeRequired {
  type: "project:e2ee_required";
  projectId: string;
  value: boolean;
}

export interface ProjectKeyForDaemon {
  type: "project_key:for_daemon";
  projectId: string;
  /** RSA-OAEP-encrypted base64 of the AES-256 project key. Daemon
   *  decrypts with its private key and keeps in memory only. */
  wrappedProjectKey: string;
  /**
   * Cadeia de chaves antigas (project_key_ring), mais antiga → mais nova.
   * Cada entrada é a chave anterior cifrada AES-GCM ("e2e:") com a seguinte.
   * Opcional: sem o campo, só a ativa (retrocompat; auto-promote se antiga em RAM).
   */
  keyRing?: string[];
}

export interface DaemonWelcome {
  type: "daemon:welcome";
  user: { id: string; email: string; name: string };
}

export interface DaemonPing { type: "daemon:ping"; ts: number }
export interface DaemonPong { type: "daemon:pong"; ts: number }

/**
 * Server → daemon: release novo em /install (T-033).
 * Dispara self-update check na hora. Daemons antigos ignoram (sem case).
 */
export interface ReleaseAvailable {
  type: "release:available";
  /** sha256 hex do daemon.cjs publicado. */
  sha256: string;
}

/** Política definida no dashboard e persistida no servidor. */
export interface RunnerPolicySet {
  type: "runner-policy:set";
  allowedRunners: Array<"claude" | "codex" | "opencode" | "gemini" | "crush" | "grok">;
}

/* H-18 proof-of-possession da pubkey RSA do daemon. Server gera nonce
 * após receber hello; daemon assina com privkey e responde. Server só
 * promove cryptoVerified=true após verificar signature. */
export interface DaemonChallenge { type: "daemon:challenge"; nonce: string }
export interface DaemonChallengeResponse { type: "daemon:challenge_response"; signature: string }

/* ---------- agent control (orch → daemon) ---------- */

export interface AgentSpawn {
  type: "agent:spawn";
  agent: AgentInfo;
  /** Project this agent belongs to. Used by the daemon to look up the
   *  E2EE project key when the agent's systemPrompt and inbound
   *  messages are encrypted. */
  projectId?: string;
  /** T-074: fail-closed no write deste projeto. Piggyback — o caso crítico é SEM chave. */
  e2eeRequired?: boolean;
  basePath: string;
  /** name of the project base repo (folder under basePath) when agent has none of its own */
  repoName?: string;
  /** absolute path on this machine; if set, overrides basePath. */
  cwdOverride?: string;
  /** agent's own repo — daemon clones it inside cwdOverride. */
  agentRepo?: AgentRepoSpec;
  autoApprove: boolean;
  agentToken: string;
  orchUrl: string;
  /** if true, create an isolated git worktree for this agent */
  agentWorktrees?: boolean;
  /**
   * MCP servers a serem injetados no claude --mcp-config além do "the-dudes"
   * bridge. Server resolve allowlist e envia o subset filtrado dos
   * `workspaceMCPs`. Map key = server name. Phase 2 — só claude consome
   * por enquanto (codex/gemini/opencode leem direto do filesystem do CLI).
   */
  extraMcpServers?: Record<string, MCPServerConfig>;
  /**
   * Hot-set of project-memory entries injected into the agent system
   * prompt at (re)start. titleCipher/bodyCipher are E2EE blobs; the
   * daemon decrypts each (it holds the project key) and appends a
   * "## Project Memory" block to the already-decrypted systemPrompt.
   * Re-sent on every spawn so durable knowledge survives model/runner
   * switches and context compaction. Server cannot pre-concatenate this
   * into systemPrompt because that prompt is itself cipher at rest.
   */
  memory?: MemoryInjectionEntry[];
  /**
   * Blocos de contexto ligados neste projeto. Cada flag off remove DUAS
   * pontas: a seção correspondente do system prompt E o grupo de tools no
   * mcp-bridge (via env THE_DUDES_FEATURES), pra não ocupar contexto à toa.
   * Ausente = tudo ligado (compat com server/daemon antigos).
   */
  features?: ContextFeatures;
}

/** Grupos de contexto gateáveis por projeto. Fase 1 só desliga memory e
 *  filelock ponta-a-ponta; teammates/tasks vêm sempre true até a Fase 2
 *  reescrever a prosa emaranhada do header. */
export interface ContextFeatures {
  teammates?: boolean;
  tasks?: boolean;
  filelock?: boolean;
  memory?: boolean;
  goals?: boolean;
  credentials?: boolean;
  webhooks?: boolean;
  /** Knowledge graph (graphify) — injeta o MCP server graphify-mcp no agente
   *  e indexa o workspace sob demanda. Off = não injeta nem indexa. */
  graph?: boolean;
  /** Explanation Board — tools board_* + prosa no system prompt. Opt-in. */
  board?: boolean;
  /** Linguagem de diagrama que o agente deve escrever no quadro. Viaja junto
   *  das features porque é a mesma decisão de projeto e o mesmo caminho até o
   *  bridge/system prompt. Ausente = mermaid (comportamento histórico). */
  diagramLanguage?: "mermaid" | "d2";
  /** Modo do quadro: `blocks` (markdown+diagrama) ou `html` (página inteira).
   *  Exclusivos — ver Project.boardMode no protocolo do server. */
  boardMode?: "blocks" | "html";
  /** Requinte da página no modo html: basic | normal | quality. */
  boardHtmlLevel?: "basic" | "normal" | "quality";
}

export interface MemoryInjectionEntry {
  type: string;
  scope: string;
  titleCipher: string;
  bodyCipher: string;
}

export interface MCPServerConfig {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface AgentStop { type: "agent:stop"; agentId: string }
export type AgentSendPart =
  | { kind: "plain"; text: string }
  | { kind: "cipher"; text: string };

export interface AgentSend {
  type: "agent:send";
  agentId: string;
  /**
   * T-037: id estável da entrega. Server reenvia o mesmo id no reconnect;
   * daemon deduplica pra não duplicar TASK_ASSIGN. Opcional (legado).
   */
  deliveryId?: string;
  /** When the active project has E2EE enabled, content arrives as
   *  "e2e:" + base64(iv||ct||tag). Daemon decrypts before forwarding
   *  to the CLI. Ignored if `parts` is provided. */
  content: string;
  /** Plaintext server-side prefix (e.g. anti-loop / preventive mode
   *  notice, agent-to-agent envelope `[from X]:`) prepended to the
   *  decrypted content before sending to the CLI. Server-generated,
   *  never encrypted. Ignored if `parts` is provided. */
  systemPrefix?: string;
  /** Plaintext server-side suffix appended after the decrypted content
   *  (e.g. agent-to-agent reply hint). Server-generated, never
   *  encrypted. Ignored if `parts` is provided. */
  systemSuffix?: string;
  /** Optional structured form for prompts that interleave plaintext
   *  envelope with multiple cipher fields (task notify, history replay,
   *  etc.). When present, daemon ignores `content`/`systemPrefix`/
   *  `systemSuffix` and concatenates parts in order, decrypting each
   *  cipher part with the project key. */
  parts?: AgentSendPart[];
  /** Project the message belongs to — required for E2EE decrypt. */
  projectId?: string;
  images?: ImageAttachment[];
  /** Espelho Telegram: quando presente, vincula este agente a um chat do
   *  Telegram. O daemon passa a encaminhar TODA saída do agente (texto em
   *  claro, pré-E2EE) pra esse chat via sendMessage. null desvincula. */
  telegram?: { botToken: string; chatId: string } | null;
}
export interface AgentClear { type: "agent:clear"; agentId: string }
export interface AgentCompact { type: "agent:compact"; agentId: string; saveMemory?: boolean }
export interface AutoApproveSet { type: "auto_approve:set"; value: boolean }
export interface WorkspaceSet {
  type: "workspace:set";
  projectId: string;
  basePath: string;
  repos: RepoSummary[];
}

/* ---------- agent events (daemon → orch) ---------- */

export interface AgentStateEv { type: "agent:state"; agentId: string; state: AgentRuntimeState }
export interface AgentRunningEv { type: "agent:running"; agentId: string; running: boolean }
export interface AgentSessionEv { type: "agent:session"; agentId: string; sessionId: string }
export interface AgentTokenResyncEv { type: "agent:token_resync"; agentId: string; token: string }
export interface AgentUsageDeltaEv { type: "agent:usage_delta"; agentId: string; delta: AgentUsage }
export interface AgentTextEv { type: "agent:text"; agentId: string; text: string }
export interface AgentToolUseEv { type: "agent:tool_use"; agentId: string; toolName: string; input: unknown }
export interface AgentThinkingEv { type: "agent:thinking"; agentId: string; text: string; redacted: boolean }
export interface AgentErrorEv {
  type: "agent:error";
  agentId: string;
  message: string;
  /**
   * T-092: classe operacional no plaintext ANTES do seal (paridade hung.soft).
   * Ausente = daemon velho: em E2EE o server NÃO dispara auto-retry até atualizar.
   */
  errorKind?: "rate_limit" | "other";
}
/** Runner sem atividade / processo morto — soft=aviso; hard=turno abortado. */
export interface AgentHungEv {
  type: "agent:hung";
  agentId: string;
  soft: boolean;
  reason: string;
  idleMs: number;
  runner?: string;
}
export interface AgentExitEv { type: "agent:exit"; agentId: string; code: number | null }
export interface AgentContextWarningEv { type: "agent:context_warning"; agentId: string; used: number; limit: number }
export interface AgentContextFullEv { type: "agent:context_full"; agentId: string }
/** Ocupação atual da janela (runtime) — atualiza a cada turno quando o runner sabe. */
export interface AgentContextEv { type: "agent:context"; agentId: string; used: number; limit: number }

export interface WorkspaceResult {
  type: "workspace:result";
  projectId: string;
  basePath: string;
  clones: { repoName: string; ok: boolean; message: string }[];
}

/* ---------- file browser (orch → daemon) ---------- */

export interface FileListRequest {
  type: "file:list";
  correlationId: string;
  path: string;
  /** Workspace root do projeto ativo. Override do this.workspacePath
   *  global. Sem isso, daemon multi-projeto usa last-write-wins. */
  workspaceRoot?: string;
}

export interface FileReadRequest {
  type: "file:read";
  correlationId: string;
  path: string;
  workspaceRoot?: string;
}

export interface FileWriteRequest {
  type: "file:write";
  correlationId: string;
  path: string;
  content: string;
  workspaceRoot?: string;
}

export interface FileOperationRequest {
  type: "file:operation";
  correlationId: string;
  op: "create_file" | "create_directory" | "rename" | "delete";
  path: string;
  newPath?: string;
  workspaceRoot?: string;
}

export interface FileSearchRequest {
  type: "file:search";
  correlationId: string;
  query: string;
  workspaceRoot?: string;
}

/* ---------- file browser results (daemon → orch) ---------- */

export interface FileListResult {
  type: "file:list_result";
  correlationId: string;
  path: string;
  entries: FileEntry[];
  error?: string;
}

export interface FileReadResult {
  type: "file:read_result";
  correlationId: string;
  path: string;
  content?: string;
  encoding?: "utf8" | "base64";
  mimeType?: string;
  error?: string;
}

export interface FileWriteResult {
  type: "file:write_result";
  correlationId: string;
  path: string;
  ok: boolean;
  error?: string;
}

export interface FileOperationResult {
  type: "file:operation_result";
  correlationId: string;
  op: FileOperationRequest["op"];
  path: string;
  newPath?: string;
  ok: boolean;
  error?: string;
}

export interface FileSearchResult {
  type: "file:search_result";
  correlationId: string;
  query: string;
  entries: FileEntry[];
  error?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

/* ---------- git browser (orch → daemon) ---------- */

/** Workspace root opcional em todas Git requests — daemon usa esse path
 *  ao invés do this.workspacePath global pra suportar multi-projeto. */
export interface GitLogRequest {
  type: "git:log";
  correlationId: string;
  count?: number;
  workspaceRoot?: string;
}

export interface GitStatusRequest {
  type: "git:status";
  correlationId: string;
  workspaceRoot?: string;
}

export interface GitDiffRequest {
  type: "git:diff";
  correlationId: string;
  path: string;
  workspaceRoot?: string;
}

export interface GitStageRequest {
  type: "git:stage";
  correlationId: string;
  path: string;
  workspaceRoot?: string;
}

export interface GitUnstageRequest {
  type: "git:unstage";
  correlationId: string;
  path: string;
  workspaceRoot?: string;
}

export interface GitCommitRequest {
  type: "git:commit";
  correlationId: string;
  message: string;
  paths?: string[];
  workspaceRoot?: string;
}

export interface GitPushRequest { type: "git:push"; correlationId: string; workspaceRoot?: string; }
export interface GitPullRequest { type: "git:pull"; correlationId: string; workspaceRoot?: string; }
export interface GitBranchesRequest { type: "git:branches"; correlationId: string; workspaceRoot?: string; }

export interface GitSwitchBranchRequest {
  type: "git:switch_branch";
  correlationId: string;
  branch: string;
  workspaceRoot?: string;
}

export interface GitCreateBranchRequest {
  type: "git:create_branch";
  correlationId: string;
  branch: string;
  workspaceRoot?: string;
}

export interface GitShowRequest {
  type: "git:show";
  correlationId: string;
  hash: string;
  workspaceRoot?: string;
}

export interface GitFileLogRequest {
  type: "git:file_log";
  correlationId: string;
  path: string;
  count?: number;
  workspaceRoot?: string;
}

export interface GitGraphRequest { type: "git:graph"; correlationId: string; workspaceRoot?: string; }

/** Knowledge graph (graphify) — orch pede rebuild do índice do workspace.
 *  projectId só pra rotular o status de volta. */
export interface GraphBuildRequest { type: "graph:build"; correlationId?: string; projectId?: string; workspaceRoot?: string; semantic?: boolean; backend?: string; model?: string; apiKeyEnv?: string; apiKeyCipher?: string; }
/** Status do índice graphify reportado pelo daemon (durante/após build). */
export interface GraphStatusEvent {
  type: "graph:status";
  projectId?: string;
  status: "building" | "ready" | "error";
  nodeCount?: number;
  edgeCount?: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** 0–100 durante extract/update (quando o CLI imprime progresso). */
  progress?: number;
  /** Fase legível: "ast" | "semantic" | "update" | "watch" | … */
  phase?: string;
  /** mtime do graph.json (ms epoch) quando ready. */
  indexMtime?: number;
  /** true se arquivos mudaram e um reindex debounced está pendente. */
  stale?: boolean;
  /** graphify CLI (build) disponível no daemon. */
  graphifyAvailable?: boolean;
  /** graphify-mcp (serve) disponível no daemon. */
  graphifyMcpAvailable?: boolean;
  /** Docs/imagens pendentes de re-extract semântico (+ docs). */
  docsPending?: boolean;
  /** true se o grafo tem (ou preservou) camada semântica de docs. */
  hasSemantic?: boolean;
  correlationId?: string;
}
/** Orch pede o graph.json do workspace pra renderizar o mapa na UI. */
export interface GraphFetchRequest { type: "graph:fetch"; correlationId?: string; projectId?: string; workspaceRoot?: string; }
/** graph.json (string) devolvido pelo daemon pro mapa. */
export interface GraphDataEvent { type: "graph:data"; projectId?: string; json?: string; error?: string; correlationId?: string; }

export interface GitBlameRequest {
  type: "git:blame";
  correlationId: string;
  path: string;
  workspaceRoot?: string;
}

export interface GitStashListRequest { type: "git:stash_list"; correlationId: string; workspaceRoot?: string; }
export interface GitStashRequest { type: "git:stash"; correlationId: string; message?: string; workspaceRoot?: string; }
export interface GitStashPopRequest { type: "git:stash_pop"; correlationId: string; workspaceRoot?: string; }

/* ---------- git browser results (daemon → orch) ---------- */

export interface GitLogResult {
  type: "git:log_result";
  correlationId: string;
  commits: GitCommit[];
  error?: string;
}

export interface GitStatusResult {
  type: "git:status_result";
  correlationId: string;
  files: GitFileStatus[];
  branch?: string;
  error?: string;
}

export interface GitDiffResult {
  type: "git:diff_result";
  correlationId: string;
  path: string;
  diff?: string;
  error?: string;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitFileStatus {
  path: string;
  status: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
}

export interface GitResult {
  type: "git:result";
  correlationId: string;
  op: string;
  ok: boolean;
  message?: string;
  output?: string;
  error?: string;
  commits?: GitCommit[];
  files?: GitFileStatus[];
  diff?: string;
  branches?: GitBranch[];
  stashes?: GitStashEntry[];
}

/* ---------- TTS summarizer (orch ↔ daemon) ---------- */

export interface SummarizeRequest {
  type: "summarize:request";
  correlationId: string;
  runner: "claude" | "codex" | "opencode" | "gemini" | "crush" | "grok";
  model?: string;
  effort?: string;
  systemPrompt?: string;
  text: string;
  claudeConfigDir?: string;
  /** When E2EE is on, `text` arrives as "e2e:" + b64. Daemon decrypts
   *  with this project's key, runs the LLM, and re-encrypts the
   *  summary with the same key before sending result back. */
  projectId?: string;
}

export interface SummarizeResult {
  type: "summarize:result";
  correlationId: string;
  ok: boolean;
  summary?: string;
  error?: string;
  usage?: { input: number; output: number };
}

export interface WebhookDispatchRequest {
  type: "webhook:dispatch";
  /** Server-issued correlation id; daemon echoes back in delivery_result. */
  deliveryId: string;
  projectId: string;
  /** Human-friendly project name, shown in formatted payload footers. */
  projectName?: string;
  /** Map agentId → agent name so the formatter shows "@kubernetes"
   *  instead of "agent_622c6498" in `from`/`to`/etc. */
  agentNames?: Record<string, string>;
  url: string;
  secret: string | null;
  format: "generic" | "discord" | "slack";
  headers?: Record<string, string>;
  /** Raw event payload (may contain "e2e:" cipher fields). Daemon
   *  decrypts in place using project_key, then formats and POSTs. */
  event: unknown;
}

export interface WebhookDeliveryResult {
  type: "webhook:delivery_result";
  deliveryId: string;
  eventType: string;
  status: number | null;
  body: string;
  error?: string;
}

export interface SkillsScanResult {
  type: "skills:scan";
  /** Snapshot completo das skills detectadas. Substitui o set anterior. */
  skills: SkillDefinition[];
  /** Para troubleshooting — paths inspecionados, mesmo quando vazios. */
  scannedSources: string[];
  ts: number;
}


/** Pede pro daemon re-escanear sources e re-emitir snapshot. */
export interface SkillsRescanRequest {
  type: "skills:rescan";
  /** Path absoluto pra `<basePath>/skills` do projeto ativo. Override
   *  do this.workspacePath. Se omitido, scanner usa workspace atual. */
  workspaceSkillsRoot?: string;
}

export interface SkillReadFileRequest {
  type: "skill:read_file";
  correlationId: string;
  /** Nome canônico da skill (chave usada em workspace/skills/<name>/). */
  skillName: string;
  /** Caminho relativo dentro da pasta da skill. Default: "SKILL.md". */
  relPath?: string;
  /** Override do workspaceSkillsRoot. Recomendado — server resolve por
   *  projeto. Sem isto, daemon usa this.workspacePath + "/skills". */
  workspaceSkillsRoot?: string;
}

export interface SkillReadFileResult {
  type: "skill:read_file_result";
  correlationId: string;
  ok: boolean;
  content?: string;
  error?: string;
}

export interface SkillSaveFileRequest {
  type: "skill:save_file";
  correlationId: string;
  skillName: string;
  relPath?: string;
  content: string;
  workspaceSkillsRoot?: string;
}

export interface SkillSaveFileResult {
  type: "skill:save_file_result";
  correlationId: string;
  ok: boolean;
  error?: string;
}

export interface SkillDeleteRequest {
  type: "skill:delete";
  correlationId: string;
  skillName: string;
  workspaceSkillsRoot?: string;
}

export interface SkillDeleteResult {
  type: "skill:delete_result";
  correlationId: string;
  ok: boolean;
  error?: string;
}

/* ---------- MCP servers — discovery (Phase 1, read-only) ---------- */

export interface MCPsScanResult {
  type: "mcps:scan";
  /** Snapshot completo dos MCP servers configurados. Substitui o set anterior. */
  mcps: MCPDefinition[];
  /** Paths inspecionados, mesmo quando vazios — útil pro UI mostrar onde
   *  o user pode adicionar config. */
  scannedSources: string[];
  ts: number;
}

export interface MCPsRescanRequest {
  type: "mcps:rescan";
  /** Path absoluto do workspace. Daemon scaneia config local + ~/. */
  workspaceRoot?: string;
}

/* ---------- MCP servers — CRUD no override file ---------- */

/**
 * Salva (insert ou update) um MCP server no override file local
 * (`~/.config/the-dudes/mcp-servers.json`). Daemon re-scanea depois e
 * emite novo `mcps:scan` automaticamente.
 */
export interface MCPSaveRequest {
  type: "mcps:save";
  correlationId?: string;
  name: string;
  /** stdio | sse | http. Default: stdio. */
  transport?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  /** Path absoluto do workspace pra trigger re-scan correto. */
  workspaceRoot?: string;
}

export interface MCPSaveResult {
  type: "mcps:save_result";
  correlationId?: string;
  ok: boolean;
  error?: string;
}

export interface MCPDeleteRequest {
  type: "mcps:delete";
  correlationId?: string;
  name: string;
  workspaceRoot?: string;
}

export interface MCPDeleteResult {
  type: "mcps:delete_result";
  correlationId?: string;
  ok: boolean;
  error?: string;
}

/** GitLab API proxy — o server pede e o DAEMON faz o request HTTP (a partir da
 *  rede do daemon). Necessário quando o GitLab é interno/on-prem, alcançável só
 *  da infra do usuário e não do server público. */
export interface GitlabApiRequest {
  type: "gitlab:request";
  correlationId: string;
  method: string;
  url: string;
  token: string;
  body?: string;
}
export interface GitlabApiResult {
  type: "gitlab:request_result";
  correlationId: string;
  ok: boolean;
  status: number;
  statusText?: string;
  text?: string;
  /** Falha de transporte (DNS/conexão/timeout) — distinto de um HTTP !ok. */
  error?: string;
}

/* ---------- runner model discovery (orch ↔ daemon) ---------- */

export interface DiscoveredRunnerModel {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  efforts?: string[];
  inputModalities?: string[];
  capabilityTier?: 1 | 2 | 3 | 4;
  speedTier?: 1 | 2 | 3;
  costTier?: 1 | 2 | 3;
}

export interface RunnerModelCatalog {
  runner: "claude" | "codex" | "opencode" | "gemini" | "crush" | "grok";
  models: DiscoveredRunnerModel[];
  source: "codex-app-server" | "cli-command" | "unsupported";
  fetchedAt: number;
  error?: string;
}

export interface ModelsDiscoverRequest {
  type: "models:discover";
  correlationId: string;
  runner?: RunnerModelCatalog["runner"];
  force?: boolean;
}

export interface ModelsCatalogResult {
  type: "models:catalog";
  correlationId: string;
  catalogs: RunnerModelCatalog[];
}

/** Snapshot de saúde do daemon (indicadores da UI). */
export interface DaemonHealthEv {
  type: "daemon:health";
  health: {
    ts: number;
    uptimeS: number;
    memRssMb: number;
    wsRttMs: number | null;
    turnGate: { active: number; queued: number; max: number };
    turns: { started: number; ok: number; failed: number; hardRecovers: number; hangs: number };
    turnP50Ms: number | null;
    turnP95Ms: number | null;
    byRunner: Record<string, { started: number; ok: number; failed: number; hardRecovers: number; hangs: number }>;
    agentsRunning: number;
    e2eeProjects: number;
    /** T-088: identidade da imagem em execução (mesmo contrato do hello). */
    binaryHash?: string;
    buildTs?: number;
    updatePending?: boolean;
  };
}

/** Pedido do visor de logs de debug da UI (via server). */
export interface DaemonLogsGetRequest {
  type: "daemon:logs:get";
  correlationId?: string;
  limit?: number;
}

export interface DaemonLogsResult {
  type: "daemon:logs:result";
  correlationId?: string;
  lines: Array<{ ts: number; level: "info" | "warn" | "error"; msg: string }>;
}

export type FromDaemon =
  | DaemonHealthEv
  | DaemonLogsResult
  | GitlabApiResult
  | DaemonHello | DaemonPing | DaemonChallengeResponse
  | AgentStateEv | AgentRunningEv | AgentSessionEv | AgentTokenResyncEv | AgentUsageDeltaEv
  | AgentTextEv | AgentToolUseEv | AgentThinkingEv | AgentErrorEv | AgentHungEv | AgentExitEv
  | AgentContextWarningEv | AgentContextFullEv | AgentContextEv
  | WorkspaceResult
  | FileListResult | FileReadResult | FileWriteResult | FileOperationResult | FileSearchResult
  | GitLogResult | GitStatusResult | GitDiffResult
  | GitResult
  | SummarizeResult
  | WebhookDeliveryResult
  | SkillsScanResult
  | SkillReadFileResult
  | SkillSaveFileResult
  | SkillDeleteResult
  | MCPsScanResult
  | MCPSaveResult
  | MCPDeleteResult
  | GraphStatusEvent
  | GraphDataEvent
  | ModelsCatalogResult;

export type FromOrch =
  | DaemonLogsGetRequest
  | DaemonWelcome | DaemonPong | DaemonChallenge | RunnerPolicySet
  | ReleaseAvailable
  | AgentSpawn | AgentStop | AgentSend | AgentClear | AgentCompact
  | AutoApproveSet | WorkspaceSet
  | FileListRequest | FileReadRequest | FileWriteRequest | FileOperationRequest | FileSearchRequest
  | GitLogRequest | GitStatusRequest | GitDiffRequest
  | GitStageRequest | GitUnstageRequest | GitCommitRequest
  | GitPushRequest | GitPullRequest | GitBranchesRequest
  | GitSwitchBranchRequest | GitCreateBranchRequest
  | GitShowRequest | GitFileLogRequest | GitGraphRequest
  | GitBlameRequest | GitStashListRequest | GitStashRequest | GitStashPopRequest
  | GitlabApiRequest
  | SummarizeRequest
  | ProjectKeyForDaemon
  | ProjectE2eeRequired
  | WebhookDispatchRequest
  | SkillsRescanRequest
  | SkillReadFileRequest
  | SkillSaveFileRequest
  | SkillDeleteRequest
  | MCPsRescanRequest
  | MCPSaveRequest
  | MCPDeleteRequest
  | GraphBuildRequest
  | GraphFetchRequest
  | ModelsDiscoverRequest;
