import { TurnLatency, type TurnTiming } from "./runners/turn-latency.js";
import {type ChildProcess, type ChildProcessWithoutNullStreams} from "node:child_process";

import {readdirSync, realpathSync, existsSync, statSync, openSync, readSync, closeSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import type {AgentInfo, AgentRuntimeState, AgentUsage, CliRunner, ImageAttachment} from "./types.js";
import type {ContextFeatures} from "./protocol.js";
import {spawnDropped, type DropTarget} from "./privileges.js";
import type {ResolvedCliCommands} from "./cli-config.js";


import {acquireTurnSlot} from "./runners/turn-gate.js";
import {recordHang, recordHardRecover, recordHardRecoverNotified} from "./health-monitor.js";
import {isGrokFamily, isPerMessageRunner, runnerAdapter} from "./runners/index.js";


import {grokSignalsPath, parseGrokChatToolCalls, type GrokChatToolCall} from "./runners/parsers.js";

import {summarizeMcpServers} from "./runners/mcp-config.js";
import {RunnerRuntimeFiles} from "./runners/runtime-files.js";
import {ContextTracker, CumulativeUsageTracker} from "./runners/context-tracker.js";
import {killGrokLeader, killPidTree, killProcess, pidAlive, processAlive as procAlive, terminateWithEscalation} from "./runners/process-lifecycle.js";

import {createActivityClock, hangPhase, hangThresholds, hardRecoverNotifyPolicy, toolsInFlightHardDue, touchActivityClock, turnLifetimeDue, type HardRecoverKind, type TurnActivityClock} from "./runners/turn-watchdog.js";
import {OpenCodeTransport} from "./runners/opencode-transport.js";
import {HANG_RECOVER_NUDGE_BACKOFF_MS, HANG_RECOVER_NUDGE_MAX, deliverHangRecoverNudge, planHangRecoverNudge} from "./runners/hang-nudge.js";


import {PerMessageSessionState, type FirstTurnSnapshot} from "./runners/message-session.js";


import {resolveContextLimit, resolveContextLimitKnown} from "./runners/model-policy.js";

import {isLoopStopMessage} from "./runners/error-classifier.js";
import {appendFilePrompt, attachmentExtension, buildClaudeUserContent, imageExtension, isInlineImage, safeAttachmentName} from "./runners/attachments.js";
import {ensureOcServer, fetchOcCatalogLimit, ocUsageSemantics, runOpenCodeMessage, runOpenCodeMessageAttached, ocServeFetch, ocHandlePermissionAsked, ocProcessNewParts, ocDispatchPart, ocHandleStreamPart, applyOpenCodeEvents, handleOpenCodeEvent} from "./runners/turns/opencode.js";
import {ingestGeminiLine, runGeminiMessage} from "./runners/turns/gemini.js";
import {runQwenMessage} from "./runners/turns/qwen.js";
import {writeCodexConfig, runCodexMessage, handleCodexEvent, codexSessionsRoot, readCodexRolloutSignals, pollCodexContextOccupancy} from "./runners/turns/codex.js";
import {buildGrokHeadlessArgs, writeGrokConfig, grokTurnEnv, runGrokMessage, finishGrokTurn, grokSignalsCandidates, readGrokContextSignals, grokChatHistoryPath, grokSweepToolCalls, grokUpdatesCandidates, readGrokUpdatesContextTokens, readGrokTurnBilling, pollGrokContextOccupancy} from "./runners/turns/grok.js";
import {writeCrushConfig, crushTurnEnv, crushSessionJson, runCrushMessage, finishCrushTurn, ingestCrushChunk} from "./runners/turns/crush.js";
import {startDsh, dshPushUserMessage, dshStop, dshIsInTurn, dshKillForRestart, dshTakeQueue} from "./runners/turns/dsh.js";
import {compactContext, compactContextInner, waitOcIdle, parseAndStripMemory, saveExtractedMemory, fetchExistingMemories, memoryAlreadyBlock, parseEpisodeJson, memoryTitleNearDup, postBridgeJson, handleUndeliveredTurnResult, resetContextAccounting, checkContextUsage, reportContextOccupancy, notifyContextFull, registerCompactFailure, checkContextFullError} from "./runners/compact.js";
import {runOneShot, runOneShotWithSession, killClaudeForRestart} from "./runners/one-shot.js";
import {traceCli, traceSpawn, renderVerboseIoBlock, traceInternalCli, renderVerboseBlock, colorizeAgentName, supportsAnsi, hexToRgb, extractVerbosePayload, extractValueText, prettyPrintVerboseText, cleanupAgentTmpDir, grokSessionRecentWrite} from "./runners/support.js";
import {startClaude, bootPerMessageRunner, featuresEnv, bridgeEnv, writeGeminiConfig, writeQwenConfig, writeOpenCodeConfig, buildEnv, resolveClaudeConfigDir, expandHome, buildClaudeArgs, writeMcpConfig, capAccum, handleStdout, handleStreamEvent, prepareGraphify, refreshGraphifyMcp, bridgePost, runnerCommand, workspaceInfo, promptContext, initialMessage, ensureRunnerAvailable} from "./runners/bootstrap.js";
export {
  extractOneShotText,
  grokSignalsPath,
  mergeGrokContextOccupancy,
  normalizeGrokCwd,
  parseGrokChatToolCalls,
  parseGrokContextSignals,
  parseGrokTurnBillingFromUpdates,
  parseGrokUpdatesContextTokens,
} from "./runners/parsers.js";
export type { GrokChatToolCall } from "./runners/parsers.js";
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
export const ONE_SHOT_TIMEOUT_MS = 300_000;
/** Timeout do turno opencode via API do serve (POST /message é síncrono e pode
 *  rodar tools por minutos). Generoso; o serve é morto no stop() se preciso. */
/** T-750: teto do POST síncrono `/session/:id/message` do opencode.
 *  Era 600s (10min) fixos — mas o POST só resolve quando o RUN termina, e um
 *  turno real com tools longas passa disso: em 20/09 o BACKEND morreu 4× em
 *  error com durationMs 600.002ms cravados enquanto o run SEGUIA no serve
 *  (steps 10+ após o abort — log do provedor em evidence/T-750). O teto
 *  precisa cobrir o pior toolsHardMs do watchdog (~20min) com folga: quem
 *  apanha run travado é o watchdog (idle 10min / tool 20min), não este POST. */
export const OPENCODE_TURN_TIMEOUT_MS = 30 * 60_000;
/** Timeout do turno headless Grok (`grok -p …`). Sem isso, um resume + system
 *  prompt gigante (skills) deixa o processo zumbi por horas com busy=true e
 *  a fila enche (`ocQueue cheia`). 12 min cobre turnos longos com tools. */
export const GROK_TURN_TIMEOUT_MS = 12 * 60_000;
/** Cap absoluto por turno pra codex/gemini/crush. Antes só grok/opencode
 *  tinham; um CLI travado em loop dependia só do hang-watch por inatividade,
 *  que não dispara se ele segue emitindo. Generoso pra não matar turno longo
 *  legítimo (build/tool). armHardTimeout auto-limpa no exit do processo. */
export const PER_MSG_TURN_TIMEOUT_MS = 15 * 60_000;

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
  /**
   * Entrega texto do agente ao server. Se retornar `false`, o WS não
   * aceitou o frame (socket morto/backpressure) — o runner trata como
   * falha de entrega fim-a-fim (T-009 hipótese WAN).
   */
  onAssistantText: (text: string) => boolean | void;
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
  /**
   * Hang detection (0 tokens): soft = stalled/avisando; hard = turno morto
   * e busy liberado. Server usa hard pra abortar mission steps.
   * T-689: `parked` marca o hard que é PARK (orçamento de auto-continue
   * esgotado, fila vazia) — o server emite push ativo ao orquestrador e um
   * registro próprio, distinto de idle e do hard comum.
   */
  onHung?: (info: { soft: boolean; reason: string; idleMs: number; parked?: boolean }) => void;
  /** projectId (pra rotular graph:status emitido pelo auto-build do grafo). */
  projectId?: string;
  /** Reporta status do índice graphify durante o auto-build no spawn. */
  onGraphStatus?: (status: "building" | "ready" | "error", info?: {
    nodeCount?: number;
    edgeCount?: number;
    error?: string;
    progress?: number;
    phase?: string;
    indexMtime?: number;
    stale?: boolean;
    graphifyAvailable?: boolean;
    graphifyMcpAvailable?: boolean;
    docsPending?: boolean;
    hasSemantic?: boolean;
  }) => void;
  /** Liga watch debounced do workspace (root, graphifyBin). Idempotente. */
  onGraphWatch?: (workspaceRoot: string, graphifyBin: string) => void;
}

/** Paths candidatos do signals.json (cwd canônico + raw + realpath variants). */
export function grokSignalsCandidatesFor(grokHome: string, cwd: string, sessionId: string): string[] {
  const out = new Set<string>();
  out.add(grokSignalsPath(grokHome, cwd, sessionId));
  out.add(path.join(grokHome, "sessions", encodeURIComponent(cwd), sessionId, "signals.json"));
  out.add(path.join(grokHome, "sessions", encodeURIComponent(path.resolve(cwd || ".")), sessionId, "signals.json"));
  try {
    out.add(path.join(grokHome, "sessions", encodeURIComponent(realpathSync(path.resolve(cwd || "."))), sessionId, "signals.json"));
  } catch { /* noop */ }
  return [...out];
}

/** Resolve o chat_history.jsonl da sessão (mesma cadeia de candidatos
 *  do signals.json + fallback de scan por sessionId). */
export function resolveGrokChatHistoryPath(grokHome: string, cwd: string, sessionId: string): string | null {
  for (const sigPath of grokSignalsCandidatesFor(grokHome, cwd, sessionId)) {
    const p = path.join(path.dirname(sigPath), "chat_history.jsonl");
    if (existsSync(p)) return p;
  }
  try {
    const sessionsRoot = path.join(grokHome, "sessions");
    if (existsSync(sessionsRoot)) {
      for (const enc of readdirSync(sessionsRoot)) {
        const p = path.join(sessionsRoot, enc, sessionId, "chat_history.jsonl");
        if (existsSync(p)) return p;
      }
    }
  } catch { /* best-effort */ }
  return null;
}

