import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import { writeFileSync, readFileSync, readdirSync, realpathSync, mkdirSync, rmSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentInfo, AgentRuntimeState, AgentUsage, CliRunner, ImageAttachment } from "./types.js";
import type { ContextFeatures } from "./protocol.js";
import { spawnDropped, type DropTarget } from "./privileges.js";
import type { ResolvedCliCommands } from "./cli-config.js";
import { resolvePython3 } from "./cli-config.js";
import { buildGraph, graphExists, graphPath } from "./graph-indexer.js";
import { isPerMessageRunner, runnerAdapter } from "./runners/index.js";
import { claudeOneShotArgs, codexOneShotArgs, crushOneShotArgs, geminiOneShotArgs, grokHeadlessArgs, opencodeOneShotArgs } from "./runners/args.js";
import { buildBaseRunnerEnv, buildBridgeAwareEnv, buildGeminiEnv, buildGrokEnv } from "./runners/env.js";
import { extractOneShotText, grokSignalsPath, parseGrokChatToolCalls, parseGrokContextSignals, type GrokContextSignals } from "./runners/parsers.js";
import { parseCodexTurnEvent, parseCrushSessionMeta, parseGeminiTurnEvent, parseGrokStreamEvent, parseOpenCodeTurnEvent } from "./runners/turn-parsers.js";
import { buildBridgeEnv, buildClaudeMcpConfig, buildCodexMcpArgs, buildCrushMcpConfig, buildGeminiMcpServers, buildGrokMcpToml, buildOpenCodeMcpConfig } from "./runners/mcp-config.js";
import { RunnerRuntimeFiles } from "./runners/runtime-files.js";
import { ContextTracker, CumulativeUsageTracker, type UsageSemantics } from "./runners/context-tracker.js";
import { armHardTimeout, collectProcessOutput, killProcess, processAlive as procAlive, terminateAndWait, terminateWithEscalation } from "./runners/process-lifecycle.js";
import { OpenCodeTransport } from "./runners/opencode-transport.js";
import { buildOpenCodeAgentConfig, OPENCODE_MANAGED_AGENT } from "./runners/opencode-effort.js";
import { PerMessageSessionState } from "./runners/message-session.js";
import { buildAgentContext, buildInitialMessage, buildSystemPromptHeader, buildWorkspacePrompt } from "./runners/prompts.js";
import { claudeThinkingEffort, codexEffort, providerModelParts, resolveContextLimit } from "./runners/model-policy.js";
import { classifyRunnerFailure, isAbortedFailure, isApiErrorMessage, isAuthenticationFailure, isLoopStopMessage, isMissingSessionFailure as isMissingSessionMessage } from "./runners/error-classifier.js";
import { appendFileImagePrompt, buildClaudeUserContent, buildOpenCodeParts, codexImageArgs, imageExtension } from "./runners/attachments.js";
export { extractOneShotText, grokSignalsPath, normalizeGrokCwd, parseGrokChatToolCalls, parseGrokContextSignals } from "./runners/parsers.js";
export { CONTEXT_FULL_PATTERNS, RATE_LIMIT_TEXT_RE, contextTokensOf } from "./runners/context-tracker.js";
export { DEFAULT_CONTEXT_LIMIT, MODEL_CONTEXT_LIMITS, contextLimitFor, lookupContextLimit } from "./runners/model-policy.js";


/** Semântica do delta de usage por runner:
 *  - "anthropic" (claude): `input` EXCLUI cache — total = input + cacheCreate
 *    + cacheRead;
 *  - "inclusive" (codex/gemini): `input` já INCLUI o cache lido;
 *  - "auto" (opencode): o formato segue o provider — decide pela relação
 *    entre as parcelas (cache ⊆ input ⇒ inclusivo, senão soma). */
/** Timeout dos one-shots de resumo (compact). Sem isso, um CLI travado
 *  segura o guard `compacting` pra sempre e o agente fica sem processo. */
const ONE_SHOT_TIMEOUT_MS = 300_000;
/** Timeout do turno opencode via API do serve (POST /message é síncrono e pode
 *  rodar tools por minutos). Generoso; o serve é morto no stop() se preciso. */
const OPENCODE_TURN_TIMEOUT_MS = 600_000;
/** Timeout do turno headless Grok (`grok -p …`). Sem isso, um resume + system
 *  prompt gigante (skills) deixa o processo zumbi por horas com busy=true e
 *  a fila enche (`ocQueue cheia`). 12 min cobre turnos longos com tools. */
const GROK_TURN_TIMEOUT_MS = 12 * 60_000;

// Banner de rate-limit do provider que o claude CLI emite como TEXTO do assistant
// (não como erro). Sem isto o server trata como output real, cifra (E2EE), e o
// auto-retry nunca dispara — pior, zera o contador. Roteamos como erro.
// Ex: "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
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
  /** Ocupação absoluta da janela (não delta de billing). Emitido a cada update. */
  onContextUsage?: (used: number, limit: number) => void;
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


export class AgentRunner {
  readonly info: AgentInfo;
  private readonly runtimeFiles: RunnerRuntimeFiles;
  private readonly contextTracker: ContextTracker;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private currentState: AgentRuntimeState = "idle";

  /** Returns the runner's current runtime state — used during WS resync. */
  currentRuntimeState(): AgentRuntimeState { return this.currentState; }

  // OpenCode / Gemini per-message model
  private readonly messageSession: PerMessageSessionState;
  /** IDs de parts já processadas (dedup entre turnos). O POST /message só
   *  retorna a ÚLTIMA mensagem do assistant; tool calls ficam em mensagens
   *  intermediárias do loop → buscamos TODAS as msgs e processamos as novas. */
  private ocSeenPartIds = new Set<string>();
  /** Sessão veio de resume → primeira drain deve "marcar como visto" o histórico
   *  sem reemitir (senão tool calls/textos antigos reapareceriam nos RUNS). */
  private ocActiveProc: ChildProcess | null = null;
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
  // OpenCode serve+attach — connection pool warm evita ECONNRESET
  // intermitente de providers (Z.AI, deepseek) que `opencode run` standalone
  // pega na criação de socket nova cada call.
  private readonly openCodeTransport: OpenCodeTransport;

