/**
 * CONTRATO DE FIO — fonte única de ServerEvent, ClientCommand e dos tipos de
 * domínio que eles carregam.
 *
 * Antes isto vivia duplicado em `server/src/types.ts` e `web/src/protocol.ts`
 * (~2.700 linhas espelhadas na mão). O único guarda era um teste que comparava
 * por regex os literais de discriminante — ele via os NOMES dos comandos, não
 * os CAMPOS, e a essa altura os dois lados já tinham divergido:
 *
 *   - `add_task`/`update_task`: o web mandava `goalId`, o server não declarava
 *     (funcionava por spread, mas sem tipo que garantisse)
 *   - `spawn`: `collectThinking` só existia no web
 *   - `PlanTask.boardStatus`: `TaskStatus` no server, `string` solto no web
 *   - `Project.loopLimitEnabled`: obrigatório num lado, opcional no outro
 *   - `MemoryEntry.title/body`: campos de decifragem só no web
 *
 * Agora os dois lados importam daqui e o compilador é o guarda. Campos
 * exclusivos de um lado ficam nos arquivos locais, que estendem estes tipos.
 */

import type { AgentRuntimeState, CliRunner, EffortLevel, ProjectMemberRole } from "./index.js";


/**
 * AgentSkills v2 — packaged behaviour, not declarative tags.
 *
 * A skill is a folder containing a `SKILL.md` (YAML frontmatter +
 * markdown body) plus optional scripts. Daemon scans 6 sources in
 * precedence order and reports the resolved set to the orchestrator.
 * Auto-invocable skills are appended to the agent system prompt;
 * user-invocable skills become slash commands / MCP tools.
 *
 * Conforms to the AgentSkills spec used by OpenClaw + Claude Skills,
 * so a `~/.openclaw/skills/<name>/` folder is read transparently.
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Heurística pro selector saber quando usar a skill. */
  when?: string;
  /** SemVer ou livre — ClawHub envia como string. */
  version?: string;
  /** Slash command exposure. Default false. */
  userInvocable?: boolean;
  /** Bypass the LLM, dispatch directly. Default false. */
  commandDispatch?: "tool" | "shell" | null;
  /** Hide from system prompt while keeping slash availability. */
  disableModelInvocation?: boolean;
  /** Tools the skill is allowed to call (claude `--allowed-tools` style). */
  allowedTools?: string[];
  /** Conditional gating — only load when these match the host. */
  metadata?: {
    requiresBinary?: string[];
    requiresEnv?: string[];
    requiresOs?: Array<"linux" | "macos" | "windows">;
    requiresConfig?: Record<string, unknown>;
  };
}

export type SkillSource =
  | "workspace"           // <workspace>/skills
  | "project-agents"      // <workspace>/.agents/skills
  | "personal-agents"     // ~/.agents/skills
  | "openclaw-managed"    // ~/.openclaw/skills (cross-tool compat)
  | "bundled"             // shipped with daemon
  | "extra";              // configured paths

export interface SkillDefinition {
  /** Canonical name (folder name == frontmatter.name). */
  name: string;
  /** Source bucket — higher precedence overrides lower on name conflict. */
  source: SkillSource;
  /** Origem do install (registry + slug) — usado pra distinguir matches
   *  de skills com mesmo nome canônico. Ausente se criada manualmente. */
  installedFrom?: { source: string; slug: string; installedAt?: string };
  /** Absolute path to the skill folder on the daemon machine. */
  path: string;
  /** Parsed YAML frontmatter from SKILL.md. */
  frontmatter: SkillFrontmatter;
  /** Body (markdown after the closing ---). */
  body: string;
  /** sha256 of SKILL.md — stable id for caching/diff. */
  contentHash: string;
}

/**
 * MCP (Model Context Protocol) server definition discovered by daemon.
 *
 * Discovery sources (precedence: low→high):
 *   workspace          — <workspace>/.mcp.json or <workspace>/.claude/mcp.json
 *   claude-project     — project-scoped Claude Code config
 *   claude-global      — ~/.claude/mcp_servers.json (or settings.json)
 *   codex              — ~/.codex/mcp.json
 *   opencode           — ~/.config/opencode/mcp.json
 *   gemini             — ~/.config/gemini/mcp.json
 *   override           — ~/.config/the-dudes/mcp-servers.json (final say)
 *
 * Conflicts on `name` resolved by precedence (override > daemon-global >
 * runner-specific > workspace).
 */
export type MCPSource =
  | "workspace"
  | "claude-project"
  | "claude-global"
  | "codex"
  | "opencode"
  | "gemini"
  | "override";

export interface MCPDefinition {
  /** Server name (key in config). */
  name: string;
  /** Source bucket — higher precedence overrides lower on name conflict. */
  source: MCPSource;
  /** Path to the config file on the daemon machine. */
  configPath: string;
  /** Transport. Defaults to stdio when command is set. */
  transport?: "stdio" | "sse" | "http";
  /** stdio: command + args + env. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** sse/http: server URL. */
  url?: string;
  /** Optional headers for sse/http. */
  headers?: Record<string, string>;
  /** Free-form description from config (rare in MCP configs). */
  description?: string;
}

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  createdAt?: string;
  isSuperAdmin?: boolean;
  canCreateProjects?: boolean;
  disabled?: boolean;
}

export interface UserAdminView extends UserPublic {
  projectCount: number;
  memberships: Array<{ projectId: string; projectName: string; role: "admin" | "member" }>;
}

export interface AdminUserUsage {
  userId: string;
  email: string;
  name: string;
  agents: number;
  messages: number;
  messageBytes: number;
  tasks: number;
  comments: number;
  ttsSummaries: number;
  totalBytesApprox: number;
}

export interface AdminSystemStats {
  generatedAt: number;
  cpu: {
    cores: number;
    model: string;
    loadavg: [number, number, number];
    usagePercent: number | null;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    processRssBytes: number;
  };
  disk: {
    mountPoint: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
  } | null;
  uptimeSeconds: number;
  platform: string;
  hostname: string;
  db: {
    databaseBytes: number;
    tables: Array<{ name: string; bytes: number; rows: number }>;
  };
  users: AdminUserUsage[];
}

export interface ToolExecutionEvent {
  id: string;
  agentId: string;
  toolName: string;
  input: unknown;
  ts: number;
}

export interface AuditLogEntry {
  id: number;
  ts: string;
  actorUserId: string | null;
  actorEmail?: string | null;
  action: string;
  targetUserId: string | null;
  targetUserEmail?: string | null;
  targetProjectId: string | null;
  targetProjectName?: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | null;
}

/* Planners — tipos mínimos usados em Project (def. completa em § Missions abaixo). */
export type PlanValidatorMode = "human" | "creator" | "agent";

export interface PlanValidator {
  mode: PlanValidatorMode;
  agentId?: string;
  agentRole?: string;
}