/** Caminhos candidatos de updates.jsonl da sessão Grok (cwd variants + scan). */
export function grokUpdatesCandidatesFor(grokHome: string, cwd: string, sessionId: string): string[] {
  const tryFiles: string[] = [];
  for (const sigPath of grokSignalsCandidatesFor(grokHome, cwd, sessionId)) {
    tryFiles.push(path.join(path.dirname(sigPath), "updates.jsonl"));
  }
  try {
    const sessionsRoot = path.join(grokHome, "sessions");
    if (existsSync(sessionsRoot)) {
      for (const enc of readdirSync(sessionsRoot)) {
        tryFiles.push(path.join(sessionsRoot, enc, sessionId, "updates.jsonl"));
      }
    }
  } catch { /* noop */ }
  return tryFiles;
}

export interface GrokChatSweepCursor {
  path: string;
  offset: number;
}

/**
 * Lê bytes novos do chat_history.jsonl e devolve as tool_calls ainda não
 * vistas. `onToolUse` ausente = só marca ids (prime de resume).
 * Retorna null se o arquivo sumiu no meio (stat/read falhou).
 */
export function sweepGrokChatToolCallsFromPath(
  filePath: string,
  cursor: GrokChatSweepCursor | null,
  seenIds: Set<string>,
  onToolUse?: (call: GrokChatToolCall) => void,
): { cursor: GrokChatSweepCursor; emitted: boolean } | null {
  let size: number;
  try { size = statSync(filePath).size; } catch { return null; }
  const prev = cursor?.path === filePath ? cursor.offset : 0;
  // Arquivo encolheu = truncado/reescrito → recomeça do zero (dedupe por id
  // segura re-emissão do que já foi visto).
  const start = size >= prev ? prev : 0;
  if (size <= start) return { cursor: { path: filePath, offset: start }, emitted: false };
  let buf: Buffer;
  try {
    const fd = openSync(filePath, "r");
    try {
      const want = size - start;
      buf = Buffer.allocUnsafe(want);
      const n = readSync(fd, buf, 0, want, start);
      buf = buf.subarray(0, n);
    } finally { closeSync(fd); }
  } catch { return null; }
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
  let emitted = false;
  for (const line of lines) {
    for (const call of parseGrokChatToolCalls(line)) {
      if (seenIds.has(call.id)) continue;
      seenIds.add(call.id);
      if (onToolUse) {
        onToolUse(call);
        emitted = true;
      }
    }
  }
  return { cursor: { path: filePath, offset: start + consumed }, emitted };
}


export class AgentRunner {
  readonly info: AgentInfo;
  private readonly turnLatency: TurnLatency;
  private claudeTimings: TurnTiming[] = [];
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
  /** Desde quando `compacting` está ligado. O watchdog fica DESARMADO durante
   *  o compact; sem teto, um await que não resolve deixa a fila parada e o
   *  agente mudo até o usuário parar/iniciar. */
  private compactingSince: number | null = null;
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
  /** T-414: stderr de missing-session no claude só vale ANTES do init.
   *  Depois do init, "404 Not Found" de tool/HTTP não é sessão perdida. */
  private claudeSawInit = false;
  private restarting = false;
  private lastVerboseIoBody = "";
  private lastVerboseIoAt = 0;
  /** Mensagens recebidas durante restart (kill→startClaude). Flushed
   *  quando o novo proc estiver writable. Sem isso, mission engine
   *  perde dispatches feitos no meio do clearContext/compact. */
  private pendingMessages: Array<{ content: string; images?: ImageAttachment[] }> = [];

  /** Hang watchdog: última atividade SEMÂNTICA (eventos parseados / tools / state).
   *  NÃO bytes brutos de stdout/stderr — ver touchActivity + runGrokMessage. */
  private activityClock: TurnActivityClock = createActivityClock();
  /**
   * T-593: pids de turnos spawnados por este runner cujo `close` ainda não
   * chegou. `ocActiveProc` sozinho não basta: um `close` TARDIO de turno já
   * recuperado anula o campo (grok.ts:350) e o `killProcess(null)` do recover
   * seguinte vira no-op — foi assim que 10 CLIs grok ficaram vivos por horas no
   * host do dono (2026-09-16). O pid é a fonte de verdade do kill; o campo
   * continua sendo a do dead-proc-detect. Entrada só sai no `close`.
   */
  private liveTurnPids = new Set<number>();
  private hangWatchTimer: NodeJS.Timeout | null = null;
  /** T-055: true enquanto await acquireTurnSlot — hang watch NÃO conta. */
  private waitingTurnGate = false;
  private recoveringHung = false;
  /**
   * Release do turn-gate do turno per-message em voo. O 'close' do processo
   * costuma liberar; hard recover (SIGKILL sem close) PRECISA chamar isto
   * senão o slot fica preso até MAX_HOLD_MS e a fila congela.
   */
  private activeTurnRelease: (() => void) | null = null;
  /**
   * Mensagem per-message (grok/etc) em execução — re-enfileirada 1x no
   * hard hang recover. Sem isso a instrução Claude→Grok some e o Grok
   * fica idle “morto” até restart manual.
   */
  private inflightPerMessage: {
    content: string;
    images?: ImageAttachment[];
    attempt: number;
  } | null = null;
  /**
   * Claude (e similares): tool_use abertos sem tool_result ainda.
   * Enquanto >0 e com stream recente o CLI pode ficar minutos sem texto —
   * NÃO é hang. MAS se toolsInFlight fica preso (tool_result perdido) ou o
   * MCP trava sem I/O, o hang watch NÃO pode resetar idle pra sempre
   * (bug: agente mudo até restart manual).
   */
  private toolsInFlight = 0;
  /** Quando toolsInFlight passou de 0 → >0 (ms). */
  private toolsInFlightSince: number | null = null;
  /** T-240 (d): janela de agregação de notificações de hard recover (1h,
   *  por agente). 1º attempt não notifica individualmente; ≥3 na janela
   *  vira 1 resumo. attempt≥2 notifica individualmente. */
  private hardRecoverTimes: number[] = [];
  private static readonly HARD_RECOVER_WINDOW_MS = 60 * 60_000;
  /** T-364: timestamps (janela rolante de 30min) dos auto-continues já gastos. */
  private hangNudgeTimes: number[] = [];
  private hangNudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private hangNudgeBackoffs: number[] = HANG_RECOVER_NUDGE_BACKOFF_MS;
  /** Teto do compact. Acima disso o watchdog assume que travou e libera a
   *  fila — folga sobre o pior caso legítimo (one-shot 300s + summarize). */
  private static readonly COMPACT_STUCK_MS = 15 * 60_000;
  /** Intervalo mínimo entre tentativas de destravar a fila (ver tickHangWatch). */
  private static readonly QUEUE_HEAL_INTERVAL_MS = 30_000;
  private lastQueueHealAt = 0;
  /** T-426: valores referenciados por `$VAR` no `.crush.json` (por turno). */
  private crushMcpEnvRefs: Record<string, string> = {};


  private activeTaskId: string | null = null;
  private static readonly ACTIVE_TASK_ID_RE = /^[\w.:/-]{1,128}$/;

  /* R7 (T-462): estado dos turnos extraídos. */
  private ocCatalogLimitFetch?: Promise<void>;
  static readonly OC_EMPTY_RETRIES = 1;
  private codexTurnBilling: { epoch: number; delta: AgentUsage } | null = null;
  private grokSeenToolCallIds = new Set<string>();
  private grokToolsPrimed = false;
  private grokChatSweepState: { path: string; offset: number } | null = null;
  private static readonly ATTACHMENT_TTL_MS = 30 * 60_000;


  public compactContext(...args: any[]) { return (compactContext as any)(this, ...args); }
  private compactContextInner(...args: any[]) { return (compactContextInner as any)(this, ...args); } private waitOcIdle(...args: any[]) { return (waitOcIdle as any)(this, ...args); } private parseAndStripMemory(...args: any[]) { return (parseAndStripMemory as any)(this, ...args); }
  private saveExtractedMemory(...args: any[]) { return (saveExtractedMemory as any)(this, ...args); } private fetchExistingMemories(...args: any[]) { return (fetchExistingMemories as any)(this, ...args); } private memoryAlreadyBlock(...args: any[]) { return (memoryAlreadyBlock as any)(this, ...args); }
  private parseEpisodeJson(...args: any[]) { return (parseEpisodeJson as any)(this, ...args); } private memoryTitleNearDup(...args: any[]) { return (memoryTitleNearDup as any)(this, ...args); } private postBridgeJson(...args: any[]) { return (postBridgeJson as any)(this, ...args); }
  private handleUndeliveredTurnResult(...args: any[]) { return (handleUndeliveredTurnResult as any)(this, ...args); } private resetContextAccounting(...args: any[]) { return (resetContextAccounting as any)(this, ...args); } private checkContextUsage(...args: any[]) { return (checkContextUsage as any)(this, ...args); }
  private reportContextOccupancy(...args: any[]) { return (reportContextOccupancy as any)(this, ...args); } private notifyContextFull(...args: any[]) { return (notifyContextFull as any)(this, ...args); } private registerCompactFailure(...args: any[]) { return (registerCompactFailure as any)(this, ...args); }
  private checkContextFullError(...args: any[]) { return (checkContextFullError as any)(this, ...args); } private runOneShot(...args: any[]) { return (runOneShot as any)(this, ...args); } private runOneShotWithSession(...args: any[]) { return (runOneShotWithSession as any)(this, ...args); }
  private killClaudeForRestart(...args: any[]) { return (killClaudeForRestart as any)(this, ...args); } private traceCli(...args: any[]) { return (traceCli as any)(this, ...args); } private traceSpawn(...args: any[]) { return (traceSpawn as any)(this, ...args); }
  private renderVerboseIoBlock(...args: any[]) { return (renderVerboseIoBlock as any)(this, ...args); } private traceInternalCli(...args: any[]) { return (traceInternalCli as any)(this, ...args); } private renderVerboseBlock(...args: any[]) { return (renderVerboseBlock as any)(this, ...args); }
  private colorizeAgentName(...args: any[]) { return (colorizeAgentName as any)(this, ...args); } private supportsAnsi(...args: any[]) { return (supportsAnsi as any)(this, ...args); } private hexToRgb(...args: any[]) { return (hexToRgb as any)(this, ...args); }
  private extractVerbosePayload(...args: any[]) { return (extractVerbosePayload as any)(this, ...args); } private extractValueText(...args: any[]) { return (extractValueText as any)(this, ...args); } private prettyPrintVerboseText(...args: any[]) { return (prettyPrintVerboseText as any)(this, ...args); }
  private cleanupAgentTmpDir(...args: any[]) { return (cleanupAgentTmpDir as any)(this, ...args); } private grokSessionRecentWrite(...args: any[]) { return (grokSessionRecentWrite as any)(this, ...args); }