  // Context tracking
  /** Falhas consecutivas de compact — teto contra loop infinito de retry
   *  quando a falha é determinística (sessão acima do hard cap da API). */
  /** Guard de reentrância do compactContext. */
  private compacting = false;
  /** Guard de reentrância do clearContext — simétrico ao `compacting`: sem
   *  ele, clear durante clear (ou compact durante clear) roda dois
   *  killClaudeForRestart+startClaude em paralelo → processo claude órfão. */
  private clearing = false;
  /** One-shot de resumo em voo (compact codex/gemini/opencode) — precisa de
   *  kill no stop(), senão roda órfão por até ONE_SHOT_TIMEOUT_MS. */
  private oneShotProc: ChildProcess | null = null;
  /** Base acumulada dos stats do gemini (uiTelemetryService acumula por
   *  processo E re-hidrata o histórico no --resume): billing por turno é o
   *  delta contra a base, nunca o valor bruto. */
  private gemUsage = new CumulativeUsageTracker({ input: 0, output: 0, cached: 0 });
  /** Base acumulada do crush (session show --json reporta prompt/completion
   *  tokens CUMULATIVOS da sessão): billing por turno = delta contra a base.
   *  null = ainda não primed — sessão RESUMIDA precisa ler o meta atual antes
   *  do primeiro turno, senão o primeiro delta re-fatura o histórico inteiro
   *  (mesmo bug que o gemini teve com gemStatsBase=0 no resume). */
  private crushUsage = new CumulativeUsageTracker<{ prompt: number; completion: number }>(null);
  /** Geração da sessão oc — incrementada em todo resetWithSummary. Eventos de
   *  um turno spawnado num epoch anterior (proc morto pelo clear drenando
   *  stdout, thread.started tardio do codex) são descartados por comparação
   *  de epoch — descartar por `compacting` engolia eventos LEGÍTIMOS do turno
   *  em voo durante a fase de waitOcIdle. */
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
    this.messageSession = new PerMessageSessionState();
    this.runtimeFiles = new RunnerRuntimeFiles({
      workspaceRoot: opts.workspaceRoot,
      agentId: info.id,
      agentToken: opts.agentToken,
      home: opts.dropTo?.home ?? process.env.HOME ?? os.homedir(),
    });
    this.contextTracker = new ContextTracker({
      resolveLimit: (resolvedModel, catalogLimit) => resolveContextLimit({
        configuredModel: this.info.model, resolvedModel, catalogLimit,
      }),
      onUsage: opts.onContextUsage,
      onWarning: opts.onContextWarning,
      onFull: opts.onContextFull,
      onError: opts.onError,
    });
    this.openCodeTransport = new OpenCodeTransport({
      spawnServer: () => spawnDropped(
        this.runnerCommand("opencode"),
        ["serve", "--port", "0", "--hostname", "127.0.0.1"],
        { cwd: this.opts.workspaceRoot, env: this.buildEnv(), stdio: ["ignore", "pipe", "pipe"] },
        this.opts.dropTo ?? null,
      ),
      streamEvents: !opts.autoApprove,
      onReady: (url) => this.opts.log("info", `[cli:${this.info.id}:opencode] serve ready ${url}`),
      onExit: (code) => this.opts.log("warn", `[cli:${this.info.id}:opencode] serve exited (code ${code})`),
      onEvent: (event) => {
        const value = event as { type?: string; properties?: unknown };
        if (value?.type === "permission.asked") void this.ocHandlePermissionAsked(value.properties ?? {});
      },
    });
    if (isPerMessageRunner(opts.cliRunner) && opts.resumeSessionId) {
      this.messageSession.resume(opts.resumeSessionId, {
        needsPrime: opts.cliRunner === "opencode",
        alreadyHasSystemPrompt: runnerAdapter(opts.cliRunner).resumedSessionAlreadyHasSystemPrompt,
      });
      // crush: o acumulador fica sem base → primeiro finishCrushTurn faz prime
      // do meta cumulativo antes de faturar (sessão resumida ≠ base zero).
      // grok/codex/crush/gemini: a sessão JÁ tem o system prompt. Re-injetar
      // no first turn com --resume (system + skills + histórico) é o que
      // travava o gitlab/grok por horas (busy preso, fila em 100).
    }
  }

  private runnerCommand(runner: CliRunner): string {
    return runnerAdapter(runner).command(this.opts.cliCommands);
  }

  private workspaceInfo(): string {
    return buildWorkspacePrompt({ workspaceRoot: this.opts.workspaceRoot, repo: this.info.repo });
  }

  private promptContext(summary?: string, addon?: string) {
    return {
      capabilityHeader: buildSystemPromptHeader(this.opts.features),
      role: this.info.role,
      systemPrompt: this.info.systemPrompt,
      workspace: this.workspaceInfo(),
      summary,
      addon,
    };
  }

  private initialMessage(content: string, summary?: string): string {
    return buildInitialMessage({ ...this.promptContext(summary), content });
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

  /** Remove o tmpdir do agente (token plaintext + sessions). Best-effort,
   *  chamado no fim de vida pra não deixar token válido em /tmp. */
  private cleanupAgentTmpDir(): void {
    this.runtimeFiles.cleanup();
  }

  contextLimit(): number {
    return this.contextTracker.limit();
  }

  resetWithSummary(summary?: string): void {
    this.messageSession.reset(summary);
    this.ocSeenPartIds.clear();
    // Sessão nova nasce sem --resume (gemini) → stats do CLI voltam a zero;
    // manter a base antiga zeraria o billing dos primeiros turnos via clamp.
    this.gemUsage.reset({ input: 0, output: 0, cached: 0 });
    // crush: sessão nova = meta cumulativo novo começa do zero.
    this.crushUsage.reset({ prompt: 0, completion: 0 });
    // grok: sessão descartada → ids de tool_call antigos nunca mais colidem;
    // sem a poda o Set crescia sem teto pela vida do daemon. Sessão nova não
    // tem histórico pra silenciar → primed=true (prime é só pra resume).
    this.grokSeenToolCallIds.clear();
    this.grokChatSweepState = null;
    this.grokToolsPrimed = true;
    this.resetContextAccounting();
  }

  /** Zera a contabilidade de contexto (warning, cooldown de full, contador).
   *  Chamar em TODO caminho que troca/compacta a sessão — sem isso o warning
   *  de 85% vira one-shot por vida do runner e o onContextFull fica em cooldown. */
  private resetContextAccounting(): void {
    this.contextTracker.reset();
  }

  async runOneShot(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      // stop() antes do spawn: sem o check, o one-shot nasce DEPOIS do
      // emitExit (que apagou o tmpdir) e roda órfão consumindo API.
      if (this.stopped) { resolve(""); return; }
      if (!this.ensureRunnerAvailable(this.opts.cliRunner)) {
        resolve("");
        return;
      }
      let proc: ChildProcess;
      const runner = this.opts.cliRunner;
      const sid = runner === "claude" ? this.opts.resumeSessionId : this.messageSession.sessionId;

      if (runner === "gemini") {
        const args = geminiOneShotArgs({ prompt, model: this.info.model, sessionId: sid });
        this.traceCli("gemini", "argv", prompt);
        this.traceSpawn("gemini", args);
        proc = spawnDropped(this.runnerCommand("gemini"), args, {
          cwd: this.runtimeFiles.tempDir(),
          env: buildGeminiEnv(this.buildEnv()),
          stdio: ["ignore", "pipe", "pipe"],
        }, this.opts.dropTo ?? null);
      } else if (runner === "codex") {
        const args = codexOneShotArgs({ prompt, model: this.info.model, sessionId: sid });
        this.traceCli("codex", "argv", prompt);
        this.traceSpawn("codex", args);
        proc = spawnDropped(this.runnerCommand("codex"), args, {
          cwd: this.opts.workspaceRoot,
          env: this.buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, this.opts.dropTo ?? null);
      } else if (runner === "crush") {
        const args = crushOneShotArgs({ prompt, model: this.info.model, sessionId: sid, dataDir: this.runtimeFiles.crushDataDir() });
        this.traceCli("crush", "argv", prompt);
        this.traceSpawn("crush", args);
        proc = spawnDropped(this.runnerCommand("crush"), args, {
          cwd: this.opts.workspaceRoot,
          env: this.crushTurnEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, this.opts.dropTo ?? null);
      } else if (runner === "grok") {
        // Headless one-shot: plain text (compact/summarize). Session resume
        // via --resume; --always-approve = non-interactive tool approval.
        const args = this.buildGrokHeadlessArgs(prompt, {
          resume: sid,
          outputFormat: "json",
          forCompact: true,
        });
        this.traceCli("grok", "argv", prompt);
        this.traceSpawn("grok", args);
        proc = spawnDropped(this.runnerCommand("grok"), args, {
          cwd: this.opts.workspaceRoot,
          env: this.grokTurnEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, this.opts.dropTo ?? null);
      } else if (runner === "opencode") {
        const args = opencodeOneShotArgs({ prompt, model: this.info.model, sessionId: sid, autoApprove: this.opts.autoApprove });
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
        const args = claudeOneShotArgs({ prompt, model: this.info.model, sessionId: sid });
        this.traceCli("claude", "argv", prompt);
        this.traceSpawn("claude", args);
        proc = spawnDropped(this.runnerCommand("claude"), args, {
          cwd: this.opts.workspaceRoot,
          env: this.buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, this.opts.dropTo ?? null);
      }

      this.oneShotProc = proc; // stop() precisa alcançar o one-shot (senão roda órfão até o timeout)
      void collectProcessOutput(proc, {
        timeoutMs: ONE_SHOT_TIMEOUT_MS,
        onStdout: (chunk) => this.traceCli(runner, "stdout", chunk),
        onStderr: (chunk) => this.traceCli(runner, "stderr", chunk),
      }).then((result) => {
        if (this.oneShotProc === proc) this.oneShotProc = null;
        resolve(result.timedOut ? "" : extractOneShotText(result.stdout, runner));
      });
    });
  }

  private checkContextUsage(delta: AgentUsage, semantics: UsageSemantics): void {
    this.contextTracker.reportUsage(delta, semantics);
  }

  /**
   * Ocupação absoluta da janela (não delta de billing).
   * `limitHint` opcional: quando o CLI reporta a janela real (ex. Grok
   * `contextWindowTokens`), usa esse teto se for maior que o mapa estático
   * — evita false-full quando o mapa está desatualizado.
   * `used === 0` é válido (pós-clear); só warning/full com used > 0.
   */
  private reportContextOccupancy(used: number, limitHint?: number): void {
    this.contextTracker.reportOccupancy(used, limitHint);
  }

  /** Paths candidatos do signals.json (cwd canônico + raw + realpath variants). */
  private grokSignalsCandidates(sessionId: string): string[] {
    const home = this.runtimeFiles.grokHome();
    const cwd = this.opts.workspaceRoot;
    const out = new Set<string>();
    out.add(grokSignalsPath(home, cwd, sessionId));
    out.add(path.join(home, "sessions", encodeURIComponent(cwd), sessionId, "signals.json"));
    out.add(path.join(home, "sessions", encodeURIComponent(path.resolve(cwd || ".")), sessionId, "signals.json"));
    try {
      out.add(path.join(home, "sessions", encodeURIComponent(realpathSync(path.resolve(cwd || "."))), sessionId, "signals.json"));
    } catch { /* noop */ }
    return [...out];
  }

  /** Lê `signals.json` da sessão Grok (ocupação real da janela). */
  private readGrokContextSignals(sessionId: string): GrokContextSignals | null {
    for (const p of this.grokSignalsCandidates(sessionId)) {
      try {
        if (!existsSync(p)) continue;
        const sig = parseGrokContextSignals(JSON.parse(readFileSync(p, "utf8")) as unknown);
        if (sig) return sig;
      } catch { /* tenta próximo */ }
    }
    // Fallback: scan por sessionId (cwd do CLI pode divergir por symlink).
    try {
      const sessionsRoot = path.join(this.runtimeFiles.grokHome(), "sessions");
      if (!existsSync(sessionsRoot)) return null;
      for (const enc of readdirSync(sessionsRoot)) {
        const p = path.join(sessionsRoot, enc, sessionId, "signals.json");
        if (!existsSync(p)) continue;
        const sig = parseGrokContextSignals(JSON.parse(readFileSync(p, "utf8")) as unknown);
        if (sig) return sig;
      }
    } catch { /* best-effort */ }
    return null;
  }

  /** Resolve o chat_history.jsonl da sessão (mesma cadeia de candidatos
   *  do signals.json + fallback de scan por sessionId). */
  private grokChatHistoryPath(sessionId: string): string | null {
    for (const sigPath of this.grokSignalsCandidates(sessionId)) {
      const p = path.join(path.dirname(sigPath), "chat_history.jsonl");
      if (existsSync(p)) return p;
    }
    try {
      const sessionsRoot = path.join(this.runtimeFiles.grokHome(), "sessions");
      if (existsSync(sessionsRoot)) {
        for (const enc of readdirSync(sessionsRoot)) {
          const p = path.join(sessionsRoot, enc, sessionId, "chat_history.jsonl");
          if (existsSync(p)) return p;
        }
      }
    } catch { /* best-effort */ }
    return null;
  }

  /** Tool calls do grok: o streaming-json do CLI (0.2.x) NÃO emite eventos
   *  de tool no stdout (só thought/text/end) — a aba RUNS ficava vazia. A
   *  fonte real é o chat_history.jsonl da sessão (parse em
   *  parseGrokChatToolCalls). Dedupe por id de tool_call; `emit=false` só
   *  marca como vista (prime de resume — sem isso, retomar sessão antiga
   *  despejava o histórico inteiro de tools na aba RUNS).
   *  Leitura INCREMENTAL: JSONL é append-only — lê só os bytes novos a
   *  partir do offset consumido (reler o arquivo inteiro a cada tick de 3s
   *  era O(N²) em sessão com histórico grande). Linha parcial no fim (flush
   *  do CLI no meio da linha) fica pro próximo sweep, a menos que já seja
   *  JSON completo (última linha do arquivo costuma não ter \n final). */
  private grokSeenToolCallIds = new Set<string>();
  private grokToolsPrimed = false;
  private grokChatSweepState: { path: string; offset: number } | null = null;
  private grokSweepToolCalls(sessionId: string, emit: boolean): void {
    const p = this.grokChatHistoryPath(sessionId);
    if (!p) return;
    let size: number;
    try { size = statSync(p).size; } catch { return; }
    const prev = this.grokChatSweepState?.path === p ? this.grokChatSweepState.offset : 0;
    // Arquivo encolheu = truncado/reescrito → recomeça do zero (dedupe por id
    // segura re-emissão do que já foi visto).
    const start = size >= prev ? prev : 0;
    if (size <= start) { this.grokChatSweepState = { path: p, offset: start }; return; }
    let buf: Buffer;
    try {
      const fd = openSync(p, "r");
      try {
        const want = size - start;
        buf = Buffer.allocUnsafe(want);
        const n = readSync(fd, buf, 0, want, start);
        buf = buf.subarray(0, n);
      } finally { closeSync(fd); }
    } catch { return; }
    // Só linhas completas avançam o offset (offset sempre em fronteira de
    // linha → nunca corta um code point UTF-8 no início da próxima leitura).
    const lastNl = buf.lastIndexOf(0x0a);
    let consumed = lastNl >= 0 ? lastNl + 1 : 0;
    const lines = consumed > 0 ? buf.subarray(0, consumed).toString("utf8").split("\n") : [];
    const tail = buf.subarray(consumed).toString("utf8").trim();
    if (tail) {
      // Tail sem \n: consome só se já é JSON completo (senão espera o resto).
      try { JSON.parse(tail); lines.push(tail); consumed = buf.length; } catch { /* parcial */ }
    }
    this.grokChatSweepState = { path: p, offset: start + consumed };
    for (const line of lines) {
      for (const call of parseGrokChatToolCalls(line)) {
        if (this.grokSeenToolCallIds.has(call.id)) continue;
        this.grokSeenToolCallIds.add(call.id);
        if (emit) this.opts.onToolUse(call.name, call.input);
      }
    }
  }

  /** Max `totalTokens` visto no updates.jsonl da sessão (às vezes > signals). */
  private readGrokUpdatesMaxTokens(sessionId: string): number {
    const tryFiles: string[] = [];
    for (const sigPath of this.grokSignalsCandidates(sessionId)) {
      tryFiles.push(path.join(path.dirname(sigPath), "updates.jsonl"));
    }
    try {
      const sessionsRoot = path.join(this.runtimeFiles.grokHome(), "sessions");
      if (existsSync(sessionsRoot)) {
        for (const enc of readdirSync(sessionsRoot)) {
          tryFiles.push(path.join(sessionsRoot, enc, sessionId, "updates.jsonl"));
        }
      }
    } catch { /* noop */ }
    let max = 0;
    const seen = new Set<string>();
    for (const p of tryFiles) {
      if (seen.has(p) || !existsSync(p)) continue;
      seen.add(p);
      try {
        const text = readFileSync(p, "utf8");
        // updates.jsonl pode ser grande — só varre totalTokens
        for (const m of text.matchAll(/"totalTokens"\s*:\s*(\d+)/g)) {
          const n = Number(m[1]);
          if (n > max) max = n;
        }
      } catch { /* next */ }
    }
    return max;
  }

  /**
   * Poll pós-turno: o Grok às vezes flusha signals.json um pouco depois do
   * exit do processo. Nunca devolve "forçar 0" — null se ainda não souber.
   */
  private async pollGrokContextOccupancy(sessionId: string): Promise<GrokContextSignals | null> {
    let best: GrokContextSignals | null = null;
    for (let i = 0; i < 6; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 200));
      if (this.stopped) return best;
      const sig = this.readGrokContextSignals(sessionId);
      if (sig) {
        best = sig;
        if (sig.contextTokensUsed > 0) break;
      }
    }
    const fromUpdates = this.readGrokUpdatesMaxTokens(sessionId);
    const limit = best?.contextWindowTokens && best.contextWindowTokens > 0
      ? best.contextWindowTokens
      : this.contextLimit();
    const used = Math.max(best?.contextTokensUsed ?? 0, fromUpdates);
    if (used <= 0 && !best) return null;
    return {
      contextTokensUsed: used,
      contextWindowTokens: limit,
      contextWindowUsage: Math.round((used / limit) * 100),
    };
  }

  /** Dispara onContextFull no máximo uma vez por janela de cooldown. Sem
   *  isso, N eventos acima do limite no mesmo turno viram N compactContext
   *  concorrentes (processo claude órfão + resumo duplicado). Cooldown em vez
   *  de latch: se o compact falhar (provider flaky, timeout), o próximo sinal
   *  de contexto cheio re-dispara a compaction em vez de silenciar pra sempre. */
  private notifyContextFull(): void {
    this.contextTracker.notifyFull();
  }

  /** Registra falha de compact; ao atingir o teto, suspende a auto-compaction
   *  (rearmada por sucesso de compact ou clear, via resetContextAccounting). */
  private registerCompactFailure(): void {
    this.contextTracker.registerCompactFailure();
  }

  private checkContextFullError(msg: string): void {
    // Rate limit tem PRECEDÊNCIA (mesmo pré-filtro da rota de texto do
    // claude): o 429 TPM da Anthropic ("...rate limit of N input tokens per
    // minute... reduce the prompt length or the maximum tokens requested...")
    // casa /maximum.{0,20}token/ — sem o filtro, rajada de rate limit
    // compacta uma sessão saudável (lossy) e 3 rajadas suspendem a
    // auto-compaction via streak.
    this.contextTracker.checkFullError(msg);
  }

  async start() {
    await this.prepareGraphify();
    // prepareGraphify pode aguardar um build (até 180s); se o agente foi
    // parado/removido nessa janela, não spawnar processo zumbi.
    if (this.stopped) return;
    // Baseline na UI: barra aparece em 0% com o limit do model (antes do 1º turno).
    this.reportContextOccupancy(0);
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
    if (this.opts.cliRunner === "crush") {
      if (!this.ensureRunnerAvailable("crush")) return;
      this.writeCrushConfig();
      this.bootPerMessageRunner();
      return;
    }
    if (this.opts.cliRunner === "grok") {
      if (!this.ensureRunnerAvailable("grok")) return;
      this.writeGrokConfig();
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
    // NÃO dispara turno no start. Gastar tokens só pra "hello" é desperdício
    // (agentes iniciados em lote e nunca usados).
    //
    // - Resume (sessionId): sessão no disco já tem system+histórico.
    //   Próxima msg real usa --resume / -s / etc.
    // - Cold start: firstTurn permanece true → o 1º user/a2a message
    //   real injeta system+role+skills na hora do turno (runGrokMessage etc).
    //
    // Antes: pushUserMessage("[system] Context loaded…") forçava um call
    // ao CLI em todo start (cold e, pior, com re-injeção + resume).
    this.setState("idle");
    if (this.messageSession.sessionId) {
      this.messageSession.firstTurn = false;
      this.opts.log(
        "info",
        `[cli:${this.info.id}:${this.opts.cliRunner}] resume session=${this.messageSession.sessionId.slice(0, 8)}… — idle, aguardando input`,
      );
    } else {
      this.opts.log(
        "info",
        `[cli:${this.info.id}:${this.opts.cliRunner}] cold start — idle, system prompt no 1º input real`,
      );
    }
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

  private bridgeEnv(): Record<string, string> {
    return buildBridgeEnv({
      agentId: this.info.id,
      agentName: this.info.name,
      orchestratorUrl: this.opts.orchestratorUrl,
      tokenFile: this.runtimeFiles.tokenFile(),
      features: this.featuresEnv(),
      socketPath: this.opts.bridgeSocketPath,
    });
  }

  private writeGeminiConfig() {
    const dir = this.runtimeFiles.geminiConfigDir();
    // Gemini settings.json aceita `mcpServers` no mesmo shape do Claude
    // (command/args/env pra stdio; url/headers pra http). Apenas o campo
    // `type` é específico do Claude e deve ficar fora aqui.
    const mcpServers = buildGeminiMcpServers(this.opts.extraMcpServers, {
      command: this.opts.bridgeCommand,
      args: this.opts.bridgeArgs,
      env: this.bridgeEnv(),
    });
    const config = { mcpServers };
    // mode 0o600: o JSON contém THE_DUDES_AGENT_TOKEN inline em "env".
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  /** Path do config do opencode POR AGENTE (dir privado, fora do workspace).
   *  Passado ao serve/run via env OPENCODE_CONFIG (suportado no 1.17.x). */
  private writeOpenCodeConfig() {
    // Config POR AGENTE em dir privado + OPENCODE_CONFIG no env do serve.
    // Histórico: já morou no workspaceRoot (COMPARTILHADO entre agentes) —
    // 1ª versão com identidade literal = last-writer-wins (todos os serves
    // viravam o último agente); 2ª com placeholders {env:} = quebrava o CLI
    // manual no workspace, nome de agente com aspas corrompia o JSON (a
    // substituição é texto cru pré-parse) e o bloco mcp (filtrado pelo
    // mcpAllowlist POR agente) continuava clobberado. Arquivo por agente
    // elimina as três classes: valores literais (JSON.stringify escapa),
    // workspace intocado, mcp allowlist por agente respeitado.
    const configPath = this.runtimeFiles.openCodeConfigPath();
    // Remove o opencode.json legado que versões anteriores deixaram no
    // workspace — SÓ se for nosso (marker mcp "the-dudes"); nunca o config
    // próprio do usuário.
    try {
      const legacy = path.join(this.opts.workspaceRoot, "opencode.json");
      if (existsSync(legacy) && readFileSync(legacy, "utf8").includes('"the-dudes"')) {
        rmSync(legacy);
        this.opts.log("info", `[opencode:${this.info.name}] opencode.json legado removido do workspace (config agora é por agente via OPENCODE_CONFIG)`);
      }
    } catch { /* best-effort */ }
    // BUG histórico: faltava `environment` → o mcp-bridge spawnado pelo serve
    // não recebia THE_DUDES_AGENT_TOKEN_FILE → mandava Bearer vazio →
    // /api/bridge 401 (as tools the-dudes nunca funcionaram no opencode).
    // Valores LITERAIS por agente: o arquivo agora é por agente (ver
    // ocConfigPath), então identidade aqui é segura — e JSON.stringify escapa
    // nome com aspas/backslash. featuresEnv via spread: chave AUSENTE segue
    // significando "registra tudo (inclusive grupos futuros)" no bridge.
    const built = buildOpenCodeMcpConfig(this.opts.extraMcpServers, {
      command: this.opts.bridgeCommand,
      args: this.opts.bridgeArgs,
      env: this.bridgeEnv(),
    }, this.opts.autoApprove, buildOpenCodeAgentConfig(this.info.model, this.info.effort));
    for (const warning of built.warnings) this.opts.log("warn", `[opencode:${this.info.name}] ${warning}`);
    const config = built.config;
    // Não escreve `provider.*`: isso pode substituir/corromper providers
    // nativos. Effort entra num agent isolado, cujas opções adicionais o
    // OpenCode repassa ao provider sem alterar a configuração global.
    try {
      // mode 0o600: contém TOKEN_FILE path e identidade; dir já é 0700.
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
    // Fragmento de linha (sem \n) deixado pelo processo anterior SIGKILLado
    // se colaria à primeira linha do novo → JSON.parse falha e o init
    // (resolvedModel + idle) é perdido silenciosamente.
    this.buffer = "";
    // Identidade capturada: chunks/exit tardios do processo antigo (entregues
    // entre exit e close, ou de um órfão) não podem re-emitir session_id/usage
    // da sessão descartada nem clobberar o processo novo.
    const proc = this.proc;

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    // Flush mensagens bufferadas durante restart. Pequeno delay pra
    // Claude inicializar; CLI bufferará stdin entretanto.
    if (this.pendingMessages.length > 0) {
      const pending = this.pendingMessages.splice(0);
      this.opts.log("info", `[cli:${this.info.id}:claude] flushing ${pending.length} buffered message(s) after restart`);
      setTimeout(() => {
        for (const m of pending) this.pushUserMessage(m.content, m.images);
      }, 300);
    }

    proc.stdout.on("data", (chunk: string) => {
      if (this.proc !== proc) return; // chunk tardio de processo substituído
      this.traceCli("claude", "stdout", chunk);
      this.handleStdout(chunk);
    });
    proc.stderr.on("data", (chunk: string) => {
      if (this.proc !== proc) return;
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
    proc.on("exit", (code) => {
      // Exit de um órfão já substituído (kill pulado numa corrida de restart):
      // sem o guard, ele anularia this.proc do processo NOVO e chamaria
      // emitExit — agente marcado como morto com o processo vivo.
      if (this.proc !== proc) return;
      if (this.sessionInvalid) {
        this.sessionInvalid = false;
        this.opts.resumeSessionId = undefined;
        if (!this.stopped) {
          this.proc = null;
          // sessão nova e vazia — contadores da antiga não podem sobrar
          this.resetContextAccounting();
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
    return buildBaseRunnerEnv({
      inherited: process.env,
      runner: this.opts.cliRunner,
      agentId: this.info.id,
      agentName: this.info.name,
      orchestratorUrl: this.opts.orchestratorUrl,
      bridgeSocketPath: this.opts.bridgeSocketPath,
      claudeConfigDir: this.opts.cliRunner === "claude" ? this.resolveClaudeConfigDir() : undefined,
      opencodeConfigPath: this.opts.cliRunner === "opencode" ? this.runtimeFiles.openCodeConfigPath() : undefined,
    });
  }

  private resolveClaudeConfigDir(): string | undefined {
    const home = this.opts.dropTo?.home ?? process.env.HOME ?? "";
    // Override por env (container): ignora o campo por-agente, que costuma
    // apontar pra path do HOST inexistente no container. Permite montar as
    // credenciais num único dir fixo (ex: THE_DUDES_CLAUDE_CONFIG_DIR=
    // /root/.config/claude + -v <creds-do-host>:/root/.config/claude).
    const forced = process.env.THE_DUDES_CLAUDE_CONFIG_DIR?.trim();
    if (forced) return this.expandHome(forced, home);
    const custom = this.info.claudeConfigDir?.trim();
    if (custom) return this.expandHome(custom, home);
    // Default nativo: NÃO definir CLAUDE_CONFIG_DIR. Claude Code pode guardar
    // OAuth no Keychain/credential store associado ao HOME; forçar até mesmo
    // ~/.claude altera o contexto de autenticação em versões atuais.
    return undefined;
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
      buildAgentContext(this.promptContext(undefined, planAddon)),
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
    const effortPolicy = claudeThinkingEffort(this.info.effort, !!this.info.collectThinking);
    if (effortPolicy.lifted) {
      const prev = this.info.effort ?? "(unset)";
      this.traceInternalCli("info", `[cli:${this.info.id}:claude:thinking] effort lifted from "${prev}" to "high" because collectThinking=true`);
    }
    if (effortPolicy.effort) args.push("--effort", effortPolicy.effort);
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
    const dir = this.runtimeFiles.tempDir();
    const configPath = path.join(dir, "mcp.json");
    const config = buildClaudeMcpConfig(this.opts.extraMcpServers, {
      command: this.opts.bridgeCommand, args: this.opts.bridgeArgs, env: this.bridgeEnv(),
    });
    // mode 0o600: contém THE_DUDES_AGENT_TOKEN; tmpdir 0o700 protege parent.
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    const names = Object.keys(config.mcpServers).filter((n) => n !== "the-dudes");
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
      // CLI reporta o model realmente resolvido (alias→ID, default da conta).
      if (typeof event.model === "string" && event.model) this.contextTracker.setResolvedModel(event.model);
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
        // Sidechains (subagentes Task) reportam o contexto do SUBAGENTE:
        // contam pro billing (onUsageDelta acima), mas não podem sobrescrever
        // a ocupação do thread principal — mascarariam um contexto a 95%.
        if (!event.parent_tool_use_id) this.checkContextUsage(delta, "anthropic");
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
          if (text.toLowerCase().includes("api error")) {
            const failure = classifyRunnerFailure(text);
            if (failure === "rate_limit") {
              this.setState("idle");
              this.opts.onError(text);
              return;
            }
            // Contexto estourado também chega como texto do assistant ("API
            // Error: 400 ... prompt is too long") — sem rotear pro
            // onContextFull, o agente publica o erro como fala e trava pra
            // sempre (todos os turnos seguintes falham igual). Restrições
            // anti-falso-positivo: o banner real é uma linha curta que COMEÇA
            // com "API Error" (prosa do agente citando um erro não pode
            // suprimir a fala nem compactar sessão saudável), e banner de
            // SIDECHAIN (subagente Task estourando o próprio contexto) não
            // pode compactar o thread principal.
            if (!event.parent_tool_use_id && text.length < 600 &&
                isApiErrorMessage(text) && failure === "context_full") {
              this.setState("idle");
              this.opts.onError(text);
              this.notifyContextFull();
              return;
            }
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
        if (r) {
          if (classifyRunnerFailure(r) === "rate_limit") this.opts.onError(r);
          this.checkContextFullError(r);
        }
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
    return this.openCodeTransport.ensureServer();
  }

  /** Janela de contexto do catálogo do opencode serve (/config/providers):
   *  coleta automática — é a janela que o próprio CLI aplica, cobre qualquer
   *  provider/modelo (inclusive novos) sem depender do mapa estático, que
   *  envelhece. Uma busca por vida do runner (o model do agente não muda). */
  private ocCatalogLimitFetch?: Promise<void>;
  private fetchOcCatalogLimit(): Promise<void> {
    if (this.contextTracker.catalogLimitValue() !== undefined) return Promise.resolve();
    if (this.ocCatalogLimitFetch) return this.ocCatalogLimitFetch;
    this.ocCatalogLimitFetch = (async () => {
      try {
        const { providerID, modelID } = providerModelParts(this.info.model);
        // Sem prefixo de provider o POST do turno nem envia `model` (o serve
        // roda no default DELE) — casar o modelID em provider arbitrário
        // fixaria a janela de um modelo que não está rodando (ex. glm-5.2 do
        // fireworks = 1M pro turno que roda no deepseek de 128k). Nesse caso
        // fica no mapa estático.
        if (!providerID || !modelID) return;
        const cfg = await this.ocServeFetch("/config/providers", "GET");
        const provs = Array.isArray(cfg?.providers) ? cfg.providers : [];
        for (const p of provs) {
          if (p?.id !== providerID) continue;
          const ctx = Number(p?.models?.[modelID]?.limit?.context ?? 0);
          if (Number.isFinite(ctx) && ctx > 0) {
            this.contextTracker.setCatalogLimit(ctx);
            this.opts.log("info", `[opencode:${this.info.name}] janela do catálogo: ${this.contextTracker.catalogLimitValue()} (${providerID}/${modelID})`);
            // UI: re-emite a ocupação com o denominador certo já — sem isto,
            // a barra só corrigiria o teto no próximo turno. NUNCA re-emitir
            // 0 (pós-restart sem ocupação apagaria a barra que o server
            // ainda tem — mesmo invariante do finishGrokTurn).
            if (this.contextTracker.lastUsed() > 0) {
              this.opts.onContextUsage?.(this.contextTracker.lastUsed(), this.contextLimit());
            }
            return;
          }
        }
      } catch { /* best-effort — mapa estático cobre o fallback */ }
      finally { this.ocCatalogLimitFetch = undefined; }
    })();
    return this.ocCatalogLimitFetch;
  }

  /** Semântica do usage do opencode segue o PROVIDER, não a forma do delta:
   *  Anthropic reporta `input` EXCLUINDO cache (total = soma das parcelas);
   *  os demais (deepseek/zai/openai/google) incluem o cache lido no input.
   *  A heurística "auto" fica só pro provider desconhecido — ela subconta
   *  turnos Anthropic em que o input não-cacheado excede as parcelas de
   *  cache (tool result gigante ainda não cacheado). */
  private ocUsageSemantics(): UsageSemantics {
    const { providerID } = providerModelParts(this.info.model);
    return providerID.startsWith("anthropic") ? "anthropic" : "auto";
  }

  private runOpenCodeMessage(content: string, images?: ImageAttachment[], retry = 0) {
    if (this.stopped) return;
    if (!this.ensureRunnerAvailable("opencode")) return;
    this.setState("thinking");

    this.ensureOcServer().then(
      () => this.runOpenCodeMessageAttached(content, images, retry),
      (err) => {
        this.opts.onError(`opencode serve falhou: ${err?.message ?? err}`);
        this.messageSession.busy = false;
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
    if (this.stopped || !this.openCodeTransport.ready()) return;
    // Coleta a janela real do catálogo em paralelo ao turno (idempotente).
    void this.fetchOcCatalogLimit();
    this.ocRunSawOutput = false;
    // provider/modelID + reasoning effort (sufixo ":high"/":max" ou effort do agente).
    const { providerID, modelID } = providerModelParts(this.info.model);

    // Garante sessão no serve (POST /session). Reusa sessionId se já existe.
    if (!this.messageSession.sessionId) {
      try {
        const sess = await this.ocServeFetch("/session", "POST", {
          ...(providerID && modelID ? { model: { id: modelID, providerID }, agent: OPENCODE_MANAGED_AGENT } : {}),
        });
        if (!sess?.id) throw new Error("sessão sem id");
        this.messageSession.sessionId = sess.id;
        if (this.opts.onSessionId) this.opts.onSessionId(sess.id);
      } catch (e) {
        this.opts.onError(`opencode: falha criando sessão no serve: ${(e as Error).message}`);
        this.messageSession.busy = false; this.setState("idle"); this.drainOcQueue(); return;
      }
    }

    // Sessão deste turno: clear no meio do POST síncrono troca sessionId —
    // o resultado do turno antigo tem que ser descartado quando resolver
    // (texto velho "falando" pós-clear + usage da sessão cheia envenenando a
    // contabilidade recém-zerada).
    const turnSession = this.messageSession.sessionId;
    const turnEpoch = this.messageSession.epoch;

    // Resume: marca o histórico da sessão como já visto antes do 1º turno —
    // senão a drain por GET reemitiria tool calls/textos antigos nos RUNS.
    if (this.messageSession.needsPrime) {
      this.messageSession.needsPrime = false;
      try {
        const hist = await this.ocServeFetch(`/session/${this.messageSession.sessionId}/message`, "GET");
        if (Array.isArray(hist)) for (const m of hist) for (const p of (m?.parts ?? [])) { if (p?.id) this.ocSeenPartIds.add(p.id); }
      } catch { /* best-effort */ }
    }

    let message = content;
    const firstTurnSnapshot = this.messageSession.consumeFirstTurnIfNeeded();
    if (firstTurnSnapshot.firstTurn) {
      message = this.initialMessage(content, firstTurnSnapshot.pendingSummary);
    }
    this.traceCli("opencode", "stdin", message);
    // Transporte via API do serve (POST síncrono /session/:id/message) em vez
    // de `opencode run` — cujo stdout NÃO serializa o `text` de reasoning
    // models (ex: deepseek-v4-pro) → agente mudo. O serve retorna a message
    // completa {info, parts:[step-start, reasoning, text, tool, step-finish]}.
    // Imagens viram FilePartInput com data-URL (opencode aceita inline; sem temp).
    const parts = buildOpenCodeParts(message, images);
    let resp: any;
    try {
      resp = await this.ocServeFetch(
        `/session/${this.messageSession.sessionId}/message`,
        "POST",
        { ...(providerID && modelID ? { model: { providerID, modelID }, agent: OPENCODE_MANAGED_AGENT } : {}), parts },
        OPENCODE_TURN_TIMEOUT_MS,
      );
    } catch (e) {
      if (this.stopped) { this.messageSession.busy = false; return; }
      // Clear trocou a sessão durante o POST: este turno NÃO é mais dono de
      // busy/estado — o clear já zerou a flag e um turno NOVO pode tê-la
      // re-armado. Zerar/drenar aqui clobberaria o dono (waitOcIdle veria
      // falso-idle e o compact rodaria em paralelo com o turno novo).
      if (!this.messageSession.owns(turnEpoch, turnSession)) return;
      this.messageSession.busy = false;
      const emsg = (e as Error).message;
      if (retry < AgentRunner.OC_EMPTY_RETRIES) {
        this.opts.onError(`opencode: turno falhou (${emsg}) — retry ${retry + 1}/${AgentRunner.OC_EMPTY_RETRIES}`);
        this.messageSession.restoreFirstTurn(firstTurnSnapshot);
        this.messageSession.busy = true;
        setTimeout(() => {
          if (this.stopped) { this.messageSession.busy = false; return; }
          // Clear na janela de 1,2s descartou a mensagem — re-postá-la numa
          // sessão nova ressuscitaria o conteúdo que o usuário abortou (com
          // side effects de tools). Não toca busy: o clear já zerou e um
          // turno novo pode ser o dono agora.
          if (!this.messageSession.owns(turnEpoch, turnSession)) return;
          void this.runOpenCodeMessage(content, images, retry + 1);
        }, 1200);
        return;
      }
      this.opts.onError(`opencode: turno falhou após retry: ${emsg}`);
      // Estouro de janela chega como reject do POST (HTTP 4xx com o banner do
      // provider no corpo) — única rota reativa do transporte via serve; sem
      // isso o agente trava repetindo o mesmo erro até clear manual.
      this.checkContextFullError(emsg);
      this.setState("idle");
      this.drainOcQueue();
      return;
    }

    // Clear durante o POST: resultado pertence à sessão descartada. Retorna
    // SEM tocar busy/estado/fila — este turno não é mais o dono (ver catch).
    if (this.stopped) { this.messageSession.busy = false; return; }
    if (!this.messageSession.owns(turnEpoch, turnSession)) return;
    // Serve pode responder 200 com o erro do provider embutido em info.error
    // (nunca passa pelas parts) — cobre a variante que o reject do POST não vê.
    const infoErr = resp?.info?.error;
    if (infoErr) {
      const im = typeof infoErr === "string" ? infoErr : String(infoErr?.data?.message ?? infoErr?.message ?? JSON.stringify(infoErr));
      this.checkContextFullError(im);
    }
    // O POST /message só retorna a ÚLTIMA mensagem do assistant; as tool calls
    // ficam em mensagens INTERMEDIÁRIAS do loop (uma msg por step). Busca TODAS
    // as msgs da sessão e processa só as parts novas (dedup por id) — senão os
    // RUNS (tool executions) nunca apareciam no opencode.
    await this.ocProcessNewParts(resp, turnSession);

    // Clear durante o GET do ocProcessNewParts: mesma regra de posse.
    if (this.stopped) { this.messageSession.busy = false; return; }
    if (!this.messageSession.owns(turnEpoch, turnSession)) return;
    this.ocActiveProc = null;
    this.messageSession.busy = false;
    if (!this.ocRunSawOutput && retry < AgentRunner.OC_EMPTY_RETRIES) {
      this.opts.onError(`opencode: resposta vazia (provável flap do provider) — retry ${retry + 1}/${AgentRunner.OC_EMPTY_RETRIES}`);
      this.messageSession.restoreFirstTurn(firstTurnSnapshot);
      this.messageSession.busy = true;
      setTimeout(() => {
        if (this.stopped) { this.messageSession.busy = false; return; }
        if (!this.messageSession.owns(turnEpoch, turnSession)) return; // clear descartou a mensagem (ver retry do catch)
        void this.runOpenCodeMessage(content, images, retry + 1);
      }, 1200);
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
    return this.openCodeTransport.fetch(path, method, body, timeoutMs);
  }

  /* ---------- OpenCode permission (auto-approve OFF) ---------- */

  /** Abre o stream SSE /event do serve p/ receber `permission.asked`. Só roda
   *  com auto-approve OFF (com ON o config já libera tudo, nenhum ask é emitido).
   *  Reabre se a conexão cair (serve vivo = sessão do agente viva). */
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
        res.on("error", (e) => reject(new Error(`resposta interrompida: ${e.message}`))); // mesmo hang do ocServeFetch
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
      req.write(data);
      req.end();
    });
  }

  /** Lê TODAS as mensagens da sessão e processa as parts ainda não vistas.
   *  Cobre tool calls que vivem em mensagens intermediárias (o POST /message
   *  só devolve a última). Fallback p/ resp.parts se o GET falhar.
   *  `sessionId` é a sessão DO TURNO (capturada antes do POST) — usar
   *  this.messageSession.sessionId aqui abriria janela pro clear no meio: GET em
   *  /session/undefined + dispatch de histórico velho pós-reset. */
  private async ocProcessNewParts(resp: any, sessionId?: string): Promise<void> {
    const sid = sessionId ?? this.messageSession.sessionId;
    let messages: any[] | null = null;
    try {
      const r = await this.ocServeFetch(`/session/${sid}/message`, "GET");
      if (Array.isArray(r)) messages = r;
    } catch { /* cai pro fallback abaixo */ }
    // Clear durante o GET: não despachar parts da sessão descartada (texto
    // velho "falando" pós-clear + step-finish envenenando a contabilidade).
    if (sessionId && this.messageSession.sessionId !== sessionId) return;

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
    this.applyOpenCodeEvents(p);
  }

  private applyOpenCodeEvents(raw: unknown): void {
    for (const event of parseOpenCodeTurnEvent(raw)) {
      if (event.type === "session") {
        if (event.sessionId !== this.messageSession.sessionId) {
          this.messageSession.sessionId = event.sessionId;
          this.opts.onSessionId?.(event.sessionId);
        }
      } else if (event.type === "text") {
        this.ocRunSawOutput = true;
        this.setState("speaking");
        this.opts.onAssistantText(event.text);
      } else if (event.type === "tool") {
        this.ocRunSawOutput = true;
        this.opts.onToolUse(event.name, event.input);
        this.setState("thinking");
      } else if (event.type === "usage") {
        const delta: AgentUsage = {
          input: event.input,
          output: event.output,
          cacheCreate: event.cacheCreate,
          cacheRead: event.cacheRead,
        };
        this.opts.onUsageDelta?.(delta);
        this.checkContextUsage(delta, this.ocUsageSemantics());
      } else if (event.type === "result") this.setState("thinking");
    }
  }

  private handleOpenCodeEvent(event: any) {
    this.applyOpenCodeEvents(event);
  }

  /* ---------- Gemini per-message model ---------- */

  private runGeminiMessage(content: string, images?: ImageAttachment[]) {
    if (this.stopped) return;
    if (!this.ensureRunnerAvailable("gemini")) return;
    this.setState("thinking");

    const tmpDir = this.runtimeFiles.tempDir();
    this.writeGeminiConfig();

    let message = content;
    const firstTurnSnapshot = this.messageSession.consumeFirstTurnIfNeeded();
    const firstTurn = firstTurnSnapshot.firstTurn;
    // Preservados pra restaurar se o turno morrer sem completar: com o
    // --resume condicional, perder o firstTurn num turno falho mudaria QUAL
    // sessão o agente usa dali em diante (re-resume da sessão que o
    // clear/compact descartou) — e o resumo pendente seria perdido junto.
    const pendingSummary = firstTurnSnapshot.pendingSummary;
    const epoch = this.messageSession.epoch;
    if (firstTurn) {
      message = this.initialMessage(content, pendingSummary);
    }
    // Imagens: gemini lê arquivos referenciados por @<path> no prompt.
    let imgCleanup = () => {};
    if (images && images.length) {
      const { paths, cleanup } = this.writeImageTempFiles(images);
      imgCleanup = cleanup;
      message = appendFileImagePrompt(message, paths, "gemini");
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
    // Resume SÓ quando não é primeiro turno: o storage do gemini é indexado
    // pelo cwd (tmpdir da instância, nunca rotacionado) — `--resume latest`
    // incondicional re-abria a sessão CHEIA depois de clear/compact
    // (resetWithSummary não a apaga), tornando os dois no-ops e o compact um
    // loop infinito (resumo appendado na própria sessão que estourou).
    // Sem o resume, o processo novo cria sessão limpa que vira a "latest".
    if (!firstTurn) args.push("--resume", "latest");

    const env = buildGeminiEnv(this.buildEnv());

    this.traceSpawn("gemini", args);
    const proc = spawnDropped(this.runnerCommand("gemini"), args, {
      cwd: tmpDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }, this.opts.dropTo ?? null);
    this.ocActiveProc = proc;

    let buf = "";
    let pendingText = "";
    let sawResult = false;

    const flush = () => {
      // Epoch trocado (clear/compact durante o turno): texto da sessão
      // descartada não pode "falar" pós-reset.
      if (!this.messageSession.owns(epoch)) { pendingText = ""; return; }
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
        // Eventos de um turno pré-reset (proc morto pelo clear ainda drenando
        // stdout): result tardio envenenaria a gemStatsBase recém-zerada
        // (double-billing) e texto/tool velhos vazariam pós-clear.
        if (!this.messageSession.owns(epoch)) continue;
        try {
          for (const event of parseGeminiTurnEvent(JSON.parse(line))) {
            if (event.type === "text") pendingText += event.text;
            else if (event.type === "tool") {
              flush();
              this.opts.onToolUse(event.name, event.input);
              this.setState("thinking");
            } else if (event.type === "result") {
              sawResult = true;
              flush();
            } else if (event.type === "usage") {
            // stats do gemini-cli são ACUMULADOS (uiTelemetryService soma o
            // prompt de TODAS as requests do turno e o hydrate do --resume
            // pré-carrega o histórico inteiro): input_tokens ≈ Σ requests,
            // não a ocupação da janela. Billing = delta contra a base
            // persistida (base zera junto com a sessão no resetWithSummary);
            // ocupação NÃO é derivável daqui — contexto cheio do gemini é
            // detectado pela rota reativa (banner no stderr →
            // checkContextFullError), nunca por estes stats.
            const rawInput = event.input;
            const rawOutput = event.output;
            const rawCached = event.cacheRead;
            const cumulative = this.gemUsage.delta({ input: rawInput, output: rawOutput, cached: rawCached });
            const delta: AgentUsage = {
              input: cumulative.input,
              output: cumulative.output,
              cacheCreate: 0,
              cacheRead: cumulative.cached,
            };
            this.opts.onUsageDelta?.(delta);
            }
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
      this.messageSession.busy = false;
      if (this.stopped) { this.emitExit(code); return; }
      // Primeiro turno que morreu sem completar (sem evento result — OAuth
      // expirado, 429 de quota, --model inválido: falhas antes do CLI gravar
      // a sessão nova): restaurar firstTurn/summary. Sem isso o próximo turno
      // roda `--resume latest` e reabre a sessão que o clear/compact
      // descartou — e o delta contra gemStatsBase=0 re-fatura o histórico
      // inteiro. Só restaura no MESMO epoch (reset no meio já re-armou tudo).
      if (!sawResult && this.messageSession.owns(epoch)) this.messageSession.restoreFirstTurn(firstTurnSnapshot);
      this.setState("idle");
      this.drainOcQueue();
    });
  }

  /* ---------- Codex per-message model ---------- */

  private buildCodexConfigArgs(): string[] {
    const built = buildCodexMcpArgs(this.opts.extraMcpServers, {
      command: this.opts.bridgeCommand,
      args: this.opts.bridgeArgs,
      env: this.bridgeEnv(),
    });
    for (const warning of built.warnings) this.opts.log("warn", `[codex:${this.info.name}] ${warning}`);
    return built.args;
  }

  private runCodexMessage(content: string, images?: ImageAttachment[]) {
    if (this.stopped) return;
    if (!this.ensureRunnerAvailable("codex")) return;
    this.setState("thinking");

    let message = content;
    const firstTurnSnapshot = this.messageSession.consumeFirstTurnIfNeeded();
    if (firstTurnSnapshot.firstTurn) message = this.initialMessage(content, firstTurnSnapshot.pendingSummary);
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
      imageArgs = codexImageArgs(paths);
    }

    const args = this.messageSession.sessionId
      ? ["exec", "resume", ...commonFlags, this.messageSession.sessionId, ...imageArgs, message]
      : ["exec", ...commonFlags, ...imageArgs, message];

    this.traceSpawn("codex", args);
    const proc = spawnDropped(this.runnerCommand("codex"), args, {
      cwd: this.opts.workspaceRoot,
      env: this.buildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }, this.opts.dropTo ?? null);
    this.ocActiveProc = proc;
    // Epoch do spawn: eventos deste turno só valem enquanto a sessão não foi
    // resetada (clear/compact) — ver handleCodexEvent.
    const epoch = this.messageSession.epoch;

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
        try { this.handleCodexEvent(JSON.parse(line), epoch); } catch {}
      }
    });

    proc.stderr!.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (!msg) return;
      this.traceCli("codex", "stderr", msg);
      // Único runner cujo stderr não passava pelos CONTEXT_FULL_PATTERNS
      // (claude e gemini passam) — estouro reportado só no stderr era mudo.
      this.checkContextFullError(msg);
      if (msg.includes(" ERROR ") && !msg.includes("failed to record rollout items")) {
        this.opts.onError(msg);
      }
    });

    proc.on("close", (code) => {
      if (buf.trim().startsWith("{")) {
        try { this.handleCodexEvent(JSON.parse(buf.trim()), epoch); } catch {}
      }
      imgCleanup();
      this.ocActiveProc = null;
      this.messageSession.busy = false;
      if (this.stopped) { this.emitExit(code); return; }
      this.setState("idle");
      this.drainOcQueue();
    });
  }

  private handleCodexEvent(event: any, epoch: number) {
    // Turno spawnado num epoch anterior: clear/compact já resetou a sessão —
    // TODO evento dele é da conversa descartada (thread.started ressuscitaria
    // a sessão antiga pós-reset; turn.completed envenenaria a contabilidade
    // nova). Comparar epoch (e não `compacting`) preserva os eventos LEGÍTIMOS
    // do turno em voo durante o waitOcIdle — descartar thread.started nessa
    // fase deixava o primeiro turno órfão e o one-shot resumia thread vazia.
    if (!this.messageSession.owns(epoch)) return;
    for (const normalized of parseCodexTurnEvent(event)) {
      if (normalized.type === "session") {
        if (normalized.sessionId !== this.messageSession.sessionId) {
          this.messageSession.sessionId = normalized.sessionId;
          this.opts.onSessionId?.(normalized.sessionId);
        }
      } else if (normalized.type === "tool") {
        this.opts.onToolUse(normalized.name, normalized.input);
        this.setState(normalized.name.includes("send_message") ? "sending" : "thinking");
      } else if (normalized.type === "text") {
        this.setState("speaking");
        this.opts.onAssistantText(normalized.text);
      } else if (normalized.type === "usage") {
          const delta: AgentUsage = {
            input: normalized.input,
            output: normalized.output,
            cacheCreate: normalized.cacheCreate,
            cacheRead: normalized.cacheRead,
          };
          this.opts.onUsageDelta?.(delta);
          this.checkContextUsage(delta, "inclusive");
      } else if (normalized.type === "error") {
        this.checkContextFullError(normalized.message);
        this.opts.onError(`codex: ${normalized.message}`);
      }
    }
  }

  /* ---------- Grok Build (xAI) per-message model ---------- */

  /**
   * Args oficiais do headless mode (docs/user-guide/14-headless-mode.md):
   *   grok -p PROMPT --output-format streaming-json|json --always-approve
   *        [-m MODEL] [--effort LEVEL] [--resume SID] [--cwd PATH]
   *        [--system-prompt-override …] [--no-auto-update]
   *
   * Streaming-json: NDJSON com type=text|thought|end|error (sessionId no end).
   * JSON final: { text, stopReason, sessionId, requestId, thought? }.
   */
  private buildGrokHeadlessArgs(
    prompt: string,
    opts: { resume?: string; outputFormat: "streaming-json" | "json" | "plain"; forCompact?: boolean },
  ): string[] {
    return grokHeadlessArgs({
      prompt,
      outputFormat: opts.outputFormat,
      workspaceRoot: this.opts.workspaceRoot,
      model: this.info.model,
      effort: this.info.effort,
      collectThinking: this.info.collectThinking,
      planMode: this.info.planMode,
      sessionId: opts.resume,
      forCompact: opts.forCompact,
    });
  }

  /** Project MCP config `.grok/config.toml` (docs: project-scoped MCP).
   *  Valores por agente via `${VAR}`. Auth NÃO mora aqui — ver runtimeFiles.grokHome().
   *  Nunca criar auth.json/sessions aqui (poluiria se GROK_HOME errasse). */
  private writeGrokConfig() {
    const dir = path.join(this.opts.workspaceRoot, ".grok");
    mkdirSync(dir, { recursive: true });
    // Evita commitar config gerada + lixo de home acidental.
    const gi = path.join(dir, ".gitignore");
    try {
      if (!existsSync(gi)) {
        writeFileSync(
          gi,
          // keep only project MCP config shareable if user force-adds it
          ["*", "!.gitignore", "!config.toml"].join("\n") + "\n",
          { mode: 0o644 },
        );
      }
    } catch { /* best-effort */ }
    // Se um spawn anterior (GROK_HOME errado) deixou auth/sessions no
    // project .grok, remove pra não competir com ~/.grok real.
    for (const junk of ["auth.json", "auth.json.lock", "sessions", "models_cache.json", "active_sessions.json", "active_sessions.lock"]) {
      try { rmSync(path.join(dir, junk), { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    const bridgeEnv: Record<string, string> = {
      THE_DUDES_AGENT_ID: "${THE_DUDES_AGENT_ID}",
      THE_DUDES_AGENT_NAME: "${THE_DUDES_AGENT_NAME}",
      THE_DUDES_ORCH_URL: "${THE_DUDES_ORCH_URL}",
      THE_DUDES_AGENT_TOKEN_FILE: "${THE_DUDES_AGENT_TOKEN_FILE}",
    };
    if (this.opts.bridgeSocketPath) {
      bridgeEnv.THE_DUDES_BRIDGE_SOCKET = "${THE_DUDES_BRIDGE_SOCKET}";
    }
    for (const k of Object.keys(this.featuresEnv())) {
      bridgeEnv[k] = `\${${k}}`;
    }
    const built = buildGrokMcpToml(this.opts.extraMcpServers, {
      command: this.opts.bridgeCommand, args: this.opts.bridgeArgs, env: bridgeEnv,
    });
    for (const warning of built.warnings) this.opts.log("warn", `[grok:${this.info.name}] ${warning}`);

    try {
      writeFileSync(path.join(dir, "config.toml"), built.toml, { mode: 0o600 });
    } catch (e) {
      this.opts.log("warn", `[grok:${this.info.name}] failed to write .grok/config.toml: ${(e as Error).message}`);
    }
  }

  /**
   * HOME canônico do Grok Build (auth.json, sessions). Nunca usar o
   * `.grok/` do workspace — esse path é só project-config (MCP); se o CLI
   * confundir com GROK_HOME, headless cai em 401 (sem credenciais).
   */
  private grokTurnEnv(): NodeJS.ProcessEnv {
    return buildGrokEnv({
      base: this.buildEnv(),
      tokenFile: this.runtimeFiles.tokenFile(),
      features: this.featuresEnv(),
      grokHome: this.runtimeFiles.grokHome(),
      dropTo: this.opts.dropTo,
    });
  }

  private async runGrokMessage(content: string, images?: ImageAttachment[]) {
    if (this.stopped) { this.messageSession.busy = false; return; }
    if (!this.ensureRunnerAvailable("grok")) { this.messageSession.busy = false; return; }
    // Nunca manda ciphertext pro CLI — hang/resposta lixo. Decryption falhou
    // no spawn (sem project key): aborta o turno em vez de travar o runner.
    if (typeof this.info.systemPrompt === "string" && this.info.systemPrompt.startsWith("e2e:")) {
      this.messageSession.busy = false;
      this.opts.onError(
        `[grok] systemPrompt ainda cifrado (sem project key no daemon) — abra o projeto no browser pra re-share da chave E2EE e reinicie o agente`,
      );
      this.setState("idle");
      this.drainOcQueue();
      return;
    }
    this.setState("thinking");
    this.writeGrokConfig();

    let message = content;
    const firstTurn = this.messageSession.firstTurn;
    const pendingSummary = this.messageSession.pendingSummary;
    const epoch = this.messageSession.epoch;
    // Resume: NÃO re-injeta system+skills (já na sessão). Só first-turn cold.
    if (firstTurn && !this.messageSession.sessionId) {
      this.messageSession.consumeFirstTurn();
      message = this.initialMessage(content, pendingSummary);
    } else if (firstTurn) {
      // Tinha resumeSessionId mas firstTurn ainda true (legado) — só avança flag.
      this.messageSession.firstTurn = false;
    }

    // Imagens: grava temp e referencia por path (tool read_file do Grok).
    let imgCleanup = () => {};
    if (images && images.length) {
      const { paths, cleanup } = this.writeImageTempFiles(images);
      imgCleanup = cleanup;
      message = appendFileImagePrompt(message, paths, "grok");
    }

    // Prime do dedupe de tool_calls: em resume de sessão com histórico,
    // marca as tools de turnos antigos como vistas SEM emitir.
    if (!this.grokToolsPrimed) {
      this.grokToolsPrimed = true;
      if (this.messageSession.sessionId) this.grokSweepToolCalls(this.messageSession.sessionId, false);
    }

    const args = this.buildGrokHeadlessArgs(message, {
      resume: this.messageSession.sessionId,
      outputFormat: "streaming-json",
    });
    this.traceCli("grok", "argv", message);
    this.traceSpawn("grok", args);

    let proc: ChildProcess;
    try {
      proc = spawnDropped(this.runnerCommand("grok"), args, {
        cwd: this.opts.workspaceRoot,
        env: this.grokTurnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, this.opts.dropTo ?? null);
    } catch (e) {
      imgCleanup();
      this.messageSession.busy = false;
      this.opts.onError(`grok spawn falhou: ${(e as Error).message}`);
      this.setState("idle");
      this.drainOcQueue();
      return;
    }
    this.ocActiveProc = proc;

    // Watchdog: se o CLI não sair em GROK_TURN_TIMEOUT_MS, mata e libera
    // a fila (sintoma real: resume + prompt enorme fica em 0% CPU por horas).
    armHardTimeout(proc, GROK_TURN_TIMEOUT_MS, () => {
      this.opts.log("warn", `[grok:${this.info.name}] turno excedeu ${GROK_TURN_TIMEOUT_MS / 1000}s — SIGKILL (session=${this.messageSession.sessionId?.slice(0, 8) ?? "nova"})`);
    }, () => this.messageSession.owns(epoch));

    // Tool calls ao vivo durante o turno (só possível em resume, quando o
    // sessionId já é conhecido; turno cold emite tudo no sweep final).
    // Auto-limpa quando o turno morreu: 'close' NÃO é garantido pós-SIGKILL
    // se um neto herdou os pipes de stdio (mesmo caveat do one-shot) — sem
    // isto cada turno wedged vazava um interval de 3s pra sempre.
    const toolPoll = setInterval(() => {
      if (this.stopped || !this.messageSession.owns(epoch) || !procAlive(proc)) {
        clearInterval(toolPoll);
        return;
      }
      if (this.messageSession.sessionId) this.grokSweepToolCalls(this.messageSession.sessionId, true);
    }, 3000);
    proc.on("close", () => clearInterval(toolPoll));

    // Acumula o turno inteiro e emite UMA vez no final.
    // onAssistantText no orch cria uma mensagem por chamada — flush por
    // chunk/newline virava dezenas de balões "PM → Você" (UI quebrada).
    let buf = "";
    let fullText = "";
    let fullThought = "";
    let sawEnd = false;
    let endSessionId: string | undefined;
    let errOut = "";
    let errFromJson = "";
    let emittedAny = false;

    const ingestLine = (line: string) => {
      if (!line.startsWith("{") || !this.messageSession.owns(epoch)) return;
      try {
        for (const event of parseGrokStreamEvent(JSON.parse(line))) {
          if (event.type === "text") {
            fullText += event.text;
            if (fullText.length > 0) this.setState("speaking");
          } else if (event.type === "thought") fullThought += event.text;
          else if (event.type === "session") endSessionId = event.sessionId;
          else if (event.type === "result") sawEnd = true;
          else if (event.type === "error") {
            errFromJson = event.message;
            this.checkContextFullError(event.message);
          }
        }
      } catch { /* linha incompleta / ruído */ }
    };

    /** Emite no máximo 1 agent_to_user por turno. */
    const emitOnce = () => {
      if (!this.messageSession.owns(epoch) || emittedAny) return;
      if (fullThought && this.info.collectThinking && this.opts.onThinkingText) {
        this.opts.onThinkingText(fullThought);
      }
      const t = fullText.trim();
      if (t) {
        this.setState("speaking");
        this.opts.onAssistantText(t);
        emittedAny = true;
      }
      // Billing: headless não emite usage — estima por chars (~4 chars/token).
      // Ocupação da janela NÃO usa essa heurística: finishGrokTurn lê
      // signals.json (contextTokensUsed real) após o turno.
      if (this.messageSession.owns(epoch) && (message.length > 0 || t.length > 0)) {
        const estIn = Math.max(1, Math.ceil(message.length / 4));
        const estOut = Math.max(0, Math.ceil(t.length / 4));
        this.opts.onUsageDelta?.({
          input: estIn,
          output: estOut,
          cacheCreate: 0,
          cacheRead: 0,
        });
      }
    };

    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      this.traceCli("grok", "stdout", chunk);
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        ingestLine(line);
      }
    });
    proc.stderr!.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (!msg) return;
      this.traceCli("grok", "stderr", msg);
      errOut += chunk;
      this.checkContextFullError(msg);
    });

    proc.on("close", (code) => {
      // Resto de buffer sem newline final (json single-object ou última linha).
      if (buf.trim()) ingestLine(buf.trim());
      emitOnce();
      if (errFromJson && !emittedAny) {
        this.opts.onError(`grok: ${errFromJson.slice(0, 500)}`);
      }
      imgCleanup();
      this.ocActiveProc = null;
      if (this.stopped) { this.messageSession.busy = false; this.emitExit(code); return; }
      void this.finishGrokTurn({
        code, epoch, firstTurn, pendingSummary, content, images,
        sawEnd, endSessionId, errOut, errFromJson, emittedAny,
      });
    });
  }

  private async finishGrokTurn(t: {
    code: number | null;
    epoch: number;
    firstTurn: boolean;
    pendingSummary: string | undefined;
    content: string;
    images?: ImageAttachment[];
    sawEnd: boolean;
    endSessionId?: string;
    errOut: string;
    errFromJson: string;
    emittedAny: boolean;
  }): Promise<void> {
    try {
      if (!this.messageSession.owns(t.epoch)) return;

      // Sweep de tool calls ANTES dos branches de falha: turno abortado é
      // justamente o que precisa de auditoria na RUNS — e os branches de
      // retry descartam a sessão (sweep só no sucesso perdia o registro das
      // tools executadas pra sempre).
      const sweepSid = t.endSessionId ?? this.messageSession.sessionId;
      if (sweepSid) this.grokSweepToolCalls(sweepSid, true);

      const failed = (t.code ?? 1) !== 0 && !t.emittedAny && !t.sawEnd;
      const combinedErr = `${t.errOut}\n${t.errFromJson}`;

      // Resume de sessão inexistente / expurgada.
      if (failed && this.messageSession.sessionId && isMissingSessionMessage(combinedErr)) {
        this.opts.onError(`[grok] sessão ${this.messageSession.sessionId} não existe mais — recomeçando sessão nova`);
        this.messageSession.resetForRetry(t.pendingSummary);
        this.info.sessionId = undefined;
        if (this.opts.onSessionId) this.opts.onSessionId("");
        this.messageSession.prepend({ content: t.content, images: t.images });
        return;
      }

      // Timeout / kill sem output em resume: descarta sessão e tenta 1x cold.
      // Evita loop infinito de hang no mesmo sessionId.
      if (failed && this.messageSession.sessionId && !t.emittedAny && isAbortedFailure(combinedErr, t.code)) {
        this.opts.onError(
          `[grok] turno abortado sem output (code=${t.code ?? "?"}) — limpando sessão ${this.messageSession.sessionId.slice(0, 8)}… e recomeçando`,
        );
        this.messageSession.resetForRetry(t.pendingSummary);
        this.info.sessionId = undefined;
        if (this.opts.onSessionId) this.opts.onSessionId("");
        this.messageSession.prepend({ content: t.content, images: t.images });
        return;
      }

      if (failed) {
        this.messageSession.restoreFirstTurn(t);
        const err = combinedErr.trim() || `grok exit ${t.code ?? "?"} sem output`;
        this.checkContextFullError(err);
        // 401 / credenciais: mensagem acionável (login OAuth do CLI, não do the-dudes).
        if (isAuthenticationFailure(err)) {
          const home = this.runtimeFiles.grokHome();
          this.opts.onError(
            `[grok] autenticação falhou (401). Rode \`grok login\` no mesmo user do daemon ` +
            `(auth em ${home}/auth.json). Se usou XAI_API_KEY inválida, remova do env. ` +
            `Detalhe: ${err.slice(0, 300)}`,
          );
          return;
        }
        this.opts.onError(`grok: ${err.slice(0, 500)}`);
        return;
      }

      if (t.errOut.trim() && !t.emittedAny) {
        // stderr sem texto útil no stdout (auth/rate limit).
        this.opts.onError(t.errOut.trim().slice(0, 500));
      }

      // Captura sessionId do evento end (ou já tinha de resume).
      const sid = t.endSessionId ?? this.messageSession.sessionId;
      if (sid && sid !== this.messageSession.sessionId) {
        this.messageSession.sessionId = sid;
        if (this.opts.onSessionId) this.opts.onSessionId(sid);
      } else if (sid && !this.info.sessionId && this.opts.onSessionId) {
        this.opts.onSessionId(sid);
      }

      // Tool calls do turno: streaming-json não as emite no stdout — a fonte
      // é o chat_history.jsonl (turno cold só ganha sessionId aqui no end).
      if (sid) this.grokSweepToolCalls(sid, true);

      // Ocupação real da janela: signals.json / updates.jsonl (igual /context).
      // NÃO re-emitir 0 se a leitura falhar — isso apagava a barra (e em
      // dual-daemon um processo "cego" zerava o valor do outro).
      if (sid) {
        const sig = await this.pollGrokContextOccupancy(sid);
        if (sig && sig.contextTokensUsed > 0) {
          this.opts.log(
            "info",
            `[grok] context window ${sig.contextTokensUsed}/${sig.contextWindowTokens} (${sig.contextWindowUsage}%) session=${sid.slice(0, 8)}…`,
          );
          this.reportContextOccupancy(sig.contextTokensUsed, sig.contextWindowTokens);
        } else if (sig) {
          // sessão nova ainda com used=0 — só reporta se ainda não temos valor
          if (this.contextTracker.lastUsed() <= 0) {
            this.reportContextOccupancy(0, sig.contextWindowTokens);
          }
        }
      }
    } finally {
      this.messageSession.busy = false;
      if (!this.stopped) {
        this.setState("idle");
        this.drainOcQueue();
      }
    }
  }

  /* ---------- Crush per-message model ---------- */

  /** Data dir do crush POR AGENTE, estável entre restarts do daemon (o
   *  sessionId persiste no DB do server → o resume precisa achar o crush.db
   *  de novo; o tmpdir é aleatório e morre com o runner). Fica dentro do
   *  .crush do workspace (que o próprio crush já cobre com .gitignore "*"),
   *  segregado por agentId — sessões de agentes irmãos não colidem e o
   *  `session last` pós-turno é confiável (só vê as sessões DESTE agente). */
  /** Config de projeto do crush (`.crush.json` no workspaceRoot — prioridade
   *  máxima na cadeia de descoberta; o crush não tem flag de config path).
   *  MCPs extras + bridge the-dudes. Multi-agente no mesmo workspace: o
   *  arquivo é IDÊNTICO entre agentes porque os valores por agente entram por
   *  expansão shell-style `$VAR` (suportada em command/args/env do config) e
   *  são resolvidos do env do PROCESSO crush (buildEnv injeta por spawn). */
  private writeCrushConfig() {
    const configPath = path.join(this.opts.workspaceRoot, ".crush.json");
    // Bridge the-dudes: os valores POR AGENTE (id/name/token-file) via $VAR —
    // o token file path não é secreto (o conteúdo é, mode 0600) e o env do
    // processo crush já carrega tudo (buildEnv + crushTurnEnv).
    const built = buildCrushMcpConfig(this.opts.extraMcpServers, {
      command: this.opts.bridgeCommand,
      args: this.opts.bridgeArgs,
      env: {
        THE_DUDES_AGENT_ID: "$THE_DUDES_AGENT_ID",
        THE_DUDES_AGENT_NAME: "$THE_DUDES_AGENT_NAME",
        THE_DUDES_ORCH_URL: "$THE_DUDES_ORCH_URL",
        THE_DUDES_AGENT_TOKEN_FILE: "$THE_DUDES_AGENT_TOKEN_FILE",
        ...(this.opts.bridgeSocketPath ? { THE_DUDES_BRIDGE_SOCKET: "$THE_DUDES_BRIDGE_SOCKET" } : {}),
        ...Object.fromEntries(Object.keys(this.featuresEnv()).map((k) => [k, `$${k}`])),
      },
    });
    for (const warning of built.warnings) this.opts.log("warn", `[crush:${this.info.name}] ${warning}`);
    try {
      writeFileSync(configPath, JSON.stringify(built.config, null, 2), { mode: 0o600 });
    } catch (e) {
      this.opts.log("warn", `[crush:${this.info.name}] failed to write .crush.json: ${(e as Error).message}`);
    }
  }

  /** Env por turno do crush: buildEnv + os valores que o `.crush.json`
   *  compartilhado referencia por `$VAR` (token file é por agente). */
  private crushTurnEnv(): NodeJS.ProcessEnv {
    return buildBridgeAwareEnv(this.buildEnv(), this.runtimeFiles.tokenFile(), this.featuresEnv());
  }

  /** Roda um subcomando `crush session ...` e devolve o JSON parseado (null em
   *  erro/timeout). Usado pra capturar o uuid da sessão criada pelo run e o
   *  meta cumulativo de tokens (o `crush run` não emite nada disso no stdout). */
  private crushSessionJson(argv: string[]): Promise<any> {
    return new Promise((resolve) => {
      if (!this.opts.cliCommands.crush.available) { resolve(null); return; }
      let proc: ChildProcess;
      try {
        proc = spawnDropped(this.runnerCommand("crush"), [...argv, "--json", "--data-dir", this.runtimeFiles.crushDataDir()], {
          cwd: this.opts.workspaceRoot,
          env: this.buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, this.opts.dropTo ?? null);
      } catch { resolve(null); return; }
      void collectProcessOutput(proc, { timeoutMs: 15_000 }).then((result) => {
        if (result.timedOut) { resolve(null); return; }
        try { resolve(JSON.parse(result.stdout.trim())); } catch { resolve(null); }
      });
    });
  }

  private async runCrushMessage(content: string, images?: ImageAttachment[]) {
    if (this.stopped) { this.messageSession.busy = false; return; }
    if (!this.ensureRunnerAvailable("crush")) { this.messageSession.busy = false; return; }
    this.setState("thinking");
    this.writeCrushConfig();

    let message = content;
    const firstTurnSnapshot = this.messageSession.consumeFirstTurnIfNeeded();
    const firstTurn = firstTurnSnapshot.firstTurn;
    // Preservados pra restaurar se o turno morrer sem output (mesma lógica do
    // gemini): perder o firstTurn num turno falho descartaria system prompt e
    // resumo pendente pra sempre.
    const pendingSummary = firstTurnSnapshot.pendingSummary;
    const epoch = this.messageSession.epoch;
    if (firstTurn) {
      message = this.initialMessage(content, pendingSummary);
    }
    // Imagens: crush run não tem flag de attachment — grava temp e referencia
    // por path no prompt (a tool `view` do crush lê imagem do disco).
    let imgCleanup = () => {};
    if (images && images.length) {
      const { paths, cleanup } = this.writeImageTempFiles(images);
      imgCleanup = cleanup;
      message = appendFileImagePrompt(message, paths, "crush");
    }
    this.traceCli("crush", "argv", message);

    // Sessão RESUMIDA (daemon restart): prime da base de billing ANTES do
    // turno — o meta é cumulativo e a base zero re-faturaria o histórico.
    if (this.messageSession.sessionId && this.crushUsage.current() === null) {
      const meta = await this.crushSessionJson(["session", "show", this.messageSession.sessionId]);
      const parsed = parseCrushSessionMeta(meta);
      this.crushUsage.prime({
        prompt: parsed.prompt,
        completion: parsed.completion,
      });
      if (this.stopped) { this.messageSession.busy = false; return; }
    }
    this.crushUsage.prime({ prompt: 0, completion: 0 });

    const args = ["run", "--quiet", "--data-dir", this.runtimeFiles.crushDataDir()];
    if (this.info.model) args.push("-m", this.info.model);
    // Resume por UUID (campo `uuid` do session list — o `id` curto NÃO
    // funciona no --session do run, testado na v0.82.0).
    if (this.messageSession.sessionId) args.push("--session", this.messageSession.sessionId);
    args.push(message);

    this.traceSpawn("crush", args);
    let proc: ChildProcess;
    try {
      proc = spawnDropped(this.runnerCommand("crush"), args, {
        cwd: this.opts.workspaceRoot,
        env: this.crushTurnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, this.opts.dropTo ?? null);
    } catch (e) {
      imgCleanup();
      this.messageSession.busy = false;
      this.opts.onError(`crush spawn falhou: ${(e as Error).message}`);
      this.setState("idle");
      return;
    }
    this.ocActiveProc = proc;

    let out = "";
    let errOut = "";

    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      this.traceCli("crush", "stdout", chunk);
      out += chunk;
    });
    proc.stderr!.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (!msg) return;
      this.traceCli("crush", "stderr", msg);
      errOut += chunk;
      this.checkContextFullError(msg);
    });

    proc.on("close", (code) => {
      imgCleanup();
      this.ocActiveProc = null;
      if (this.stopped) { this.messageSession.busy = false; this.emitExit(code); return; }
      void this.finishCrushTurn({ out, errOut, code, epoch, firstTurn, pendingSummary, content, images });
    });
  }

  /** Pós-turno do crush: emite o texto, captura o uuid da sessão nova, fatura
   *  o delta de tokens e trata falha de resume (sessão sumida do crush.db).
   *  Só libera a fila (busy) DEPOIS da captura de sessão — um segundo turno
   *  spawnado antes criaria OUTRA sessão e a conversa se partiria em duas. */
  private async finishCrushTurn(t: {
    out: string; errOut: string; code: number | null; epoch: number;
    firstTurn: boolean; pendingSummary: string | undefined;
    content: string; images?: ImageAttachment[];
  }): Promise<void> {
    try {
      // Epoch trocado (clear/compact no meio do turno): nada deste turno pode
      // falar/faturar/ressuscitar sessão pós-reset.
      if (!this.messageSession.owns(t.epoch)) return;

      const text = t.out.trim();
      const failed = (t.code ?? 1) !== 0 && !text;

      // Resume apontando pra sessão que sumiu do crush.db (reboot limpou o
      // data dir, delete manual): "session not found". Larga o id e re-tenta
      // o turno UMA vez como sessão nova (a mensagem não pode se perder).
      if (failed && this.messageSession.sessionId && isMissingSessionMessage(t.errOut)) {
        this.opts.onError(`[crush] sessão ${this.messageSession.sessionId} não existe mais — recomeçando sessão nova`);
        this.messageSession.resetForRetry(t.pendingSummary);
        this.crushUsage.reset({ prompt: 0, completion: 0 });
        this.info.sessionId = undefined;
        if (this.opts.onSessionId) this.opts.onSessionId("");
        this.messageSession.prepend({ content: t.content, images: t.images });
        return; // finally libera busy e drena — o retry roda como turno novo
      }

      if (failed) {
        // Primeiro turno que morreu sem output (key inválida, modelo errado,
        // provider fora): restaurar firstTurn/summary pro retry não perder o
        // system prompt (mesma proteção do gemini).
        this.messageSession.restoreFirstTurn(t);
        const err = t.errOut.trim() || `crush exit ${t.code ?? "?"} sem output`;
        this.checkContextFullError(err);
        this.opts.onError(`crush: ${err.slice(0, 500)}`);
        return;
      }

      if (text) {
        this.setState("speaking");
        this.opts.onAssistantText(text);
      }
      if (t.errOut.trim()) this.opts.onError(t.errOut.trim().slice(0, 500));

      // Captura da sessão criada pelo run (o stdout não traz o id): com o
      // data dir POR AGENTE, a mais recente é necessariamente a deste turno.
      if (!this.messageSession.sessionId) {
        const last = await this.crushSessionJson(["session", "last"]);
        // `session last --json` retorna {meta:{uuid,...},messages:[...]} —
        // o uuid mora em .meta (o shape raiz {uuid} é só do `session list`).
        const uuid = parseCrushSessionMeta(last).sessionId;
        if (!this.messageSession.owns(t.epoch)) return; // reset durante a captura
        if (uuid) {
          this.messageSession.sessionId = uuid;
          if (this.opts.onSessionId) this.opts.onSessionId(uuid);
        } else {
          this.opts.log("warn", `[crush:${this.info.name}] não consegui capturar o uuid da sessão — próximo turno cria sessão nova`);
        }
      }

      // Billing: meta cumulativo → delta contra a base. Ocupação de janela NÃO
      // é derivável daqui (turno com N tool-calls soma N prompts) — contexto
      // cheio do crush é detectado pela rota reativa (checkContextFullError no
      // stderr), igual ao gemini.
      if (this.messageSession.sessionId) {
        const show = await this.crushSessionJson(["session", "show", this.messageSession.sessionId]);
        if (!this.messageSession.owns(t.epoch)) return;
        const parsed = parseCrushSessionMeta(show);
        const prompt = parsed.prompt;
        const completion = parsed.completion;
        if (prompt > 0 || completion > 0) {
          const cumulative = this.crushUsage.delta({ prompt, completion });
          const delta: AgentUsage = {
            input: cumulative.prompt,
            output: cumulative.completion,
            cacheCreate: 0,
            cacheRead: 0,
          };
          if (delta.input > 0 || delta.output > 0) this.opts.onUsageDelta?.(delta);
        }
      }
    } finally {
      this.messageSession.busy = false;
      if (!this.stopped) {
        this.setState("idle");
        this.drainOcQueue();
      }
    }
  }

  /** Grava imagens (base64) em arquivos temp no tmpdir do agente — pros runners
   *  per-message que aceitam imagem por caminho de arquivo (codex `-i`, gemini
   *  `@path`). Retorna paths + cleanup. opencode usa data-URL inline (não temp). */
  private writeImageTempFiles(images: ImageAttachment[]): { paths: string[]; cleanup: () => void } {
    const result = this.runtimeFiles.writeImages(images, imageExtension);
    for (const error of result.errors) this.opts.log("warn", `[cli:${this.info.id}] falha gravando imagem temp: ${error.message}`);
    return { paths: result.paths, cleanup: result.cleanup };
  }

  private drainOcQueue() {
    // `compacting` pausa a fila: turno iniciado no meio do compact roda em
    // paralelo com o one-shot/summarize na MESMA sessão (prime engoliria a
    // resposta dele; thread.started ressuscitaria a sessão pós-reset).
    // Re-drenada no finally do compactContext.
    if (this.messageSession.busy || this.compacting || this.messageSession.queuedCount() === 0 || this.stopped) return;
    this.messageSession.busy = true;
    const next = this.messageSession.dequeue();
    if (!next) { this.messageSession.busy = false; return; }
    const { content, images } = next;
    if (this.opts.cliRunner === "gemini") {
      this.runGeminiMessage(content, images);
    } else if (this.opts.cliRunner === "codex") {
      this.runCodexMessage(content, images);
    } else if (this.opts.cliRunner === "crush") {
      void this.runCrushMessage(content, images);
    } else if (this.opts.cliRunner === "grok") {
      void this.runGrokMessage(content, images);
    } else {
      this.runOpenCodeMessage(content, images);
    }
  }

  /* ---------- public API ---------- */

  // Cap defensivo nas filas: server malicioso (token roubado) ou bug
  // em restart/a2a loop podia floodar agent:send → memory unbounded.
  // 20 cobre retomada legítima; loop agent↔agent com Grok enchia 100 e
  // queimava tokens por horas.
  private static readonly MAX_BUFFERED_MESSAGES = 20;

  pushUserMessage(content: string, images?: ImageAttachment[]) {
    if (isLoopStopMessage(content)) {
      const dropped = this.messageSession.clearQueue();
      if (dropped > 0) {
        this.opts.log("warn", `[cli:${this.info.id}:${this.opts.cliRunner}] loop-stop — limpou ${dropped} msg(s) da fila`);
      }
    }
    if (isPerMessageRunner(this.opts.cliRunner)) {
      const queued = this.messageSession.queuedCount();
      if (!this.messageSession.enqueue({ content, images }, AgentRunner.MAX_BUFFERED_MESSAGES)) {
        this.opts.log("warn", `[cli:${this.info.id}:${this.opts.cliRunner}] ocQueue cheia (${queued}) — drop mensagem`);
        return;
      }
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
    const messageContent = buildClaudeUserContent(content, images);
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
    this.messageSession.clearQueue();
    this.openCodeTransport.stop();
    // One-shot de resumo em voo (compact): sem kill, roda órfão por até
    // ONE_SHOT_TIMEOUT_MS consumindo API — e o emitExit abaixo apaga o tmpdir
    // (cwd + session store do gemini) debaixo dele.
    killProcess(this.oneShotProc, "SIGKILL");
    this.oneShotProc = null;
    if (isPerMessageRunner(this.opts.cliRunner)) {
      if (procAlive(this.ocActiveProc)) {
        terminateWithEscalation(this.ocActiveProc);
      } else {
        this.emitExit(0);
      }
      return;
    }
    if (procAlive(this.proc)) {
      try { this.proc!.stdin.end(); } catch {}
      terminateWithEscalation(this.proc);
    }
  }

  async clearContext(): Promise<void> {
    // Exclusão mútua BIDIRECIONAL com o compact (e consigo mesmo): clear no
    // meio de um compact (ou de outro clear) faria killClaudeForRestart+
    // startClaude em paralelo → dois processos claude vivos na mesma sessão.
    if (this.compacting) {
      this.opts.onError("[ctx] clear ignorado — compact em andamento, aguarde terminar");
      return;
    }
    if (this.clearing) {
      this.opts.onError("[ctx] clear já em andamento — ignorado");
      return;
    }
    this.clearing = true;
    try {
      if (this.opts.cliRunner === "claude") {
        await this.killClaudeForRestart();
        this.opts.resumeSessionId = undefined;
        this.info.sessionId = undefined;
        if (this.opts.onSessionId) this.opts.onSessionId("");
        this.resetContextAccounting();
        this.startClaude();
        this.opts.onError("[ctx] context cleared — claude restarted with new session");
        return;
      }
      // Mata turno em voo E one-shot de compact (simétrico a stop()).
      killProcess(this.oneShotProc, "SIGKILL");
      this.oneShotProc = null;
      terminateWithEscalation(this.ocActiveProc);
      this.messageSession.clearQueue();
      this.messageSession.busy = false;
      this.resetWithSummary(undefined);
      this.info.sessionId = undefined;
      if (this.opts.onSessionId) this.opts.onSessionId("");
      this.setState("idle");
      this.opts.onError("[ctx] context cleared — next message starts new session");
    } finally {
      this.clearing = false;
    }
  }

  async compactContext(saveMemory = true): Promise<void> {
    // Guard de reentrância: compactContexts concorrentes (context_full em
    // rajada, clique duplo) fariam killClaudeForRestart + startClaude em
    // paralelo → processo claude órfão + resumo duplicado na conversa.
    if (this.compacting) {
      this.opts.onError("[ctx] compact já em andamento — ignorado");
      return;
    }
    // Simétrico ao check de `compacting` no clearContext: compact entrando na
    // janela do kill de um clear capturaria a sessão antiga e subiria um
    // segundo processo (o early-return do killClaudeForRestart via proc.killed
    // era o buraco; o guard fecha a porta pelo outro lado também).
    if (this.clearing) {
      this.opts.onError("[ctx] compact ignorado — clear em andamento");
      return;
    }
    this.compacting = true;
    try {
      await this.compactContextInner(saveMemory);
    } finally {
      this.compacting = false;
      // A fila oc fica pausada durante o compact (drainOcQueue checa
      // `compacting`) — mensagens chegadas no meio precisam drenar agora.
      if (this.opts.cliRunner !== "claude") this.drainOcQueue();
    }
  }

  private async compactContextInner(saveMemory: boolean): Promise<void> {
    // OpenCode roda via serve HTTP. O one-shot runOneShot/resetWithSummary
    // abaixo NÃO toca a sessão do serve → "compact não faz nada". Aqui:
    // (1) AUTO-EXTRACT de memória (Fase 3) num FORK da sessão (não polui a
    //     conversa real) — pede MEMORY_JSON, parseia, salva via bridge;
    // (2) compacta a sessão real com o summarize NATIVO do serve.
    if (this.opts.cliRunner === "opencode") {
      if (!this.openCodeTransport.ready() || !this.messageSession.sessionId) {
        this.opts.onError("[ctx] compact: sessão opencode ainda não ativa — manda uma mensagem primeiro");
        return;
      }
      // ocModelParts remove o sufixo legado ":<effort>" — split inline aqui
      // mandava "deepseek-v4-pro:max" pro serve e o compact falhava sempre.
      const { providerID, modelID } = providerModelParts(this.info.model);
      if (!providerID || !modelID) { this.opts.onError("[ctx] compact: modelo inválido"); return; }
      // Turno em voo compartilha a sessão do serve: o prime pós-summarize
      // marcaria as parts dele como vistas (resposta engolida + retry
      // re-executa tools com side effect). A fila está pausada pelo guard
      // `compacting` — só falta o em-voo terminar.
      if (!(await this.waitOcIdle())) {
        if (!this.stopped) this.opts.onError("[ctx] compact: turno em andamento não terminou a tempo — tente de novo quando o agente estiver idle");
        return;
      }

      // (1) auto-extract via fork (mesmo prompt do claude) — só se pedido
      if (saveMemory) try {
        const existing = await this.fetchExistingMemories();
        const already = this.memoryAlreadyBlock(existing);
        const extractPrompt =
          "Extract NEW durable knowledge from this conversation worth keeping permanently — every explicit decision, convention, preference, architectural choice or stable fact. Be generous." + already +
          " Respond with ONLY one line: `MEMORY_JSON:` + a single-line JSON array, each item {\"title\":\"<short>\",\"body\":\"<full>\",\"type\":\"decision\"|\"fact\"|\"reference\"|\"preference\",\"supersedes\":[\"<id>\"]?} in the conversation's language. Use `MEMORY_JSON: []` if nothing. No markdown.";
        const fork = await this.ocServeFetch(`/session/${this.messageSession.sessionId}/fork`, "POST", {});
        const forkId = fork?.id as string | undefined;
        if (forkId) {
          try {
            const resp = await this.ocServeFetch(`/session/${forkId}/message`, "POST",
              { model: { providerID, modelID }, parts: [{ type: "text", text: extractPrompt }] }, 120_000);
            const text = (Array.isArray(resp?.parts) ? resp.parts : [])
              .filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("\n");
            this.opts.onError(`[ctx] fork-extract respLen=${text.length} marker=${/MEMORY_JSON/.test(text)}`);
            const { items } = this.parseAndStripMemory(text);
            void this.saveExtractedMemory(items, existing);
            this.opts.onError(`[ctx] memória: ${items.length} fato(s) extraído(s) na compactação`);
          } finally {
            void this.ocServeFetch(`/session/${forkId}`, "DELETE").catch(() => {});
          }
        }
      } catch (e) {
        this.opts.onError(`[ctx] auto-extract falhou: ${(e as Error).message}`);
      }

      // (2) compacta a sessão real. Timeout 300s (= ONE_SHOT_TIMEOUT_MS):
      // com 120s, providers lentos (deepseek) estouravam DETERMINISTICAMENTE
      // em sessão grande — e como timeout não contava no streak, virava loop
      // infinito de compacts caros a cada cooldown.
      try {
        await this.ocServeFetch(`/session/${this.messageSession.sessionId}/summarize`, "POST", { providerID, modelID }, ONE_SHOT_TIMEOUT_MS);
        // O summarize cria uma mensagem nova na sessão (resumo + step-finish
        // com tokens do contexto PRÉ-compactação). Prime IMEDIATO marca essas
        // parts como vistas — a flag needsPrime só seria consumida no início
        // do próximo turno, e um turno em voo drenaria o step-finish antes,
        // re-disparando context_full logo após o reset (resumo-do-resumo).
        try {
          const hist = await this.ocServeFetch(`/session/${this.messageSession.sessionId}/message`, "GET");
          if (Array.isArray(hist)) for (const m of hist) for (const p of (m?.parts ?? [])) { if (p?.id) this.ocSeenPartIds.add(p.id); }
        } catch { this.messageSession.needsPrime = true; /* fallback: prime no próximo turno */ }
        this.resetContextAccounting();
        this.opts.onError(`[ctx] contexto compactado${saveMemory ? " + memória salva" : " (sem salvar memória)"}`);
      } catch (e) {
        // Timeout do cliente não desfaz o summarize no serve: se ele concluir
        // depois, as parts do resumo precisam de prime mesmo assim — senão o
        // próximo turno re-despacha o resumo como fala + context_full espúrio.
        this.messageSession.needsPrime = true;
        // Timeout CONTA no streak: isentá-lo reabria o loop infinito quando o
        // timeout é determinístico (o teto de 3 existe exatamente pra isso).
        // O falso positivo (summarize concluiu no serve após o timeout) fica
        // raro com 300s, e o prime + próximo compact bem-sucedido rearmam.
        this.registerCompactFailure();
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
    const existing = await this.fetchExistingMemories();
    const alreadyBlock = this.memoryAlreadyBlock(existing);
    const summaryPrompt =
      "Two tasks. Write BOTH the summary and the memory entries in the SAME LANGUAGE as the conversation (e.g. if the conversation is in Portuguese, respond in Portuguese). Only the `MEMORY_JSON:` marker and JSON keys stay in English.\n\n" +
      "TASK 1 — Summarize this conversation concisely (decisions made, tasks in progress, key findings, context needed to continue). Be brief.\n\n" +
      "TASK 2 — Extract NEW durable knowledge worth keeping permanently. Include EVERY explicit decision, convention, preference, architectural choice, or stable fact stated by the user or any agent — even a single one matters. Be generous: when in doubt, include it." + alreadyBlock + " Output it on a NEW FINAL LINE as exactly `MEMORY_JSON:` followed by a single-line JSON array. Each element MUST be {\"title\": \"<short>\", \"body\": \"<the fact in full>\", \"type\": \"decision\"|\"fact\"|\"reference\"|\"preference\", \"supersedes\": [\"<id>\"]?} where title/body are in the conversation's language. " +
      "Example: MEMORY_JSON: [{\"title\":\"DB engine\",\"body\":\"The project uses PostgreSQL partitioned by month\",\"type\":\"decision\"}]. " +
      "Output `MEMORY_JSON: []` ONLY if there is no NEW durable info. No markdown, no code fences, single line.";

    if (this.opts.cliRunner === "claude") {
      const oldSession = this.opts.resumeSessionId ?? this.info.sessionId;
      this.opts.onError(`[compact] killing process, oldSession=${oldSession ?? "none"}`);
      await this.killClaudeForRestart();
      this.opts.onError(`[compact] running summary one-shot…`);
      const summary = oldSession ? await this.runOneShotWithSession(summaryPrompt, oldSession) : "";
      this.opts.onError(`[compact] summary length=${summary.length}`);
      // stop()/reconfig durante o one-shot longo: não spawnar processo zumbi —
      // mas fecha o ciclo de vida (emitExit é idempotente): sem isso a UI fica
      // com o agente "running" pra sempre e o token-file sobra em /tmp.
      if (this.stopped) { this.emitExit(null); return; }
      // O one-shot herda a sessão antiga — se ela falhou (contexto estourado,
      // 401/500, billing...), o stdout é vazio ou é SÓ o banner de erro, que
      // sempre COMEÇA com "API Error". A âncora importa nos dois sentidos:
      // banner de qualquer erro é lixo, mas um resumo legítimo que MENCIONE
      // "API Error" no meio do texto (conversa sobre debugging) é válido.
      // NÃO descartar a conversa com base em resumo-lixo: preserva a sessão
      // antiga e deixa o retry (cooldown) ou o usuário decidir.
      const summaryIsError = isApiErrorMessage(summary);
      if (oldSession && (!summary || summaryIsError)) {
        this.registerCompactFailure();
        this.opts.resumeSessionId = oldSession;
        this.startClaude();
        return;
      }
      this.opts.resumeSessionId = undefined;
      this.info.sessionId = undefined;
      this.resetContextAccounting();
      this.startClaude();
      if (summary) {
        const { clean, items } = this.parseAndStripMemory(summary);
        if (saveMemory) void this.saveExtractedMemory(items, existing);
        await new Promise((r) => setTimeout(r, 600));
        this.pushUserMessage(`# Previous conversation summary\n${clean}\n\n---\n\nContinue from here.`);
      }
      return;
    }

    // codex/gemini: one-shot que resume a sessão (codex exec resume / gemini
    // --resume latest) e parseia MEMORY_JSON. Diag de tamanho pra ver se o
    // one-shot retornou texto (vazio = resume falhou ou reasoning model não
    // serializou o agent_message).
    // Sem sessão ativa NESTE epoch não há o que resumir — e o one-shot do
    // gemini (--resume latest incondicional) ressuscitaria a sessão que um
    // clear acabou de descartar (a "latest" no storage do tmpdir ainda é
    // ela); no codex, exec sem sid "resumiria" uma thread nova vazia.
    // Espelha os guards do claude (oldSession) e do opencode (sessionId).
    if (this.messageSession.firstTurn || ((this.opts.cliRunner === "codex" || this.opts.cliRunner === "crush" || this.opts.cliRunner === "grok") && !this.messageSession.sessionId)) {
      this.opts.onError("[ctx] compact: sessão ainda não ativa — manda uma mensagem primeiro");
      return;
    }
    // Turno em voo primeiro: o one-shot escreveria na MESMA sessão (gemini)
    // ou o thread.started/turn.completed dele brigaria com o reset (codex).
    if (!(await this.waitOcIdle())) {
      if (!this.stopped) this.opts.onError("[ctx] compact: turno em andamento não terminou a tempo — tente de novo quando o agente estiver idle");
      return;
    }
    const summary = await this.runOneShot(summaryPrompt);
    // stop() durante o one-shot: emitExit já rodou e o tmpdir já era — não
    // tocar estado nem anunciar compact num agente finalizado.
    if (this.stopped) return;
    this.opts.onError(`[compact] ${this.opts.cliRunner} summary length=${(summary || "").length}`);
    const { clean, items } = this.parseAndStripMemory(summary || "");
    if (saveMemory) void this.saveExtractedMemory(items, existing);
    if (clean) {
      this.resetWithSummary(clean);
      // Notifica o server de que o sessionId antigo morreu (próximo end grava
      // o novo). Sem isso o DB guarda o UUID antigo até o próximo turno.
      this.info.sessionId = undefined;
      if (this.opts.onSessionId) this.opts.onSessionId("");
      this.opts.onError(`[ctx] contexto compactado${saveMemory ? ` (${items.length} memória(s) salvas)` : " (sem salvar memória)"}`);
    } else {
      // Sem resumo utilizável = falha de compact: precisa contar no streak —
      // senão o teto de MAX_COMPACT_FAIL_STREAK nunca engata nos runners
      // codex/gemini (falha determinística vira loop eterno de one-shots
      // caros a cada janela de cooldown).
      this.registerCompactFailure();
    }
  }

  /** Espera o turno oc em voo terminar (a fila fica pausada pelo guard
   *  `compacting`). true = idle; false = desistiu (turno mais longo que o
   *  teto) ou stop() no meio. */
  private async waitOcIdle(maxMs = 120_000): Promise<boolean> {
    const step = 250;
    for (let waited = 0; this.messageSession.busy && !this.stopped && waited < maxMs; waited += step) {
      await new Promise((r) => setTimeout(r, step));
    }
    return !this.messageSession.busy && !this.stopped;
  }

  /** Extrai o bloco `MEMORY_JSON: [...]` do output do summary one-shot,
   *  retorna o summary limpo (sem o bloco) + os itens parseados. Tolerante
   *  a markdown/prefixos e a JSON malformado (retorna [] nesse caso). */
  private parseAndStripMemory(summary: string): { clean: string; items: Array<{ title: string; body: string; type: string; supersedes: string[] }> } {
    const m = summary.match(/^[ \t>*-]*MEMORY_JSON:\s*(\[[\s\S]*?\])\s*$/m);
    if (!m) return { clean: summary.trim(), items: [] };
    let items: Array<{ title: string; body: string; type: string; supersedes: string[] }> = [];
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
              return { title: s.slice(0, 80), body: s, type: "fact", supersedes: [] as string[] };
            }
            const title = pick(x, ["title", "name", "heading", "summary"]);
            const body = pick(x, ["body", "content", "detail", "details", "text", "value", "description"]) || title;
            const rawType = typeof x?.type === "string" ? x.type : (typeof x?.kind === "string" ? x.kind : "fact");
            // supersedes: ids que esta entrada substitui. Filtra ao formato
            // mem_xxxx (anti-alucinação); validação final é contra a lista real.
            const supRaw = Array.isArray(x?.supersedes) ? x.supersedes : (Array.isArray(x?.replaces) ? x.replaces : []);
            const supersedes = supRaw.filter((s: unknown) => typeof s === "string" && /^mem_[a-z0-9]+$/i.test(s)).slice(0, 5) as string[];
            return { title: (title || body).slice(0, 200), body: body.slice(0, 4000), type: allowed.has(rawType) ? rawType : "fact", supersedes };
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
   *  pra não mandar plaintext ao server (E2EE fail-safe). Merge: quando o
   *  modelo marca `supersedes`, remove as memórias antigas que a nova
   *  consolida (só ids reais da lista existente; só se o add criou entry NOVA,
   *  não dedup-hit). Add ANTES, remove DEPOIS (sem transação — duplicata
   *  benigna é preferível a perda). */
  private async saveExtractedMemory(items: Array<{ title: string; body: string; type: string; supersedes: string[] }>, existing: Array<{ id: string; title: string; body: string }> = []): Promise<void> {
    this.opts.onError(`[compact] memory extracted=${items.length}`);
    if (items.length === 0) return;
    const socket = this.opts.bridgeSocketPath;
    if (!socket) {
      this.opts.onError(`[compact] ${items.length} memory item(s) skipped — no bridge relay (would bypass E2EE)`);
      return;
    }
    const existingIds = new Set(existing.map((e) => e.id));
    let saved = 0, merged = 0;
    for (const it of items) {
      try {
        // Agent-scoped: compact extrai fatos da SESSÃO deste agente — não
        // deve poluir o prompt de todos os irmãos.
        const r = await this.postBridgeJson(socket, "memory_add", { title: it.title, body: it.body, type: it.type, scope: "agent" });
        saved++;
        const newId = r?.memory?.id as string | undefined;
        // Só faz merge se o add criou entry NOVA (id não estava na lista) —
        // senão foi dedup-hit e remover a "antiga" perderia o dado.
        const isNew = !!newId && !existingIds.has(newId);
        if (isNew) {
          for (const oldId of it.supersedes) {
            if (!existingIds.has(oldId) || oldId === newId) continue; // só ids reais existentes
            try {
              await this.postBridgeJson(socket, "memory_remove", { id: oldId });
              merged++;
            } catch { /* 403 = não foi o agente que criou → mantém viva. ok. */ }
          }
        }
      } catch (e) {
        this.opts.onError(`[compact] memory save failed: ${(e as Error).message}`);
      }
    }
    if (saved > 0) this.opts.onError(`[compact] auto-saved ${saved} memory entry(ies)${merged > 0 ? `, consolidou ${merged} antiga(s)` : ""}`);
  }

  /** Memórias já existentes (project + camada agent) com id/title/body, via
   *  relay socket (decriptados no inbound). Usado pra dedup E pro merge
   *  (consolidação) da auto-extração. */
  private async fetchExistingMemories(): Promise<Array<{ id: string; title: string; body: string }>> {
    const socket = this.opts.bridgeSocketPath;
    if (!socket) return [];
    try {
      const r = await this.postBridgeJson(socket, "memory_list", {});
      const mems = Array.isArray(r?.memories) ? r.memories : [];
      return mems
        .map((m: any) => ({
          id: typeof m.id === "string" ? m.id : "",
          title: typeof m.title === "string" ? m.title.trim() : "",
          body: typeof m.body === "string" ? m.body.trim() : "",
        }))
        .filter((m: { id: string; title: string }) => m.id && m.title)
        .slice(0, 40);
    } catch {
      return [];
    }
  }

  /** Bloco de prompt: lista as memórias existentes indexadas por id e instrui o
   *  modelo a marcar `supersedes` quando a nova entrada atualiza/substitui uma. */
  private memoryAlreadyBlock(existing: Array<{ id: string; title: string; body: string }>): string {
    if (existing.length === 0) return "";
    const list = existing
      .map((m) => `[id=${m.id}] ${m.title}${m.body ? ` — ${m.body.slice(0, 160)}` : ""}`)
      .join("\n");
    return `\n\nEXISTING MEMORY (a new entry may UPDATE/REPLACE one of these):\n${list}\n` +
      `If your new entry is a better/updated version of an existing one, add "supersedes": ["<id>"] with its id(s) from the list above — ONLY when it is genuinely the same fact updated, not merely related. Otherwise omit "supersedes". Do NOT repeat an existing entry unchanged.`;
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
          res.on("error", (e) => reject(new Error(`resposta interrompida: ${e.message}`))); // mesmo hang do ocServeFetch
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.write(data);
      req.end();
    });
  }

  private async killClaudeForRestart(): Promise<void> {
    // Teste de vida por exitCode/signalCode, NÃO por .killed: kill() marca
    // killed=true no ENVIO do sinal — early-return por .killed pulava a espera
    // quando outro caminho já tinha sinalizado (processo ainda vivo) e a
    // escalação SIGKILL nunca disparava (código morto).
    const proc = this.proc;
    if (!procAlive(proc)) return;
    this.restarting = true;
    await terminateAndWait(proc, { beforeTerminate: () => { try { proc.stdin!.end(); } catch {} } });
    this.restarting = false;
  }

  private async runOneShotWithSession(prompt: string, sessionId: string): Promise<string> {
    return new Promise((resolve) => {
      if (this.stopped) { resolve(""); return; } // mesmo guard do runOneShot
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
      this.oneShotProc = proc; // stop() precisa alcançar o one-shot
      void collectProcessOutput(proc, {
        timeoutMs: ONE_SHOT_TIMEOUT_MS,
        onStdout: (chunk) => this.traceCli("claude", "stdout", chunk),
        onStderr: (chunk) => this.traceCli("claude", "stderr", chunk),
      }).then((result) => {
        if (this.oneShotProc === proc) this.oneShotProc = null;
        resolve(result.timedOut ? "" : result.stdout.trim());
      });
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
