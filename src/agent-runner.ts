import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import { writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentInfo, AgentRuntimeState, AgentUsage, CliRunner, ImageAttachment } from "./types.js";
import type { ContextFeatures } from "./protocol.js";
import { spawnDropped, type DropTarget } from "./privileges.js";
import type { ResolvedCliCommands } from "./cli-config.js";
import { resolvePython3 } from "./cli-config.js";
import { buildGraph, graphExists, graphPath } from "./graph-indexer.js";

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Claude. opusplan = Opus no plan, Sonnet na execução; janela efetiva 200k.
  opus: 200_000, opusplan: 200_000, sonnet: 200_000, haiku: 200_000,
  // Fable 5 — Claude Code serve a variante [1m] (claude-fable-5[1m]) por padrão.
  fable: 1_000_000, "claude-fable-5": 1_000_000,
  // Gemini
  "gemini-3-flash-preview": 1_000_000,
  "gemini-3.1-flash-lite-preview": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.5-flash-lite": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  // OpenAI / Codex. GPT-5.5 has 1M in the API, but Codex currently exposes
  // a 400K window, so keep the runner threshold aligned with Codex.
  "gpt-5.5": 400_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.2": 400_000,
  "gpt-5-codex": 400_000,
  "gpt-5": 400_000,
  "o4-mini": 200_000, "o3": 200_000,
  "gpt-4.1": 1_000_000,
  // OpenCode / ZAI
  "zai-coding-plan/glm-4.7": 128_000,
  "zai-coding-plan/glm-4.5-air": 128_000,
  "zai-coding-plan/glm-5-turbo": 128_000,
  "zai-coding-plan/glm-5.1": 128_000,
  // OpenCode / DeepSeek
  "deepseek/deepseek-v4-pro": 200_000,
  "deepseek/deepseek-v4-flash": 200_000,
};

const CONTEXT_WARN_PCT = 0.85;
const OPENCODE_NO_OUTPUT_TIMEOUT_MS = 120_000;
/** Timeout do turno opencode via API do serve (POST /message é síncrono e pode
 *  rodar tools por minutos). Generoso; o serve é morto no stop() se preciso. */
const OPENCODE_TURN_TIMEOUT_MS = 600_000;

const CONTEXT_FULL_PATTERNS = [
  /context.{0,20}(length|window|limit).{0,20}exceed/i,
  /maximum.{0,20}(context|token)/i,
  /too many tokens/i,
  /prompt is too long/i,
  /reduce.{0,20}(message|token|context)/i,
];

const MISSING_SESSION_PATTERNS = [
  /no conversation found with session id/i,
];

// Banner de rate-limit do provider que o claude CLI emite como TEXTO do assistant
// (não como erro). Sem isto o server trata como output real, cifra (E2EE), e o
// auto-retry nunca dispara — pior, zera o contador. Roteamos como erro.
// Ex: "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
const RATE_LIMIT_TEXT_RE = /temporarily limiting requests|·\s*rate limited|\brate.?limited\b|overloaded|too many requests|\b429\b|\b529\b/i;

const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
  "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
};
function mimeToExt(mime: string): string {
  return MIME_EXT[mime?.toLowerCase()] ?? "bin";
}

export interface AgentRunnerOptions {
  bridgeCommand: string;
  bridgeArgs: string[];
  orchestratorUrl: string;
  agentToken: string;
  cliRunner: CliRunner;
  autoApprove: boolean;
  workspaceRoot: string;
  resumeSessionId?: string;
  /**
   * If set, child processes (CLI runners + MCP bridge) will be spawned
   * with this uid/gid/env so the daemon can run as root (e.g. to bypass
   * outbound firewall apps) while agents and their files stay owned by
   * the original user.
   */
  dropTo?: DropTarget | null;
  /**
   * If set, the MCP bridge reaches the orchestrator through this
   * Unix-socket relay instead of fetching directly.
   */
  bridgeSocketPath?: string | null;
  /**
   * Servers MCP extras pra fundir no mcp.json gerado pra esse agente.
   * Vêm filtrados pelo allowlist do agente no servidor. A chave
   * "the-dudes" (bridge interno) é reservada e sobrescreve qualquer
   * conflito.
   */
  extraMcpServers?: Record<string, {
    type?: "stdio" | "sse" | "http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>;
  /** Blocos de contexto ligados (gateiam header + tools). Ausente = tudo on. */
  features?: ContextFeatures;
  cliCommands: ResolvedCliCommands;
  verbose: boolean;
  verboseHuman: boolean;
  verboseHumanIo: boolean;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  cliLog: (level: "info" | "warn" | "error", msg: string) => void;
  onState: (state: AgentRuntimeState) => void;
  onAssistantText: (text: string) => void;
  onToolUse: (tool: string, input: unknown) => void;
  /** Extended-thinking text from Claude (only when info.collectThinking === true). */
  onThinkingText?: (text: string, opts?: { redacted?: boolean }) => void;
  onSessionId?: (sessionId: string) => void;
  onUsageDelta?: (delta: AgentUsage) => void;
  onContextWarning?: (used: number, limit: number) => void;
  onContextFull?: () => void;
  onSessionInvalid?: () => void;
  onError: (err: string) => void;
  onExit: (code: number | null) => void;
  /** projectId (pra rotular graph:status emitido pelo auto-build do grafo). */
  projectId?: string;
  /** Reporta status do índice graphify durante o auto-build no spawn. */
  onGraphStatus?: (status: "building" | "ready" | "error", info?: { nodeCount?: number; edgeCount?: number; error?: string }) => void;
}

// Header montado por seções com gating por projeto (Fase 2). Cada bloco off
// remove a prosa E as referências cruzadas — nunca deixa o agente lendo
// instrução de uma tool que ele não tem. teammates/tasks/filelock/memory são
// gateáveis; goals/webhooks/credentials/state-verify/footer ficam (ajustados).
const HDR_ROUTING = `# CRITICAL ROUTING RULE
- Direct text in your response is delivered ONLY to the human user.
- To talk to ANOTHER AGENT (teammate), you MUST use the \`mcp__the-dudes__send_message\` tool — never as plain text.
- If a message arrives prefixed with \`[from <name>]:\`, that came from a teammate. Your reply to them MUST go through \`mcp__the-dudes__send_message\` with \`to: "<name>"\`. Do NOT answer them via plain text — plain text will not reach the teammate.
- Plain text is for the user. Tool call is for teammates. They are separate channels — pick the right one.
- It is fine to also include a short status line as plain text (visible to user) AFTER calling \`send_message\`, but the actual answer to the teammate must be inside the tool call.
- Respect the hierarchy from \`list_agents\`: managers coordinate their reports, leads route work inside their teams, and specialists/worker agents should escalate cross-team or priority conflicts to their manager.`;

// Seção de teammate; a fallback de erro só cita o board quando tasks on.
function teammateSection(tasks: boolean): string {
  const blocked = tasks
    ? `  - Use the task board to coordinate: add a task assigned to that teammate, or add a comment on a shared task.
  - If the error says "preventive mode", direct messages are disabled project-wide — use only the task board.
  - If the error says "limit reached" or "loop detected", the conversation was paused — escalate to the user with a summary.
  - If the error says "hierarchy violation", you are not allowed to message this agent — use the task board or escalate to your manager.`
    : `  - If the error says "preventive mode", direct messages are disabled project-wide — escalate to the user.
  - If the error says "limit reached" or "loop detected", the conversation was paused — escalate to the user with a summary.
  - If the error says "hierarchy violation", you are not allowed to message this agent — escalate to your manager or the user.`;
  return `# Teammate communication
- \`mcp__the-dudes__list_agents\` — list teammates, including hierarchy level, team, manager and skills.
- \`mcp__the-dudes__send_message\` (args: {to, content}) — send a message to a teammate.
- **Hierarchy rules**: \`send_message\` is enforced by the server. You can ONLY message:
  - Your direct manager (the agent listed as your manager)
  - Your direct reports (agents who list you as manager)
  - Same-team peers at your exact hierarchy level
  - If no hierarchy is configured, all communication is allowed
- If \`send_message\` returns an error, the message was blocked — do NOT retry. Instead:
${blocked}`;
}

// Board de tasks SEM as tools de webhook (extraídas pra HDR_WEBHOOKS).
const HDR_TASKS_CORE = `# Shared task board (visible to the user and any teammates)
- \`mcp__the-dudes__list_tasks\` — read the current board. Shows lock status and blocker dependencies.
- \`mcp__the-dudes__add_task\` (args: {title, description?, status?, assignee?}) — add a task. Status defaults to \`todo\`.
- \`mcp__the-dudes__update_task\` (args: {id, status?, title?, description?, assignee?}) — change a task; use status to move it between todo/doing/done/blocked. You can also set \`blockedByTaskId\` to make it depend on another task.
- \`mcp__the-dudes__lock_task\` (args: {id}) — **ALWAYS lock a task BEFORE starting work.** Atomic lock prevents double-work. Fails if already locked or blocked by an incomplete dependency.
- \`mcp__the-dudes__unlock_task\` (args: {id}) — release the lock when done or if you must abandon the task.
- \`mcp__the-dudes__add_task_comment\` (args: {taskId, content}) — add a comment to a task for documentation or questions.
- \`mcp__the-dudes__list_task_comments\` (args: {taskId}) — read all comments on a task in chronological order.`;

// Webhooks: tools ungated (sempre registradas no bridge) → seção própria.
const HDR_WEBHOOKS = `# Webhooks
- \`mcp__the-dudes__send_webhook\` (args: {webhookName, message}) — send a custom message through a named outbound webhook configured in this project (Discord, Slack, etc). Use only when the operator has configured the webhook by name and asked you to notify external systems.
- \`mcp__the-dudes__list_webhooks\` — list webhook subscriptions in this project (name, direction, enabled, events). URLs and secrets are NOT returned. Use to discover the names accepted by send_webhook.`;

const HDR_FILELOCK = `# File locking (MANDATORY when enabled)
- If file locking is enabled in the project, you MUST use these tools before editing any file:
- \`mcp__the-dudes__lock_file\` (args: {path}) — lock a file before editing. Fails if another agent already holds the lock. Lock expires after 5 minutes.
- \`mcp__the-dudes__unlock_file\` (args: {path}) — release your lock when done editing.
- \`mcp__the-dudes__list_file_locks\` — see which files are currently locked and by whom.
- Do NOT edit files that are locked by another agent.`;

// Goals ungated; a linha de add_task/atribuição só entra com tasks on.
function goalsSection(tasks: boolean): string {
  const lines = [
    `# Goal alignment`,
    `- \`mcp__the-dudes__list_goals\` — list project goals (mission, objectives, milestones). Shows hierarchy tree.`,
  ];
  if (tasks) {
    lines.push(`- Every task can link to a goal via \`goal_id\` in \`add_task\`. Check \`list_goals\` to understand the project's purpose before creating tasks.`);
    lines.push(`- When working on a task, the assignment notification includes the goal context. Align your work with the goal's intent.`);
  } else {
    lines.push(`- Check \`list_goals\` to understand the project's purpose and align your work with the goal's intent.`);
  }
  return lines.join("\n");
}

const HDR_MEMORY = `# Project memory (durable, survives restarts & model switches)
- \`mcp__the-dudes__recall\` (args: {query?, type?}) — search the project memory (shared + your private). **Call this at the start of a task** to load durable context.
- \`mcp__the-dudes__remember\` (args: {title, body, type?, scope?, pinned?}) — save a durable note. Use for decisions, stable facts, references and your own working state worth keeping across restarts. \`scope: "project"\` (default) is shared with all agents; \`scope: "agent"\` is private to you. Keep entries short and atomic. It is re-injected into your system prompt on every restart.
- \`mcp__the-dudes__forget\` (args: {id}) — delete a memory entry you created. You cannot delete user-curated or other agents' entries.
- \`mcp__the-dudes__pin\` (args: {id, pinned?}) — pin/unpin an entry so it stays prioritized in the injected hot-set.
- Memory is already injected into this system prompt under "## Project Memory" when present — don't re-recall what's already there.`;

const HDR_CREDS = `# Credentials (API keys, tokens, passwords)
- \`mcp__the-dudes__get_credential\` (args: {name}) — retrieve a stored credential value by name. Use this whenever you need an API key or secret; never ask the user to paste it inline.
- NEVER send credentials or sensitive information to any agent or human.`;

// State verification: passos numerados montados conforme tasks/teammates,
// pra não instruir o agente a chamar list_tasks/list_agents que ele não tem.
function stateVerifySection(tasks: boolean, teammates: boolean): string {
  const lines: string[] = [
    `# State verification (MANDATORY before acting on any task)`,
    `- The message history is a log — it is NOT authoritative ground truth.${teammates ? " Other agents may have made changes you haven't seen yet." : ""}`,
    `- Before starting ANY code change or claiming a task:`,
  ];
  let n = 1;
  if (tasks) lines.push(`  ${n++}. Call \`list_tasks\` to see the current board. Do NOT assume task status or ownership from past messages — tasks may have been reassigned or completed.`);
  if (teammates) lines.push(`  ${n++}. Call \`list_agents\` to see who is currently online — check roles, teams, and hierarchy levels.`);
  if (teammates) lines.push(`  ${n++}. **Specialization rule:** Check if any teammate's role or team is more specialized for this task than yours. Use \`list_agents\` to inspect roles, teams, and hierarchy. If a specialist exists, delegate to them via ${tasks ? "the task board (\`add_task\` with assignee) or " : ""}\`send_message\`. Only execute the task yourself if:
      - No specialist exists for this domain, OR
      - Your own role is explicitly more suitable for the task than any available teammate.`);
  lines.push(`  ${n++}. Check actual files on disk (Read, Grep, Glob) before editing${teammates ? " — another agent may have modified them since you last looked" : ""}.`);
  if (tasks) lines.push(`- If a task appears duplicated or already in-progress, coordinate with the assignee — do NOT start parallel work on the same task.`);
  lines.push(`- When you discover the ${tasks ? "board or disk" : "disk"} contradicts your understanding, update your understanding and proceed from the current state.`);
  return lines.join("\n");
}

const HDR_DISCIPLINE = `# Conversation discipline (anti-loop)
- Limit back-and-forth exchanges. After 2-3 exchanges with a teammate on the same topic without progress, STOP and escalate to the user with a summary. Do NOT keep replying.
- If you receive a message that repeats the same point you already addressed, do NOT reply with the same counterpoint — the conversation is stuck. Escalate.
- Reply ONLY when you have new information or a decision to communicate. "Ok", "Got it", "Thanks" do NOT count as new information — skip them.
- If you are about to reply to a teammate and no user has spoken in the last several messages, ask yourself: "Is the user aware this conversation is happening?" If not, summarize and tag the user instead.
- Do NOT reply to system messages about conversation pauses — those are final.`;

// Rodapé: só cita board/atribuição quando os blocos correspondentes estão on.
function footerSection(tasks: boolean, teammates: boolean): string {
  const parts: string[] = [];
  if (tasks) parts.push("Use the board to coordinate work: when you start a piece of work, mark it `doing`; when you finish, mark it `done`.");
  if (tasks && teammates) parts.push("When you discover work for someone else, add a task assigned to that teammate.");
  parts.push("Stay in character. Be concise.");
  return parts.join(" ");
}

/** Monta o header gateando seção + referências cruzadas por projeto.
 *  Ausente/undefined numa flag = ligada (compat com server antigo). */
function buildSystemPromptHeader(features?: ContextFeatures): string {
  const teammates = features?.teammates !== false;
  const tasks = features?.tasks !== false;
  const filelock = features?.filelock !== false;
  const memory = features?.memory !== false;
  const sections: string[] = [];
  sections.push(teammates
    ? `You are part of a multi-agent team running locally.`
    : `You are an agent running locally.`);
  if (teammates) sections.push(HDR_ROUTING);
  if (teammates) sections.push(teammateSection(tasks));
  if (tasks) sections.push(HDR_TASKS_CORE);
  if (features?.webhooks !== false) sections.push(HDR_WEBHOOKS);
  if (filelock) sections.push(HDR_FILELOCK);
  if (features?.goals !== false) sections.push(goalsSection(tasks));
  if (memory) sections.push(HDR_MEMORY);
  if (features?.credentials !== false) sections.push(HDR_CREDS);
  sections.push(stateVerifySection(tasks, teammates));
  if (teammates) sections.push(HDR_DISCIPLINE);
  sections.push(footerSection(tasks, teammates));
  return sections.join("\n\n");
}

export class AgentRunner {
  readonly info: AgentInfo;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private currentState: AgentRuntimeState = "idle";