  private startClaude(...args: any[]) { return (startClaude as any)(this, ...args); } private bootPerMessageRunner(...args: any[]) { return (bootPerMessageRunner as any)(this, ...args); } private featuresEnv(...args: any[]) { return (featuresEnv as any)(this, ...args); }
  private bridgeEnv(...args: any[]) { return (bridgeEnv as any)(this, ...args); } private writeGeminiConfig(...args: any[]) { return (writeGeminiConfig as any)(this, ...args); } private writeQwenConfig(...args: any[]) { return (writeQwenConfig as any)(this, ...args); }
  private writeOpenCodeConfig(...args: any[]) { return (writeOpenCodeConfig as any)(this, ...args); } private buildEnv(...args: any[]) { return (buildEnv as any)(this, ...args); } private resolveClaudeConfigDir(...args: any[]) { return (resolveClaudeConfigDir as any)(this, ...args); }
  private expandHome(...args: any[]) { return (expandHome as any)(this, ...args); } private buildClaudeArgs(...args: any[]) { return (buildClaudeArgs as any)(this, ...args); } private writeMcpConfig(...args: any[]) { return (writeMcpConfig as any)(this, ...args); }
  private capAccum(...args: any[]) { return (capAccum as any)(this, ...args); } private handleStdout(...args: any[]) { return (handleStdout as any)(this, ...args); } private handleStreamEvent(...args: any[]) { return (handleStreamEvent as any)(this, ...args); }
  private prepareGraphify(...args: any[]) { return (prepareGraphify as any)(this, ...args); } public refreshGraphifyMcp(...args: any[]) { return (refreshGraphifyMcp as any)(this, ...args); } private bridgePost(...args: any[]) { return (bridgePost as any)(this, ...args); }
  private runnerCommand(...args: any[]) { return (runnerCommand as any)(this, ...args); } private workspaceInfo(...args: any[]) { return (workspaceInfo as any)(this, ...args); } private promptContext(...args: any[]) { return (promptContext as any)(this, ...args); }
  private initialMessage(...args: any[]) { return (initialMessage as any)(this, ...args); } private ensureRunnerAvailable(...args: any[]) { return (ensureRunnerAvailable as any)(this, ...args); }

  /* R7 (T-462): turnos delegam para runners/turns (god-file < 1500). */
  private ensureOcServer(...args: any[]) { return (ensureOcServer as any)(this, ...args); } private fetchOcCatalogLimit(...args: any[]) { return (fetchOcCatalogLimit as any)(this, ...args); } private ocUsageSemantics(...args: any[]) { return (ocUsageSemantics as any)(this, ...args); }
  private runOpenCodeMessage(...args: any[]) { return (runOpenCodeMessage as any)(this, ...args); } private runOpenCodeMessageAttached(...args: any[]) { return (runOpenCodeMessageAttached as any)(this, ...args); } private ocServeFetch(...args: any[]) { return (ocServeFetch as any)(this, ...args); }
  private ocHandlePermissionAsked(...args: any[]) { return (ocHandlePermissionAsked as any)(this, ...args); } private ocProcessNewParts(...args: any[]) { return (ocProcessNewParts as any)(this, ...args); } private ocDispatchPart(...args: any[]) { return (ocDispatchPart as any)(this, ...args); }
  private ocHandleStreamPart(...args: any[]) { return (ocHandleStreamPart as any)(this, ...args); } private applyOpenCodeEvents(...args: any[]) { return (applyOpenCodeEvents as any)(this, ...args); } private handleOpenCodeEvent(...args: any[]) { return (handleOpenCodeEvent as any)(this, ...args); }
  private ingestGeminiLine(...args: any[]) { return (ingestGeminiLine as any)(this, ...args); } private runGeminiMessage(...args: any[]) { return (runGeminiMessage as any)(this, ...args); } private runQwenMessage(...args: any[]) { return (runQwenMessage as any)(this, ...args); }
  private writeCodexConfig(...args: any[]) { return (writeCodexConfig as any)(this, ...args); } private runCodexMessage(...args: any[]) { return (runCodexMessage as any)(this, ...args); } private handleCodexEvent(...args: any[]) { return (handleCodexEvent as any)(this, ...args); }
  private codexSessionsRoot(...args: any[]) { return (codexSessionsRoot as any)(this, ...args); } private readCodexRolloutSignals(...args: any[]) { return (readCodexRolloutSignals as any)(this, ...args); } private pollCodexContextOccupancy(...args: any[]) { return (pollCodexContextOccupancy as any)(this, ...args); }
  private buildGrokHeadlessArgs(...args: any[]) { return (buildGrokHeadlessArgs as any)(this, ...args); } private writeGrokConfig(...args: any[]) { return (writeGrokConfig as any)(this, ...args); } private grokTurnEnv(...args: any[]) { return (grokTurnEnv as any)(this, ...args); }
  private runGrokMessage(...args: any[]) { return (runGrokMessage as any)(this, ...args); } private finishGrokTurn(...args: any[]) { return (finishGrokTurn as any)(this, ...args); } private grokSignalsCandidates(...args: any[]) { return (grokSignalsCandidates as any)(this, ...args); }
  private readGrokContextSignals(...args: any[]) { return (readGrokContextSignals as any)(this, ...args); } private grokChatHistoryPath(...args: any[]) { return (grokChatHistoryPath as any)(this, ...args); } private grokSweepToolCalls(...args: any[]) { return (grokSweepToolCalls as any)(this, ...args); }
  private grokUpdatesCandidates(...args: any[]) { return (grokUpdatesCandidates as any)(this, ...args); } private readGrokUpdatesContextTokens(...args: any[]) { return (readGrokUpdatesContextTokens as any)(this, ...args); } private readGrokTurnBilling(...args: any[]) { return (readGrokTurnBilling as any)(this, ...args); }
  private pollGrokContextOccupancy(...args: any[]) { return (pollGrokContextOccupancy as any)(this, ...args); } private writeCrushConfig(...args: any[]) { return (writeCrushConfig as any)(this, ...args); } private crushTurnEnv(...args: any[]) { return (crushTurnEnv as any)(this, ...args); }
  private crushSessionJson(...args: any[]) { return (crushSessionJson as any)(this, ...args); } private runCrushMessage(...args: any[]) { return (runCrushMessage as any)(this, ...args); } private finishCrushTurn(...args: any[]) { return (finishCrushTurn as any)(this, ...args); }
  private ingestCrushChunk(...args: any[]) { return (ingestCrushChunk as any)(this, ...args); }