export interface Project {
  id: string;
  name: string;
  autoApprove: boolean;
  /** "reactive" = detect and break loops (default), "preventive" = block all agent-to-agent messages */
  loopProtection: "reactive" | "preventive";
  /** whether the per-agent consecutive-message limit is enforced in reactive
   *  mode (default false — the pair rapid-fire guard always runs regardless) */
  loopLimitEnabled: boolean;
  /** max consecutive agent-to-agent messages before loop detection triggers (default 10) */
  loopLimit: number;
  /** max exchanges between the same pair before loop detection (default 3) */
  loopPairLimit: number;
  /** time window in ms for same-pair exchange detection (default 8000) */
  loopPairWindowMs: number;
  /** auto-retry: ao receber erro de rate-limit do provider, reenviar "continue"
   *  após autoRetrySeconds. Default off. */
  autoRetryEnabled?: boolean;
  /** segundos de espera antes do auto-retry (default 10, clamp 3..300). */
  autoRetrySeconds?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  baseRepoName?: string;
  baseRepoUrl?: string;
  baseRepoBranch?: string;
  fileLocking?: boolean;
  agentWorktrees?: boolean;
  /** Project-wide default for collecting Claude extended-thinking blocks. Per-agent override possible. */
  collectThinking?: boolean;
  /** Agent escolhido pra gerar planos de mission. Null = fallback (role match, then first running). */
  defaultPlannerAgentId?: string;
  /** Agent planner default da feature Planners (planos complexos). Isolado de mission planner. */
  defaultPlanPlannerAgentId?: string;
  /** Default de validação de PlanTask no projeto (configurável). */
  defaultPlanValidator?: PlanValidator;
  /** Memória global ligada (default true). Off = não injeta memórias no contexto dos agentes. */
  memoryEnabled?: boolean;
  /** Cota de pins (hot-set) por agente. Clamp 1–100, default 15. */
  memoryMaxPinned?: number;
  /** Board de tasks ligado p/ os agentes (tools + seção do system prompt). Lean: novos nascem off. */
  tasksEnabled?: boolean;
  /** Comunicação entre agentes ligada (send_message/list_agents + regras). Lean: novos nascem off. */
  teammatesEnabled?: boolean;
  /** Acesso do agente a goals (list_goals + prosa). Não afeta a gestão humana. */
  goalsEnabled?: boolean;
  /** Acesso do agente a credenciais (get_credential + prosa). */
  credentialsEnabled?: boolean;
  /** Acesso do agente a webhooks (send_webhook/list_webhooks + prosa). */
  webhooksEnabled?: boolean;
  /** Knowledge graph (graphify) ligado p/ os agentes — injeta o MCP graphify
   *  e indexa o workspace. Lean: novos nascem off. */
  graphEnabled?: boolean;
  /** Explanation Board — tools board_* + aba Quadro. Lean: novos nascem off. */
  boardEnabled?: boolean;
  /** Linguagem de diagrama do quadro (default mermaid). */
  diagramLanguage?: DiagramLanguage;
  /**
   * Modo do quadro — os dois caminhos são EXCLUSIVOS, não se misturam:
   *
   * - `blocks` (default, barato): markdown + diagrama (mermaid|d2) + chart,
   *   callout, steps/flow. Renderiza rápido, custa poucos tokens.
   * - `html` (rico, caro): o agente escreve a página inteira — HTML, CSS e
   *   JS — em iframe sandbox sem same-origin. Mais expressivo e mais caro
   *   de gerar.
   *
   * Misturar os dois deixava o agente escolhendo caso a caso e o resultado
   * saía inconsistente: metade markdown pobre, metade página rica.
   */
  boardMode?: BoardMode;
  /** Requinte da página no modo html (default `normal`). */
  boardHtmlLevel?: BoardHtmlLevel;
  /** Largura útil do quadro (default `small`). */
  boardWidth?: BoardWidth;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
  email: string;
  name: string;
}

/**
 * Per-agent repository assignment (replaces the old shared repos table +
 * agent_repos junction). Lives inline as columns on the agents table.
 */
export interface AgentRepo {
  name: string;
  gitUrl: string;
  branch?: string;
}

export interface UserWorkspace {
  userId: string;
  projectId: string;
  basePath: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  hierarchyLevel?: number;
  team?: string;
  color?: string;
  model?: string;
  effort?: EffortLevel;
  cliRunner?: CliRunner;
  planMode?: boolean;
  cwdOverride?: string;
  /** Custom CLAUDE_CONFIG_DIR. Empty/undefined → native Claude default (env unset). */
  claudeConfigDir?: string;
  /** AgentSkills v2 — null/undefined=todas, []=nenhuma, lista=só essas. */
  skillAllowlist?: string[] | null;
  /** MCP servers — mesma semântica do skillAllowlist. */
  mcpAllowlist?: string[] | null;
  enabled?: boolean;
  createdBy?: string;
  createdAt?: string;
}

export interface AgentSpec {
  id?: string;
  name: string;
  role: string;
  /** Required on create. On update, undefined = preserve existing. */
  systemPrompt?: string;
  hierarchyLevel?: number;
  managerAgentId?: string | null;
  team?: string;
  color?: string;
  model?: string;
  effort?: EffortLevel;
  cliRunner?: CliRunner;
  planMode?: boolean;
  /** Custom CLAUDE_CONFIG_DIR for the claude runner. Empty string clears (uses default). */
  claudeConfigDir?: string | null;
  /** Override project default for thinking collection. null = inherit project. */
  collectThinking?: boolean | null;
  /** Override global TTS toggle. null = inherit user's global setting. */
  ttsEnabled?: boolean | null;
  /**
   * AgentSkills v2 — allowlist of skill names this agent may invoke.
   *   undefined / null = all detected skills available
   *   []               = explicitly none
   *   ["foo", "bar"]   = only these
   * Daemon resolves names against the scanned set at agent spawn.
   */
  skillAllowlist?: string[] | null;
  /** MCP servers — mesma semântica do skillAllowlist. */
  mcpAllowlist?: string[] | null;
  /** Cadeia de fallback p/ auto-retry: "runner/model" ou "model" (mesmo runner)
   *  por entrada. Em rate-limit do provider, troca pro próximo da cadeia. */
  fallbackChain?: string[] | null;
  /** Marca subagente efêmero de delegação (uso interno do delegate). */
  ephemeral?: boolean;
  ownerUserId?: string;
  /**
   * Per-agent repo. When set, the daemon clones it at cwdOverride
   * (which becomes mandatory and must differ from the user's basePath).
   * Pass null/empty to clear.
   */
  repo?: AgentRepo | null;
  /**
   * Absolute path on the owner's machine. Mandatory when repo is set.
   * The repo is cloned exactly at this path (the dir IS the repo).
   * Empty string clears.
   */
  cwdOverride?: string | null;
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
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
  /** Custom CLAUDE_CONFIG_DIR. Empty/undefined → native Claude default (env unset). */
  claudeConfigDir?: string;
  /** Per-agent override (null/undefined = inherit from project). */
  collectThinking?: boolean | null;
  /** Per-agent override for TTS playback (null/undefined = inherit user global). */
  ttsEnabled?: boolean | null;
  sessionId?: string;
  /** AgentSkills v2 allowlist. undefined/null = all available. */
  skillAllowlist?: string[] | null;
  /** MCP servers — mesma semântica do skillAllowlist. */
  mcpAllowlist?: string[] | null;
  /** Cadeia de fallback p/ auto-retry (rate-limit): "runner/model" ou "model". */
  fallbackChain?: string[] | null;
  /** Subagente efêmero criado por delegação (mcp delegate). Reapeado ao concluir
   *  a mission/TTL/pai-morto. parent = managerAgentId; depth = hierarchyLevel. */
  ephemeral?: boolean;
  repo?: AgentRepo;
  cwdOverride?: string;
  usage: AgentUsage;
  /**
   * Ocupação atual da janela de contexto do CLI (runtime, não billing).
   * Atualizado via `agent:context` do daemon; não persiste no DB.
   */
  contextWindow?: { used: number; limit: number } | null;
}

export type MessageKind =
  | "user_to_agent"
  | "agent_to_user"
  | "agent_to_agent"
  | "system";

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
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