  /** Returns the runner's current runtime state — used during WS resync. */
  currentRuntimeState(): AgentRuntimeState { return this.currentState; }

  // OpenCode / Gemini per-message model
  private ocSessionId: string | undefined;
  /** IDs de parts já processadas (dedup entre turnos). O POST /message só
   *  retorna a ÚLTIMA mensagem do assistant; tool calls ficam em mensagens
   *  intermediárias do loop → buscamos TODAS as msgs e processamos as novas. */
  private ocSeenPartIds = new Set<string>();
  /** Sessão veio de resume → primeira drain deve "marcar como visto" o histórico
   *  sem reemitir (senão tool calls/textos antigos reapareceriam nos RUNS). */
  private ocNeedsPrime = false;
  private ocQueue: Array<{ content: string; images?: ImageAttachment[] }> = [];
  private ocBusy = false;
  private ocActiveProc: ChildProcess | null = null;
  private ocFirstTurn = true;
  /** true se a run opencode atual emitiu algum evento produtivo (text/tool/
   *  step_finish). false no fim = falha transitória → dispara retry. */
  private ocRunSawOutput = false;
  private stopped = false;
  /** Garante que onExit dispara no máximo uma vez. stop() é re-chamável e
   *  pode correr com um close handler em voo (ocActiveProc null →
   *  onExit(0) imediato enquanto um close ainda pendente também chamaria),
   *  emitindo agent:exit duplicado pro orchestrator. Flag idempotente,
   *  estilo `settled` do killClaudeForRestart. */
  private exited = false;
  private ocPendingSummary: string | undefined;
  // OpenCode serve+attach — connection pool warm evita ECONNRESET
  // intermitente de providers (Z.AI, deepseek) que `opencode run` standalone
  // pega na criação de socket nova cada call.
  private ocServerProc: ChildProcess | null = null;
  private ocServerUrl: string | undefined;
  private ocServerBootPromise: Promise<void> | null = null;
  /** SSE /event do serve — só ativo com auto-approve OFF, p/ receber os
   *  pedidos de permissão (permission.asked) e resolver via orquestrador. */
  private ocEventReq: import("node:http").ClientRequest | null = null;

  // Context tracking
  private lastInputTokens = 0;
  private contextWarned = false;
  private sessionInvalid = false;
  private restarting = false;
  private lastVerboseIoBody = "";
  private lastVerboseIoAt = 0;
  /** Mensagens recebidas durante restart (kill→startClaude). Flushed
   *  quando o novo proc estiver writable. Sem isso, mission engine
   *  perde dispatches feitos no meio do clearContext/compact. */
  private pendingMessages: Array<{ content: string; images?: ImageAttachment[] }> = [];

  constructor(info: AgentInfo, private opts: AgentRunnerOptions) {
    this.info = info;
    if ((opts.cliRunner === "opencode" || opts.cliRunner === "codex") && opts.resumeSessionId) {
      this.ocSessionId = opts.resumeSessionId;
      if (opts.cliRunner === "opencode") this.ocNeedsPrime = true;
    }
  }

  private runnerCommand(runner: CliRunner): string {
    return this.opts.cliCommands[runner].command;
  }

  private workspaceInfo(): string {
    const lines: string[] = [];
    lines.push(`Your working directory is \`${this.opts.workspaceRoot}\`.`);
    lines.push("All project files and the git repository are located in this directory.");
    if (this.info.repo) {
      lines.push(`Repository: ${this.info.repo.gitUrl} (branch: ${this.info.repo.branch ?? "main"})`);
    }
    lines.push("Use this directory as the root for all file operations, git commands, and tool executions.");
    return lines.join("\n");
  }

  private ensureRunnerAvailable(runner: CliRunner): boolean {
    const status = this.opts.cliCommands[runner];
    if (status.available) return true;
    this.opts.onError(`[cli] ${runner} not found. Set the path manually or install the binary.`);
    return false;
  }

  private traceCli(runner: CliRunner, direction: "spawn" | "argv" | "stdin" | "stdout" | "stderr", text: string) {
    if (!this.opts.verbose) return;
    if (this.opts.verboseHumanIo) {
      if (direction === "stderr" || direction === "spawn") return;
      const rendered = this.renderVerboseIoBlock(runner, direction, text);
      if (rendered) this.opts.cliLog("info", rendered);
      return;
    }
    if (this.opts.verboseHuman) {
      if (direction === "spawn") {
        this.opts.cliLog("info", `cli ${runner} spawn ${text}`);
        return;
      }
      const rendered = this.renderVerboseBlock(runner, direction, text);
      if (rendered) this.opts.cliLog("info", rendered);
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      this.opts.cliLog("info", `[cli:${this.info.id}:${runner}:${direction}] ${trimmed}`);
    }
  }

  private traceSpawn(runner: CliRunner, args: string[]) {
    if (!this.opts.verbose) return;
    if (this.opts.verboseHumanIo) return;
    if (this.opts.verboseHuman) {
      const lines = [
        `cli ${runner} spawn`,
        `  command: ${this.runnerCommand(runner)}`,
        `  args:`,
        ...args.map((a) => `    ${a}`),
      ];
      this.opts.cliLog("info", lines.join("\n"));
      return;
    }
    this.opts.cliLog("info", `[cli:${this.info.id}:${runner}:spawn] ${this.runnerCommand(runner)} ${args.map((a) => JSON.stringify(a)).join(" ")}`);
  }

  private renderVerboseIoBlock(_runner: CliRunner, _direction: "argv" | "stdin" | "stdout", text: string): string {
    const lines = text.replace(/\r/g, "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return "";
    const bodyLines: string[] = [];
    for (const line of lines) {
      const body = this.extractVerbosePayload(line);
      if (!body) continue;
      bodyLines.push(...body.split("\n").filter((chunk) => chunk.trim().length > 0));
    }
    if (bodyLines.length === 0) return "";
    const body = bodyLines.join("\n").trim();
    if (!body) return "";
    const now = Date.now();
    if (body === this.lastVerboseIoBody && now - this.lastVerboseIoAt < 10_000) return "";
    this.lastVerboseIoBody = body;
    this.lastVerboseIoAt = now;
    const agent = this.colorizeAgentName(this.info.name);
    return [agent, ...bodyLines.map((chunk) => `  ${chunk}`)].join("\n");
  }

  private traceInternalCli(level: "info" | "warn" | "error", msg: string) {
    if (this.opts.verboseHumanIo) return;
    this.opts.cliLog(level, msg);
  }

  private renderVerboseBlock(runner: CliRunner, direction: "argv" | "stdin" | "stdout" | "stderr", text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return "";
    const header = `cli ${runner} ${direction}`;
    const body = this.prettyPrintVerboseText(trimmed);
    return [header, ...body.split("\n").map((line) => `  ${line}`)].join("\n");
  }

  private colorizeAgentName(name: string): string {
    if (!this.supportsAnsi()) return name;
    const rgb = this.hexToRgb(this.info.color);
    if (!rgb) return name;
    return `\u001b[1m\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m${name}\u001b[0m`;
  }

  private supportsAnsi(): boolean {
    return !!(process.stdout.isTTY || process.stderr.isTTY);
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = Number.parseInt(m[1], 16);
    return {
      r: (n >> 16) & 0xff,
      g: (n >> 8) & 0xff,
      b: n & 0xff,
    };
  }

  private extractVerbosePayload(text: string): string {
    const compact = text.trim();
    if (!compact) return "";
    if (compact.startsWith("{") || compact.startsWith("[")) {
      try {
        const parsed = JSON.parse(compact);
        return this.extractValueText(parsed);
      } catch {
        // fall through to raw text
      }
    }
    return compact.replace(/\t/g, "  ");
  }

  private extractValueText(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      return value.map((item) => this.extractValueText(item)).filter(Boolean).join("\n").trim();
    }
    if (typeof value !== "object") return "";
    const obj = value as Record<string, unknown>;
    if (obj.type === "rate_limit_event") return "";
    if (obj.type === "thinking") return "";
    if (obj.type === "tool_use") {
      const input = typeof obj.input === "object" && obj.input
        ? obj.input as Record<string, unknown>
        : {};
      if (typeof input.command === "string" && input.command.trim()) return input.command.trim();
      return this.extractValueText(input.content ?? input.text ?? input.message);
    }
    if (typeof obj.type === "string" && obj.type === "tool_result") {
      const pieces: string[] = [];
      for (const key of ["content", "stdout", "output", "text", "message", "result"] as const) {
        const extracted = this.extractValueText(obj[key]);
        if (extracted) pieces.push(extracted);
      }
      return pieces.join("\n").trim();
    }
    if (typeof obj.type === "string" && obj.type === "text" && typeof obj.text === "string") {
      return obj.text.trim();
    }
    if (typeof obj.text === "string" && obj.text.trim()) return obj.text.trim();
    if (typeof obj.content !== "undefined") return this.extractValueText(obj.content);
    if (typeof obj.message !== "undefined") return this.extractValueText(obj.message);
    if (typeof obj.tool_result !== "undefined") return this.extractValueText(obj.tool_result);
    if (typeof obj.output !== "undefined") return this.extractValueText(obj.output);
    if (typeof obj.stdout !== "undefined") return this.extractValueText(obj.stdout);
    if (typeof obj.stderr !== "undefined") return this.extractValueText(obj.stderr);
    if (typeof obj.result !== "undefined") return this.extractValueText(obj.result);
    return "";
  }