  constructor(info: AgentInfo, private opts: AgentRunnerOptions) {
    this.info = info;
    this.turnLatency = new TurnLatency(info.id, opts.cliRunner, opts.log);
    this.messageSession = new PerMessageSessionState({
      reset: () => this.turnLatency.current?.finish("reset", "context-reset"),
      queued: (m, retry) => this.turnLatency.enqueue(m, retry),
      discarded: (m, reason) => this.turnLatency.discard(m, reason),
    });
    this.runtimeFiles = new RunnerRuntimeFiles({
      workspaceRoot: opts.workspaceRoot,
      agentId: info.id,
      agentToken: opts.agentToken,
      home: opts.dropTo?.home ?? process.env.HOME ?? os.homedir(),
      runner: opts.cliRunner,
    });
    this.contextTracker = new ContextTracker({
      resolveLimit: (resolvedModel, catalogLimit) => resolveContextLimit({
        configuredModel: this.info.model, resolvedModel, catalogLimit,
      }),
      // T-147: resolução sem fallback — pré-uso, sem fonte real, o payload
      // de usage expõe UNKNOWN (0) em vez do default 200k fabricado.
      resolveLimitKnown: (resolvedModel, catalogLimit) => resolveContextLimitKnown({
        configuredModel: this.info.model, resolvedModel, catalogLimit,
      }),
      onUsage: opts.onContextUsage,
      onWarning: opts.onContextWarning,
      onFull: opts.onContextFull,
      onError: opts.onError,
    });
    // T-308: rastro de injeção MCP por spawn — nomes+transportes apenas
    // (NUNCA env/headers/tokens). Skips por transporte ficam nos warnings
    // dos builders (cada um com nome+motivo).
    if (opts.extraMcpServers && Object.keys(opts.extraMcpServers).length > 0) {
      this.opts.log("info", `[mcp:inject] runner=${opts.cliRunner} agent=${info.name} servers=${summarizeMcpServers(opts.extraMcpServers)}`);
    }
    this.startHangWatch();
    this.openCodeTransport = new OpenCodeTransport({
      // T-703: porta loopback explícita (livre, escolhida pelo transporte);
      // readiness por GET /config — o serve 1.18.31 não depende de URL no stdout.
      spawnServer: (port) => spawnDropped(
        this.runnerCommand("opencode"),
        ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
        { cwd: this.opts.workspaceRoot, env: this.buildEnv(), stdio: ["ignore", "pipe", "pipe"] },
        this.opts.dropTo ?? null,
      ),
      // Stream SEMPRE ligado: era `!autoApprove` (só pra receber
      // permission.asked), então com auto-approve — o modo comum — nada
      // chegava até o POST /message retornar e a UI ficava muda o turno
      // inteiro. É por aqui que saem RUNs, reasoning e usage ao vivo.
      streamEvents: true,
      onReady: (url) => this.opts.log("info", `[cli:${this.info.id}:opencode] serve ready ${url}`),
      onExit: (code) => this.opts.log("warn", `[cli:${this.info.id}:opencode] serve exited (code ${code})`),
      onEvent: (event) => {
        const value = event as { type?: string; properties?: any };
        if (value?.type === "permission.asked") { void this.ocHandlePermissionAsked(value.properties ?? {}); return; }
        if (value?.type === "message.part.updated") this.ocHandleStreamPart(value.properties ?? {});
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

  contextLimit(): number {
    return this.contextTracker.limit();
  }

  resetWithSummary(summary?: string): void {
    // T-417: o reset abaixo bumpa o epoch e invalida o turno em voo — a partir
    // daqui o close dele é STALE e (pelo guarda dos runners per-message) não
    // toca em mais nada. O slot do gate que era dele tem de voltar AGORA:
    // antes o close tardio o libertava mesmo com epoch velho; com o guarda,
    // sem isto clear/compact a meio do turno vazava o slot até o guarda
    // anti-deadlock do turn-gate (MAX_HOLD_MS) o liberar à força.
    // Idempotente (releaseActiveTurnSlot puxa e nula o handle).
    this.releaseActiveTurnSlot();
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
  isAlive(): boolean {
    if (this.exited || this.stopped) return false;
    if (this.opts.cliRunner === "claude") return procAlive(this.proc);
    return true;
  }

  /** M18 (T-441): turno VIVO do claude contínuo — o self-update usava só o
   *  turn-gate (per-message) e reiniciava no meio do turno do claude, matando
   *  a sessão. Estados de trabalho + mensagens bufferizadas com proc vivo
   *  contam; per-message devolve false (lá o turn-gate é a fonte). */
  isTurnActive(): boolean {
    if (this.exited || this.stopped) return false;
    if (this.opts.cliRunner !== "claude") return false;
    if (this.pendingMessages.length > 0 && procAlive(this.proc)) return true;
    return this.currentState === "thinking" || this.currentState === "sending" || this.currentState === "speaking";
  }

  async start() {
    await this.prepareGraphify();
    // prepareGraphify pode aguardar um build (até 180s); se o agente foi
    // parado/removido nessa janela, não spawnar processo zumbi.
    if (this.stopped) return;
    // Baseline na UI: barra aparece em 0% com o limit do model (antes do 1º turno).
    this.reportContextOccupancy(0);
    if (this.opts.cliRunner === "opencode") {
      if (!this.ensureRunnerAvailable("opencode")) { this.emitExit(1); return; }
      this.writeOpenCodeConfig();
      this.bootPerMessageRunner();
      return;
    }
    if (this.opts.cliRunner === "gemini") {
      if (!this.ensureRunnerAvailable("gemini")) { this.emitExit(1); return; }
      this.writeGeminiConfig();
      this.bootPerMessageRunner();
      return;
    }
    if (this.opts.cliRunner === "qwen") {
      if (!this.ensureRunnerAvailable("qwen")) { this.emitExit(1); return; }
      this.writeQwenConfig();
      this.bootPerMessageRunner();
      return;
    }
    if (this.opts.cliRunner === "codex") {
      if (!this.ensureRunnerAvailable("codex")) { this.emitExit(1); return; }
      this.bootPerMessageRunner();
      return;
    }
    if (this.opts.cliRunner === "crush") {
      if (!this.ensureRunnerAvailable("crush")) { this.emitExit(1); return; }
      this.writeCrushConfig();
      this.bootPerMessageRunner();
      return;
    }
    if (isGrokFamily(this.opts.cliRunner)) {
      if (!this.ensureRunnerAvailable(this.opts.cliRunner)) { this.emitExit(1); return; }
      this.writeGrokConfig();
      this.bootPerMessageRunner();
      return;
    }
    if (this.opts.cliRunner === "dsh") {
      // T-690: servidor ACP v1 stdio persistente (`dsh --profile acp`).
      if (!this.ensureRunnerAvailable("dsh")) { this.emitExit(1); return; }
      startDsh(this as unknown as Record<string, unknown>);
      return;
    }
    if (!this.ensureRunnerAvailable("claude")) { this.emitExit(1); return; }
    this.startClaude();
  }

  /** Feature graph (graphify): se ligada, garante o índice do workspace
   *  (build local se ausente) e injeta o MCP server `graphify` em
   *  extraMcpServers — daí os 4 config writers (claude/gemini/opencode/codex)
   *  o serializam como qualquer outro MCP. No-op se a feature está off ou o
   *  binário graphify-mcp não está instalado.
   *
   *  Se o índice JÁ existe: injeta MCP na hora e faz `update` em background
   *  (não bloqueia o spawn). Só aguarda o build quando é a 1ª indexação. */
  private writeAttachmentFiles(
    items: ImageAttachment[],
  ): { files: Array<{ path: string; name: string; inline: boolean }>; cleanup: () => void } {
    const result = this.runtimeFiles.writeImages(
      items,
      imageExtension,
      (a, i, nonce) =>
        isInlineImage(a)
          ? `img-${nonce}-${i}.${imageExtension(a.mimeType)}`
          // Nome original preservado: é o que o agente lê no prompt.
          : `${nonce}-${safeAttachmentName((a as ImageAttachment).name, `anexo-${i}.${attachmentExtension(a as ImageAttachment)}`)}`,
    );
    for (const error of result.errors) this.opts.log("warn", `[cli:${this.info.id}] falha gravando anexo temp: ${error.message}`);
    // `written` traz o índice de origem — `paths` sozinho desalinha os nomes
    // quando uma gravação falha no meio.
    const files = result.written.map(({ index, path: filePath }) => ({
      path: filePath,
      name: items[index]?.name ?? filePath.split("/").pop() ?? "anexo",
      inline: isInlineImage(items[index] ?? { mimeType: "" }),
    }));
    return { files, cleanup: result.cleanup };
  }

  /**
   * Anexo temp não pode sumir junto com o turno: o agente lê o arquivo quando
   * chega na tool (fila, aprovação, thinking longo), não quando a mensagem
   * entra. `unref` pra o timer pendente não segurar o shutdown do daemon.
   */
  private scheduleAttachmentCleanup(cleanup: () => void): void {
    const timer = setTimeout(cleanup, AgentRunner.ATTACHMENT_TTL_MS);
    timer.unref?.();
  }

  /**
   * Grava só os anexos NÃO-imagem e devolve o trecho de prompt que os
   * referencia. Para claude/opencode, que mandam imagem inline: sem isto o
   * arquivo era filtrado do payload e sumia sem erro nenhum.
   */
  private attachNonImageFiles(content: string, images?: ImageAttachment[]): { content: string; cleanup: () => void } {
    const arquivos = (images ?? []).filter((a) => !isInlineImage(a));
    if (!arquivos.length) return { content, cleanup: () => {} };
    const { files, cleanup } = this.writeAttachmentFiles(arquivos);
    return { content: appendFilePrompt(content, files), cleanup };
  }

  private drainOcQueue() {
    // `compacting` pausa a fila: turno iniciado no meio do compact roda em
    // paralelo com o one-shot/summarize na MESMA sessão (prime engoliria a
    // resposta dele; thread.started ressuscitaria a sessão pós-reset).
    // Re-drenada no finally do compactContext.
    if (this.messageSession.busy || this.compacting || this.messageSession.queuedCount() === 0 || this.stopped) return;
    this.messageSession.busy = true;
    this.touchActivity();
    const next = this.messageSession.dequeue();
    if (!next) { this.messageSession.busy = false; return; }
    this.turnLatency.activate(next, this.messageSession.sessionId ? "resume" : "cold");
    const { content, images } = next;
    if (this.opts.cliRunner === "gemini") {
      void this.runGeminiMessage(content, images);
    } else if (this.opts.cliRunner === "qwen") {
      void this.runQwenMessage(content, images);
    } else if (this.opts.cliRunner === "codex") {
      void this.runCodexMessage(content, images);
    } else if (this.opts.cliRunner === "crush") {
      void this.runCrushMessage(content, images);
    } else if (isGrokFamily(this.opts.cliRunner)) {
      void this.runGrokMessage(content, images);
    } else {
      void this.runOpenCodeMessage(content, images);
    }
  }

  /* ---------- public API ---------- */

  // Cap defensivo nas filas: server malicioso (token roubado) ou bug
  // em restart/a2a loop podia floodar agent:send → memory unbounded.
  // 20 cobre retomada legítima; loop agent↔agent com Grok enchia 100 e
  // queimava tokens por horas.
  private static readonly MAX_BUFFERED_MESSAGES = 20;

  /**
   * T-720: dreno do self-update. Devolve e LIMPA as mensagens enfileiradas e
   * ainda não iniciadas — fila per-message, pendingMessages do claude (restart)
   * e fila do dsh — na ordem de chegada. O turno em curso não está em nenhuma
   * delas e segue intacto. O host re-cifra isto no spool do re-exec.
   */
  takeQueuedForDrain(): Array<{ content: string; images?: ImageAttachment[] }> {
    const out: Array<{ content: string; images?: ImageAttachment[] }> = [];
    for (const m of this.messageSession.takeAllForDrain()) out.push({ content: m.content, images: m.images });
    for (const m of this.pendingMessages) this.turnLatency.discard(m, "drained");
    out.push(...this.pendingMessages.splice(0));
    out.push(...dshTakeQueue(this as unknown as Record<string, unknown>));
    return out;
  }

  pushUserMessage(content: string, images?: ImageAttachment[], latencyMessage?: { content: string; images?: ImageAttachment[] }) {
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
    if (this.opts.cliRunner === "dsh") {
      // T-690: fila própria do ACP (1 prompt por vez por sessão); o driver
      // buffera até o handshake concluir.
      dshPushUserMessage(this as unknown as Record<string, unknown>, content, images);
      return;
    }
    if (this.restarting || !this.proc || !this.proc.stdin.writable) {
      if (this.pendingMessages.length >= AgentRunner.MAX_BUFFERED_MESSAGES) {
        this.opts.log("warn", `[cli:${this.info.id}:claude] pendingMessages cheia (${this.pendingMessages.length}) — drop mensagem durante restart`);
        return;
      }
      const pending = latencyMessage ?? { content, images };
      this.turnLatency.enqueue(pending);
      this.pendingMessages.push(pending);
      this.opts.log("info", `[cli:${this.info.id}:claude] buffered message during restart (queued=${this.pendingMessages.length})`);
      return;
    }
    const latencyInput = latencyMessage ?? { content, images };
    this.turnLatency.enqueue(latencyInput);
    // Não-imagem não cabe no payload inline do claude — vai por arquivo.
    const anexos = this.attachNonImageFiles(content, images);
    const messageContent = buildClaudeUserContent(anexos.content, images);
    this.scheduleAttachmentCleanup(anexos.cleanup);
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: messageContent },
    });
    this.traceCli("claude", "stdin", line);
    const timing = this.turnLatency.activate(latencyInput, this.info.sessionId ? "resume" : "cold");
    timing.start();
    this.claudeTimings.push(timing);
    this.proc.stdin.write(line + "\n");
    this.setState("thinking");
  }

  stop() {
    this.turnLatency.finishAll("stopped", "stop");
    for (const timing of this.claudeTimings) timing.finish("stopped", "stop");
    this.claudeTimings = [];
    this.stopped = true;
    this.stopHangWatch();
    if (this.hangNudgeTimer) {
      clearTimeout(this.hangNudgeTimer);
      this.hangNudgeTimer = null;
    }
    // Limpa buffers pendentes — sem isso, mensagens bufferadas durante
    // restart ficam em memory por toda vida do AgentRunner (mesmo após
    // stop). Cleanup explicit pra GC. M18: o isTurnActive segura o
    // self-update enquanto há buffer com proc vivo; se o stop chega com
    // buffer, o descarte é DECLARADO (antes era mudo).
    if (this.pendingMessages.length > 0) {
      this.opts.log("info", `[cli:${this.info.id}:${this.opts.cliRunner}] stop com ${this.pendingMessages.length} msg(s) bufferizada(s) — descartadas`);
    }
    this.pendingMessages = [];
    this.messageSession.clearQueue();
    this.openCodeTransport.stop();
    // One-shot de resumo em voo (compact): sem kill, roda órfão por até
    // ONE_SHOT_TIMEOUT_MS consumindo API — e o emitExit abaixo apaga o tmpdir
    // (cwd + session store do gemini) debaixo dele.
    killProcess(this.oneShotProc, "SIGKILL");
    this.oneShotProc = null;
    // Grok: mata também o leader persistente (não é o ocActiveProc). Sem isto
    // o leader fica zumbi entre restarts — só era morto no HARD recover.
    if (isGrokFamily(this.opts.cliRunner)) {
      try { killGrokLeader(this.runtimeFiles.grokLeaderSocket()); } catch { /* best-effort */ }
    }
    if (isPerMessageRunner(this.opts.cliRunner)) {
      // T-593: turno abandonado por hard recover não está em `ocActiveProc` —
      // sem isto o stop() deixava o CLI vivo (o daemon só morre junto com os
      // filhos no shutdown; um stop de agente isolado vazava o processo).
      this.killTrackedTurnPids("SIGKILL");
      if (procAlive(this.ocActiveProc)) {
        terminateWithEscalation(this.ocActiveProc);
      } else {
        this.emitExit(0);
      }
      return;
    }
    if (this.opts.cliRunner === "dsh") {
      // T-690: o driver fecha a sessão (best-effort) e mata o processo ACP.
      dshStop(this as unknown as Record<string, unknown>);
      this.emitExit(0);
      return;
    }
    if (procAlive(this.proc)) {
      try { this.proc!.stdin.end(); } catch {}
      terminateWithEscalation(this.proc);
    } else {
      // M17 (T-440): proc nunca subiu/morreu sem exit — o host precisa do
      // evento pra desanexar o runner (antes o entry ficava com cadáver).
      this.proc = null;
      this.emitExit(0);
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
      if (this.opts.cliRunner === "dsh") {
        // T-690: mesmo contrato do claude — sessão nova, sem resume.
        await dshKillForRestart(this as unknown as Record<string, unknown>);
        this.opts.resumeSessionId = undefined;
        this.info.sessionId = undefined;
        if (this.opts.onSessionId) this.opts.onSessionId("");
        this.resetContextAccounting();
        startDsh(this as unknown as Record<string, unknown>);
        this.opts.onError("[ctx] context cleared — dsh restarted with new session");
        return;
      }
      // Mata turno em voo E one-shot de compact (simétrico a stop()).
      killProcess(this.oneShotProc, "SIGKILL");
      this.oneShotProc = null;
      // T-593: e o turno abandonado por um recover anterior, que já não está
      // referenciado em `ocActiveProc` (senão o clear deixa o CLI rodando o
      // turno da sessão descartada).
      this.killTrackedTurnPids("SIGKILL");
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

  setActiveTask(taskId: string): void {
    const id = typeof taskId === "string" ? taskId.trim() : "";
    if (!AgentRunner.ACTIVE_TASK_ID_RE.test(id)) {
      this.opts.onError(`[active-task] taskId inválido ignorado: ${String(taskId).slice(0, 64)}`);
      return;
    }
    if (this.activeTaskId !== id) {
      this.activeTaskId = id;
      this.opts.onError(`[active-task] set ${id}`);
    }
  }

  /** Limpa a task ativa em task:updated (status done). Com taskId, só limpa
   *  se for a ativa — done atrasado de task antiga não apaga reatribuição
   *  mais nova. Sem taskId (defensivo), limpa incondicionalmente. */
  clearActiveTask(taskId?: string): void {
    if (!this.activeTaskId) return;
    if (taskId && this.activeTaskId !== taskId) return;
    this.opts.onError(`[active-task] clear ${this.activeTaskId}`);
    this.activeTaskId = null;
  }

  /**
   * T-343 — memória EPISÓDICA no momento do done. A extração do compact só
   * acontece quando o contexto explode; o fim de uma task é o ponto de maior
   * densidade de conhecimento ("como é que isto se resolveu aqui"). One-shot
   * na MESMA sessão (runOneShot faz resume em todos os runners) a pedir UMA
   * entrada `{title, body}` com situação→abordagem que funcionou→armadilha,
   * gravada como type=experience (não-pinada: recall-only, o hot-set só a
   * recebe se alguém a fixar). Guards: agente idle (nunca escrever na sessão
   * em voo), uma reflexão por task, cooldown por agente, e o fail-safe E2EE
   * do saveExtractedMemory (sem relay, nada é gravado).
   */
  private reflectionInFlight = false;
  private lastReflectionAt = 0;
  private reflectedTaskIds = new Set<string>();
  private static readonly REFLECTION_COOLDOWN_MS = 5 * 60_000;

  async noteTaskDone(taskId: string, title?: string): Promise<void> {
    if (this.stopped || this.reflectionInFlight) return;
    if (this.currentState !== "idle") return;
    if (!this.activeTaskId || (this.activeTaskId !== taskId)) return;
    if (this.reflectedTaskIds.has(taskId)) return;
    if (Date.now() - this.lastReflectionAt < AgentRunner.REFLECTION_COOLDOWN_MS) return;
    const sid = this.opts.cliRunner === "claude" ? this.opts.resumeSessionId : this.messageSession.sessionId;
    if (!sid) return; // sem sessão não há o que refletir
    this.reflectionInFlight = true;
    this.reflectedTaskIds.add(taskId);
    if (this.reflectedTaskIds.size > 64) this.reflectedTaskIds.clear();
    try {
      const titleLine = title ? `Task title: "${title}"\n` : "";
      const prompt =
        "Reflect on the task you just completed in this conversation. " +
        titleLine +
        "Write ONE lesson about HOW it was solved in THIS project (what worked, what to avoid next time a similar task shows up). " +
        "Skip it if the task was trivial, fully automated, or taught you nothing reusable. " +
        "Write in the conversation's language. Output exactly one line: `EPISODE_JSON:` followed by a single-line JSON array with ONE element " +
        "{\"title\": \"<short, <=120 chars>\", \"body\": \"<situation -> what worked -> pitfall>\"} or `EPISODE_JSON: []` to skip. No markdown, no fences." +
        (this.opts.cliRunner ? "" : "");
      const out = await this.runOneShot(prompt);
      if (this.stopped) return;
      const items = this.parseEpisodeJson(out);
      if (items.length === 0) {
        this.opts.onError("[episode] reflexão: nada a guardar");
        return;
      }
      const existing = await this.fetchExistingMemories();
      // proveniência EXPLÍCITA: quando a reflexão grava, o activeTaskId já foi
      // limpo pelo clearActiveTask (o save é async e o clear é síncrono).
      await this.saveExtractedMemory(items, existing, taskId);
      this.lastReflectionAt = Date.now();
      this.opts.onError(`[episode] reflexão gravada (task ${taskId})`);
    } catch (e) {
      this.opts.onError(`[episode] reflexão falhou: ${(e as Error).message}`);
    } finally {
      this.reflectionInFlight = false;
    }
  }

  /** Parse tolerante de EPISODE_JSON (mesma robustez do MEMORY_JSON). */
  private emitExit(code: number | null) {
    if (this.exited) return;
    this.turnLatency.finishAll("process-exit");
    for (const timing of this.claudeTimings) timing.finish("process-exit");
    this.claudeTimings = [];
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
    // Atividade real (não stalled/idle/queued) zera o soft-stall.
    // "queued" = espera de gate — NÃO reseta o relógio (T-055).
    if (state !== "idle" && state !== "stopping" && state !== "stalled" && state !== "queued") {
      this.touchActivity();
    }
    this.opts.onState(state);
  }

  /* ---------- Hang watchdog (0 tokens) ---------- */

  private touchActivity(): void {
    touchActivityClock(this.activityClock);
    // Soft hang anterior: progresso semântico limpa o visual "stalled".
    if (this.currentState === "stalled") {
      this.setState("thinking");
    }
  }

  /** Idempotente — close e hard recover podem chamar os dois. */
  private releaseActiveTurnSlot(): void {
    const r = this.activeTurnRelease;
    this.activeTurnRelease = null;
    try { r?.(); } catch { /* release do gate é best-effort */ }
  }

  /** T-593: registra o pid do turno recém-spawnado (chamar logo após o spawn). */
  private trackTurnPid(pid: number | null | undefined): void {
    if (pid && pid > 1) this.liveTurnPids.add(pid);
  }

  /** T-593: o `close` confirmou a morte — para de rastrear. Idempotente. */
  private untrackTurnPid(pid: number | null | undefined): void {
    if (pid) this.liveTurnPids.delete(pid);
  }

  /**
   * T-593: mata TODO turno ainda rastreado, POR PID. Cobre o caso em que
   * `ocActiveProc` já foi anulado por um close tardio (kill no-op) e o caso de
   * processo cujo `close` nunca chega (netos herdam os pipes). Best-effort e
   * idempotente: pid já morto devolve false.
   *
   * Pid que já morreu sai do rastreio: sem isso o Set cresceria por toda a vida
   * do daemon quando o `close` não chega, e um pid reciclado pelo SO poderia
   * apanhar um processo alheio.
   */
  private killTrackedTurnPids(signal: NodeJS.Signals = "SIGKILL"): number {
    let killed = 0;
    for (const pid of [...this.liveTurnPids]) {
      if (!pidAlive(pid)) { this.liveTurnPids.delete(pid); continue; }
      if (killPidTree(pid, signal)) killed += 1;
    }
    return killed;
  }

  /**
   * T-251: gate de turno para TODOS os runners per-message (antes só o
   * Grok gateava — gemini/codex/crush/opencode fugiam do semáforo e o
   * self-update, que usa o gate como prova de idle (T-088), matava o CLI em
   * turno alheio). Mesmo contrato do caminho Grok: estado "queued" + flag
   * suspendem o watchdog de hang (T-055), o release é amarrado ao 'close'
   * do processo (ou ao fim do POST no opencode serve) via activeTurnRelease,
   * e o hard recover/idempotência cuidam do resto. Retorna false se o
   * runner parou enquanto esperava slot.
   */
  private async gateTurn(): Promise<boolean> {
    if (this.stopped) return false;
    const timing = this.turnLatency.current;
    timing?.gateStart();
    this.waitingTurnGate = true;
    this.setState("queued");
    const pool = this.info.ephemeral ? "bg" as const : "main" as const;
    const release = await acquireTurnSlot(`${this.opts.cliRunner}:${this.info.name}`, this.opts.log, pool);
    timing?.gateEnd();
    timing?.start();
    this.waitingTurnGate = false;
    if (this.stopped) { release(); return false; }
    this.activeTurnRelease = release;
    return true;
  }

  /** M20 (T-443): spawn que rebenta (ENOENT/setpriv/unsafe drop) tem de
   *  desfazer o que o turno já reservou: slot do gate, busy e anexos. Sem
   *  isto o turno fica "vivo" sem processo e 3 falhas bloqueiam o pool de
   *  gates por 15min para TODOS os agentes da pool. Espelha o cleanup do
   *  close (owns(epoch) → release/busy/idle) + restore do firstTurn. */
  private failTurnSpawn(
    runner: string,
    error: unknown,
    epoch: number,
    imgCleanup: () => void,
    firstTurnSnapshot: FirstTurnSnapshot,
  ): void {
    this.turnLatency.current?.finish("spawn-error");
    imgCleanup();
    this.opts.onError(`${runner} spawn falhou: ${(error as Error).message}`);
    if (this.messageSession.owns(epoch) || this.stopped) {
      this.releaseActiveTurnSlot();
      this.ocActiveProc = null;
      this.messageSession.busy = false;
    }
    if (this.stopped) return;
    if (this.messageSession.owns(epoch)) {
      this.messageSession.restoreFirstTurn(firstTurnSnapshot);
      this.setState("idle");
      this.drainOcQueue();
    }
  }

  /** Grok: tool_call abriu — protege hang watch até result/text/teto. */
  private noteGrokToolInFlight(): void {
    if (this.toolsInFlight === 0) this.toolsInFlightSince = Date.now();
    this.toolsInFlight++;
    this.touchActivity();
  }

  private clearGrokToolsInFlight(): void {
    if (this.toolsInFlight === 0) return;
    this.toolsInFlight = 0;
    this.toolsInFlightSince = null;
  }

  /**
   * CLI terminou com texto, mas o frame agent:text não saiu no WS.
   * Sem isto o agente fica idle “mudo” sem watchdog (hipótese WAN T-009):
   * processo OK, busy=false, user sem resposta até restart.
   * Re-enfileira a mensagem em voo 1× e telemetra como hard recover.
   */
  private startHangWatch(): void {
    if (this.hangWatchTimer) return;
    this.hangWatchTimer = setInterval(() => {
      try { this.tickHangWatch(); } catch (e) {
        this.opts.log("warn", `[hang] tick error: ${(e as Error).message}`);
      }
    }, 5_000);
    if (this.hangWatchTimer.unref) this.hangWatchTimer.unref();
  }

  private stopHangWatch(): void {
    if (this.hangWatchTimer) {
      clearInterval(this.hangWatchTimer);
      this.hangWatchTimer = null;
    }
  }

  /** true se o agent está no meio de um turno (busy per-message ou estado ativo). */
  private isInTurn(): boolean {
    // T-055: "queued" = esperando slot do gate — NÃO é turno em execução.
    if (this.waitingTurnGate || this.currentState === "queued") return false;
    if (this.messageSession.busy) return true;
    if (this.opts.cliRunner === "dsh" && dshIsInTurn(this as unknown as Record<string, unknown>)) return true;
    const s = this.currentState;
    return s === "thinking" || s === "speaking" || s === "sending" || s === "stalled";
  }

  /** Grok: mtime de signals/updates avança sem stdout → conta como atividade. */
  private tickHangWatch(): void {
    if (this.stopped || this.recoveringHung) return;
    // T-055: espera no turn-gate (MAX saturado) — relógio NÃO corre. O
    // busy=true + thinking antigo contava a fila como inatividade e o
    // watchdog matava turnos que nem tinham spawnado.
    if (this.waitingTurnGate || this.currentState === "queued") {
      this.activityClock.deadSince = null;
      this.activityClock.softReported = false;
      return;
    }
    // compacting preso: desbloqueia a fila (senão mensagens somem pra sempre).
    // Este teto era só um comentário — o código apenas retornava, então um
    // await que nunca resolve no compact desarmava o watchdog E travava a
    // fila: agente mudo até parar/iniciar, sem UMA linha de log.
    if (this.compacting) {
      const since = this.compactingSince;
      if (since != null && Date.now() - since >= AgentRunner.COMPACT_STUCK_MS) {
        this.opts.log(
          "warn",
          `[hang:${this.info.name}] compact preso há ${Math.round((Date.now() - since) / 1000)}s — liberando flag e drenando fila`,
        );
        this.compacting = false;
        this.compactingSince = null;
        this.opts.onError("[ctx] compact travou — liberado automaticamente; a fila voltou a rodar");
        if (this.opts.cliRunner !== "claude") this.drainOcQueue();
      }
      return;
    }
    // Fila órfã: mensagens enfileiradas, nenhum turno em voo e nada as
    // drenando. Qualquer early-return que erre o drain (ou exceção engolida)
    // deixava o agente mudo com as mensagens paradas — o watchdog nem
    // acordava, porque sem busy `isInTurn()` é false. Auto-cura antes disso.
    // Throttle: se o drain falha na origem (CLI ausente, systemPrompt cifrado)
    // a fila continua cheia e um retry a cada tick viraria flood de log.
    if (
      isPerMessageRunner(this.opts.cliRunner)
      && !this.messageSession.busy
      && this.messageSession.queuedCount() > 0
    ) {
      const now = Date.now();
      if (now - this.lastQueueHealAt >= AgentRunner.QUEUE_HEAL_INTERVAL_MS) {
        this.lastQueueHealAt = now;
        this.opts.log(
          "warn",
          `[hang:${this.info.name}] fila com ${this.messageSession.queuedCount()} msg(s) parada sem turno — drenando`,
        );
        this.drainOcQueue();
      }
      return;
    }
    if (!this.isInTurn()) {
      this.activityClock.deadSince = null;
      // Fora de turno: limpa contagem residual de tools.
      if (this.toolsInFlight > 0 && this.currentState === "idle") {
        this.toolsInFlight = 0;
        this.toolsInFlightSince = null;
      }
      return;
    }

    const runner = this.opts.cliRunner;
    const t = hangThresholds(runner);
    const now = Date.now();
    const idleMs = now - this.activityClock.lastActivityAt;

    // T-240 (b): processo do turno MORTO com busy → hard em deadProcMs
    // (~12s grok) — detecção real de morte fica rápida MESMO com tool
    // in-flight (antes o bloqueio de tool adiava a morte até o teto).
    const proc = this.ocActiveProc;
    if (this.messageSession.busy && proc && !procAlive(proc)) {
      if (this.activityClock.deadSince == null) this.activityClock.deadSince = now;
      const deadFor = now - this.activityClock.deadSince;
      if (deadFor >= t.deadProcMs) {
        this.recoverHungTurn(`process dead for ${Math.round(deadFor / 1000)}s while busy`, idleMs);
        return;
      }
    } else {
      this.activityClock.deadSince = null;
    }

    // Claude continuous: proc morto sem busy (state thinking/stalled) → recover
    if (runner === "claude" && !this.messageSession.busy && this.proc && !procAlive(this.proc)) {
      void this.recoverClaudeContinuousHang(`claude process dead while state=${this.currentState}`, idleMs);
      return;
    }
    if (runner === "dsh" && this.isInTurn()) {
      const client = (this as unknown as { dsh?: { alive?: boolean } }).dsh;
      if (client && client.alive === false) {
        void this.recoverDshContinuousHang(`dsh process dead while state=${this.currentState}`, idleMs);
        return;
      }
    }

    // T-371 (d): teto ABSOLUTO de lifetime do turno — elapsed desde
    // markTurnStart, não se renova com atividade. É o que apanha o loop de
    // tokens que renova o relógio de ociosidade semântica para sempre (F4);
    // tools em voo também não o adiam.
    // T-598: kind="lifetime" — corte por teto em turno vivo preserva a
    // sessão (retry continua de onde parou) e não notifica no 1º attempt.
    if (this.messageSession.busy && turnLifetimeDue(this.activityClock, t, now)) {
      this.recoverHungTurn(
        `turn lifetime ${Math.round((now - this.activityClock.turnStartedAt) / 1000)}s ≥ ${Math.round((t.lifetimeMs ?? 0) / 1000)}s`,
        idleMs,
        "lifetime",
      );
      return;
    }

    // Tools em execução (Claude continuous + Grok tool loop): silêncio de
    // stream é esperado por minutos (shell, MCP, peer wait). T-240 (a): COM
    // tool em voo e processo VIVO, hard só no teto absoluto toolsHardMs
    // (~10min grok) — tsc/suíte/watch de CI rodam minutos sem evento e o
    // hard de 120s matava turnos saudáveis (119 falsos positivos em prod).
    // Passado o teto: assume tool_result perdido e reavalia o hang abaixo.
    if (this.toolsInFlight > 0) {
      const toolsAge = this.toolsInFlightSince != null ? now - this.toolsInFlightSince : 0;
      if (toolsInFlightHardDue(toolsAge, t)) {
        this.opts.log(
          "warn",
          `[hang:${this.info.name}] toolsInFlight=${this.toolsInFlight} aberto há ${Math.round(toolsAge / 1000)}s ` +
            `(teto absoluto ${Math.round(t.toolsHardMs / 60000)}min) — tool_result perdido ou teto; reavaliando hang`,
        );
        this.toolsInFlight = 0;
        this.toolsInFlightSince = null;
        // não return — cai no hangPhase abaixo
      } else {
        // tool viva + processo vivo: não soft/hard; idle semântico NÃO mata
        if (this.currentState === "stalled") this.setState("thinking");
        return;
      }
    }

    // Grok: NÃO resetar idle por mtime de signals/updates/chat_history.
    // O poll de tools + o CLI escrevem nesses arquivos a cada poucos
    // segundos MESMO quando o turno está zumbi sem resposta pro user —
    // isso fazia hangPhase nunca chegar em hard e busy ficar preso até
    // restart manual. Só stdout/stderr (touchActivity nos handlers) conta.

    // T-593: cold start (turno ainda sem NENHUM evento semântico) usa a janela
    // firstEventMs em vez do hardMs seco — medido: 121/124 hard recovers de prod
    // disparavam no limiar de 120s com o turno apenas carregando o CLI.
    // T-685: DEPOIS do primeiro evento vale o teto postEventMs — o silêncio do
    // modelo (xhigh) estourava o hardMs seco com o turno vivo; a trava real
    // segue recolhida, no teto declarado (grok: 5min), não aos 120s.
    const phase = hangPhase(idleMs, t, this.activityClock.firstEventAt == null);
    if (phase === "hard") {
      if (this.messageSession.busy) {
        // per-message: mata o turno e drena fila
        this.recoverHungTurn(`no activity for ${Math.round(idleMs / 1000)}s`, idleMs);
        return;
      }
      if (runner === "claude" && this.isInTurn()) {
        // continuous: soft nunca bastava — agente ficava "stalled" pra sempre
        // até restart manual. Hard = reinicia o processo claude com resume.
        void this.recoverClaudeContinuousHang(
          `no activity for ${Math.round(idleMs / 1000)}s (continuous)`,
          idleMs,
        );
        return;
      }
      if (runner === "dsh" && this.isInTurn()) {
        void this.recoverDshContinuousHang(
          `no activity for ${Math.round(idleMs / 1000)}s (dsh)`,
          idleMs,
        );
        return;
      }
    }
    // Soft: aviso visual (uma vez). Soft alto (12min claude) cobre tools longas.
    if (phase === "soft" && !this.activityClock.softReported) {
      this.activityClock.softReported = true;
      this.setState("stalled");
      recordHang(runner);
      const msg = `[hang] sem atividade há ${Math.round(idleMs / 1000)}s (runner=${runner}) — aguardando…`;
      this.opts.log("warn", `${msg} agent=${this.info.name}`);
      this.opts.onError(msg);
      this.opts.onHung?.({ soft: true, reason: msg, idleMs });
    }
  }

  /** Hard recover: mata turno, libera busy + turn-gate, avisa server.
   *  T-598: `kind` distingue o corte por TETO DE LIFETIME (turno vivo,
   *  parcial legítima → sessão preservada, sem notificação no 1º attempt)
   *  do hang clássico (semântica T-240/T-371 intacta). */
  private recoverHungTurn(reason: string, idleMs: number, kind: HardRecoverKind = "hang"): void {
    if (this.recoveringHung || this.stopped) return;
    this.turnLatency.current?.finish("hard-recover", reason.startsWith("hard timeout") ? "hard-timeout" : reason.startsWith("token loop") ? "token-loop" : "watchdog", kind);
    this.recoveringHung = true;
    recordHardRecover(this.opts.cliRunner);
    const label = kind === "lifetime" ? "lifetime" : "hang";
    try {
      this.opts.log(
        "warn",
        `[${label}:${this.info.name}] HARD recover: ${reason} (runner=${this.opts.cliRunner} idleMs=${Math.round(idleMs)})`,
      );
      killProcess(this.ocActiveProc, "SIGKILL");
      killProcess(this.oneShotProc, "SIGKILL");
      // T-593: `ocActiveProc` pode já ter sido anulado por um close TARDIO do
      // turno anterior (grok.ts:350) — nesse caso o kill acima é no-op e o CLI
      // antigo sobrevivia por horas. Mata também todo pid rastreado: turno
      // abandonado é, por definição, todo turno vivo deste runner num recover.
      const nTracked = this.killTrackedTurnPids("SIGKILL");
      if (nTracked > 0) {
        this.opts.log("warn", `[hang:${this.info.name}] matou ${nTracked} pid(s) de turno rastreado(s)`);
      }
      // T-055: cliente headless morto NÃO mata o leader do Grok — se o leader
      // travou, o próximo turno fica mudo até restart. Mata o processo no
      // --leader-socket deste agente e limpa o sock.
      if (isGrokFamily(this.opts.cliRunner)) {
        const sock = this.runtimeFiles.grokLeaderSocket();
        const n = killGrokLeader(sock);
        if (n > 0) {
          this.opts.log("warn", `[hang:${this.info.name}] matou leader grok (${n} pid) sock=${sock}`);
        }
      }
      // Grok/crush: netos podem manter o ChildProcess "vivo" no Node —
      // nullifica mesmo se kill falhar pra não bloquear dead-detect.
      this.ocActiveProc = null;
      this.oneShotProc = null;
      this.waitingTurnGate = false;
      this.toolsInFlight = 0;
      this.toolsInFlightSince = null;
      this.activityClock.softReported = false;
      this.activityClock.deadSince = null;
      // Slot do gate ANTES de drain: senão a re-fila espera em si mesma.
      this.releaseActiveTurnSlot();

      // M19 (T-442): o turno do opencode roda no SERVE persistente — matar o
      // POST/cliente não cancela a run lá. Aborta a sessão ANTES de
      // re-enfileirar, senão o retry dispara um turno paralelo e os side
      // effects (tools) duplicam. Best-effort: abort tardio não bloqueia.
      if (this.opts.cliRunner === "opencode" && this.messageSession.sessionId) {
        const sid = this.messageSession.sessionId;
        void this.openCodeTransport.abortSession(sid)
          .then(() => this.opts.log("warn", `[hang:${this.info.name}] opencode: turno abortado no serve (session ${sid.slice(0, 8)}…)`))
          .catch((e) => this.opts.log("warn", `[hang:${this.info.name}] abort do opencode falhou: ${(e as Error).message}`));
      }

      // CRÍTICO: invalidar epoch ANTES de liberar busy/drenar. Senão o
      // finishGrokTurn tardio (close após SIGKILL) zera busy do próximo
      // turno e o Grok fica mudo até restart manual (Claude→Grok intermitente).
      this.messageSession.bumpEpoch();
      this.messageSession.busy = false;

      // Grok: limpa sessionId pra não re-travar no mesmo state zumbi.
      if (isGrokFamily(this.opts.cliRunner)) {
        if (this.messageSession.sessionId) {
          this.opts.log("warn", `[hang:${this.info.name}] limpando sessionId grok após hard recover`);
        }
        this.messageSession.resetForRetry(this.messageSession.pendingSummary);
        this.info.sessionId = undefined;
        this.opts.onSessionId?.("");
      }
      // T-371 (a): qwen é resume por sessão (`-r <id>`): a parcial degenerada
      // do turno morto ficou gravada no jsonl do CLI e voltava no turno
      // seguinte. Neutralizar a sessão ⇒ o próximo spawn abre `--session-id`
      // novo em vez de replayar o lixo. (gemini/codex/crush seguem o mesmo
      // padrão quando houver medição análoga — declarado na entrega.)
      if (this.opts.cliRunner === "qwen" && this.messageSession.sessionId) {
        if (kind === "lifetime") {
          // T-598: corte por TETO em turno vivo — a parcial é legítima (não a
          // degenerada do loop T-371 (c)). Preservar a sessão faz o retry
          // RETOMAR de onde parou (resume) em vez de recomeçar do zero.
          this.opts.log("warn", `[lifetime:${this.info.name}] sessão qwen preservada pós-teto (parcial será retomada)`);
        } else {
          this.opts.log("warn", `[hang:${this.info.name}] neutralizando sessão qwen pós-hard recover (parcial não será replayada)`);
          this.messageSession.resetForRetry(this.messageSession.pendingSummary);
          this.info.sessionId = undefined;
          this.opts.onSessionId?.("");
        }
      }

      // Re-enfileira a mensagem em voo. Sem isso a instrução some e o agente
      // fica idle sem processar nada. Teto de tentativas: hang = 1 retry
      // (contrato T-371 (b)); lifetime = 2 (o corte por teto não é defeito da
      // mensagem — desistir dela no 1º corte perdia trabalho legítimo).
      const inflight = this.inflightPerMessage;
      const attemptBefore = inflight ? inflight.attempt : Number.MAX_SAFE_INTEGER;
      const maxAttempts = kind === "lifetime" ? 2 : 1;
      let retried = false;
      if (inflight && inflight.attempt < maxAttempts) {
        this.inflightPerMessage = { ...inflight, attempt: inflight.attempt + 1 };
        this.messageSession.prepend({ content: inflight.content, images: inflight.images });
        retried = true;
        this.opts.log(
          "warn",
          `[${label}:${this.info.name}] re-enfileirando mensagem após hard recover (attempt ${this.inflightPerMessage.attempt})`,
        );
      } else {
        this.inflightPerMessage = null;
      }
      const tag = kind === "lifetime" ? "[lifetime]" : "[hang]";
      const full = retried
        ? `${tag} turno abortado: ${reason} — reenviando a última mensagem automaticamente` +
          (kind === "lifetime" ? " (sessão preservada)" : " (1×)")
        : `${tag} turno abortado: ${reason}` + (inflight ? " — retry esgotado; envie de novo se necessário" : "");

      // T-240 (d): 1º attempt não notifica individualmente (67/119 falsos
      // positivos em prod eram exatamente isso e TODOS completavam). Agrega:
      // ≥3 hard recovers de 1º attempt na janela de 1h → 1 resumo. A partir
      // do 2º attempt (ou sem mensagem pra re-enfileirar) notifica na hora.
      // T-598: a janela/resumo é de HANG; corte por lifetime em 1º attempt é
      // backstop esperado (silêncio). attempt≥1 de lifetime segue imediato.
      const nowTs = Date.now();
      this.hardRecoverTimes = this.hardRecoverTimes.filter(
        (ts) => nowTs - ts < AgentRunner.HARD_RECOVER_WINDOW_MS,
      );
      if (kind === "hang") this.hardRecoverTimes.push(nowTs);
      const policy = hardRecoverNotifyPolicy(attemptBefore, this.hardRecoverTimes.length, kind);
      // T-662: o contador do health espelha o que a política decidiu avisar —
      // o banner do web deixa de disparar em supressões (spam de "1 hard recover").
      if (policy !== "suppress") recordHardRecoverNotified(this.opts.cliRunner);
      if (policy === "suppress") {
        this.opts.log(
          "warn",
          `[${label}:${this.info.name}] notificação suprimida (1º attempt; ${this.hardRecoverTimes.length}/${3} na janela) — turno re-enfileirado`,
        );
      } else if (policy === "summary") {
        const summary =
          `[hang] ${this.hardRecoverTimes.length} hard recovers (1º attempt) na última hora — ` +
          `turnos re-enfileirados automaticamente (runner=${this.opts.cliRunner})`;
        this.opts.onHung?.({ soft: false, reason: summary, idleMs });
        this.opts.onError(summary);
        this.hardRecoverTimes = []; // janela nova após o resumo
      } else {
        this.opts.onHung?.({ soft: false, reason: full, idleMs });
        this.opts.onError(full);
      }

      this.touchActivity();
      this.setState("idle");
      // Continua fila (inclui re-fila acima)
      try { this.drainOcQueue(); } catch { /* */ }
      this.scheduleHangNudge(idleMs);
    } finally {
      this.recoveringHung = false;
    }
  }

  /**
   * T-364: hard stall sem trabalho na fila deixa o agente idle pra sempre —
   * o turno morreu, não há mensagem pra drenar. Enfileira UM nudge sintético
   * (orçamento 2 / 30min por agente) pro respawn com resume retomar o trabalho.
   * Chamado só de recoverHungTurn, ou seja, nunca na fase soft.
   */
  private scheduleHangNudge(idleMs: number): void {
    if (this.stopped || !isPerMessageRunner(this.opts.cliRunner)) return;
    const plan = planHangRecoverNudge({
      queueLength: this.messageSession.queuedCount(),
      now: Date.now(),
      sentTimes: this.hangNudgeTimes,
      backoffMs: this.hangNudgeBackoffs,
    });
    this.hangNudgeTimes = plan.sentTimes;
    if (plan.notify) {
      const reason =
        `[hang] auto-continue esgotado (${HANG_RECOVER_NUDGE_MAX} por 30min, ` +
        `runner=${this.opts.cliRunner}) — agente parado, envia mensagem pra retomar`;
      this.opts.log("warn", `[hang:${this.info.name}] ${reason}`);
      // T-689: `parked` = este hard é um PARK — o server emite push ativo ao
      // orquestrador (agente+runner+ts), distinto do hard comum e de idle.
      this.opts.onHung?.({ soft: false, reason, idleMs, parked: true });
      return;
    }
    if (!plan.nudge) return;
    this.opts.log(
      "warn",
      `[hang:${this.info.name}] auto-continue ${plan.used}/${HANG_RECOVER_NUDGE_MAX} ` +
        `em ${Math.round(plan.backoffMs / 1000)}s (fila vazia após hard recover)`,
    );
    if (this.hangNudgeTimer) clearTimeout(this.hangNudgeTimer);
    this.hangNudgeTimer = setTimeout(() => {
      this.hangNudgeTimer = null;
      if (this.stopped) return;
      if (!deliverHangRecoverNudge(this.messageSession, AgentRunner.MAX_BUFFERED_MESSAGES)) {
        this.opts.log("warn", `[hang:${this.info.name}] nudge descartado (fila já tinha trabalho)`);
        return;
      }
      this.opts.log("warn", `[hang:${this.info.name}] nudge sintético enfileirado — retomando turno`);
      this.touchActivity();
      try { this.drainOcQueue(); } catch { /* */ }
    }, plan.backoffMs);
    this.hangNudgeTimer.unref?.();
  }

  /**
   * Claude continuous mudo: reinicia o processo com --resume da sessão
   * (preserva contexto) e volta a aceitar mensagens. Antes o hard hang
   * só rodava com messageSession.busy — continuous nunca seta busy, então
   * o agente ficava stalled pra sempre até o user reiniciar.
   */
  private async recoverClaudeContinuousHang(reason: string, idleMs: number): Promise<void> {
    if (this.recoveringHung || this.stopped) return;
    if (this.opts.cliRunner !== "claude") return;
    this.turnLatency.current?.finish("hard-recover", "watchdog", "hang");
    for (const timing of this.claudeTimings) timing.finish("hard-recover", "watchdog", "hang");
    this.claudeTimings = [];
    this.recoveringHung = true;
    try {
      this.opts.log(
        "warn",
        `[hang:${this.info.name}] HARD recover claude continuous: ${reason}`,
      );
      this.toolsInFlight = 0;
      this.toolsInFlightSince = null;
      this.messageSession.busy = false;
      this.activityClock.softReported = false;
      this.activityClock.deadSince = null;
      // Preserva sessionId pra resume
      const sid = this.info.sessionId || this.opts.resumeSessionId;
      if (sid) this.opts.resumeSessionId = sid;
      await this.killClaudeForRestart();
      if (this.stopped) return;
      this.startClaude();
      this.touchActivity();
      this.setState("idle");
      const full = `[hang] claude reiniciado (continuous): ${reason}`;
      this.opts.onHung?.({ soft: false, reason: full, idleMs });
      this.opts.onError(full + " — sessão resumida; envie de novo se a última msg não entrou");
    } catch (e) {
      this.opts.log("error", `[hang:${this.info.name}] recoverClaude falhou: ${(e as Error).message}`);
      this.setState("idle");
    } finally {
      this.recoveringHung = false;
    }
  }

  /** T-690: dsh é persistent como o claude — hard hang sem busy deixava o
   *  agente stalled pra sempre. Mata o ACP e ressobe com session/resume. */
  private async recoverDshContinuousHang(reason: string, idleMs: number): Promise<void> {
    if (this.recoveringHung || this.stopped) return;
    if (this.opts.cliRunner !== "dsh") return;
    this.turnLatency.current?.finish("hard-recover", "watchdog", "hang");
    for (const timing of this.claudeTimings) timing.finish("hard-recover", "watchdog", "hang");
    this.claudeTimings = [];
    this.recoveringHung = true;
    try {
      this.opts.log(
        "warn",
        `[hang:${this.info.name}] HARD recover dsh: ${reason}`,
      );
      this.toolsInFlight = 0;
      this.toolsInFlightSince = null;
      this.activityClock.softReported = false;
      this.activityClock.deadSince = null;
      const sid = this.info.sessionId || this.opts.resumeSessionId;
      if (sid) this.opts.resumeSessionId = sid;
      await dshKillForRestart(this as unknown as Record<string, unknown>);
      if (this.stopped) return;
      startDsh(this as unknown as Record<string, unknown>);
      this.touchActivity();
      this.setState("idle");
      const full = `[hang] dsh reiniciado: ${reason}`;
      this.opts.onHung?.({ soft: false, reason: full, idleMs });
      this.opts.onError(full + " — sessão resumida; envie de novo se a última msg não entrou");
    } catch (e) {
      this.opts.log("error", `[hang:${this.info.name}] recoverDsh falhou: ${(e as Error).message}`);
      this.setState("idle");
    } finally {
      this.recoveringHung = false;
    }
  }
}