export interface FileLock {
  id: string;
  projectId: string;
  agentId: string;
  path: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface MessageEntry {
  id: string;
  ts: number;
  from: string;
  to: string;
  content: string;
  kind: MessageKind;
  fromUserId?: string;
  imageCount?: number;
}

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

export interface CredentialPublic {
  id: string;
  name: string;
  note?: string;
  preview: string;
  createdAt?: string;
  grantedUserIds?: string[]; // admin-only field
  /** value cifrado E2EE (project key) — server não lê. false/undefined = legacy
   *  (server-side enc:v1). */
  e2ee?: boolean;
  /** TTL — ISO timestamp; undefined = não expira. */
  expiresAt?: string;
  /** false = agentes não podem ler via get_credential (só humanos via reveal). */
  agentAccess?: boolean;
}

/**
 * Anexo de mensagem de chat.
 *
 * O nome é histórico: começou só com imagem, hoje carrega qualquer arquivo.
 * A distinção importa no daemon — IMAGEM vai inline pro modelo (visão), e
 * qualquer outra coisa é gravada em disco e referenciada por caminho no
 * prompt. Mandar um PDF como `type: "image"` quebra o runner.
 */
export interface ImageAttachment {
  mimeType: string;
  base64: string;
  /** Nome original do arquivo. Ausente em anexos antigos (só imagem colada). */
  name?: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assigneeAgentId?: string;
  createdBy: string;
  createdAt?: string;
  updatedAt?: string;
  /** sequential per-project number (1-indexed) for human reference */
  taskNumber?: number;
  externalProvider?: "gitlab";
  externalId?: string;
  externalUrl?: string;
  /** Labels sincronizadas com a issue do GitLab (sev::P3, type::data,
   *  status::open, etc.). Texto puro — não-secretas (o GitLab já as expõe). */
  labels?: string[];
  /** agent that currently holds the execution lock */
  lockedByAgentId?: string | null;
  /** task id that blocks this one (must be done before this can start) */
  blockedByTaskId?: string | null;
  blockedByTaskNumber?: number | null;
  /** goal this task contributes to */
  goalId?: string | null;
}

export interface TaskComment {
  id: string;
  taskId: string;
  projectId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt?: string;
}

export type MemoryScope = "project" | "agent";

export type MemoryType = "fact" | "decision" | "reference" | "preference" | "task_state";

/** Memory entry (E2EE title/body). Hot-set no system prompt: só
 *  scope=agent do próprio agente (evita duplicar o mesmo texto em N
 *  agentes). scope=project fica no catálogo do projeto (UI + recall),
 *  sem auto-injeção em todos. */
export interface MemoryEntry {
  /** Preenchidos no cliente após decifrar o blob `e2e:`. O server nunca vê. */
  title?: string;
  body?: string;
  id: string;
  projectId: string;
  scope: MemoryScope;
  /** required when scope='agent' — alvo da injeção / live-push */
  agentId?: string | null;
  type: MemoryType;
  titleCipher: string;
  bodyCipher: string;
  tags: string[];
  pinned: boolean;
  confidence?: number | null;
  /** provenance: who/which model wrote it */
  source?: string | null;
  supersedesId?: string | null;
  createdBy?: string | null;
  createdAt?: string;
  lastAccessedAt?: string | null;
  /** one-way hash of normalized title+body for exact-dup detection (server
   *  blind to plaintext; computed where plaintext is — web or daemon relay). */
  contentHash?: string | null;
  /** Links opcionais ao resto do produto (board/goals/plans). */
  goalId?: string | null;
  taskId?: string | null;
  planId?: string | null;
  /** Arquivada: some do recall/hot-set default; permanece no audit/UI com filtro. */
  archivedAt?: string | null;
  /** Expiração opcional (ISO); após expires some do hot-set/recall ativo. */
  expiresAt?: string | null;
}

export interface GitLabIntegrationPublic {
  configured: boolean;
  baseUrl?: string;
  projectRef?: string;
  defaultBranch?: string;
  webhookSecretSet?: boolean;
  lastSyncAt?: string;
}

export interface PermissionRequest {
  requestId: string;
  agentId: string;
  tool: string;
  input: unknown;
  ts: number;
}

/** ---------- Explanation Board ----------
 * Quadro visual que o agent preenche via MCP (tempo real).
 * Ops tipadas (não HTML livre). Persistido em Postgres (explanation_boards).
 */
/**
 * `mermaid` e `d2` são o MESMO papel (diagrama por texto) com sintaxes
 * incompatíveis. O kind vem no bloco — e não da configuração do projeto — pra
 * que um quadro antigo continue renderizando depois que alguém troca a
 * preferência, e pra que o renderer não precise adivinhar a linguagem.
 */
export type BoardBlockKind = "markdown" | "mermaid" | "d2" | "html" | "chart" | "callout" | "steps" | "flow";

/** Linguagem de diagrama que o agente é instruído a usar no quadro. */
export type DiagramLanguage = "mermaid" | "d2";

/** Ver `Project.boardMode`. */
export type BoardMode = "blocks" | "html";

/**
 * Requinte da página no modo `html` — quanto o agente investe (e gasta) para
 * explicar:
 *
 * - `basic`   HTML + CSS. Rápido e barato.
 * - `normal`  + JavaScript: animação leve e gráficos.
 * - `quality` + three.js: página rica, animação intuitiva, gráfico moderno —
 *             sem virar demo técnica: o objetivo continua sendo explicar.
 */
export type BoardHtmlLevel = "basic" | "normal" | "quality";

/**
 * Largura útil do quadro. `small` é o texto em coluna de leitura (720px, o
 * histórico); as maiores existem porque uma página HTML com diagrama e
 * gráfico lado a lado sufoca nessa medida.
 */
export type BoardWidth = "small" | "medium" | "large";

export interface BoardChartSpec {
  type: "bar" | "line" | "pie";
  labels: string[];
  series: { name: string; values: number[] }[];
}

/** Passo de um fluxo animável (kind steps | flow). */
export interface BoardStep {
  id?: string;
  label: string;
  detail?: string;
}

export interface BoardBlock {
  id: string;
  kind: BoardBlockKind;
  title?: string;
  /** markdown / mermaid source / callout text */
  body?: string;
  chart?: BoardChartSpec;
  /** Fluxo passo a passo (steps/flow). */
  steps?: BoardStep[];
  tone?: "info" | "warn" | "ok" | "err";
  order: number;
}

/** Playhead de animação de fluxo controlado pelo agent ou UI. */
export interface BoardPlayhead {
  blockId: string;
  stepIndex: number;
  playing: boolean;
  intervalMs: number;
}

/** Frase falada via TTS na UI (efêmera — uma por revision). */
export interface BoardNarration {
  text: string;
  agentId?: string;
  ts: number;
}

/** Ponto normalizado (0–1) relativo à superfície do quadro. */
export interface BoardPoint {
  x: number;
  y: number;
}

/**
 * Desenho / marcação no quadro (agent ou humano).
 * Coords normalizadas 0–1 na superfície do documento do board.
 */
export type BoardDrawKind = "rect" | "ellipse" | "arrow" | "pen" | "pin" | "text";

/**
 * Marcação no quadro (agent ou humano) — contrato bidirecional.
 * - author=human → azul; author=agent → laranja (UI).
 * - anchor=board → points normalizados 0–1 na superfície do quadro.
 * - anchor=block → UI posiciona sobre o DOM do blockId (agent: aroundBlock).
 */
export interface BoardAnnotation {
  /**
   * Id da anotação do HUMANO que esta marcação responde.
   *
   * Sem isto, um quadro com 3 marcas suas e 3 do agente não diz qual responde
   * qual — a feature nasceu como diálogo bidirecional, mas o par
   * pergunta→resposta não era representado. Preenchido pelo SERVER quando o
   * agente marca dentro da janela aberta pela pergunta; o agente não precisa
   * (nem consegue confiavelmente) informar.
   */
  replyTo?: string;
  id: string;
  kind: BoardDrawKind;
  /** Bloco sob a marcação (se detectado / informado). */
  blockId?: string;
  /**
   * board = free geometry (humano arrasta; agent com points).
   * block = encaixa no bloco (agent aroundBlock / highlight).
   * element = ancorado num elemento DENTRO do HTML do modo `html`, via
   *   `selector`. A geometria é recalculada a cada layout, então a marca
   *   continua exatamente sobre o elemento mesmo se a página reflui.
   */
  anchor?: "board" | "block" | "element";
  /**
   * Seletor CSS do alvo dentro do bloco html (ex.: `#step-2`).
   *
   * É o que dá PRECISÃO no modo html: pixels soltos sobre um iframe
   * envelhecem no primeiro reflow, e o agente não tem como adivinhar
   * coordenadas de uma página que o navegador acabou de diagramar. Ele
   * aponta o id que ele mesmo escreveu; a UI resolve o retângulo.
   */
  selector?: string;
  /** rect/ellipse: [tl, br]; arrow: [from, to]; pen: path; pin/text: [anchor]. */
  points: BoardPoint[];
  color: string;
  /** Rótulo / nota (pin, text, ou legenda humana). */
  label?: string;
  strokeWidth?: number;
  author: "agent" | "human";
  authorId?: string;
  authorName?: string;
  createdAt: number;
}

/** Resumo de um quadro na lista (multi-board). */
export interface BoardSummary {
  id: string;
  title: string;
  blockCount: number;
  annotationCount: number;
  updatedAt: number;
  revision: number;
}

export interface ExplanationBoard {
  /** Id estável do quadro (multi-board por projeto). */
  id: string;
  projectId: string;
  title: string;
  revision: number;
  updatedAt: number;
  updatedByAgentId?: string;
  updatedByAgentName?: string;
  blocks: BoardBlock[];
  /** Desenhos / círculos / setas no quadro (agent + humano). */
  annotations: BoardAnnotation[];
  /** Bloco em foco (scroll + highlight na UI). */
  focusBlockId?: string;
  /** Animação de steps/flow. */
  play?: BoardPlayhead;
  /** Narração TTS desta revision (agent ensina ao vivo). */
  narration?: BoardNarration;
  /** Última operação (UI pode pulsar / abrir aba). */
  lastOp?: "upsert" | "focus" | "play" | "step" | "clear" | "title" | "say" | "remove" | "draw" | "create" | "switch" | "delete" | "restore";
}

export type ScheduleRunStatus = "ok" | "skipped" | "partial";

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  projectId: string;
  ts: number;
  status: ScheduleRunStatus;
  /** agent_stopped | daemon_offline | waking_agent | no_targets | ok */
  reason?: string;
  deliveredTo: string[];
}