  private prettyPrintVerboseText(text: string): string {
    const compact = text.trim();
    if (!compact) return "";
    if (compact.startsWith("{") || compact.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(compact), null, 2);
      } catch {}
    }
    const lines = compact.replace(/\r/g, "").split("\n");
    return lines
      .map((line) => line.replace(/\t/g, "  "))
      .join("\n");
  }

  /** Tmpdir do agente — nome ALEATÓRIO (mkdtemp), memoizado por instância.
   *  Antes era /tmp/the-dudes/<agentId> (path previsível): um agente irmão
   *  same-uid sob prompt-injection fazia `cat /tmp/the-dudes/<outro>/agent.token`
   *  e roubava o token de outro agente (cross-project). O nome aleatório sem o
   *  agentId remove o mapeamento agentId→token — o irmão pode listar o parent
   *  mas não sabe qual dir é de qual agente. NÃO é isolamento forte (same-uid
   *  ainda lê qualquer arquivo do dono); isolamento real exige uid distinto/
   *  container por agente — ver SECURITY-TODO S-05. */
  private _tmpDir?: string;
  private agentTmpDir(): string {
    if (this._tmpDir) return this._tmpDir;
    const parent = path.join(os.tmpdir(), "the-dudes");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { chmodSync(parent, 0o700); } catch {}
    this._tmpDir = mkdtempSync(path.join(parent, "ag-")); // 0700 por padrão
    return this._tmpDir;
  }

  /** Grava agent token em arquivo mode 0o600 e retorna path. Em vez de
   *  passar token via env do CLI child (visible em /proc/<pid>/environ
   *  pra outros processos do mesmo user), MCP bridge lê via TOKEN_FILE.
   *  CLI process nunca vê o token. */
  private writeAgentTokenFile(): string {
    const dir = this.ensureSecureAgentTmpDir();
    const tokenPath = path.join(dir, "agent.token");
    writeFileSync(tokenPath, this.opts.agentToken, { mode: 0o600 });
    try { chmodSync(tokenPath, 0o600); } catch {}
    return tokenPath;
  }

  /** Garante o tmpdir do agente (mkdtemp já cria 0700). */
  private ensureSecureAgentTmpDir(): string {
    return this.agentTmpDir();
  }

  /** Remove o tmpdir do agente (token plaintext + sessions). Best-effort,
   *  chamado no fim de vida pra não deixar token válido em /tmp. */
  private cleanupAgentTmpDir(): void {
    if (!this._tmpDir) return;
    try { rmSync(this._tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    this._tmpDir = undefined;
  }

  contextLimit(): number {
    return MODEL_CONTEXT_LIMITS[this.info.model ?? "sonnet"] ?? 200_000;
  }

  resetWithSummary(summary?: string): void {
    this.ocSessionId = undefined;
    this.ocSeenPartIds.clear();
    this.ocNeedsPrime = false;
    this.ocFirstTurn = true;
    this.contextWarned = false;
    this.lastInputTokens = 0;
    this.ocPendingSummary = summary;
  }

  async runOneShot(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.ensureRunnerAvailable(this.opts.cliRunner)) {
        resolve("");
        return;
      }
      let proc: ChildProcess;
      const runner = this.opts.cliRunner;
      const sid = runner === "claude" ? this.opts.resumeSessionId : this.ocSessionId;

      if (runner === "gemini") {
        const args = ["--output-format", "stream-json", "--skip-trust", "--yolo"];
        // gemini stores latest session inside agentTmpDir; --resume latest reuses it
        args.push("--resume", "latest");
        args.push("-p", prompt);
        if (this.info.model) args.push("--model", this.info.model);
        this.traceCli("gemini", "argv", prompt);
        this.traceSpawn("gemini", args);
        proc = spawnDropped(this.runnerCommand("gemini"), args, {
          cwd: this.agentTmpDir(),
          env: { ...this.buildEnv(), GEMINI_CLI_TRUST_WORKSPACE: "true" },
          stdio: ["ignore", "pipe", "pipe"],
        }, this.opts.dropTo ?? null);
      } else if (runner === "codex") {
        const baseFlags = ["--json", "--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox"];
        const modelFlags = this.info.model ? ["-m", this.info.model] : [];
        const args = sid
          ? ["exec", "resume", ...baseFlags, ...modelFlags, sid, prompt]
          : ["exec", ...baseFlags, ...modelFlags, prompt];
        this.traceCli("codex", "argv", prompt);
        this.traceSpawn("codex", args);
        proc = spawnDropped(this.runnerCommand("codex"), args, {
          cwd: this.opts.workspaceRoot,
          env: this.buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, this.opts.dropTo ?? null);
      } else if (runner === "opencode") {
        const args = ["run", "--format", "json"];
        if (this.opts.autoApprove) args.push("--dangerously-skip-permissions");
        if (this.info.model) args.push("--model", this.info.model);
        if (sid) args.push("-s", sid);
        args.push(prompt);
        this.traceCli("opencode", "argv", prompt);
        this.traceSpawn("opencode", args);
        const py = resolvePython3();
        if (!py) { this.opts.onError("python3 não encontrado em path absoluto — opencode precisa do wrapper PTY"); resolve(""); return; }
        proc = spawnDropped(py, ["-c", "import pty,sys; pty.spawn(sys.argv[1:])", this.runnerCommand("opencode"), ...args], {
          cwd: this.opts.workspaceRoot,
          env: this.buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, this.opts.dropTo ?? null);
      } else {
        const args = ["--print", "-p", prompt];
        if (this.info.model) args.push("--model", this.info.model);
        if (sid) args.push("--resume", sid);
        this.traceCli("claude", "argv", prompt);
        this.traceSpawn("claude", args);
        proc = spawnDropped(this.runnerCommand("claude"), args, {
          cwd: this.opts.workspaceRoot,
          env: this.buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, this.opts.dropTo ?? null);
      }

      proc.stdout!.setEncoding("utf8");
      proc.stderr!.setEncoding("utf8");
      let out = "";
      proc.stdout!.on("data", (c: string) => { this.traceCli(runner, "stdout", c); out += c; });
      proc.stderr!.on("data", (c: string) => { this.traceCli(runner, "stderr", c); });
      proc.on("close", () => resolve(extractOneShotText(out, runner)));
      proc.on("error", () => resolve(""));
    });
  }

  private checkContextUsage(delta: AgentUsage): void {
    if (delta.input > 0) this.lastInputTokens = delta.input;
    const limit = this.contextLimit();
    const pct = this.lastInputTokens / limit;
    if (pct >= 1.0) {
      this.opts.onContextFull?.();
    } else if (pct >= CONTEXT_WARN_PCT && !this.contextWarned) {
      this.contextWarned = true;
      this.opts.onContextWarning?.(this.lastInputTokens, limit);
    }
  }

  private checkContextFullError(msg: string): void {
    if (CONTEXT_FULL_PATTERNS.some((p) => p.test(msg))) {
      this.opts.onContextFull?.();
    }
  }

  async start() {
    await this.prepareGraphify();
    // prepareGraphify pode aguardar um build (até 180s); se o agente foi
    // parado/removido nessa janela, não spawnar processo zumbi.
    if (this.stopped) return;
    if (this.opts.cliRunner === "opencode") {
      if (!this.ensureRunnerAvailable("opencode")) return;
      this.writeOpenCodeConfig();
      this.bootPerMessageRunner();
      return;
    }
    if (this.opts.cliRunner === "gemini") {
      if (!this.ensureRunnerAvailable("gemini")) return;
      this.writeGeminiConfig();
      this.bootPerMessageRunner();
      return;
    }
    if (this.opts.cliRunner === "codex") {
      if (!this.ensureRunnerAvailable("codex")) return;
      this.bootPerMessageRunner();
      return;
    }
    if (!this.ensureRunnerAvailable("claude")) return;
    this.startClaude();
  }

  /** Feature graph (graphify): se ligada, garante o índice do workspace
   *  (build local se ausente) e injeta o MCP server `graphify` em
   *  extraMcpServers — daí os 4 config writers (claude/gemini/opencode/codex)
   *  o serializam como qualquer outro MCP. No-op se a feature está off ou o
   *  binário graphify-mcp não está instalado. */
  private async prepareGraphify() {
    if (!this.opts.features?.graph) return;
    const mcpBin = this.opts.cliCommands.graphifyMcp;
    if (!mcpBin?.available) {
      this.opts.log("warn", `[graph:${this.info.name}] feature ligada mas graphify-mcp não encontrado — pip install graphifyy mcp. Pulando.`);
      return;
    }
    const root = this.opts.workspaceRoot;
    const gbin = this.opts.cliCommands.graphify;
    const hadIndex = graphExists(root);
    if (gbin?.available) {
      // Rebuild incremental do código a CADA spawn (cache SHA256 = barato; sem
      // LLM). Mantém o grafo fresco pros agentes sem reindex manual. A 1ª vez
      // (sem índice) emite status pra UI; refreshes seguintes são silenciosos.
      if (!hadIndex) this.opts.onGraphStatus?.("building");
      this.opts.log("info", `[graph:${this.info.name}] ${hadIndex ? "atualizando" : "indexando"} workspace (graphify update)…`);
      const r = await buildGraph(root, gbin.command);
      if (r.ok) {
        this.opts.log("info", `[graph:${this.info.name}] índice ${hadIndex ? "atualizado" : "pronto"}: ${r.nodeCount ?? "?"} nós, ${r.edgeCount ?? "?"} arestas.`);
        if (!hadIndex) this.opts.onGraphStatus?.("ready", { nodeCount: r.nodeCount, edgeCount: r.edgeCount });
      } else {
        this.opts.log("warn", `[graph:${this.info.name}] build falhou: ${r.error}`);
        if (!hadIndex) { this.opts.onGraphStatus?.("error", { error: r.error }); return; }
        // tinha índice antigo → segue servindo o que existe
      }
    } else if (!hadIndex) {
      this.opts.log("warn", `[graph:${this.info.name}] sem índice e graphify (build) não encontrado — pulando injeção.`);
      return;
    }
    if (!graphExists(root)) return; // sem grafo → não serve
    this.opts.extraMcpServers = {
      ...(this.opts.extraMcpServers ?? {}),
      graphify: {
        type: "stdio",
        command: mcpBin.command,
        args: [graphPath(root), "--transport", "stdio"],
      },
    };
  }

  private bootPerMessageRunner() {
    // Trigger first-turn prompt injection without requiring user input.
    // Empty content → only the system prompt is sent, agent awaits next message.
    this.pushUserMessage("[system] Context loaded. Awaiting instructions.");
  }

  /** Env do mcp-bridge: lista de grupos de contexto ligados. Objeto vazio
   *  quando não há features (bridge registra tudo). Spread nos 4 config
   *  writers do bridge (gemini/opencode/claude/codex). */
  private featuresEnv(): Record<string, string> {
    const f = this.opts.features;
    if (!f) return {};
    const on: string[] = [];
    if (f.teammates !== false) on.push("teammates");
    if (f.tasks !== false) on.push("tasks");
    if (f.filelock !== false) on.push("filelock");
    if (f.memory !== false) on.push("memory");
    if (f.goals !== false) on.push("goals");
    if (f.credentials !== false) on.push("credentials");
    if (f.webhooks !== false) on.push("webhooks");
    return { THE_DUDES_FEATURES: on.join(",") };
  }

  private writeGeminiConfig() {
    this.ensureSecureAgentTmpDir();
    const dir = path.join(this.agentTmpDir(), ".gemini");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
    const env: Record<string, string> = {
      THE_DUDES_AGENT_ID: this.info.id,
      THE_DUDES_AGENT_NAME: this.info.name,
      THE_DUDES_ORCH_URL: this.opts.orchestratorUrl,
      THE_DUDES_AGENT_TOKEN_FILE: this.writeAgentTokenFile(),
      ...this.featuresEnv(),
    };
    if (this.opts.bridgeSocketPath) env.THE_DUDES_BRIDGE_SOCKET = this.opts.bridgeSocketPath;
    // Gemini settings.json aceita `mcpServers` no mesmo shape do Claude
    // (command/args/env pra stdio; url/headers pra http). Apenas o campo
    // `type` é específico do Claude e deve ficar fora aqui.
    const mcpServers: Record<string, unknown> = {};
    if (this.opts.extraMcpServers) {
      for (const [name, cfg] of Object.entries(this.opts.extraMcpServers)) {
        if (name === "the-dudes") continue;
        const { type: _unused, ...rest } = cfg;
        mcpServers[name] = rest;
      }
    }
    mcpServers["the-dudes"] = {
      command: this.opts.bridgeCommand,
      args: this.opts.bridgeArgs,
      env,
    };
    const config = { mcpServers };
    // mode 0o600: o JSON contém THE_DUDES_AGENT_TOKEN inline em "env".
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  private writeOpenCodeConfig() {
    const configPath = path.join(this.opts.workspaceRoot, "opencode.json");
    // OpenCode usa shape distinto: stdio = {type:"local", command:[cmd, ...args], environment?}.
    // SSE/HTTP servers ainda não suportados pelo OpenCode — descartamos com warning.
    const mcp: Record<string, unknown> = {};
    if (this.opts.extraMcpServers) {
      for (const [name, cfg] of Object.entries(this.opts.extraMcpServers)) {
        if (name === "the-dudes") continue;
        const isStdio = (cfg.type ?? "stdio") === "stdio";
        if (!isStdio || !cfg.command) {
          this.opts.log("warn", `[opencode:${this.info.name}] skipping MCP "${name}" — only stdio transport is supported`);
          continue;
        }
        const entry: Record<string, unknown> = {
          type: "local",
          enabled: true,
          command: [cfg.command, ...(cfg.args ?? [])],
        };
        if (cfg.env && Object.keys(cfg.env).length > 0) entry.environment = cfg.env;
        mcp[name] = entry;
      }
    }
    // BUG histórico: faltava `environment` → o mcp-bridge spawnado pelo serve
    // não recebia THE_DUDES_AGENT_TOKEN_FILE → mandava Bearer vazio →
    // /api/bridge 401 (as tools the-dudes nunca funcionaram no opencode).
    const tdEnv: Record<string, string> = {
      THE_DUDES_AGENT_ID: this.info.id,
      THE_DUDES_AGENT_NAME: this.info.name,
      THE_DUDES_ORCH_URL: this.opts.orchestratorUrl,
      THE_DUDES_AGENT_TOKEN_FILE: this.writeAgentTokenFile(),
      ...this.featuresEnv(),
    };
    if (this.opts.bridgeSocketPath) tdEnv.THE_DUDES_BRIDGE_SOCKET = this.opts.bridgeSocketPath;
    mcp["the-dudes"] = {
      type: "local",
      enabled: true,
      command: [this.opts.bridgeCommand, ...this.opts.bridgeArgs],
      environment: tdEnv,
    };
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      mcp,
      // auto-approve: ON = libera tudo; OFF = pede aprovação nas tools de risco
      // (shell/edição/rede/fora-do-workspace). As demais (read/grep/glob/list +
      // MCP the-dudes, que são seguras) ficam no default (allow). Os "ask" são
      // resolvidos pelo daemon via evento SSE → política do orquestrador (mesma
      // UI do claude). Sem isto o opencode rodava com default=allow, ignorando
      // o toggle.
      permission: this.opts.autoApprove
        ? "allow"
        : { edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" },
    };
    // NÃO escrever bloco `provider.*` aqui: qualquer override de provider no
    // opencode.json (mesmo `options:{}` vazio) corrompe o zai-coding-plan
    // (provider some no run → agente mudo). reasoning_effort/thinking não são
    // configuráveis por aqui; o modelo roda no default dele.
    try {
      // mode 0o600: arquivo fica em workspaceRoot, então pode acabar em git
      // se .gitignore não cobrir. Mode restrito reduz blast-radius em
      // multi-user host enquanto não migramos pro tmpdir (precisa --config
      // flag no opencode CLI).
      writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error(`[opencode:${this.info.name}] failed to write opencode.json: ${e}`);
    }
  }

  private startClaude() {
    const args = this.buildClaudeArgs();
    const env = this.buildEnv();
    const appendPromptIndex = args.indexOf("--append-system-prompt");
    if (appendPromptIndex >= 0 && typeof args[appendPromptIndex + 1] === "string") {
      this.traceCli("claude", "argv", args[appendPromptIndex + 1]);
    }
    this.traceSpawn("claude", args);

    this.proc = spawnDropped(this.runnerCommand("claude"), args, {
      cwd: this.opts.workspaceRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }, this.opts.dropTo ?? null) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    // Flush mensagens bufferadas durante restart. Pequeno delay pra
    // Claude inicializar; CLI bufferará stdin entretanto.
    if (this.pendingMessages.length > 0) {
      const pending = this.pendingMessages.splice(0);
      this.opts.log("info", `[cli:${this.info.id}:claude] flushing ${pending.length} buffered message(s) after restart`);
      setTimeout(() => {
        for (const m of pending) this.pushUserMessage(m.content, m.images);
      }, 300);
    }

    this.proc.stdout.on("data", (chunk: string) => {
      this.traceCli("claude", "stdout", chunk);
      this.handleStdout(chunk);
    });
    this.proc.stderr.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (!msg) return;
      this.traceCli("claude", "stderr", msg);
      if (isMissingSessionMessage(msg)) {
        this.sessionInvalid = true;
        this.opts.resumeSessionId = undefined;
        this.info.sessionId = undefined;
        this.opts.onSessionId?.("");
        this.opts.onSessionInvalid?.();
        return;
      }
      this.checkContextFullError(msg);
      this.opts.onError(msg);
    });
    this.proc.on("exit", (code) => {
      if (this.sessionInvalid) {
        this.sessionInvalid = false;
        this.opts.resumeSessionId = undefined;
        if (!this.stopped) {
          this.proc = null;
          this.startClaude();
          return;
        }
      }
      if (this.restarting) {
        // caller manages restart manually; just clear proc and don't notify project
        this.proc = null;
        return;
      }
      this.emitExit(code);
    });
  }

  private buildEnv(): NodeJS.ProcessEnv {
    // CLI process NÃO recebe THE_DUDES_AGENT_TOKEN — leak via
    // /proc/<pid>/environ pra outros procs do mesmo user. Bridge MCP
    // (spawned como child do CLI) recebe via TOKEN_FILE inline em
    // mcp.json/settings.json — esse env só vai pro proc bridge, não
    // pro CLI runner.
    // Scrub adicional: THE_DUDES_DAEMON_TOKEN do process.env do daemon
    // vazaria pro CLI agente (prompt injection no agente poderia fazer
    // ele revelar/exfiltrar). Mesmo motivo pra outras chaves sensíveis.
    const scrubbed = { ...process.env };
    delete scrubbed.THE_DUDES_DAEMON_TOKEN;
    delete scrubbed.THE_DUDES_TOKEN;
    delete scrubbed.THE_DUDES_ENCRYPTION_KEY;
    const env: NodeJS.ProcessEnv = {
      ...scrubbed,
      THE_DUDES_AGENT_ID: this.info.id,
      THE_DUDES_AGENT_NAME: this.info.name,
      THE_DUDES_ORCH_URL: this.opts.orchestratorUrl,
    };
    if (this.opts.bridgeSocketPath) env.THE_DUDES_BRIDGE_SOCKET = this.opts.bridgeSocketPath;
    if (this.opts.cliRunner === "claude") {
      env.CLAUDE_CONFIG_DIR = this.resolveClaudeConfigDir();
    }
    return env;
  }

  private resolveClaudeConfigDir(): string {
    const home = this.opts.dropTo?.home ?? process.env.HOME ?? "";
    // Override por env (container): ignora o campo por-agente, que costuma
    // apontar pra path do HOST inexistente no container. Permite montar as
    // credenciais num único dir fixo (ex: THE_DUDES_CLAUDE_CONFIG_DIR=
    // /root/.config/claude + -v <creds-do-host>:/root/.config/claude).
    const forced = process.env.THE_DUDES_CLAUDE_CONFIG_DIR?.trim();
    if (forced) return this.expandHome(forced, home);
    const custom = this.info.claudeConfigDir?.trim();
    if (custom) return this.expandHome(custom, home);
    return home ? path.join(home, ".config", "claude") : path.join(".config", "claude");
  }

  private expandHome(p: string, home: string): string {
    if (!home) return p;
    if (p === "~" || p === "$HOME") return home;
    if (p.startsWith("~/")) return path.join(home, p.slice(2));
    if (p.startsWith("$HOME/")) return path.join(home, p.slice(6));
    if (p.startsWith("${HOME}/")) return path.join(home, p.slice(8));
    return p;
  }

  private buildClaudeArgs(): string[] {
    const mcpConfig = this.writeMcpConfig();
    const planAddon = this.info.planMode
      ? `\n\n# PLAN MODE ACTIVE\nDo NOT execute destructive tools (Write, Edit, Bash that mutates state, etc.). Only Read, Grep, Glob and analysis. Output a clear, numbered plan and ask the user to confirm before any execution. Wait for explicit user approval before proceeding.`
      : "";
    // Allowed-tools base: tools internos do bridge "the-dudes" sempre liberados
    // (não passa pelo permission-prompt). Cada MCP server extra ganha um
    // wildcard `mcp__<name>__*` pra não cair em prompt — quando o user
    // libera um MCP via allowlist, ele já está confiando.
    const baseAllowed = [
      "mcp__the-dudes__send_message",
      "mcp__the-dudes__list_agents",
      "mcp__the-dudes__list_tasks",
      "mcp__the-dudes__add_task",
      "mcp__the-dudes__update_task",
      "mcp__the-dudes__lock_task",
      "mcp__the-dudes__unlock_task",
      "mcp__the-dudes__add_task_comment",
      "mcp__the-dudes__list_task_comments",
      "mcp__the-dudes__list_goals",
      "mcp__the-dudes__get_credential",
      "mcp__the-dudes__send_webhook",
      "mcp__the-dudes__list_webhooks",
    ];
    const extraAllowed: string[] = [];
    if (this.opts.extraMcpServers) {
      for (const name of Object.keys(this.opts.extraMcpServers)) {
        if (name === "the-dudes") continue;
        extraAllowed.push(`mcp__${name}__*`);
      }
    }
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--mcp-config", mcpConfig,
      "--append-system-prompt",
      `${buildSystemPromptHeader(this.opts.features)}\n\n# Your role\n${this.info.role}\n\n${this.info.systemPrompt}\n\n# Workspace\n${this.workspaceInfo()}${planAddon}`,
      "--allowed-tools",
      [...baseAllowed, ...extraAllowed].join(","),
    ];
    if (this.opts.autoApprove) {
      args.push("--permission-mode", "bypassPermissions");
    } else {
      // O McpServer registra como "the-dudes" (com hífen); Claude Code
      // expõe via mcp__the-dudes__approve_action. Underscore dispara
      // "tool not found" e mata o agent.
      args.push("--permission-prompt-tool", "mcp__the-dudes__approve_action");
    }
    if (this.info.model) args.push("--model", this.info.model);
    // Claude only emits `thinking` blocks when --effort gives the model
    // enough thinking budget AND the prompt is complex enough to warrant
    // it. low/medium have ~zero budget. high/xhigh/max all engage thinking
    // when the prompt requires reasoning. Floor at "high" when the user
    // opted in but set a level too low to ever emit thinking.
    let effort = this.info.effort;
    if (this.info.collectThinking && (!effort || effort === "low" || effort === "medium")) {
      const prev = effort ?? "(unset)";
      effort = "high";
      this.traceInternalCli("info", `[cli:${this.info.id}:claude:thinking] effort lifted from "${prev}" to "high" because collectThinking=true`);
    }
    if (effort) args.push("--effort", effort);
    if (this.info.collectThinking) {
      // Required to make Claude CLI emit thinking content (not just signature).
      // See https://github.com/anthropics/claude-code/issues/56356
      args.push("--thinking", "adaptive", "--thinking-display", "summarized");
      const m = (this.info.model ?? "").toLowerCase();
      if (m.includes("opus-4-7") || m === "opus") {
        this.traceInternalCli("warn", `[cli:${this.info.id}:claude:thinking] WARNING: Opus 4.7 has a known bug (issue #56356) — thinking content arrives empty. Use sonnet (4.6) or claude-opus-4-6 instead.`);
      }
    }
    if (this.opts.resumeSessionId) args.push("--resume", this.opts.resumeSessionId);
    return args;
  }

  private writeMcpConfig(): string {
    const dir = this.ensureSecureAgentTmpDir();
    const configPath = path.join(dir, "mcp.json");
    const env: Record<string, string> = {
      THE_DUDES_AGENT_ID: this.info.id,
      THE_DUDES_AGENT_NAME: this.info.name,
      THE_DUDES_ORCH_URL: this.opts.orchestratorUrl,
      THE_DUDES_AGENT_TOKEN_FILE: this.writeAgentTokenFile(),
      ...this.featuresEnv(),
    };
    if (this.opts.bridgeSocketPath) env.THE_DUDES_BRIDGE_SOCKET = this.opts.bridgeSocketPath;
    // Bridge interno reservado em "the-dudes" — sempre presente. Servers
    // extras (vindos do workspace via allowlist) são mesclados antes; se
    // alguém declarar "the-dudes" no workspace, é sobrescrito pelo bridge.
    const mcpServers: Record<string, unknown> = {};
    if (this.opts.extraMcpServers) {
      for (const [name, cfg] of Object.entries(this.opts.extraMcpServers)) {
        if (name === "the-dudes") continue;
        mcpServers[name] = cfg;
      }
    }
    mcpServers["the-dudes"] = {
      type: "stdio",
      command: this.opts.bridgeCommand,
      args: this.opts.bridgeArgs,
      env,
    };
    const config = { mcpServers };
    // mode 0o600: contém THE_DUDES_AGENT_TOKEN; tmpdir 0o700 protege parent.
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    const names = Object.keys(mcpServers).filter((n) => n !== "the-dudes");
    this.opts.log("info", `[mcp:write] agent=${this.info.name} servers=[${names.join(",") || "(only-bridge)"}] path=${configPath}`);
    return configPath;
  }

  /* ---------- Claude stdout parsing ---------- */

  private handleStdout(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        this.handleStreamEvent(event);
      } catch {
        // ignore malformed
      }
    }
  }

  private handleStreamEvent(event: any) {
    // claude emits session_id on every stream event. Only forward to
    // the orchestrator when it actually changes — otherwise we'd flood
    // listeners with redundant agent:session messages (one per chunk).
    if (typeof event.session_id === "string" && this.opts.onSessionId && event.session_id !== this.info.sessionId) {
      this.info.sessionId = event.session_id;
      this.opts.onSessionId(event.session_id);
    }
    if (event.type === "system" && event.subtype === "init") {
      this.setState("idle");
      return;
    }
    if (event.type === "assistant") {
      const blocks = event.message?.content ?? [];
      const usage = event.message?.usage;
      if (usage) {
        const delta: AgentUsage = {
          input: Number(usage.input_tokens ?? 0),
          output: Number(usage.output_tokens ?? 0),
          cacheCreate: Number(usage.cache_creation_input_tokens ?? 0),
          cacheRead: Number(usage.cache_read_input_tokens ?? 0),
        };
        this.opts.onUsageDelta?.(delta);
        this.checkContextUsage(delta);
      }
      const textParts: string[] = [];
      let hasToolUse = false;
      for (const b of blocks) {
        if (b.type === "text" && b.text) textParts.push(b.text);
        if (b.type === "thinking") {
          const t = typeof b.thinking === "string" ? b.thinking.trim() : "";
          this.traceInternalCli("info", `[cli:${this.info.id}:claude:thinking] block_received len=${t.length} collectFlag=${this.info.collectThinking}`);
          if (this.info.collectThinking && t) this.opts.onThinkingText?.(t);
        }
        if (b.type === "redacted_thinking") {
          this.traceInternalCli("info", `[cli:${this.info.id}:claude:thinking] redacted_block_received collectFlag=${this.info.collectThinking}`);
          if (this.info.collectThinking) {
            this.opts.onThinkingText?.("[raciocínio omitido pelo modelo]", { redacted: true });
          }
        }
        if (b.type === "tool_use") {
          hasToolUse = true;
          this.opts.onToolUse(b.name, b.input);
          if (b.name?.includes("send_message")) this.setState("sending");
          else this.setState("thinking");
        }
      }
      if (textParts.length) {
        const text = textParts.join("\n").trim();
        if (text) {
          // Banner de rate-limit vem como texto do assistant (não é output real):
          // roteia como erro p/ o server disparar auto-retry e não zerar contador.
          // Exige contexto "API Error" (o banner do claude CLI sempre tem) p/ não
          // confundir com prosa normal do agente que cite "rate limit"/"overloaded".
          if (/API Error/i.test(text) && RATE_LIMIT_TEXT_RE.test(text)) {
            this.setState("idle");
            this.opts.onError(text);
            return;
          }
          this.setState("speaking");
          this.opts.onAssistantText(text);
        }
      }
      if (!hasToolUse && !textParts.length) this.setState("thinking");
      return;
    }
    if (event.type === "user") {
      this.setState("thinking");
      return;
    }
    if (event.type === "result") {
      this.setState("idle");
      // Resultado de erro (ex rate limit) que não veio como texto do assistant:
      // surfacia como erro p/ auto-retry. result/error pode estar em vários campos.
      if (event.is_error || event.subtype === "error_during_execution" || event.subtype === "error_max_turns") {
        const r = String(event.result ?? event.error ?? event.message ?? "");
        if (r && RATE_LIMIT_TEXT_RE.test(r)) this.opts.onError(r);
      }
      return;
    }
  }

  /* ---------- OpenCode per-message model ---------- */

  /**
   * Boot `opencode serve` por agente. Servidor persistente reusa connection
   * pool com providers HTTP → evita ECONNRESET intermitente que `opencode run`
   * standalone pega no TLS handshake de cada call (Z.AI flaky, deepseek
   * lento). Modo equivalente ao usado pela TUI internamente.
   */
  private ensureOcServer(): Promise<void> {
    if (this.ocServerUrl) return Promise.resolve();
    if (this.ocServerBootPromise) return this.ocServerBootPromise;
    this.ocServerBootPromise = new Promise<void>((resolve, reject) => {
      const proc = spawnDropped(
        this.runnerCommand("opencode"),
        ["serve", "--port", "0", "--hostname", "127.0.0.1"],
        { cwd: this.opts.workspaceRoot, env: this.buildEnv(), stdio: ["ignore", "pipe", "pipe"] },
        this.opts.dropTo ?? null,
      );
      this.ocServerProc = proc;
      let resolved = false;
      const onData = (chunk: string) => {
        const m = chunk.match(/https?:\/\/[\w.:-]+:\d+/);
        if (m && !resolved) {
          resolved = true;
          this.ocServerUrl = m[0];
          this.opts.log("info", `[cli:${this.info.id}:opencode] serve ready ${this.ocServerUrl}`);
          this.ocStartEventStream(); // permission.asked listener (auto-approve OFF)
          resolve();
        }
      };
      proc.stdout!.setEncoding("utf8");
      proc.stderr!.setEncoding("utf8");
      proc.stdout!.on("data", onData);
      proc.stderr!.on("data", onData);
      proc.on("exit", (code) => {
        this.ocServerProc = null;
        this.ocServerUrl = undefined;
        this.ocServerBootPromise = null;
        if (!resolved) reject(new Error(`opencode serve exited before listening (code ${code})`));
        else this.opts.log("warn", `[cli:${this.info.id}:opencode] serve exited (code ${code})`);
      });
      setTimeout(() => {
        if (!resolved) {
          try { proc.kill("SIGTERM"); } catch {}
          reject(new Error("opencode serve boot timeout (10s)"));
        }
      }, 10_000);
    });
    return this.ocServerBootPromise;
  }

  /** Quebra o model do opencode em provider/modelID. Tolera um sufixo legado
   *  ":<effort>" no model (ex glm-5.2:high) — só removido, NÃO aplicado: o
   *  reasoning_effort NÃO é configurável via opencode.json no provider
   *  zai-coding-plan (qualquer bloco `provider.<id>` corrompe o provider →
   *  agente mudo). O GLM-5.2 roda no default dele (reasoning_effort=max). */
  private ocModelParts(): { providerID: string; modelID: string } {
    const raw = (this.info.model ?? "").replace(/:(off|minimal|none|low|medium|high|xhigh|max)$/, "");
    const slash = raw.indexOf("/");
    const providerID = slash > 0 ? raw.slice(0, slash) : "";
    const modelID = slash > 0 ? raw.slice(slash + 1) : raw;
    return { providerID, modelID };
  }

  private runOpenCodeMessage(content: string, images?: ImageAttachment[], retry = 0) {
    if (this.stopped) return;
    if (!this.ensureRunnerAvailable("opencode")) return;
    this.setState("thinking");

    this.ensureOcServer().then(
      () => this.runOpenCodeMessageAttached(content, images, retry),
      (err) => {
        this.opts.onError(`opencode serve falhou: ${err?.message ?? err}`);
        this.ocBusy = false;
        this.setState("idle");
        this.drainOcQueue();
      }
    );
  }

  /** Máx. de retries por mensagem quando a run volta SEM output produtivo
   *  (sintoma de ECONNRESET do provider: o modelo começa o stream e a
   *  conexão TLS cai no meio → opencode sai sem emitir text/step_finish).
   *  1 retry cobre o flap intermitente (ex.: Z.AI) sem loop infinito. */
  private static readonly OC_EMPTY_RETRIES = 1;

  private async runOpenCodeMessageAttached(content: string, images?: ImageAttachment[], retry = 0) {
    if (this.stopped || !this.ocServerUrl) return;
    // first-turn wrapping pode ser re-aplicado no retry (capturado aqui).
    const wasFirstTurn = this.ocFirstTurn;
    this.ocRunSawOutput = false;
    // provider/modelID + reasoning effort (sufixo ":high"/":max" ou effort do agente).
    const { providerID, modelID } = this.ocModelParts();

    // Garante sessão no serve (POST /session). Reusa ocSessionId se já existe.
    if (!this.ocSessionId) {
      try {
        const sess = await this.ocServeFetch("/session", "POST", providerID && modelID ? { model: { id: modelID, providerID } } : {});
        if (!sess?.id) throw new Error("sessão sem id");
        this.ocSessionId = sess.id;
        if (this.opts.onSessionId) this.opts.onSessionId(sess.id);
      } catch (e) {
        this.opts.onError(`opencode: falha criando sessão no serve: ${(e as Error).message}`);
        this.ocBusy = false; this.setState("idle"); this.drainOcQueue(); return;
      }
    }

    // Resume: marca o histórico da sessão como já visto antes do 1º turno —
    // senão a drain por GET reemitiria tool calls/textos antigos nos RUNS.
    if (this.ocNeedsPrime) {
      this.ocNeedsPrime = false;
      try {
        const hist = await this.ocServeFetch(`/session/${this.ocSessionId}/message`, "GET");
        if (Array.isArray(hist)) for (const m of hist) for (const p of (m?.parts ?? [])) { if (p?.id) this.ocSeenPartIds.add(p.id); }
      } catch { /* best-effort */ }
    }

    let message = content;
    if (this.ocFirstTurn) {
      this.ocFirstTurn = false;
      const summary = this.ocPendingSummary ? `\n\n# Previous conversation summary\n${this.ocPendingSummary}` : "";
      this.ocPendingSummary = undefined;
      message = `${buildSystemPromptHeader(this.opts.features)}\n\n# Your role\n${this.info.role}\n\n${this.info.systemPrompt}\n\n# Workspace\n${this.workspaceInfo()}${summary}\n\n---\n\n${content}`;
    }
    this.traceCli("opencode", "stdin", message);
    // Transporte via API do serve (POST síncrono /session/:id/message) em vez
    // de `opencode run` — cujo stdout NÃO serializa o `text` de reasoning
    // models (ex: deepseek-v4-pro) → agente mudo. O serve retorna a message
    // completa {info, parts:[step-start, reasoning, text, tool, step-finish]}.
    // Imagens viram FilePartInput com data-URL (opencode aceita inline; sem temp).
    const parts: any[] = [{ type: "text", text: message }];
    if (images && images.length) {
      for (const img of images) {
        parts.push({ type: "file", mime: img.mimeType, url: `data:${img.mimeType};base64,${img.base64}` });
      }
    }
    let resp: any;
    try {
      resp = await this.ocServeFetch(
        `/session/${this.ocSessionId}/message`,
        "POST",
        { ...(providerID && modelID ? { model: { providerID, modelID } } : {}), parts },
        OPENCODE_TURN_TIMEOUT_MS,
      );
    } catch (e) {
      this.ocBusy = false;
      if (this.stopped) return;
      const emsg = (e as Error).message;
      if (retry < AgentRunner.OC_EMPTY_RETRIES) {
        this.opts.onError(`opencode: turno falhou (${emsg}) — retry ${retry + 1}/${AgentRunner.OC_EMPTY_RETRIES}`);
        if (wasFirstTurn) this.ocFirstTurn = true;
        this.ocBusy = true;
        setTimeout(() => { if (this.stopped) { this.ocBusy = false; return; } void this.runOpenCodeMessage(content, images, retry + 1); }, 1200);
        return;
      }
      this.opts.onError(`opencode: turno falhou após retry: ${emsg}`);
      this.setState("idle");
      this.drainOcQueue();
      return;
    }

    // O POST /message só retorna a ÚLTIMA mensagem do assistant; as tool calls
    // ficam em mensagens INTERMEDIÁRIAS do loop (uma msg por step). Busca TODAS
    // as msgs da sessão e processa só as parts novas (dedup por id) — senão os
    // RUNS (tool executions) nunca apareciam no opencode.
    await this.ocProcessNewParts(resp);

    this.ocActiveProc = null;
    this.ocBusy = false;
    if (this.stopped) return;
    if (!this.ocRunSawOutput && retry < AgentRunner.OC_EMPTY_RETRIES) {
      this.opts.onError(`opencode: resposta vazia (provável flap do provider) — retry ${retry + 1}/${AgentRunner.OC_EMPTY_RETRIES}`);
      if (wasFirstTurn) this.ocFirstTurn = true;
      this.ocBusy = true;
      setTimeout(() => { if (this.stopped) { this.ocBusy = false; return; } void this.runOpenCodeMessage(content, images, retry + 1); }, 1200);
      return;
    }
    if (!this.ocRunSawOutput) {
      this.opts.onError(`opencode: turno terminou sem texto — o modelo "${this.info.model ?? "?"}" pode não retornar resposta. Troque o modelo.`);
    }
    this.setState("idle");
    this.drainOcQueue();
  }

  /** HTTP ao opencode serve (loopback). Resolve com JSON parseado; rejeita
   *  em status !2xx ou erro de rede/timeout. Usado pelo transporte por API
   *  (POST /session, POST /session/:id/message). */
  private ocServeFetch(path: string, method: string, body?: unknown, timeoutMs = 20_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ocServerUrl) { reject(new Error("serve não está pronto")); return; }
      let u: URL;
      try { u = new URL(this.ocServerUrl + path); } catch (e) { reject(e as Error); return; }
      const data = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method,
          headers: {
            "Content-Type": "application/json",
            ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const txt = Buffer.concat(chunks).toString("utf8");
            const sc = res.statusCode ?? 0;
            if (sc >= 200 && sc < 300) {
              try { resolve(txt ? JSON.parse(txt) : {}); } catch { resolve({}); }
            } else {
              reject(new Error(`HTTP ${sc}${txt ? ` — ${txt.slice(0, 200)}` : ""}`));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
      if (data) req.write(data);
      req.end();
    });
  }

  /* ---------- OpenCode permission (auto-approve OFF) ---------- */

  /** Abre o stream SSE /event do serve p/ receber `permission.asked`. Só roda
   *  com auto-approve OFF (com ON o config já libera tudo, nenhum ask é emitido).
   *  Reabre se a conexão cair (serve vivo = sessão do agente viva). */
  private ocStartEventStream(): void {
    if (this.opts.autoApprove) return;
    if (!this.ocServerUrl || this.ocEventReq || this.stopped) return;
    let u: URL;
    try { u = new URL(this.ocServerUrl + "/event"); } catch { return; }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: "/event", method: "GET", headers: { Accept: "text/event-stream" } },
      (res) => {
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const js = line.slice(5).trim();
            if (!js) continue;
            try {
              const ev = JSON.parse(js);
              if (ev?.type === "permission.asked") void this.ocHandlePermissionAsked(ev.properties ?? {});
            } catch { /* linha SSE não-JSON (keep-alive etc) */ }
          }
        });
        res.on("end", () => { this.ocEventReq = null; this.ocReopenEvents(); });
        res.on("error", () => { this.ocEventReq = null; this.ocReopenEvents(); });
      },
    );
    req.on("error", () => { this.ocEventReq = null; this.ocReopenEvents(); });
    req.end();
    this.ocEventReq = req;
  }

  private ocReopenEvents(): void {
    if (this.stopped || this.opts.autoApprove || !this.ocServerUrl) return;
    setTimeout(() => { if (!this.stopped && this.ocServerUrl) this.ocStartEventStream(); }, 1000);
  }

  /** Resolve um permission.asked: consulta a política do orquestrador (mesma do
   *  approve_action do claude) e responde ao serve (once = libera / reject = nega). */
  private async ocHandlePermissionAsked(props: any): Promise<void> {
    const permId = props?.id as string | undefined;
    const sessionID = props?.sessionID as string | undefined;
    const tool = String(props?.permission ?? "");
    if (!permId || !sessionID) return;
    // input p/ exibir na UI: metadata (ex bash {command, description}) + patterns
    const input = { ...(props?.metadata ?? {}), patterns: props?.patterns };
    let allow = false;
    try {
      const r = await this.bridgePost("permission", { tool, input });
      allow = !!r?.allow;
    } catch (e) {
      // fail-closed: nega se a política não respondeu (igual approve_action)
      this.opts.log("warn", `[cli:${this.info.id}:opencode] permission '${tool}' negada (erro política): ${(e as Error).message}`);
    }
    try {
      await this.ocServeFetch(`/session/${sessionID}/permissions/${permId}`, "POST", { response: allow ? "once" : "reject" });
    } catch (e) {
      this.opts.log("warn", `[cli:${this.info.id}:opencode] falha respondendo permission: ${(e as Error).message}`);
    }
  }

  /** POST ao orquestrador /api/bridge/<agentId>/<route> (via socket se houver,
   *  senão HTTP). Bearer = agentToken. Timeout longo: aprovação humana pode
   *  demorar (waiter do server expira em 5min). */
  private bridgePost(route: string, body: unknown): Promise<any> {
    const data = JSON.stringify(body);
    const path = `/api/bridge/${this.info.id}/${route}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(data)),
      "Authorization": `Bearer ${this.opts.agentToken}`,
    };
    const timeoutMs = 6 * 60_000;
    return new Promise((resolve, reject) => {
      let opts: import("node:http").RequestOptions;
      if (this.opts.bridgeSocketPath) {
        opts = { socketPath: this.opts.bridgeSocketPath, path, method: "POST", headers, timeout: timeoutMs };
      } else {
        let u: URL;
        try { u = new URL(this.opts.orchestratorUrl + path); } catch (e) { reject(e as Error); return; }
        opts = { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers, timeout: timeoutMs };
      }
      const req = http.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const txt = Buffer.concat(chunks).toString("utf8");
          const sc = res.statusCode ?? 0;
          if (sc >= 200 && sc < 300) { try { resolve(txt ? JSON.parse(txt) : {}); } catch { resolve({}); } }
          else reject(new Error(`HTTP ${sc}${txt ? ` — ${txt.slice(0, 120)}` : ""}`));
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
      req.write(data);
      req.end();
    });
  }

  /** Lê TODAS as mensagens da sessão e processa as parts ainda não vistas.
   *  Cobre tool calls que vivem em mensagens intermediárias (o POST /message
   *  só devolve a última). Fallback p/ resp.parts se o GET falhar. */
  private async ocProcessNewParts(resp: any): Promise<void> {
    let messages: any[] | null = null;
    try {
      const r = await this.ocServeFetch(`/session/${this.ocSessionId}/message`, "GET");
      if (Array.isArray(r)) messages = r;
    } catch { /* cai pro fallback abaixo */ }

    const groups: any[][] = messages
      ? messages
          .filter((m) => (m?.info?.role ?? m?.role) === "assistant")
          .map((m) => (Array.isArray(m?.parts) ? m.parts : []))
      : [Array.isArray(resp?.parts) ? resp.parts : []];

    for (const parts of groups) {
      for (const p of parts) {
        const id = p?.id;
        if (id) {
          if (this.ocSeenPartIds.has(id)) continue;
          this.ocSeenPartIds.add(id);
        }
        this.ocDispatchPart(p);
      }
    }
  }

  /** Despacha uma part da resposta opencode (text/tool/step-finish). */
  private ocDispatchPart(p: any): void {
    const t = p?.type;
    if (t === "text") {
      const text = (p.text as string | undefined)?.trim();
      if (text) { this.ocRunSawOutput = true; this.setState("speaking"); this.opts.onAssistantText(text); }
    } else if (t === "tool" || t === "tool-use" || t === "tool_use" || t === "tool-call" || t === "tool_call") {
      // só conta tool já resolvida (completed/error) — evita emitir pending sem input
      const status = p.state?.status;
      if (status && status !== "completed" && status !== "error") return;
      this.ocRunSawOutput = true;
      const toolName = p.tool ?? p.name ?? p.state?.name ?? "";
      const input = p.state?.input ?? p.input ?? {};
      this.opts.onToolUse(toolName, input);
    } else if (t === "step-finish" || t === "step_finish") {
      const tokens = p.tokens;
      if (tokens) {
        const delta: AgentUsage = {
          input: Number(tokens.input ?? 0),
          output: Number(tokens.output ?? 0),
          cacheCreate: Number(tokens.cache?.write ?? 0),
          cacheRead: Number(tokens.cache?.read ?? 0),
        };
        this.opts.onUsageDelta?.(delta);
        this.checkContextUsage(delta);
      }
    }
  }

  private handleOpenCodeEvent(event: any) {
    const sid = event.sessionID as string | undefined;
    if (sid && sid !== this.ocSessionId) {
      this.ocSessionId = sid;
      if (this.opts.onSessionId) this.opts.onSessionId(sid);
    }

    switch (event.type) {
      case "text": {
        const text = (event.part?.text as string | undefined)?.trim();
        if (text) {
          this.ocRunSawOutput = true;
          this.setState("speaking");
          this.opts.onAssistantText(text);
        }
        break;
      }
      case "tool_use":
      case "tool_call": {
        this.ocRunSawOutput = true;
        const toolName = event.part?.tool ?? event.part?.name ?? "";
        const input = event.part?.state?.input ?? event.part?.input ?? {};
        this.opts.onToolUse(toolName, input);
        this.setState("thinking");
        break;
      }
      case "step_start":
        this.setState("thinking");
        break;
      case "step_finish": {
        // NÃO marca ocRunSawOutput aqui: um turno que só emite usage/step_finish
        // (sem text/tool — ex.: reasoning model cujo text não serializa pro
        // stdout) NÃO é resposta visível. Marcar aqui mascarava o mudo (sucesso
        // falso → sem retry, sem erro). Só text/tool_use/tool_call contam.
        const tokens = event.part?.tokens;
        if (tokens) {
          const delta: AgentUsage = {
            input: Number(tokens.input ?? 0),
            output: Number(tokens.output ?? 0),
            cacheCreate: Number(tokens.cache?.write ?? 0),
            cacheRead: Number(tokens.cache?.read ?? 0),
          };
          this.opts.onUsageDelta?.(delta);
          this.checkContextUsage(delta);
        }
        break;
      }
    }
  }

  /* ---------- Gemini per-message model ---------- */

  private runGeminiMessage(content: string, images?: ImageAttachment[]) {
    if (this.stopped) return;
    if (!this.ensureRunnerAvailable("gemini")) return;
    this.setState("thinking");

    const tmpDir = this.agentTmpDir();
    mkdirSync(tmpDir, { recursive: true });
    this.writeGeminiConfig();

    let message = content;
    if (this.ocFirstTurn) {
      this.ocFirstTurn = false;
      const summary = this.ocPendingSummary ? `\n\n# Previous conversation summary\n${this.ocPendingSummary}` : "";
      this.ocPendingSummary = undefined;
      message = `${buildSystemPromptHeader(this.opts.features)}\n\n# Your role\n${this.info.role}\n\n${this.info.systemPrompt}\n\n# Workspace\n${this.workspaceInfo()}${summary}\n\n---\n\n${content}`;
    }
    // Imagens: gemini lê arquivos referenciados por @<path> no prompt.
    let imgCleanup = () => {};
    if (images && images.length) {
      const { paths, cleanup } = this.writeImageTempFiles(images);
      imgCleanup = cleanup;
      if (paths.length) message += `\n\n${paths.map((p) => `@${p}`).join(" ")}`;
    }
    this.traceCli("gemini", "argv", message);

    // Gemini só conecta MCP servers nomeados na allowlist. Montar
    // dinamicamente a partir de extraMcpServers (graphify + outros do
    // workspace) — senão a feature graph fica sem efeito no gemini.
    const allowedMcp = ["the-dudes", ...Object.keys(this.opts.extraMcpServers ?? {})]
      .filter((n, i, a) => a.indexOf(n) === i)
      .join(",");
    const args = [
      "--output-format", "stream-json",
      "--include-directories", this.opts.workspaceRoot,
      "--allowed-mcp-server-names", allowedMcp,
      "--skip-trust",
      "-p", message,
    ];
    if (this.info.model) args.push("--model", this.info.model);
    if (this.opts.autoApprove) args.push("--yolo");
    // Resume previous session if one exists for this agent dir
    args.push("--resume", "latest");

    const env = {
      ...this.buildEnv(),
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    };

    this.traceSpawn("gemini", args);
    const proc = spawnDropped(this.runnerCommand("gemini"), args, {
      cwd: tmpDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }, this.opts.dropTo ?? null);
    this.ocActiveProc = proc;

    let buf = "";
    let pendingText = "";

    const flush = () => {
      const t = pendingText.trim();
      if (t) {
        this.setState("speaking");
        this.opts.onAssistantText(t);
      }
      pendingText = "";
    };

    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      this.traceCli("gemini", "stdout", chunk);
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("{")) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") {
            pendingText += ev.content;
          } else if (ev.type === "tool_call" || ev.type === "tool_use") {
            flush();
            this.opts.onToolUse(ev.name ?? "", ev.args ?? {});
            this.setState("thinking");
          } else if (ev.type === "result") {
            flush();
            const s = ev.stats ?? {};
            const delta: AgentUsage = {
              input: Number(s.input_tokens ?? s.input ?? 0),
              output: Number(s.output_tokens ?? 0),
              cacheCreate: 0,
              cacheRead: Number(s.cached ?? 0),
            };
            this.opts.onUsageDelta?.(delta);
            this.checkContextUsage(delta);
          }
        } catch {}
      }
    });

    proc.stderr!.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (msg) { this.traceCli("gemini", "stderr", msg); this.checkContextFullError(msg); this.opts.onError(msg); }
    });

    proc.on("close", (code) => {
      flush();
      imgCleanup();
      this.ocActiveProc = null;
      this.ocBusy = false;
      if (this.stopped) { this.emitExit(code); return; }
      this.setState("idle");
      this.drainOcQueue();
    });
  }

  /* ---------- Codex per-message model ---------- */

  private buildCodexConfigArgs(): string[] {
    // Codex aceita config via flags `-c key=value` em TOML inline.
    // Nome do server vira segmento da chave (`mcp_servers.<name>.command`).
    // Strings TOML usam aspas simples pra preservar chars do nome (".", "-").
    const tomlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const tomlStringArray = (xs: string[]) => `[${xs.map(tomlString).join(",")}]`;
    const tomlEnvTable = (env: Record<string, string>) => {
      const entries = Object.entries(env).map(([k, v]) => `${k}=${tomlString(v)}`);
      return `{${entries.join(",")}}`;
    };
    const tomlKey = (name: string) => /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);

    const out: string[] = [];

    // MCPs Phase 3 — extras antes do bridge (bridge reservado em "the-dudes").
    // Codex stdio only — SSE/HTTP servers descartados com warning.
    if (this.opts.extraMcpServers) {
      for (const [name, cfg] of Object.entries(this.opts.extraMcpServers)) {
        if (name === "the-dudes") continue;
        const isStdio = (cfg.type ?? "stdio") === "stdio";
        if (!isStdio || !cfg.command) {
          this.opts.log("warn", `[codex:${this.info.name}] skipping MCP "${name}" — only stdio transport is supported`);
          continue;
        }
        const k = tomlKey(name);
        out.push("-c", `mcp_servers.${k}.command=${tomlString(cfg.command)}`);
        if (cfg.args && cfg.args.length > 0) {
          out.push("-c", `mcp_servers.${k}.args=${tomlStringArray(cfg.args)}`);
        }
        if (cfg.env && Object.keys(cfg.env).length > 0) {
          out.push("-c", `mcp_servers.${k}.env=${tomlEnvTable(cfg.env)}`);
        }
      }
    }

    const env: Record<string, string> = {
      THE_DUDES_AGENT_ID: this.info.id,
      THE_DUDES_AGENT_NAME: this.info.name,
      THE_DUDES_ORCH_URL: this.opts.orchestratorUrl,
      THE_DUDES_AGENT_TOKEN_FILE: this.writeAgentTokenFile(),
      ...this.featuresEnv(),
    };
    if (this.opts.bridgeSocketPath) env.THE_DUDES_BRIDGE_SOCKET = this.opts.bridgeSocketPath;
    out.push(
      "-c", `mcp_servers.the-dudes.command=${tomlString(this.opts.bridgeCommand)}`,
      "-c", `mcp_servers.the-dudes.args=${tomlStringArray(this.opts.bridgeArgs)}`,
      "-c", `mcp_servers.the-dudes.env=${tomlEnvTable(env)}`,
    );
    return out;
  }

  private runCodexMessage(content: string, images?: ImageAttachment[]) {
    if (this.stopped) return;
    if (!this.ensureRunnerAvailable("codex")) return;
    this.setState("thinking");

    let message = content;
    if (this.ocFirstTurn) {
      this.ocFirstTurn = false;
      const summary = this.ocPendingSummary ? `\n\n# Previous conversation summary\n${this.ocPendingSummary}` : "";
      this.ocPendingSummary = undefined;
      message = `${buildSystemPromptHeader(this.opts.features)}\n\n# Your role\n${this.info.role}\n\n${this.info.systemPrompt}\n\n# Workspace\n${this.workspaceInfo()}${summary}\n\n---\n\n${content}`;
    } else {
      this.ocFirstTurn = false;
    }
    this.traceCli("codex", "argv", message);

    const configArgs = this.buildCodexConfigArgs();
    const commonFlags = [
      "--json",
      "--skip-git-repo-check",
      // Codex has no way to show approval prompts when stdin is closed;
      // our MCP tools are safe (no shell execution) so bypass is fine.
      "--dangerously-bypass-approvals-and-sandbox",
      ...configArgs,
      ...(this.info.model ? ["-m", this.info.model] : []),
      ...(this.info.effort ? ["-c", `model_reasoning_effort="${codexEffort(this.info.effort)}"`] : []),
    ];

    // Imagens: codex aceita `-i <FILE>` (repetido). Grava temp e anexa.
    let imgCleanup = () => {};
    let imageArgs: string[] = [];
    if (images && images.length) {
      const { paths, cleanup } = this.writeImageTempFiles(images);
      imgCleanup = cleanup;
      imageArgs = paths.flatMap((p) => ["-i", p]);
    }

    const args = this.ocSessionId
      ? ["exec", "resume", ...commonFlags, this.ocSessionId, ...imageArgs, message]
      : ["exec", ...commonFlags, ...imageArgs, message];

    this.traceSpawn("codex", args);
    const proc = spawnDropped(this.runnerCommand("codex"), args, {
      cwd: this.opts.workspaceRoot,
      env: this.buildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }, this.opts.dropTo ?? null);
    this.ocActiveProc = proc;

    let buf = "";

    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      this.traceCli("codex", "stdout", chunk);
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("{")) continue;
        try { this.handleCodexEvent(JSON.parse(line)); } catch {}
      }
    });

    proc.stderr!.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (msg) this.traceCli("codex", "stderr", msg);
      if (msg && msg.includes(" ERROR ") && !msg.includes("failed to record rollout items")) {
        this.opts.onError(msg);
      }
    });

    proc.on("close", (code) => {
      if (buf.trim().startsWith("{")) {
        try { this.handleCodexEvent(JSON.parse(buf.trim())); } catch {}
      }
      imgCleanup();
      this.ocActiveProc = null;
      this.ocBusy = false;
      if (this.stopped) { this.emitExit(code); return; }
      this.setState("idle");
      this.drainOcQueue();
    });
  }

  private handleCodexEvent(event: any) {
    switch (event.type) {
      case "thread.started": {
        const tid = event.thread_id as string | undefined;
        if (tid && tid !== this.ocSessionId) {
          this.ocSessionId = tid;
          if (this.opts.onSessionId) this.opts.onSessionId(tid);
        }
        break;
      }
      case "item.started": {
        const item = event.item;
        if (item?.type === "mcp_tool_call") {
          this.opts.onToolUse(item.tool ?? "", item.arguments ?? {});
          if ((item.tool as string)?.includes("send_message")) this.setState("sending");
          else this.setState("thinking");
        }
        break;
      }
      case "item.completed": {
        const item = event.item;
        if (item?.type === "agent_message") {
          const text = (item.text as string | undefined)?.trim();
          if (text) {
            this.setState("speaking");
            this.opts.onAssistantText(text);
          }
        }
        break;
      }
      case "turn.completed": {
        const u = event.usage;
        if (u) {
          const delta: AgentUsage = {
            input: Number(u.input_tokens ?? 0),
            output: Number(u.output_tokens ?? 0),
            cacheCreate: 0,
            cacheRead: Number(u.cached_input_tokens ?? 0),
          };
          this.opts.onUsageDelta?.(delta);
          this.checkContextUsage(delta);
        }
        break;
      }
    }
  }

  /** Grava imagens (base64) em arquivos temp no tmpdir do agente — pros runners
   *  per-message que aceitam imagem por caminho de arquivo (codex `-i`, gemini
   *  `@path`). Retorna paths + cleanup. opencode usa data-URL inline (não temp). */
  private writeImageTempFiles(images: ImageAttachment[]): { paths: string[]; cleanup: () => void } {
    const dir = this.agentTmpDir();
    mkdirSync(dir, { recursive: true });
    const paths: string[] = [];
    images.forEach((img, i) => {
      const p = path.join(dir, `img-${Date.now()}-${i}.${mimeToExt(img.mimeType)}`);
      try { writeFileSync(p, Buffer.from(img.base64, "base64"), { mode: 0o600 }); paths.push(p); }
      catch (e) { this.opts.log("warn", `[cli:${this.info.id}] falha gravando imagem temp: ${(e as Error).message}`); }
    });
    return { paths, cleanup: () => { for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* noop */ } } } };
  }

  private drainOcQueue() {
    if (this.ocBusy || this.ocQueue.length === 0 || this.stopped) return;
    this.ocBusy = true;
    const { content, images } = this.ocQueue.shift()!;
    if (this.opts.cliRunner === "gemini") {
      this.runGeminiMessage(content, images);
    } else if (this.opts.cliRunner === "codex") {
      this.runCodexMessage(content, images);
    } else {
      this.runOpenCodeMessage(content, images);
    }
  }

  /* ---------- public API ---------- */

  // Cap defensivo nas filas: server malicioso (token roubado) ou bug
  // em restart loop podia floodar agent:send → memory unbounded. 100
  // mensagens cobre fluxo legítimo de retomada após restart longo
  // (compact_context, etc); ataque vê erro logado e drop silencioso.
  private static readonly MAX_BUFFERED_MESSAGES = 100;

  pushUserMessage(content: string, images?: ImageAttachment[]) {
    if (this.opts.cliRunner === "opencode" || this.opts.cliRunner === "gemini" || this.opts.cliRunner === "codex") {
      if (this.ocQueue.length >= AgentRunner.MAX_BUFFERED_MESSAGES) {
        this.opts.log("warn", `[cli:${this.info.id}:${this.opts.cliRunner}] ocQueue cheia (${this.ocQueue.length}) — drop mensagem`);
        return;
      }
      this.ocQueue.push({ content, images });
      this.drainOcQueue();
      return;
    }
    // Durante restart (clearContext/compact) ou se proc ainda não está
    // writable, buffera. Flush acontece no spawn callback do startClaude.
    if (this.restarting || !this.proc || !this.proc.stdin.writable) {
      if (this.pendingMessages.length >= AgentRunner.MAX_BUFFERED_MESSAGES) {
        this.opts.log("warn", `[cli:${this.info.id}:claude] pendingMessages cheia (${this.pendingMessages.length}) — drop mensagem durante restart`);
        return;
      }
      this.pendingMessages.push({ content, images });
      this.opts.log("info", `[cli:${this.info.id}:claude] buffered message during restart (queued=${this.pendingMessages.length})`);
      return;
    }
    let messageContent: any;
    if (images && images.length > 0) {
      const blocks: any[] = [];
      if (content) blocks.push({ type: "text", text: content });
      for (const img of images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mimeType, data: img.base64 },
        });
      }
      messageContent = blocks;
    } else {
      messageContent = content;
    }
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: messageContent },
    });
    this.traceCli("claude", "stdin", line);
    this.proc.stdin.write(line + "\n");
    this.setState("thinking");
  }

  stop() {
    this.stopped = true;
    // Limpa buffers pendentes — sem isso, mensagens bufferadas durante
    // restart ficam em memory por toda vida do AgentRunner (mesmo após
    // stop). Cleanup explicit pra GC.
    this.pendingMessages = [];
    this.ocQueue = [];
    if (this.ocEventReq) { try { this.ocEventReq.destroy(); } catch { /* noop */ } this.ocEventReq = null; }
    if (this.opts.cliRunner === "opencode" || this.opts.cliRunner === "gemini" || this.opts.cliRunner === "codex") {
      if (this.ocServerProc && !this.ocServerProc.killed) {
        try { this.ocServerProc.kill("SIGTERM"); } catch {}
        setTimeout(() => {
          if (this.ocServerProc && !this.ocServerProc.killed) { try { this.ocServerProc.kill("SIGKILL"); } catch {} }
        }, 1500);
      }
      if (this.ocActiveProc && !this.ocActiveProc.killed) {
        this.ocActiveProc.kill("SIGTERM");
        setTimeout(() => {
          if (this.ocActiveProc && !this.ocActiveProc.killed) this.ocActiveProc.kill("SIGKILL");
        }, 1500);
      } else {
        this.emitExit(0);
      }
      return;
    }
    if (this.proc && !this.proc.killed) {
      try { this.proc.stdin.end(); } catch {}
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
      }, 1500);
    }
  }

  async clearContext(): Promise<void> {
    if (this.opts.cliRunner === "claude") {
      await this.killClaudeForRestart();
      this.opts.resumeSessionId = undefined;
      this.info.sessionId = undefined;
      if (this.opts.onSessionId) this.opts.onSessionId("");
      this.startClaude();
      this.opts.onError("[ctx] context cleared — claude restarted with new session");
      return;
    }
    if (this.ocActiveProc && !this.ocActiveProc.killed) {
      try { this.ocActiveProc.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        if (this.ocActiveProc && !this.ocActiveProc.killed) try { this.ocActiveProc.kill("SIGKILL"); } catch {}
      }, 1500);
    }
    this.ocQueue = [];
    this.ocBusy = false;
    this.resetWithSummary(undefined);
    this.info.sessionId = undefined;
    if (this.opts.onSessionId) this.opts.onSessionId("");
    this.setState("idle");
    this.opts.onError("[ctx] context cleared — next message starts new session");
  }

  async compactContext(saveMemory = true): Promise<void> {
    // OpenCode roda via serve HTTP. O one-shot runOneShot/resetWithSummary
    // abaixo NÃO toca a sessão do serve → "compact não faz nada". Aqui:
    // (1) AUTO-EXTRACT de memória (Fase 3) num FORK da sessão (não polui a
    //     conversa real) — pede MEMORY_JSON, parseia, salva via bridge;
    // (2) compacta a sessão real com o summarize NATIVO do serve.
    if (this.opts.cliRunner === "opencode") {
      if (!this.ocServerUrl || !this.ocSessionId) {
        this.opts.onError("[ctx] compact: sessão opencode ainda não ativa — manda uma mensagem primeiro");
        return;
      }
      const slash = (this.info.model ?? "").indexOf("/");
      const providerID = slash > 0 ? (this.info.model as string).slice(0, slash) : "";
      const modelID = slash > 0 ? (this.info.model as string).slice(slash + 1) : (this.info.model ?? "");
      if (!providerID || !modelID) { this.opts.onError("[ctx] compact: modelo inválido"); return; }

      // (1) auto-extract via fork (mesmo prompt do claude) — só se pedido
      if (saveMemory) try {
        const existingTitles = await this.fetchExistingMemoryTitles();
        const already = existingTitles.length > 0
          ? ` Do NOT repeat anything already saved (skip): ${existingTitles.map((t) => `"${t}"`).join(", ")}.`
          : "";
        const extractPrompt =
          "Extract NEW durable knowledge from this conversation worth keeping permanently — every explicit decision, convention, preference, architectural choice or stable fact. Be generous." + already +
          " Respond with ONLY one line: `MEMORY_JSON:` + a single-line JSON array, each item {\"title\":\"<short>\",\"body\":\"<full>\",\"type\":\"decision\"|\"fact\"|\"reference\"|\"preference\"} in the conversation's language. Use `MEMORY_JSON: []` if nothing. No markdown.";
        const fork = await this.ocServeFetch(`/session/${this.ocSessionId}/fork`, "POST", {});
        const forkId = fork?.id as string | undefined;
        if (forkId) {
          try {
            const resp = await this.ocServeFetch(`/session/${forkId}/message`, "POST",
              { model: { providerID, modelID }, parts: [{ type: "text", text: extractPrompt }] }, 120_000);
            const text = (Array.isArray(resp?.parts) ? resp.parts : [])
              .filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("\n");
            this.opts.onError(`[ctx] fork-extract respLen=${text.length} marker=${/MEMORY_JSON/.test(text)}`);
            const { items } = this.parseAndStripMemory(text);
            void this.saveExtractedMemory(items);
            this.opts.onError(`[ctx] memória: ${items.length} fato(s) extraído(s) na compactação`);
          } finally {
            void this.ocServeFetch(`/session/${forkId}`, "DELETE").catch(() => {});
          }
        }
      } catch (e) {
        this.opts.onError(`[ctx] auto-extract falhou: ${(e as Error).message}`);
      }

      // (2) compacta a sessão real
      try {
        await this.ocServeFetch(`/session/${this.ocSessionId}/summarize`, "POST", { providerID, modelID }, 120_000);
        this.opts.onError(`[ctx] contexto compactado${saveMemory ? " + memória salva" : " (sem salvar memória)"}`);
      } catch (e) {
        this.opts.onError(`[ctx] compact falhou: ${(e as Error).message}`);
      }
      return;
    }

    // Phase 3 — auto-extract durable memory on compaction. The summary
    // one-shot already has the full plaintext context (via --resume), so
    // we ask it to ALSO emit a MEMORY_JSON line. The daemon parses it,
    // strips it from the continuation summary, and writes each entry via
    // the bridge relay (which E2EE-encrypts title/body). One LLM call,
    // no extra cost.
    // Dedup da auto-extração: passa os títulos já em memória pro modelo
    // não re-emitir fatos existentes (rewordings escapam do hash exato).
    const existingTitles = await this.fetchExistingMemoryTitles();
    const alreadyBlock = existingTitles.length > 0
      ? ` Do NOT repeat anything already saved in memory (skip these): ${existingTitles.map((t) => `"${t}"`).join(", ")}.`
      : "";
    const summaryPrompt =
      "Two tasks. Write BOTH the summary and the memory entries in the SAME LANGUAGE as the conversation (e.g. if the conversation is in Portuguese, respond in Portuguese). Only the `MEMORY_JSON:` marker and JSON keys stay in English.\n\n" +
      "TASK 1 — Summarize this conversation concisely (decisions made, tasks in progress, key findings, context needed to continue). Be brief.\n\n" +
      "TASK 2 — Extract NEW durable knowledge worth keeping permanently. Include EVERY explicit decision, convention, preference, architectural choice, or stable fact stated by the user or any agent — even a single one matters. Be generous: when in doubt, include it." + alreadyBlock + " Output it on a NEW FINAL LINE as exactly `MEMORY_JSON:` followed by a single-line JSON array. Each element MUST be {\"title\": \"<short>\", \"body\": \"<the fact in full>\", \"type\": \"decision\"|\"fact\"|\"reference\"|\"preference\"} where title/body are in the conversation's language. " +
      "Example: MEMORY_JSON: [{\"title\":\"DB engine\",\"body\":\"The project uses PostgreSQL partitioned by month\",\"type\":\"decision\"}]. " +
      "Output `MEMORY_JSON: []` ONLY if there is no NEW durable info. No markdown, no code fences, single line.";

    if (this.opts.cliRunner === "claude") {
      const oldSession = this.opts.resumeSessionId ?? this.info.sessionId;
      this.opts.onError(`[compact] killing process, oldSession=${oldSession ?? "none"}`);
      await this.killClaudeForRestart();
      this.opts.onError(`[compact] running summary one-shot…`);
      const summary = oldSession ? await this.runOneShotWithSession(summaryPrompt, oldSession) : "";
      this.opts.onError(`[compact] summary length=${summary.length}`);
      this.opts.resumeSessionId = undefined;
      this.info.sessionId = undefined;
      this.startClaude();
      if (summary) {
        const { clean, items } = this.parseAndStripMemory(summary);
        if (saveMemory) void this.saveExtractedMemory(items);
        await new Promise((r) => setTimeout(r, 600));
        this.pushUserMessage(`# Previous conversation summary\n${clean}\n\n---\n\nContinue from here.`);
      }
      return;
    }

    // codex/gemini: one-shot que resume a sessão (codex exec resume / gemini
    // --resume latest) e parseia MEMORY_JSON. Diag de tamanho pra ver se o
    // one-shot retornou texto (vazio = resume falhou ou reasoning model não
    // serializou o agent_message).
    const summary = await this.runOneShot(summaryPrompt);
    this.opts.onError(`[compact] ${this.opts.cliRunner} summary length=${(summary || "").length}`);
    const { clean, items } = this.parseAndStripMemory(summary || "");
    if (saveMemory) void this.saveExtractedMemory(items);
    if (clean) {
      this.resetWithSummary(clean);
      this.opts.onError(`[ctx] contexto compactado${saveMemory ? ` (${items.length} memória(s) salvas)` : " (sem salvar memória)"}`);
    } else {
      this.opts.onError(`[ctx] compact: one-shot ${this.opts.cliRunner} sem resumo — sessão não compactada (resume/parsing). Mande uma mensagem e tente de novo.`);
    }
  }

  /** Extrai o bloco `MEMORY_JSON: [...]` do output do summary one-shot,
   *  retorna o summary limpo (sem o bloco) + os itens parseados. Tolerante
   *  a markdown/prefixos e a JSON malformado (retorna [] nesse caso). */
  private parseAndStripMemory(summary: string): { clean: string; items: Array<{ title: string; body: string; type: string }> } {
    const m = summary.match(/^[ \t>*-]*MEMORY_JSON:\s*(\[[\s\S]*?\])\s*$/m);
    if (!m) return { clean: summary.trim(), items: [] };
    let items: Array<{ title: string; body: string; type: string }> = [];
    try {
      const arr = JSON.parse(m[1]);
      if (Array.isArray(arr)) {
        const allowed = new Set(["fact", "decision", "reference", "preference", "task_state"]);
        // Tolerante a variações de schema do modelo: aceita item como
        // objeto (várias keys alternativas) ou string solta.
        const pick = (o: any, keys: string[]): string => {
          for (const k of keys) if (typeof o?.[k] === "string" && o[k].trim()) return o[k];
          return "";
        };
        items = arr
          .map((x) => {
            if (typeof x === "string") {
              const s = x.trim();
              return { title: s.slice(0, 80), body: s, type: "fact" };
            }
            const title = pick(x, ["title", "name", "heading", "summary"]);
            const body = pick(x, ["body", "content", "detail", "details", "text", "value", "description"]) || title;
            const rawType = typeof x?.type === "string" ? x.type : (typeof x?.kind === "string" ? x.kind : "fact");
            return { title: (title || body).slice(0, 200), body: body.slice(0, 4000), type: allowed.has(rawType) ? rawType : "fact" };
          })
          .filter((it) => it.title && it.body)
          .slice(0, 5);
      }
    } catch { /* malformed — skip extraction, keep summary */ }
    const clean = summary.replace(m[0], "").trim();
    return { clean, items };
  }

  /** Grava as memórias auto-extraídas via relay socket — o relay cifra
   *  title/body com a project key (server cego). Sem relay socket, pula
   *  pra não mandar plaintext ao server (E2EE fail-safe). */
  private async saveExtractedMemory(items: Array<{ title: string; body: string; type: string }>): Promise<void> {
    this.opts.onError(`[compact] memory extracted=${items.length}`);
    if (items.length === 0) return;
    const socket = this.opts.bridgeSocketPath;
    if (!socket) {
      this.opts.onError(`[compact] ${items.length} memory item(s) skipped — no bridge relay (would bypass E2EE)`);
      return;
    }
    let saved = 0;
    for (const it of items) {
      try {
        await this.postBridgeJson(socket, "memory_add", { title: it.title, body: it.body, type: it.type, scope: "project" });
        saved++;
      } catch (e) {
        this.opts.onError(`[compact] memory save failed: ${(e as Error).message}`);
      }
    }
    if (saved > 0) this.opts.onError(`[compact] auto-saved ${saved} memory entry(ies)`);
  }

  /** Títulos das memórias já existentes (project + camada agent), via relay
   *  socket (decriptados no inbound). Usado pra dedup da auto-extração. */
  private async fetchExistingMemoryTitles(): Promise<string[]> {
    const socket = this.opts.bridgeSocketPath;
    if (!socket) return [];
    try {
      const r = await this.postBridgeJson(socket, "memory_list", {});
      const mems = Array.isArray(r?.memories) ? r.memories : [];
      return mems
        .map((m: any) => (typeof m.title === "string" ? m.title.trim() : ""))
        .filter(Boolean)
        .slice(0, 40);
    } catch {
      return [];
    }
  }

  private postBridgeJson(socketPath: string, route: string, body: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body ?? {});
      const req = http.request(
        {
          socketPath,
          method: "POST",
          path: `/api/bridge/${this.info.id}/${route}`,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.opts.agentToken}`,
            "Content-Length": Buffer.byteLength(data),
          },
          timeout: 15000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            if (res.statusCode && res.statusCode < 300) {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
              catch { resolve({}); }
            } else reject(new Error(`HTTP ${res.statusCode}`));
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.write(data);
      req.end();
    });
  }

  private async killClaudeForRestart(): Promise<void> {
    if (!this.proc || this.proc.killed) return;
    this.restarting = true;
    await new Promise<void>((resolve) => {
      const proc = this.proc!;
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      proc.once("exit", done);
      try { proc.stdin.end(); } catch {}
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (proc && !proc.killed) proc.kill("SIGKILL");
      }, 1500);
      setTimeout(done, 3000);
    });
    this.restarting = false;
  }

  private async runOneShotWithSession(prompt: string, sessionId: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.ensureRunnerAvailable("claude")) {
        resolve("");
        return;
      }
      const args = ["--print", "-p", prompt, "--resume", sessionId];
      if (this.info.model) args.push("--model", this.info.model);
      this.traceSpawn("claude", args);
      const proc = spawnDropped(this.runnerCommand("claude"), args, {
        cwd: this.opts.workspaceRoot,
        env: this.buildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, this.opts.dropTo ?? null);
      proc.stdout!.setEncoding("utf8");
      proc.stderr!.setEncoding("utf8");
      let out = "";
      proc.stdout!.on("data", (c: string) => { this.traceCli("claude", "stdout", c); out += c; });
      proc.stderr!.on("data", (c: string) => { this.traceCli("claude", "stderr", c); });
      proc.on("close", () => resolve(out.trim()));
      proc.on("error", () => resolve(""));
    });
  }

  /** Encaminha onExit pro orchestrator no máximo uma vez (guard idempotente
   *  contra stop() repetido ou close handler racing). */
  private emitExit(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    // Remove o token-file plaintext + tmpdir no fim de vida — sem isso o token
    // (válido até o server reiniciar, que re-arma todos) ficava em /tmp pra
    // sempre, colhível por qualquer processo same-uid futuro (#11/rodada 3).
    this.cleanupAgentTmpDir();
    this.opts.onExit(code);
  }

  private setState(state: AgentRuntimeState) {
    if (state === this.currentState) return;
    this.currentState = state;
    this.info.state = state;
    this.opts.onState(state);
  }
}

/**
 * Codex reasoning levels (per the gpt-5.x picker): low | medium | high |
 * xhigh ("Extra high"). Pass our EffortLevel through, cap "max" → "xhigh"
 * since that's the highest codex accepts.
 */
function codexEffort(level: string): string {
  if (level === "low" || level === "medium" || level === "high" || level === "xhigh") return level;
  return "xhigh";
}

function isMissingSessionMessage(msg: string): boolean {
  return MISSING_SESSION_PATTERNS.some((p) => p.test(msg));
}

export function extractOneShotText(out: string, runner: CliRunner): string {
  if (runner === "codex") {
    const texts: string[] = [];
    for (const line of out.split("\n")) {
      try {
        const ev = JSON.parse(line.trim());
        if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
          texts.push(ev.item.text ?? "");
        }
      } catch {}
    }
    return texts.join("\n").trim();
  }
  if (runner === "gemini") {
    const texts: string[] = [];
    for (const line of out.split("\n")) {
      try {
        const ev = JSON.parse(line.trim());
        if (ev.type === "message" && ev.role === "assistant") texts.push(String(ev.content ?? ""));
      } catch {}
    }
    return texts.join("\n").trim();
  }
  if (runner === "opencode") {
    const texts: string[] = [];
    for (const line of out.split("\n")) {
      try {
        const ev = JSON.parse(line.trim().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""));
        if (ev.type === "text") texts.push(String(ev.part?.text ?? ""));
      } catch {}
    }
    return texts.join("\n").trim();
  }
  return out.trim();
}