export interface ScheduledPrompt {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  targetAgentId?: string;
  scheduleType: "interval" | "daily" | "cron";
  intervalMs?: number;
  dailyTime?: string;
  /** Expressão cron 5 campos (minute hour dom month dow). */
  cronExpr?: string;
  /** IANA timezone para daily/cron. Default = fuso do servidor. */
  timezone?: string;
  /** Se true, tenta startAgent quando o alvo está parado. */
  wakeAgent?: boolean;
  enabled: boolean;
  /** Última tentativa (ok ou skip). */
  lastRunAt?: number;
  /** Última entrega com ≥1 agent. Usado na cadência. */
  lastSuccessAt?: number;
  lastStatus?: ScheduleRunStatus;
  lastSkipReason?: string;
  createdAt?: string;
  /** Últimas execuções (preenchido no snapshot / events). */
  recentRuns?: ScheduleRun[];
}

export interface Goal {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  parentGoalId?: string;
  status: "active" | "achieved" | "archived";
  /** Phase 1 — quando todas missions filhas ficam done, goal auto-achieved.
   *  Default true; user pode desligar pra goals com critério humano. */
  autoCompleteFromMissions?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/* ---------- Missions (workflow engine) ---------- */

export type MissionStatus = "draft" | "running" | "paused" | "done" | "failed" | "cancelled";

export type MissionStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "awaiting_approval"
  | "skipped";

export type MissionStepCompletionMode = "explicit" | "first_response" | "reviewer" | "confirmed";

export interface MissionStep {
  id: string;
  missionId: string;
  idx: number;                    // ordem linear
  deps: string[];                 // Phase 3 — vazio em Phase 1
  title: string;
  prompt: string;                 // mensagem enviada ao agent
  agentId?: string;               // assign direto
  agentRole?: string;             // OU lookup por role no project
  status: MissionStepStatus;
  output?: string;                // captura da última agent_text antes do result
  attempts: number;
  maxAttempts: number;
  timeoutMs?: number;
  requiresHuman: boolean;
  acceptance?: { regex?: string; llmJudge?: string };  // Phase 2
  /**
   * Como o engine decide que step terminou:
   *  - "explicit" (default): aguarda sentinel `<<<STEP_COMPLETE>>>` no
   *    output. Idle sem sentinel marca como "stalled" (não done).
   *  - "first_response": legacy idle 4s vira done com primeira resposta.
   *  - "reviewer": depois do agent confirmar, dispatch pra `reviewerAgentId`
   *    validar. Reviewer responde `<<<REVIEW_APPROVE>>>` ou
   *    `<<<REVIEW_REJECT motivo='...'>>>`.
   */
  completionMode?: MissionStepCompletionMode;
  reviewerAgentId?: string;
  /** Board task vinculada (ex.: plano materializado como mission). */
  taskId?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface Mission {
  id: string;
  projectId: string;
  goalId?: string;
  title: string;
  description?: string;
  status: MissionStatus;
  /** Steps inline pra reduzir round-trips. Ordenado por idx. */
  steps: MissionStep[];
  progressPct: number;            // 0..100, derivado de steps done/total
  tokensInput: number;
  tokensOutput: number;
  createdBy?: string;
  createdAt?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type PlanStatus = "draft" | "running" | "paused" | "done" | "failed" | "cancelled";

export type PlanTaskStatus =
  | "pending"
  | "running"
  | "awaiting_validation"
  | "done"
  | "failed"
  | "skipped";

/**
 * Membership de um Plan: aponta para uma **board Task** (fonte de verdade).
 * title/prompt/executor vêm da task; validator/acceptance são overlay do plano.
 */
export interface PlanTask {
  id: string;
  planId: string;
  /** FK obrigatória para tasks do board. */
  taskId: string;
  idx: number;
  /** Snapshot / join da board task. */
  title: string;
  prompt: string;
  executorAgentId?: string;
  executorRole?: string;
  taskNumber?: number;
  boardStatus?: TaskStatus;
  /** Override; se omitido, herda plan.defaultValidator. */
  validator?: PlanValidator;
  status: PlanTaskStatus;
  output?: string;
  acceptance?: string;
  validationNote?: string;
  attempts: number;
  maxAttempts: number;
  timeoutMs?: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface Plan {
  id: string;
  projectId: string;
  goalId?: string;
  title: string;
  description?: string;
  status: PlanStatus;
  /** Agente que gerou o plano — base do mode "creator". */
  plannerAgentId?: string;
  defaultValidator: PlanValidator;
  /** Mission materializada no start (runtime reusa MissionEngine). */
  linkedMissionId?: string;
  /** Itens = board tasks ordenadas (membership). */
  tasks: PlanTask[];
  progressPct: number;
  tokensInput: number;
  tokensOutput: number;
  createdBy?: string;
  createdAt?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface DaemonInfo {
  name: string;
  os: string;
  hostname: string;
  version: string;
  binaryHash?: string;
  updateAvailable?: boolean;
  /** Versão do protocolo de fio declarada no hello (ausente = daemon antigo). */
  protocolVersion?: number;
  lastSeen?: number;
  connectedAt?: number;
  /** graphify CLI (build) disponível no daemon. */
  graphifyCli?: boolean;
  /** graphify-mcp (serve) disponível no daemon. */
  graphifyMcp?: boolean;
  /** CLIs de agente instalados no daemon (p/ UI do + docs). */
  availableRunners?: Array<"claude" | "codex" | "opencode" | "gemini" | "crush" | "grok">;
}

export interface DaemonStatus {
  userId: string;
  online: boolean;
  /** Canal caiu recentemente, mas os processos locais ainda são considerados
   *  vivos durante a janela de reconexão. */
  reconnecting?: boolean;
  daemons: DaemonInfo[];
}

/** Saúde do daemon, medida pelo próprio daemon a cada heartbeat. */
export interface DaemonHealth {
  ts: number;
  uptimeS: number;
  memRssMb: number;
  /** RTT do ping WS daemon↔orchestrator (ms); null antes da 1ª medição. */
  wsRttMs: number | null;
  turnGate: { active: number; queued: number; max: number };
  turns: { started: number; ok: number; failed: number; hardRecovers: number; hangs: number };
  turnP50Ms: number | null;
  turnP95Ms: number | null;
  byRunner: Record<string, { started: number; ok: number; failed: number; hardRecovers: number; hangs: number }>;
  agentsRunning: number;
  e2eeProjects: number;
}

export interface DaemonLogLine {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

export interface DaemonTokenPublic {
  id: string;
  label?: string;
  lastSeen?: number;
  createdAt?: string;
  revokedAt?: number;
}

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
  runner: CliRunner;
  models: DiscoveredRunnerModel[];
  source: "codex-app-server" | "cli-command" | "unsupported";
  fetchedAt: number;
  error?: string;
}

export type ServerEvent =
  | { type: "prefs_updated"; prefs: Record<string, unknown> }
  | { type: "auth"; user: UserPublic | null }
  | { type: "daemon:status"; status: DaemonStatus }
  | {
      type: "daemon:health"; daemonName: string; health: DaemonHealth;
      /** Identidade e compatibilidade das duas pontas, avaliada pelo server. */
      versions?: {
        daemonVersion: string;
        daemonBinaryHash?: string;
        daemonProtocol?: number;
        serverBuild: string;
        serverProtocol: number;
        /** daemonProtocol === serverProtocol; null quando o daemon não declara. */
        compatible: boolean | null;
        /** Binário rodando ≠ release publicado — atualização disponível. */
        updateAvailable?: boolean;
      };
    }
  | { type: "daemon:logs"; daemonName: string; lines: DaemonLogLine[] }
  | { type: "daemon:statuses"; list: DaemonStatus[] }
  | { type: "daemon:verified"; userId: string }
  | { type: "model_catalogs"; catalogs: RunnerModelCatalog[]; error?: string }
  | { type: "projects"; list: Project[] }
  | { type: "project:created"; project: Project }
  | { type: "project:updated"; project: Project }
  | { type: "project:deleted"; id: string }
  | {
      type: "snapshot";
      project: Project;
      role: ProjectMemberRole;
      members: ProjectMember[];
      workspace: UserWorkspace | null;
      agents: AgentInfo[];
      log: MessageEntry[];
      tasks: Task[];
      goals: Goal[];
      memories: MemoryEntry[];
      credentials: CredentialPublic[];
      schedules: ScheduledPrompt[];
      explanationBoard?: ExplanationBoard;
      /** Lista de quadros do projeto (multi-board). */
      explanationBoards?: BoardSummary[];
      activeBoardId?: string;
      gitlab: GitLabIntegrationPublic;
      autoApprove: boolean;
      comments: TaskComment[];
      toolExecutions: ToolExecutionEvent[];
    }
  | { type: "members"; list: ProjectMember[] }
  | { type: "workspace"; workspace: UserWorkspace | null }
  | { type: "users"; list: UserPublic[] }
  | { type: "admin:users"; list: UserAdminView[] }
  | { type: "admin:user_updated"; user: UserAdminView }
  | { type: "admin:error"; message: string }
  | { type: "admin:audit"; list: AuditLogEntry[] }
  | { type: "admin:system_stats"; stats: AdminSystemStats }
  | { type: "templates"; list: AgentTemplate[] }
  | { type: "template:added"; template: AgentTemplate }
  | { type: "template:updated"; template: AgentTemplate }
  | { type: "template:removed"; id: string }
  | { type: "agent:added"; agent: AgentInfo }
  | { type: "agent:updated"; agent: AgentInfo }
  | { type: "agent:removed"; id: string }
  | { type: "agent:state"; id: string; state: AgentRuntimeState }
  | { type: "agent:running"; id: string; running: boolean }
  | { type: "agent:thinking"; id: string; text: string; redacted?: boolean; ts: number }
  | { type: "agent:session"; id: string; sessionId: string }
  | { type: "agent:usage"; id: string; usage: AgentUsage }
  | { type: "agent:context"; id: string; used: number; limit: number }
  | { type: "message"; msg: MessageEntry }
  | { type: "task:added"; task: Task }
  | { type: "task:updated"; task: Task }
  | { type: "task:removed"; id: string }
  | { type: "task:comment:added"; comment: TaskComment }
  | { type: "memory:added"; memory: MemoryEntry }
  | { type: "memory:updated"; memory: MemoryEntry }
  | { type: "memory:removed"; id: string }
  | { type: "credential:added"; credential: CredentialPublic }
  | { type: "credential:updated"; credential: CredentialPublic }
  | { type: "credential:removed"; id: string }
  | { type: "credential:revealed"; id: string; value: string }
  | { type: "permission:request"; req: PermissionRequest }
  | { type: "permission:resolved"; requestId: string; allow: boolean }
  | { type: "config"; autoApprove: boolean; loopProtection: "reactive" | "preventive"; loopLimitEnabled?: boolean; loopLimit?: number; loopPairLimit?: number; loopPairWindowMs?: number; memoryEnabled?: boolean; memoryMaxPinned?: number; tasksEnabled?: boolean; teammatesEnabled?: boolean; goalsEnabled?: boolean; credentialsEnabled?: boolean; webhooksEnabled?: boolean; graphEnabled?: boolean; boardEnabled?: boolean; diagramLanguage?: DiagramLanguage; boardMode?: BoardMode; boardHtmlLevel?: BoardHtmlLevel; boardWidth?: BoardWidth; autoRetryEnabled?: boolean; autoRetrySeconds?: number }
  | { type: "graph:status"; status: "idle" | "building" | "ready" | "error"; nodeCount?: number; edgeCount?: number; error?: string; inputTokens?: number; outputTokens?: number; lastIndexedAt?: number; progress?: number; phase?: string; indexMtime?: number; stale?: boolean; graphifyAvailable?: boolean; graphifyMcpAvailable?: boolean; docsPending?: boolean; hasSemantic?: boolean }
  | { type: "graph:data"; json?: string; error?: string }
  | { type: "usage_breakdown"; byUser: { userId: string; input: number; output: number }[]; byModel: { model: string; input: number; output: number }[]; from?: string; to?: string }
  | { type: "pong" }
  | { type: "schedule:added"; schedule: ScheduledPrompt }
  | { type: "schedule:updated"; schedule: ScheduledPrompt }
  | { type: "schedule:removed"; id: string }
  | {
      type: "schedule:fired";
      id: string;
      ts: number;
      status: ScheduleRunStatus;
      reason?: string;
      deliveredTo: string[];
      /** Título do schedule (webhook/UI sem lookup). */
      title?: string;
      scheduleType?: "interval" | "daily" | "cron";
    }
  | { type: "schedule:run"; run: ScheduleRun }
  | { type: "schedule:runs"; runs: ScheduleRun[]; scheduleId?: string }
  | {
      type: "board:updated";
      board: ExplanationBoard;
      boards?: BoardSummary[];
      activeBoardId?: string;
    }
  | { type: "gitlab:updated"; integration: GitLabIntegrationPublic }
  | { type: "messages:cleared" }
  /** AgentSkills v2 — set scaneado pelo daemon do owner do projeto. */
  | { type: "workspace_skills"; list: SkillDefinition[] }
  /** MCP servers — Phase 1 read-only. Daemon scaneia 7 fontes. */
  | { type: "workspace_mcps"; list: MCPDefinition[] }
  | { type: "mcp_save_result"; correlationId?: string; ok: boolean; error?: string }
  | { type: "mcp_delete_result"; correlationId?: string; ok: boolean; error?: string }
  | { type: "skill_file_result"; correlationId: string; ok: boolean; content?: string; error?: string }
  | { type: "skill_save_result"; correlationId: string; ok: boolean; error?: string }
  | { type: "skill_delete_result"; correlationId: string; ok: boolean; error?: string }
  | { type: "goals"; list: Goal[] }
  | { type: "goal:added"; goal: Goal }
  | { type: "goal:updated"; goal: Goal }
  | { type: "goal:removed"; id: string }
  | { type: "goal:auto-achieved"; goalId: string; viaMissions: string[]; viaTasks?: string[]; viaPlans?: string[] }
  | { type: "project:updated"; project: Project }
  | { type: "missions"; list: Mission[] }
  | { type: "mission:created"; mission: Mission }
  | { type: "mission:updated"; mission: Mission }
  | { type: "mission:removed"; id: string }
  | { type: "mission:step_started"; missionId: string; stepId: string; agentId?: string; completionMode?: MissionStepCompletionMode }
  | { type: "mission:step_finished"; missionId: string; stepId: string; status: string }
  | { type: "mission:awaiting_approval"; missionId: string; stepId: string }
  | { type: "mission:progress"; missionId: string; pct: number }
  | { type: "plans"; list: Plan[] }
  | { type: "plan:created"; plan: Plan }
  | { type: "plan:updated"; plan: Plan }
  | { type: "plan:removed"; id: string }
  | { type: "plan:task_started"; planId: string; taskId: string; executorAgentId?: string; role?: "executor" | "validator" }
  | { type: "plan:task_finished"; planId: string; taskId: string; status: PlanTaskStatus }
  | { type: "plan:awaiting_validation"; planId: string; taskId: string; mode: PlanValidatorMode }
  | { type: "plan:progress"; planId: string; pct: number }
  | { type: "agent:tool_use"; event: ToolExecutionEvent }
  | { type: "info"; message: string }
  | { type: "error"; message: string }
  | { type: "file_list"; path: string; entries: FileEntry[]; error?: string }
  | { type: "file_content"; path: string; content?: string; encoding?: "utf8" | "base64"; mimeType?: string; error?: string }
  | { type: "file_write_result"; path: string; ok: boolean; error?: string }
  | { type: "file_operation_result"; op: "create_file" | "create_directory" | "rename" | "delete"; path: string; newPath?: string; ok: boolean; error?: string }
  | { type: "file_search_result"; query: string; entries: FileEntry[]; error?: string }
  | { type: "git_log"; commits: GitCommit[]; error?: string }
  | { type: "git_status"; files: GitFileStatus[]; branch?: string; error?: string }
  | { type: "git_diff"; path: string; diff?: string; error?: string }
  | { type: "git_result"; op: string; ok: boolean; message?: string; output?: string; error?: string;
      commits?: GitCommit[]; diff?: string; files?: GitFileStatus[];
      branches?: { name: string; current: boolean }[];
      stashes?: { index: number; message: string; branch: string }[]; }
  | { type: "file_locks"; locks: FileLock[] }
  | { type: "file_lock:updated"; lock: FileLock }
  | { type: "file_lock:released"; id: string }
  | { type: "summarize_result"; correlationId: string; ok: boolean; summary?: string; error?: string; usage?: { input: number; output: number } }
  | { type: "crypto:setup"; publicKey: string | null; wrappedPrivateKey: string | null; wrappedPrivateKeyRecovery: string | null; kekSalt: string | null; encryptionSetupAt: string | null }
  | { type: "crypto:recovery_hash"; recoveryCodeHash: string | null }
  | { type: "crypto:initialized" }
  | { type: "crypto:rotated" }
  | { type: "crypto:reset_done" }
  | { type: "crypto:error"; message: string }
  | {
      type: "project_keys:current"; projectId: string; wrappedProjectKey: string | null;
      /**
       * Cadeia de chaves antigas, da mais antiga pra mais nova. Cada entrada é
       * a chave AES ANTERIOR cifrada (AES-GCM, formato "e2e:") com a chave que
       * a substituiu — o server nunca vê plaintext de chave nenhuma. O cliente
       * decifra de trás pra frente a partir da ativa e usa as antigas como
       * fallback de leitura: sem isso, rotacionar a chave tornava TODO o
       * histórico ilegível pra sempre.
       */
      keyRing?: string[];
    }
  | { type: "project_keys:rotated"; projectId: string }
  | { type: "totp:status"; enabled: boolean; setupAt: string | null; hasRecoveryCodes: boolean; recoveryCodesRemaining: number }
  | { type: "totp:setup_pending"; secret: string; provisioningUri: string }
  | { type: "totp:setup_done"; recoveryCodes: string[] }
  | { type: "totp:disabled" }
  | { type: "totp:error"; message: string }
  | { type: "project_keys:pending"; projectId: string; pending: { userId: string; publicKey: string | null }[] }
  | { type: "user_public_key"; userId: string; publicKey: string | null }
  | { type: "daemon_public_key"; publicKey: string | null }
  | { type: "tts_summaries"; list: TtsSummaryEntry[] }
  | { type: "tts_summary:added"; entry: TtsSummaryEntry }
  | { type: "tts_summaries:cleared" }
  | { type: "runs:cleared" };

export interface TtsSummaryEntry {
  id: string;
  agentId?: string;
  agentName?: string;
  agentColor?: string;
  original: string;
  summary?: string;
  state: "ok" | "err" | "fallback";
  error?: string;
  createdAt: string;
}

export type ClientCommand =
  | { type: "list_projects" }
  | { type: "create_project"; project: { name: string } }
  | { type: "duplicate_project"; id: string; name?: string; wrappedProjectKey?: string }
  | { type: "update_project"; project: Pick<Project, "id" | "name"> & {
      baseRepoName?: string | null;
      baseRepoUrl?: string | null;
      baseRepoBranch?: string | null;
      loopProtection?: "reactive" | "preventive";
      loopLimit?: number;
      loopPairLimit?: number;
      loopPairWindowMs?: number;
      fileLocking?: boolean;
      agentWorktrees?: boolean;
      /** Linguagem de diagrama do quadro (mermaid | d2). */
      diagramLanguage?: DiagramLanguage;
      /** Modo do quadro: blocos (markdown+diagrama) ou HTML rico. */
      boardMode?: BoardMode;
      /** Requinte da página HTML (basic | normal | quality). */
      boardHtmlLevel?: BoardHtmlLevel;
      /** Largura útil do quadro (small | medium | large). */
      boardWidth?: BoardWidth;
      /** A UI já mandava isto e o server já persistia (`collect_thinking`),
       *  mas só o tipo do web declarava. */
      collectThinking?: boolean;
    } }
  | { type: "delete_project"; id: string }
  | { type: "select_project"; id: string }
  | { type: "leave_project" }
  | { type: "list_users" }
  | { type: "admin:list_users" }
  | { type: "admin:set_super_admin"; userId: string; value: boolean }
  | { type: "admin:set_can_create_projects"; userId: string; value: boolean }
  | { type: "admin:set_disabled"; userId: string; value: boolean }
  | { type: "admin:add_user_to_project"; userId: string; projectId: string; role: "admin" | "member" }
  | { type: "admin:remove_user_from_project"; userId: string; projectId: string }
  | { type: "admin:set_project_role"; userId: string; projectId: string; role: "admin" | "member" }
  | { type: "admin:list_audit"; actorUserId?: string; action?: string; limit?: number }
  | { type: "admin:get_system_stats" }
  | { type: "list_templates" }
  | { type: "save_template"; template: Omit<AgentTemplate, "id" | "createdBy" | "createdAt"> }
  | { type: "update_template"; id: string; patch: Partial<Omit<AgentTemplate, "id" | "createdBy" | "createdAt">> }
  | { type: "delete_template"; id: string }
  // members (admin only)
  | { type: "add_member"; email: string; role: ProjectMemberRole }
  | { type: "update_member"; userId: string; role: ProjectMemberRole }
  | { type: "remove_member"; userId: string }
  // workspace (per user)
  | { type: "set_workspace"; basePath: string }
  // agents
  | { type: "save_agent"; spec: AgentSpec }
  | { type: "spawn"; spec: AgentSpec }
  | { type: "start_agent"; id: string }
  | { type: "stop_agent"; id: string }
  | { type: "remove_agent"; id: string }
  | { type: "transfer_agent_owner"; id: string; newOwnerUserId: string }
  | { type: "assign_agent_repo"; id: string; repo: AgentRepo | null }
  | { type: "user_to_agent"; id: string; content: string; images?: ImageAttachment[] }
  | { type: "broadcast"; content: string; images?: ImageAttachment[] }
  | { type: "set_auto_approve"; value: boolean }
  | { type: "set_loop_protection"; value: "reactive" | "preventive"; limitEnabled?: boolean; limit?: number; pairLimit?: number; pairWindowMs?: number }
  | { type: "set_auto_retry"; enabled: boolean; seconds: number }
  | { type: "permission:respond"; requestId: string; allow: boolean }
  | { type: "add_task"; task: { title: string; description?: string; assigneeAgentId?: string; status?: TaskStatus; blockedByTaskId?: string | null; goalId?: string | null } }
  | { type: "update_task"; id: string; patch: { title?: string; description?: string; status?: TaskStatus; assigneeAgentId?: string | null; blockedByTaskId?: string | null; labels?: string[]; goalId?: string | null } }
  | { type: "remove_task"; id: string }
  | { type: "lock_task"; id: string }
  | { type: "unlock_task"; id: string }
  | { type: "add_task_comment"; taskId: string; authorName: string; content: string }
  | { type: "add_memory"; memory: { titleCipher: string; bodyCipher: string; type?: MemoryType; scope?: MemoryScope; agentId?: string | null; tags?: string[]; pinned?: boolean; confidence?: number | null; contentHash?: string; supersedesId?: string | null; goalId?: string | null; taskId?: string | null; planId?: string | null; expiresAt?: string | null } }
  | { type: "update_memory"; id: string; patch: { titleCipher?: string; bodyCipher?: string; type?: MemoryType; scope?: MemoryScope; agentId?: string | null; tags?: string[]; pinned?: boolean; confidence?: number | null; supersedesId?: string | null; goalId?: string | null; taskId?: string | null; planId?: string | null; archivedAt?: string | null; expiresAt?: string | null } }
  | { type: "remove_memory"; id: string }
  | { type: "clear_memories" }
  | { type: "bulk_memories"; ids: string[]; action: "pin" | "unpin" | "archive" | "unarchive" | "delete" | "set_scope_project" | "set_scope_agent"; agentId?: string | null }
  | { type: "memory_hygiene"; mode?: "unpin_non_sticky" | "enforce_quota" }
  | { type: "set_memory_enabled"; value: boolean }
  | { type: "set_memory_max_pinned"; value: number }
  | { type: "set_context_feature"; feature: "tasks" | "teammates" | "goals" | "credentials" | "webhooks" | "graph" | "board"; value: boolean }
  | { type: "graph:reindex"; semantic?: boolean; backend?: string; model?: string }
  | { type: "graph:get" }
  | { type: "get_usage"; from?: string; to?: string }
  | { type: "ping" }
  | { type: "gitlab_save_config"; config: { baseUrl: string; projectRef: string; token?: string; defaultBranch?: string; webhookSecret?: string } }
  | { type: "gitlab_test" }
  | { type: "gitlab_import_issues"; state?: "opened" | "closed" | "all"; labels?: string }
  | { type: "gitlab_export_task"; taskId: string; labels?: string }
  | { type: "gitlab_export_all_tasks"; labels?: string; deleteMissing?: boolean }
  | { type: "gitlab_create_webhook"; publicUrl: string }
  | { type: "gitlab_create_branch"; branch: string; ref?: string }
  | { type: "gitlab_create_mr"; title: string; sourceBranch: string; targetBranch?: string; description?: string; taskId?: string }
  | { type: "gitlab_comment_issue"; issueIid: number; body: string }
  | { type: "gitlab_comment_mr"; mergeRequestIid: number; body: string }
  | { type: "add_credential"; credential: { name: string; value?: string; note?: string; expiresAt?: string | null; agentAccess?: boolean } }
  | { type: "remove_credential"; id: string }
  | { type: "reveal_credential"; id: string }
  | { type: "grant_credential"; credentialId: string; userId: string }
  | { type: "revoke_credential"; credentialId: string; userId: string }
  | { type: "clear_context"; id: string }
  | { type: "compact_context"; id: string; saveMemory?: boolean }
  | { type: "inject_chat_history"; id: string; count: number; instructions?: string; includeTasks?: boolean; taskIds?: string[] }
  | { type: "add_schedule"; schedule: { title: string; prompt: string; targetAgentId?: string; scheduleType: "interval" | "daily" | "cron"; intervalMs?: number; dailyTime?: string; cronExpr?: string; timezone?: string; wakeAgent?: boolean } }
  | { type: "update_schedule"; id: string; patch: { title?: string; prompt?: string; targetAgentId?: string | null; enabled?: boolean; intervalMs?: number; dailyTime?: string; cronExpr?: string; timezone?: string; wakeAgent?: boolean; scheduleType?: "interval" | "daily" | "cron" } }
  | { type: "remove_schedule"; id: string }
  | { type: "fire_schedule"; id: string }
  | { type: "list_schedule_runs"; scheduleId?: string; limit?: number }
  | { type: "board_clear" }
  | { type: "board_set_title"; title: string }
  | { type: "board_create"; title?: string }
  | { type: "board_switch"; id: string }
  | { type: "board_delete"; id: string }
  | { type: "board_restore"; id: string }
  | { type: "board_remove_block"; id: string }
  | { type: "board_focus"; blockId: string }
  | { type: "board_set_step"; blockId: string; stepIndex: number; playing?: boolean }
  | { type: "board_play"; blockId: string; intervalMs?: number; from?: number }
  | { type: "board_pause" }
  | {
      type: "board_draw";
      annotation: {
        id?: string;
        kind: "rect" | "ellipse" | "arrow" | "pen" | "pin" | "text";
        blockId?: string;
        /** Elemento alvo dentro do bloco html (ver BoardAnnotation.selector). */
        selector?: string;
        points: { x: number; y: number }[];
        aroundBlock?: boolean;
        color?: string;
        label?: string;
        strokeWidth?: number;
      };
      /** Se true, também envia a marcação ao agent alvo (explicar). */
      askAgentId?: string;
      askPrompt?: string;
    }
  | { type: "board_remove_annotation"; id: string }
  | { type: "board_clear_drawings" }
  | { type: "clear_messages" }
  | { type: "request_skills_scan" }
  | { type: "request_mcps_scan" }
  | { type: "request_model_catalogs"; runner?: CliRunner; force?: boolean }
  | {
      type: "mcp:save";
      correlationId?: string;
      name: string;
      transport?: "stdio" | "sse" | "http";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      description?: string;
    }
  | { type: "mcp:delete"; correlationId?: string; name: string }
  | { type: "skill:read_file"; correlationId: string; skillName: string; relPath?: string }
  | { type: "skill:save_file"; correlationId: string; skillName: string; relPath?: string; content: string }
  | { type: "skill:delete"; correlationId: string; skillName: string }
  | { type: "list_goals" }
  | { type: "add_goal"; goal: { title: string; description?: string; parentGoalId?: string } }
  | { type: "update_goal"; id: string; patch: { title?: string; description?: string; status?: "active" | "achieved" | "archived"; parentGoalId?: string | null } }
  | { type: "remove_goal"; id: string }
  | { type: "update_goal_auto_complete"; id: string; value: boolean }
  | { type: "list_missions" }
  | {
      type: "create_mission";
      mission: {
        title: string;
        description?: string;
        goalId?: string;
        steps?: Array<{ title: string; prompt: string; agentId?: string; agentRole?: string; requiresHuman?: boolean; maxAttempts?: number; timeoutMs?: number }>;
      };
    }
  | { type: "update_mission"; id: string; patch: { title?: string; description?: string; goalId?: string | null } }
  | { type: "start_mission"; id: string }
  | { type: "cancel_mission"; id: string }
  | { type: "reset_mission"; id: string }
  | { type: "duplicate_mission"; id: string }
  | { type: "remove_mission"; id: string }
  | { type: "approve_step"; stepId: string; approve: boolean; comment?: string }
  | { type: "force_complete_step"; stepId: string; output: string }
  | { type: "report_step_sentinel"; stepId: string; kind: "complete" | "failed" | "review_approve" | "review_reject"; output?: string; reason?: string }
  | { type: "generate_plan"; missionId: string }
  | {
      type: "apply_plan_steps";
      missionId: string;
      mode: "append" | "replace";
      steps: Array<{ title: string; prompt: string; agentId?: string; agentRole?: string; requiresHuman?: boolean; completionMode?: MissionStepCompletionMode; reviewerAgentId?: string }>;
    }
  | { type: "set_project_planner"; agentId: string | null }
  | { type: "add_mission_step"; missionId: string; step: { title: string; prompt: string; agentId?: string; agentRole?: string; requiresHuman?: boolean; maxAttempts?: number; timeoutMs?: number } }
  | { type: "update_mission_step"; stepId: string; patch: { title?: string; prompt?: string; agentId?: string | null; agentRole?: string | null; requiresHuman?: boolean; maxAttempts?: number; timeoutMs?: number | null } }
  | { type: "remove_mission_step"; stepId: string }
  | { type: "reorder_mission_steps"; missionId: string; stepIds: string[] }
  /* Planners (feature nova — docs/PLANNERS-SPEC.md) */
  | { type: "list_plans" }
  | {
      type: "create_plan";
      plan: {
        title: string;
        description?: string;
        goalId?: string;
        plannerAgentId?: string;
        defaultValidator?: PlanValidator;
        taskIds?: string[];
        tasks?: Array<{
          taskId?: string;
          title?: string;
          prompt?: string;
          executorAgentId?: string;
          executorRole?: string;
          validator?: PlanValidator;
          acceptance?: string;
          maxAttempts?: number;
          timeoutMs?: number;
        }>;
      };
    }
  | {
      type: "update_plan";
      id: string;
      patch: {
        title?: string;
        description?: string;
        goalId?: string | null;
        plannerAgentId?: string | null;
        defaultValidator?: PlanValidator;
      };
    }
  | { type: "remove_plan"; id: string; deleteBoardTasks?: boolean; deleteLinkedMission?: boolean }
  | {
      type: "add_plan_task";
      planId: string;
      task: {
        taskId?: string;
        title?: string;
        prompt?: string;
        executorAgentId?: string;
        executorRole?: string;
        validator?: PlanValidator;
        acceptance?: string;
        maxAttempts?: number;
        timeoutMs?: number;
      };
    }
  | {
      type: "update_plan_task";
      taskId: string;
      patch: {
        title?: string;
        prompt?: string;
        executorAgentId?: string | null;
        executorRole?: string | null;
        validator?: PlanValidator | null;
        acceptance?: string | null;
        maxAttempts?: number;
        timeoutMs?: number | null;
      };
    }
  | { type: "remove_plan_task"; taskId: string }
  | { type: "reorder_plan_tasks"; planId: string; taskIds: string[] }
  | {
      type: "apply_plan_tasks";
      planId: string;
      mode: "append" | "replace";
      tasks: Array<{
        taskId?: string;
        title?: string;
        prompt?: string;
        executorAgentId?: string;
        executorRole?: string;
        validator?: PlanValidator;
        acceptance?: string;
      }>;
    }
  | { type: "start_plan"; id: string }
  | { type: "pause_plan"; id: string }
  | { type: "cancel_plan"; id: string }
  | { type: "reset_plan"; id: string }
  | {
      type: "validate_plan_task";
      taskId: string;
      approve: boolean;
      note?: string;
    }
  | {
      type: "report_plan_task_sentinel";
      taskId: string;
      kind: "complete" | "failed" | "validate_approve" | "validate_reject";
      output?: string;
      reason?: string;
    }
  | {
      type: "set_project_plan_defaults";
      plannerAgentId?: string | null;
      defaultValidator?: PlanValidator | null;
    }
  | { type: "list_files"; path: string }
  | { type: "read_file"; path: string }
  | { type: "write_file"; path: string; content: string }
  | { type: "file_operation"; op: "create_file" | "create_directory" | "rename" | "delete"; path: string; newPath?: string }
  | { type: "search_files"; query: string }
  | { type: "summarize"; correlationId: string; runner: "claude" | "codex" | "opencode" | "gemini" | "crush" | "grok"; model?: string; effort?: string; systemPrompt?: string; text: string; dedupKey?: string; claudeConfigDir?: string; agentId?: string; probe?: boolean }
  | { type: "crypto:get_setup" }
  | { type: "crypto:init"; publicKey: string; wrappedPrivateKey: string; wrappedPrivateKeyRecovery: string; kekSalt: string; recoveryCodeHash: string }
  | { type: "crypto:rotate_passphrase"; wrappedPrivateKey: string; kekSalt: string }
  | { type: "crypto:get_recovery_hash" }
  | { type: "crypto:reset_with_recovery"; wrappedPrivateKey: string; wrappedPrivateKeyRecovery: string; kekSalt: string; recoveryCodeHash: string; oldRecoveryCodeHash?: string }
  /** Só em dev (THE_DUDES_DEV_LOGIN=1 + user dev@local.test). Limpa identidade E2EE. */
  | { type: "crypto:dev_reset" }
  | {
      type: "project_keys:rotate"; projectId: string; wraps: Array<{ userId: string; wrappedProjectKey: string }>;
      /** Chave ATUAL cifrada com a NOVA (vira entrada do key ring — ver project_keys:current). */
      ringEntry?: string;
    }
  | { type: "totp:status" }
  | { type: "totp:setup_init" }
  | { type: "totp:setup_confirm"; code: string }
  | { type: "totp:disable"; code: string }
  | { type: "project_keys:get"; projectId: string }
  | { type: "daemon:logs:get"; daemonName?: string; limit?: number }
  | { type: "project_keys:set_for_member"; projectId: string; userId: string; wrappedProjectKey: string }
  | { type: "project_keys:list_pending"; projectId: string }
  | { type: "user_public_key:get"; userId: string }
  | { type: "create_project_with_key"; project: { name: string }; wrappedProjectKey: string }
  | { type: "project_keys:enable_e2ee"; projectId: string; wrappedProjectKey: string }
  | { type: "daemon_public_key:get" }
  | { type: "project_key:send_to_daemon"; projectId: string; wrappedProjectKey: string }
  | { type: "list_tts_summaries" }
  | { type: "save_tts_summary"; entry: { id: string; agentId?: string; agentName?: string; agentColor?: string; original: string; summary?: string; state: "ok" | "err" | "fallback"; error?: string } }
  | { type: "clear_tts_summaries" }
  | { type: "clear_runs" }
  | { type: "git_log"; count?: number }
  | { type: "git_status" }
  | { type: "git_diff"; path: string }
  | { type: "git_stage"; path: string }
  | { type: "git_unstage"; path: string }
  | { type: "git_commit"; message: string; paths?: string[] }
  | { type: "git_push" }
  | { type: "git_pull" }
  | { type: "git_branches" }
  | { type: "git_switch_branch"; branch: string }
  | { type: "git_create_branch"; branch: string }
  | { type: "git_show"; hash: string }
  | { type: "git_file_log"; path: string; count?: number }
  | { type: "git_graph" }
  | { type: "git_blame"; path: string }
  | { type: "git_stash_list" }
  | { type: "git_stash"; message?: string }
  | { type: "git_stash_pop" }
  | { type: "list_file_locks" }
  | { type: "lock_file"; path: string }
  | { type: "unlock_file"; path: string };
