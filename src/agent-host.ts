import { profileHome } from "./profile-home.js";
import path from "node:path";
import fs from "node:fs";
import {AgentRunner, type AgentRunnerOptions} from "./agent-runner.js";
import {breadcrumb, captureWarn} from "./sentry.js";
import {assertWorkspaceScoped, autoWorkspaceCwd, cloneRepoIfMissing, expandBasePath, findGitRoot, getWorkspaceRoot, isInsideRoot, repoCwd} from "./workspace.js";
import {aadV2, E2EE_TABLE, MIGRATE_SEED_DROPPED_REASON, MIGRATE_SEED_RESUME_SKIPS_REASON} from "@the-dudes/protocol/e2ee-fields";
import {decryptForProject, encryptForProject, isE2eEncrypted, isE2eeRequired, setE2eeRequired, redactCredentials, redactCredentialsDeep} from "./daemon-crypto.js";
import {classifyRunnerFailure} from "./runners/error-classifier.js";
import {migratedSeedFor, MIGRATED_SEED_LIMIT_BYTES} from "./migrated-seed.js";
import {agentStateInfo, cliIoCounters, recordAgentEvent, recordAgentState} from "./debug/store.js";
import {formatDrainHolders, type DrainHolder} from "./self-update.js";
import {expirar as expirarFilaRetida, devolver as devolverFilaRetida, esquecer as esquecerFilaRetida, TTL_ITEM_MS, listar as listarFilaRetida, paraFio, reter as reterFila, tamanho as tamanhoFilaRetida, tomar as tomarFilaRetida, totalRetido, CAP_POR_AGENTE} from "./queue-retained.js";

/** 1 enum operacional (paridade hung.soft). Classifica no plaintext ANTES do seal. */
export type AgentErrorKind = "rate_limit" | "other";

export function agentErrorKind(plain: string): AgentErrorKind {
  return classifyRunnerFailure(plain) === "rate_limit" ? "rate_limit" : "other";
}

/**
 * A13 (T-425): `git worktree add` isolado do agent-host.
 *  - spawnDropped com drop (quando o daemon roda como root);
 *  - env por allowlist (buildSummarizerEnv) — antes era spawnSync herdando
 *    process.env inteiro e sem drop;
 *  - `--` antes do path (mesmo contrato do task-workspace/T-424).
 */
export function runGitWorktreeAdd(
  gitRoot: string,
  branchName: string,
  worktreePath: string,
  drop: DropTarget | null = null,
): Promise<{ error?: Error; status: number | null; stderr: string }> {
  // R8 (T-463): helper central (env mínimo + spawnDropped + timeout de grupo).
  return runGit(gitRoot, ["worktree", "add", "-b", branchName, "--", worktreePath], { drop }).then((r) => ({
    error: r.timedOut ? new Error("git worktree add timeout") : undefined,
    status: r.ok ? 0 : (r.status ?? 1),
    stderr: r.stderr,
  }));
}

/**
 * T-092: cifra stderr/erro com o mesmo AAD de agent:text (`messages.content`).
 * Sem chave + e2ee-required → null (caller DROP). Sem projectId → plaintext redatado.
 */
export function sealAgentErrorMessage(projectId: string | undefined, message: string): string | null {
  const raw = String(message ?? "");
  const red = projectId ? redactCredentials(projectId, raw) : raw;
  if (!projectId) return red;
  const enc = encryptForProject(
    red,
    projectId,
    aadV2({ projectId, table: E2EE_TABLE.MESSAGES, field: "content" }),
  );
  if (enc) return enc;
  if (isE2eeRequired(projectId)) return null;
  return red;
}

import type {ResolvedCliCommands} from "./cli-config.js";
import type {AgentInfo, ImageAttachment} from "./types.js";
import type {AgentSpawn, FromDaemon} from "./protocol.js";
import {type DropTarget} from "./privileges.js";
import {runGit} from "./runners/run-git.js";

import {compatibleSessionId} from "./runners/index.js";
import {createAgentInboundBuffer} from "./inbound-dedup.js";
import {montarSnapshot, QUEUE_LIVE_DEBOUNCE_MS, QUEUE_LIVE_RECONCILE_MS, type PendingItem, type WireRecord} from "./queue-live.js";

// Works in both CJS bundle (where __dirname is native) and ESM dev (tsx)
// where we fall back to the process entry script.
const baseDir: string = (() => {
  // __dirname só existe no bundle CJS; em ESM (tsx) o typeof cai no else.
  if (typeof __dirname !== "undefined") return __dirname as string;
  const entry = process.argv[1] || ".";
  return path.dirname(path.resolve(entry));
})();

function resolveBridge(): { command: string; args: string[] } {
  // P2 (T-474): em dev (entry .ts via tsx) a FONTE vence cjs/js stale em
  // daemon/src — antes um daemon.cjs velho deixado por build local sombreava
  // o mcp-bridge.ts e o daemon rodava código antigo.
  const runningFromTs = String(process.argv[1] ?? "").endsWith(".ts");
  const bundled = path.resolve(baseDir, "mcp-bridge.cjs");
  if (!runningFromTs && fs.existsSync(bundled)) return { command: "node", args: [bundled] };
  // Compiled tsc output
  const compiled = path.resolve(baseDir, "mcp-bridge.js");
  if (!runningFromTs && fs.existsSync(compiled)) return { command: "node", args: [compiled] };
  // Dev: tsx + .ts source
  const source = path.resolve(baseDir, "mcp-bridge.ts");
  const tsxBin = (() => {
    const candidates = [
      path.resolve(baseDir, "../node_modules/.bin/tsx"),
      path.resolve(baseDir, "../../node_modules/.bin/tsx"),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return "tsx";
  })();
  return { command: tsxBin, args: [source] };
}

interface Entry {
  info: AgentInfo;
  runner: AgentRunner | null;
  /** T-899: parado pelo dono — mensagem que chega vai para a retenção até o
   *  próximo spawn (antes caía num runner morto e morria com ele). */
  parado?: boolean;
  /** T-899: reentrega da fila retida no spawn. Default LIGADO (o "opcional"
   *  do dono é poder desligar). */
  queueAutoRedeliver?: boolean;
  autoApprove: boolean;
  /** Project ID, captured at spawn. Used to look up the E2EE key when
   *  the bridge relay needs to encrypt/decrypt agent_to_agent traffic. */
  projectId?: string;
  /** Agent token (passed via THE_DUDES_AGENT_TOKEN env). Necessário
   *  pra ressincronizar com o server após restart — server perde o
   *  Map agentTokens (in-memory) mas o processo mcp-bridge segue
   *  rodando com o token antigo. Daemon devolve no resync. */
  agentToken?: string;
  /** Espelho Telegram: chat vinculado pra onde TODA saída do agente é
   *  encaminhada (texto em claro). Setado via agent:send.telegram. */
  telegramMirror?: { botToken: string; chatId: string };
  /** M25 (T-448): worktree isolado deste agente (removido em stop/shutdown).
   *  Sem isto o par (path, gitRoot) perdia-se no escopo do spawn e os
   *  worktrees antigos acumulavam em `<repo>/../worktrees`. */
  worktreePath?: string;
  gitRoot?: string;
}

/**
 * M25 (T-448): remove o worktree de um agente (best-effort, com fallback).
 * `git worktree remove --force` limpa também o metadata (.git/worktrees);
 * se o git falhar (dir já apagado/lock), rmSync + `git worktree prune`.
 */
export function runGitWorktreeRemove(
  gitRoot: string,
  worktreePath: string,
  drop: DropTarget | null = null,
): Promise<{ ok: boolean; detail?: string }> {
  const run = (args: string[]) => runGit(gitRoot, args, { drop });
  return run(["worktree", "remove", "--force", "--", worktreePath]).then(async (r) => {
    if (r.ok) return { ok: true };
    const detail = r.timedOut ? "timeout" : (r.stderr || `exit ${r.status}`);
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* já limpo */ }
    const pr = await run(["worktree", "prune"]);
    if (pr.ok) return { ok: true, detail: `fallback rm+prune (${detail})` };
    return { ok: false, detail };
  });
}

/** T-720: mensagem retida no dreno (em memória, plaintext — nunca em disco). */
interface SpoolItem {
  content: string;
  images?: ImageAttachment[];
  deliveryId?: string;
  enqueuedAt: number;
}
/** T-720: registro do spool em disco — só metadados + blob e2e:v2 re-cifrado. */
interface SpoolRecord {
  agentId: string;
  projectId: string;
  deliveryId?: string;
  enqueuedAt: number;
  blob: string;
}
const SPOOL_FILE = "reexec-spool.json";
/** Spool mais velho que isto não é entregue (o contexto já passou). */
const SPOOL_TTL_MS = 60 * 60_000;
/** AAD próprio: blob do spool não abre como nenhum campo do catálogo e vice-versa. */
function spoolAad(projectId: string): string {
  return aadV2({ projectId, table: "daemon_reexec_spool", field: "message" });
}
/** T-824 (revisão): por PERFIL. Com os dois perfis desta máquina no mesmo
 *  HOME, o spool era um arquivo só: no logout/reboot os dois daemons faziam
 *  rename no mesmo caminho (o último vencia) e, no boot, um regravava as
 *  mensagens do outro. */
export function reexecSpoolDir(): string {
  return process.env.THE_DUDES_REEXEC_SPOOL_DIR || path.join(profileHome(), "reexec-spool");
}

export class AgentHost {
  private entries = new Map<string, Entry>();
  /** T-037: agent:send chegando antes do runner (gap pós-spawn/self-update). */
  private inboundBuffer = createAgentInboundBuffer({ maxPerAgent: 20 });
  /** T-720: ids com mensagem no inboundBuffer (o buffer não lista agentes). */
  private inboundAgentIds = new Set<string>();

  /** T-720: dreno do self-update — nenhum turno novo; mensagens retidas aqui
   *  (e nas filas tiradas dos runners) até o spool do re-exec. */
  private draining = false;
  private drainHeld = new Map<string, SpoolItem[]>();
  /** T-824: por que o dreno está ligado — muda o aviso no chat. */
  private drainReason: "update" | "shutdown" = "update";
  /** T-824: agentes que já receberam o aviso de dreno (1× por dreno). */
  private drainNotified = new Set<string>();
  /** T-720: spool carregado no boot do processo novo, entregue no spawn. */
  private spooled = new Map<string, SpoolRecord[]>();

  /** T-1005: fila ao vivo — registro de cada entrega como veio do fio
   *  (agentId → deliveryId → blob original), debounce e último snapshot. */
  private filaVivaRegistros = new Map<string, Map<string, WireRecord>>();
  private filaVivaTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private filaVivaUltimo = new Map<string, string>();
  /** T-822: último `agent:context` de cada agente. O tipo não entra na fila de
   *  reenvio (só text/error/hung/exit/thinking/tool_use entram), então o open do
   *  WS reemite o valor ATUAL daqui — sem isto a UI fica com o contexto velho. */
  private ultimoContexto = new Map<string, { used: number; limit: number }>();
  private filaVivaReconcilia: ReturnType<typeof setInterval> | null = null;
  private spoolPath: string | null = null;

  /** Quantos agentes este daemon mantém vivos — indicador de saúde da UI. */
  agentCount(): number {
    return this.entries.size;
  }

  /** T-812: visão de debug de cada agente (metadados; nunca conteúdo). */
  debugSnapshot(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const [id, e] of this.entries) {
      let runner: Record<string, unknown> | null = null;
      try { runner = e.runner ? e.runner.debugSnapshot() : null; } catch (err) { runner = { error: (err as Error).message }; }
      out.push({
        agentId: id,
        name: e.info.name,
        role: e.info.role ?? null,
        cliRunner: e.info.cliRunner ?? "claude",
        model: e.info.model ?? null,
        effort: e.info.effort ?? null,
        ephemeral: !!e.info.ephemeral,
        projectId: e.projectId ?? null,
        autoApprove: e.autoApprove,
        worktree: e.worktreePath ?? null,
        telegramMirror: !!e.telegramMirror,
        hasRunner: !!e.runner,
        inboundBuffered: this.inboundBuffer.size(id),
        drainHeld: this.drainHeld.get(id)?.length ?? 0,
        spooled: this.spooled.get(id)?.length ?? 0,
        stateInfo: agentStateInfo(id),
        io: cliIoCounters(id),
        runner,
      });
    }
    return out;
  }

  /** T-812: estado do host (dreno/spool/buffers) para o dashboard. */
  debugHostState(): Record<string, unknown> {
    return {
      agents: this.entries.size,
      withRunner: [...this.entries.values()].filter((e) => !!e.runner).length,
      draining: this.draining,
      // T-899: visibilidade da fila retida (o dono vê o que ficou no stop).
      filaRetida: totalRetido(),
      filaRetidaPorAgente: this.filaRetidaPorAgente(),
      drainHolders: this.drainHolders(),
      reexecuting: this.reexecuting,
      inboundAgents: [...this.inboundAgentIds].map((id) => ({ agentId: id, pending: this.inboundBuffer.size(id) })),
      drainHeld: [...this.drainHeld.entries()].map(([id, l]) => ({ agentId: id, held: l.length })),
      spoolPending: this.spoolPendingCount(),
    };
  }

  /** M18 (T-441): algum runner com turno VIVO fora do turn-gate (claude
   *  contínuo). O idle do self-update precisa consultar isto além do gate. */
  hasActiveTurn(): boolean {
    for (const e of this.entries.values()) {
      if (e.runner?.isTurnActive()) return true;
    }
    return false;
  }

  /** T-1017: quantas mensagens estão enfileiradas (não iniciadas) no runner
   *  do agente — sonda para teste esperar a fila estacionar antes do dreno,
   *  sem depender de timing. -1 = sem runner. */
  runnerEnfileiradas(agentId: string): number {
    const e = this.entries.get(agentId);
    const q = (e?.runner as unknown as { peekQueue?: () => unknown[] } | null)?.peekQueue;
    if (typeof q !== "function") return e?.runner ? 0 : -1;
    try { return q.call(e!.runner)?.length ?? 0; } catch { return 0; }
  }

  /** T-839: claude em turno, com agentId e idade. O turn-gate entra pelo main. */
  drainHolders(now = Date.now()): DrainHolder[] {
    const out: DrainHolder[] = [];
    for (const [agentId, e] of this.entries) {
      const r = e.runner;
      if (!r?.isTurnActive()) continue;
      out.push({
        agentId,
        turnAgeMs: r.activeTurnAgeMs(now) ?? 0,
        runner: e.info?.cliRunner ?? "claude",
        state: e.info?.state,
        reason: r.turnHoldReason() ?? undefined,
      });
    }
    return out;
  }
  private autoApproveDefault = false;
  /** Liga watch debounced do grafo (setado pelo DaemonClient). */
  onGraphWatch?: (workspaceRoot: string, graphifyBin: string, projectId?: string) => void;

  /**
   * Após reindex bem-sucedido: injeta graphify MCP nos agentes já rodando
   * com features.graph (reescreve configs no disco).
   */
  refreshGraphifyMcpForAgents(mcpCommand: string, gPath: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (!e.runner) continue;
      try {
        if (e.runner.refreshGraphifyMcp(mcpCommand, gPath)) n++;
      } catch { /* skip */ }
    }
    return n;
  }

  constructor(
    /** Retorna false se o frame não foi entregue ao socket (WS down/backpressure). */
    private send: (msg: FromDaemon) => boolean | void,
    private dropTo: DropTarget | null = null,
    private bridgeSocketPath: string | null = null,
    private cliCommands: ResolvedCliCommands,
    private verbose: boolean = false,
    private verboseHuman: boolean = false,
    private verboseHumanIo: boolean = false,
    private log: (level: "info" | "warn" | "error", msg: string) => void = () => {},
    private cliLog: (level: "info" | "warn" | "error", msg: string) => void = () => {},
  ) {}

  /** true se o canal aceitou o frame (void legado = assume ok). */
  private deliver(msg: FromDaemon): boolean {
    const r = this.send(msg);
    return r !== false;
  }

  /** Emite agent:error cifrado (messages.content) ou DROP se e2ee-required sem chave. */
  private emitAgentError(agentId: string, message: string, projectId?: string): void {
    const pid = projectId ?? this.entries.get(agentId)?.projectId;
    const errorKind = agentErrorKind(message);
    const sealed = sealAgentErrorMessage(pid, message);
    if (sealed == null) {
      this.log("error", `agent:error recusado: e2ee-required sem chave project=${pid}`);
      return;
    }
    this.deliver({ type: "agent:error", agentId, message: sealed, errorKind });
  }

  /** Returns the project ID this agent is spawned into, or null if the
   *  agent isn't tracked locally (e.g. message destined for an agent on
   *  another daemon — bridge relay falls back to passing through). */
  getAgentProjectId(agentId: string): string | null {
    return this.entries.get(agentId)?.projectId ?? null;
  }

  /** T-581: nome do agente — o relay usa no prompt de delegação cifrado. */
  getAgentName(agentId: string): string | null {
    return this.entries.get(agentId)?.info.name ?? null;
  }

  /** T-233: task ativa do agente — pass-through pro runner. Fonte
   *  autoritativa: server via agent:send.taskId / task:updated done. */
  setActiveTask(agentId: string, taskId: string): void {
    this.entries.get(agentId)?.runner?.setActiveTask(taskId);
  }

  clearActiveTask(agentId: string, taskId?: string): void {
    this.entries.get(agentId)?.runner?.clearActiveTask(taskId);
  }

  /** T-343: reflexão episódica no done (best-effort; o runner impõe guards
   *  de idle/sessão/cooldown). titleCipher é o título cifrado do task (o
   *  daemon decripta com a key do projeto do agente). */
  noteTaskDone(agentId: string, taskId: string, titleCipher?: string): void {
    const e = this.entries.get(agentId);
    if (!e?.runner || !e.projectId) return;
    let title: string | undefined;
    if (titleCipher) {
      title = isE2eEncrypted(titleCipher)
        ? decryptForProject(titleCipher, e.projectId, aadV2({ projectId: e.projectId, table: E2EE_TABLE.TASKS, field: "title" })) ?? undefined
        : titleCipher;
    }
    void e.runner.noteTaskDone(taskId, title);
  }

  /** Vincula/desvincula o agente a um chat do Telegram (espelho de saída). */
  setTelegramMirror(agentId: string, mirror: { botToken: string; chatId: string } | null): void {
    const e = this.entries.get(agentId);
    if (!e) return;
    e.telegramMirror = mirror ?? undefined;
  }

  /** Encaminha um texto pro chat do Telegram via Bot API (egress local, SSRF
   *  guard). Best-effort: falha não derruba o turno do agente. */
  private async mirrorToTelegram(mirror: { botToken: string; chatId: string }, text: string): Promise<void> {
    try {
      const { safeFetch } = await import("./ssrf-guard.js");
      const url = `https://api.telegram.org/bot${mirror.botToken}/sendMessage`;
      // Telegram corta em 4096 chars/mensagem.
      const body = JSON.stringify({ chat_id: mirror.chatId, text: text.slice(0, 4096), disable_web_page_preview: true });
      await safeFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }, { maxRedirects: 0 });
    } catch (e) {
      // Redact o token do bot caso o erro (undici/cause) ecoe a URL.
      const safe = ((e as Error).message ?? "").replace(/bot\d+:[\w-]+/g, "bot***");
      this.log("warn", `[telegram-mirror] falha enviando pro chat ${mirror.chatId}: ${safe}`);
    }
  }

  setAutoApprove(value: boolean) {
    this.autoApproveDefault = value;
  }

  async spawn(msg: AgentSpawn): Promise<void> {
    if (msg.projectId && msg.e2eeRequired != null) setE2eeRequired(msg.projectId, !!msg.e2eeRequired);
    const existing = this.entries.get(msg.agent.id);
    if (existing?.runner) {
      // Distingue RECONNECT (WS reconectou; mesma config) de RECONFIG
      // (troca de runner/model/effort/… — server parou e re-spawnou). No
      // reconfig, o spawn pode chegar ANTES do runner antigo terminar de
      // sair (race com o fallback de 8s do server). Sem este check, o
      // re-broadcast abaixo re-attacha no runner VELHO e o novo nunca sobe
      // — agente fica mudo até reiniciar, OU (pior) segue com effort/model
      // antigo se só o effort mudou. Detecta a mudança e derruba o velho.
      const reconfig =
        existing.info?.cliRunner !== msg.agent.cliRunner ||
        existing.info?.model !== msg.agent.model ||
        existing.info?.effort !== msg.agent.effort ||
        existing.info?.collectThinking !== msg.agent.collectThinking ||
        existing.info?.planMode !== msg.agent.planMode ||
        existing.info?.claudeConfigDir !== msg.agent.claudeConfigDir ||
        // T-597 F1: pid diferente = re-spawn completo. O reconnect puro não
        // atualiza o entry (nem a closure do runner) e os DOIS selos ficariam
        // no pid velho — com o reconfig, entry e closure nascem juntos no pid
        // novo. Cobre também entry sem pid (daemon antigo) que passaria a
        // selar em plaintext no relay.
        existing.projectId !== msg.projectId;
      // M17 (T-440): reconnect só vale para runner VIVO. Claude cujo proc
      // nunca subiu (spawn error) ou morreu sem exit ficava marcado running e
      // nada rodava; aqui o cadáver cai no spawn completo abaixo.
      if (!reconfig && existing.runner.isAlive()) {
        // Reconnect puro — re-anuncia estado pro orchestrator reconciliar.
        // Re-anuncia o token: server perdeu o Map agentTokens (in-memory)
        // após restart e o mcp-bridge segue com o token antigo — sem isto
        // /api/bridge devolve 401 nas próximas chamadas.
        if (existing.agentToken) {
          this.send({ type: "agent:token_resync", agentId: msg.agent.id, token: existing.agentToken });
        }
        this.send({ type: "agent:running", agentId: msg.agent.id, running: true });
        const sid = existing.info?.sessionId ?? existing.runner.info?.sessionId;
        if (sid) this.send({ type: "agent:session", agentId: msg.agent.id, sessionId: sid });
        this.send({ type: "agent:state", agentId: msg.agent.id, state: existing.runner.currentRuntimeState() });
        return;
      }
      // Reconfig OU runner stale (M17): derruba o antigo antes de criar o
      // novo. Seu onExit tardio não vai zerar o novo (guard
      // `e.runner === thisRunner`).
      // T-899: `replace` diz a origem — o callback `onQueueRetained` do runner
      // retém sob o agentId (a fila é do AGENTE) e o spawn a reentrega abaixo.
      try { existing.runner.stop("replace"); } catch { /* já morto */ }
      this.retainFromRunner(msg.agent.id, existing, "replace"); // fallback (callback cobre o runner real)
      existing.runner = null;
    }

    // Resolve cwd:
    //   - agentRepo present → legacy path: cwdOverride/<repo.name>; clone repo there if missing.
    //   - agentRepo absent + cwdOverride → cwdOverride direct.
    //   - else detect git from basePath automatically; legacy repoName is only
    //     used when that subfolder already exists.
    let cwd: string;
    // Em container/scoped: os paths configurados na UI (basePath/cwdOverride)
    // são do HOST e podem não existir aqui. Se THE_DUDES_WORKSPACE_ROOT está
    // setado e o path cai fora dele, usa o próprio root (= a pasta montada,
    // ex: /workspace) — senão o agente nem inicia no daemon containerizado.
    const wsRoot = getWorkspaceRoot();
    const remap = (p: string | undefined): string | undefined =>
      (!p || !wsRoot || isInsideRoot(expandBasePath(p), wsRoot)) ? p : wsRoot;
    const cwdOverrideEff = remap(msg.cwdOverride);
    const basePathEff = remap(msg.basePath) ?? msg.basePath;
    if (wsRoot && (cwdOverrideEff !== msg.cwdOverride || basePathEff !== msg.basePath)) {
      this.emitAgentError(
        msg.agent.id,
        `workspace configurado fica fora do root permitido — usando "${wsRoot}" (THE_DUDES_WORKSPACE_ROOT)`,
        msg.projectId,
      );
    }
    if (msg.agentRepo && cwdOverrideEff) {
      const cwdOverride = expandBasePath(cwdOverrideEff);
      cwd = repoCwd(cwdOverride, msg.agentRepo.name);
      if (!fs.existsSync(path.join(cwd, ".git"))) {
        this.emitAgentError(
          msg.agent.id,
          `clonando ${msg.agentRepo.name} em ${cwd} …`,
          msg.projectId,
        );
        try {
          // ensure parent dir exists
          if (!fs.existsSync(cwdOverride)) {
            fs.mkdirSync(cwdOverride, { recursive: true });
            if (this.dropTo) try { fs.chownSync(cwdOverride, this.dropTo.uid, this.dropTo.gid); } catch {}
          }
          const result = await cloneRepoIfMissing(
            cwdOverride,
            { id: "agent", name: msg.agentRepo.name, gitUrl: msg.agentRepo.gitUrl, defaultBranch: msg.agentRepo.branch },
            this.dropTo,
          );
          if (!result.ok) {
            this.emitAgentError(
              msg.agent.id,
              `git clone falhou: ${result.message}`,
              msg.projectId,
            );
            this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
            return;
          }
        } catch (e) {
          this.emitAgentError(
            msg.agent.id,
            `setup falhou: ${(e as Error).message}`,
            msg.projectId,
          );
          this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
          return;
        }
      }
    } else if (cwdOverrideEff) {
      cwd = expandBasePath(cwdOverrideEff);
      if (!fs.existsSync(cwd)) {
        fs.mkdirSync(cwd, { recursive: true });
        if (this.dropTo) try { fs.chownSync(cwd, this.dropTo.uid, this.dropTo.gid); } catch {}
      }
    } else if (msg.repoName) {
      const legacyRepoCwd = repoCwd(expandBasePath(basePathEff), msg.repoName);
      cwd = fs.existsSync(legacyRepoCwd) ? legacyRepoCwd : autoWorkspaceCwd(basePathEff);
    } else {
      cwd = autoWorkspaceCwd(basePathEff);
      if (!fs.existsSync(cwd)) {
        fs.mkdirSync(cwd, { recursive: true });
        if (this.dropTo) try { fs.chownSync(cwd, this.dropTo.uid, this.dropTo.gid); } catch {}
      }
    }
    // Blast-radius: o cwd resolvido (incluindo cwdOverride vindo do server)
    // tem que estar dentro do THE_DUDES_WORKSPACE_ROOT, se configurado.
    try {
      assertWorkspaceScoped(cwd);
    } catch (e) {
      this.emitAgentError(msg.agent.id, (e as Error).message, msg.projectId);
      this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
      return;
    }
    // Features no log: quando o agente "ignora" uma capacidade, a primeira
    // pergunta é se ela chegou até ele — sem isto não havia como saber.
    if (msg.features) {
      const f = msg.features;
      const on = Object.entries(f).filter(([, v]) => v === true).map(([k]) => k);
      this.log("info", `agent ${msg.agent.id} features: ${on.join(",") || "none"} diagram=${f.diagramLanguage ?? "mermaid"}`);
    }
    this.log("info", `agent ${msg.agent.id} cwd resolvido=${cwd}${wsRoot ? ` (root=${wsRoot})` : ""}`);
    if (!fs.existsSync(cwd)) {
      this.emitAgentError(
        msg.agent.id,
        `cwd "${cwd}" not found — set workspace and clone repos first`,
        msg.projectId,
      );
      this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
      return;
    }

    // Git worktree isolation: create an isolated worktree for this agent
    // so it never shares the same working directory with other agents.
    let worktreePath: string | undefined;
    // M25 (T-448): captura o par (path, gitRoot) pro entry — o `gitRoot` local
    // do bloco não inclui a árvore do worktree (rev-parse dentro dele devolve o
    // próprio worktree).
    let agentWorktree: { path: string; gitRoot: string } | undefined;
    if (msg.agentWorktrees) {
      const gitRoot = findGitRoot(cwd);
      if (gitRoot) {
        const worktreesDir = path.join(gitRoot, "..", "worktrees");
        // Sanitiza o nome do agente ANTES de montar o path. Vinha cru aqui
        // (só branchName era limpo) — um nome com "../" colapsava via
        // path.join e o worktreePath apontava fora de worktreesDir, com
        // rmSync recursivo + git worktree add + chown rodando ANTES do
        // realpath-check (dano já feito).
        const safeName = msg.agent.name.replace(/[^a-zA-Z0-9_-]/g, "-");
        const idSuffix = msg.agent.id.slice(0, 8);
        const branchName = `agent/${safeName}-${idSuffix}`;
        worktreePath = path.join(worktreesDir, `${safeName}-${idSuffix}`);
        try {
          // Containment antes de qualquer operação destrutiva (rmSync/add/chown).
          if (!path.resolve(worktreePath).startsWith(path.resolve(worktreesDir) + path.sep)) {
            throw new Error(`worktree path escapou da base: ${worktreePath}`);
          }
          // E também dentro do workspace root permitido, se configurado.
          assertWorkspaceScoped(worktreePath);
          if (!fs.existsSync(worktreesDir)) {
            fs.mkdirSync(worktreesDir, { recursive: true });
            // chown pro user dropado — sem isso, daemon root cria dir
            // root-owned + CLI (uid=1000) não escreve dentro depois.
            if (this.dropTo) {
              try { fs.chownSync(worktreesDir, this.dropTo.uid, this.dropTo.gid); } catch {}
            }
          }
          if (fs.existsSync(worktreePath)) {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          }
          // A13 (T-425): mesmo helper do graph-indexer — spawnDropped (drop
          // quando root) + env por allowlist; antes era spawnSync herdando
          // process.env inteiro e sem drop.
          const wtRes = await runGitWorktreeAdd(gitRoot, branchName, worktreePath, this.dropTo);
          if (wtRes.error || wtRes.status !== 0) {
            // Falha (branch já existe, HEAD destacado, árvore suja…). Não cair
            // silenciosamente no cwd compartilhado: avisa e mantém o cwd base.
            const detail = wtRes.error?.message ?? ((wtRes.stderr || "").trim() || `exit ${wtRes.status}`);
            this.emitAgentError(
              msg.agent.id,
              `worktree isolado falhou (${detail}) — agente roda no cwd compartilhado`,
              msg.projectId,
            );
            worktreePath = undefined;
          } else if (this.dropTo && fs.existsSync(worktreePath)) {
            // chown recursive — git worktree add criou árvore como root.
            try {
              const chownRecursive = (p: string) => {
                fs.chownSync(p, this.dropTo!.uid, this.dropTo!.gid);
                const st = fs.statSync(p);
                if (st.isDirectory()) {
                  for (const f of fs.readdirSync(p)) chownRecursive(path.join(p, f));
                }
              };
              chownRecursive(worktreePath);
            } catch {}
          }
          // Só segue se o worktree foi de fato criado (git ok acima).
          if (worktreePath) {
            // Defesa em profundidade: garantir que o worktree resolvido
            // não escapou da pasta de worktrees (symlink/race).
            const resolvedWt = fs.realpathSync(worktreePath);
            const resolvedBase = fs.realpathSync(worktreesDir);
            if (!resolvedWt.startsWith(resolvedBase + path.sep)) {
              fs.rmSync(worktreePath, { recursive: true, force: true });
              throw new Error(`worktree escapou da base: ${resolvedWt}`);
            }
            if (fs.existsSync(worktreePath)) {
              agentWorktree = { path: worktreePath, gitRoot };
              cwd = worktreePath;
              this.emitAgentError(
                msg.agent.id,
                `worktree isolado criado em ${worktreePath} (branch ${branchName})`,
                msg.projectId,
              );
            }
          }
        } catch (e) {
          // Não engolir silenciosamente: o throw aqui vem do escape-guard de
          // containment (path traversal / symlink) — é segurança, tem que
          // aparecer. Cai no cwd compartilhado depois de avisar.
          this.emitAgentError(
            msg.agent.id,
            `worktree isolado abortado: ${(e as Error).message}`,
            msg.projectId,
          );
        }
      }
    }

    const bridge = resolveBridge();
    const cliRunner = msg.agent.cliRunner ?? "claude";
    // Drop any session id that isn't valid for this runner. claude uses
    // UUIDs, opencode uses `ses_*`, codex uses opaque thread ids — passing
    // a wrong-format id makes the CLI exit immediately.
    const resumeSessionId = compatibleSessionId(cliRunner, msg.agent.sessionId);
    // Identidade do runner deste spawn. Usada no onExit pra só zerar
    // `e.runner` se ainda for ESTE runner — senão o exit tardio de um
    // runner antigo (troca de runner) zeraria o runner novo.
    let thisRunner: AgentRunner | null = null;
    const opts: AgentRunnerOptions = {
      bridgeCommand: bridge.command,
      bridgeArgs: bridge.args,
      orchestratorUrl: msg.orchUrl,
      agentToken: msg.agentToken,
      cliRunner,
      autoApprove: msg.autoApprove,
      workspaceRoot: cwd,
      resumeSessionId,
      dropTo: this.dropTo,
      bridgeSocketPath: this.bridgeSocketPath,
      extraMcpServers: msg.extraMcpServers,
      features: msg.features,
      cliCommands: this.cliCommands,
      verbose: this.verbose,
      verboseHuman: this.verboseHuman,
      verboseHumanIo: this.verboseHumanIo,
      log: this.log,
      cliLog: this.cliLog,
      onState: (state) => {
        try { recordAgentState(msg.agent.id, state); } catch { /* observação */ }
        this.deliver({ type: "agent:state", agentId: msg.agent.id, state });
        // T-1005: turno começou/acabou = a fila andou.
        this.agendarFilaViva(msg.agent.id);
      },
      onQueueChanged: () => this.agendarFilaViva(msg.agent.id),
      onHung: (info) => {
        try { recordAgentEvent(msg.agent.id, info.parked ? "park" : info.soft ? "hung-soft" : "hung-hard", `${info.reason} (idle ${Math.round(info.idleMs / 1000)}s)`); } catch { /* observação */ }
        this.deliver({
          type: "agent:hung",
          agentId: msg.agent.id,
          soft: info.soft,
          reason: info.reason,
          idleMs: info.idleMs,
          runner: cliRunner,
          // T-689: park (auto-continue esgotado) — o server emite o push ao
          // orquestrador. Campo ausente nos hards comuns (compat).
          ...(info.parked ? { parked: true } : {}),
        });
      },
      onAssistantText: (text) => {
        // Redact credenciais que o agente buscou (get_credential) e ecoou, ANTES
        // de cifrar — em projeto E2EE o server não vê o plaintext, então a
        // redação tem que ser aqui. Depois cifra com a project key. Sem key
        // (legacy/pre-bootstrap) cai pro plaintext já redatado.
        const red = msg.projectId ? redactCredentials(msg.projectId, text) : text;
        const enc = msg.projectId
          ? encryptForProject(red, msg.projectId, aadV2({ projectId: msg.projectId, table: E2EE_TABLE.MESSAGES, field: "content" }))
          : null;
        if (msg.projectId && isE2eeRequired(msg.projectId) && !enc) {
          this.log("error", `agent:text recusado: e2ee-required sem chave project=${msg.projectId}`);
          this.emitAgentError(msg.agent.id, "e2ee-required: sem chave do projeto — texto não enviado", msg.projectId);
          return true;
        }
        const ok = this.deliver({ type: "agent:text", agentId: msg.agent.id, text: enc ?? red });
        // Espelho Telegram: encaminha a MESMA resposta (em claro, já redatada)
        // pro chat vinculado. Server é E2EE-cego, por isso o mirror é aqui.
        const mirror = this.entries.get(msg.agent.id)?.telegramMirror;
        if (mirror && red.trim()) void this.mirrorToTelegram(mirror, red);
        return ok;
      },
      onToolUse: (toolName, input) => {
        this.deliver({
          type: "agent:tool_use",
          agentId: msg.agent.id,
          toolName,
          // tool_use.input vai cru pro server (não cifrado); redact aqui as
          // credenciais conhecidas (ex `curl -H "Authorization: Bearer <cred>"`).
          input: msg.projectId ? redactCredentialsDeep(msg.projectId, input) : input,
        });
      },
      onThinkingText: (text, thinkOpts) => {
        const red = msg.projectId ? redactCredentials(msg.projectId, text) : text;
        const enc = msg.projectId ? encryptForProject(red, msg.projectId) : null;
        if (msg.projectId && isE2eeRequired(msg.projectId) && !enc) {
          this.log("error", `agent:thinking recusado: e2ee-required sem chave project=${msg.projectId}`);
          return;
        }
        this.deliver({ type: "agent:thinking", agentId: msg.agent.id, text: enc ?? red, redacted: !!thinkOpts?.redacted });
      },
      onSessionId: (sid) => { this.deliver({ type: "agent:session", agentId: msg.agent.id, sessionId: sid }); },
      onUsageDelta: (delta) => { this.deliver({ type: "agent:usage_delta", agentId: msg.agent.id, delta }); },
      onSessionInvalid: () => {
        this.emitAgentError(
          msg.agent.id,
          "[ctx] sessão anterior não encontrada — iniciando sessão nova",
          msg.projectId,
        );
      },
      onContextUsage: (used, limit) => {
        this.ultimoContexto.set(msg.agent.id, { used, limit });
        this.deliver({ type: "agent:context", agentId: msg.agent.id, used, limit });
      },
      onContextWarning: (used, limit) => { this.deliver({ type: "agent:context_warning", agentId: msg.agent.id, used, limit }); },
      onContextFull: () => { this.deliver({ type: "agent:context_full", agentId: msg.agent.id }); },
      projectId: msg.projectId,
      onGraphStatus: (status, info) => {
        this.deliver({
          type: "graph:status",
          projectId: msg.projectId,
          status,
          nodeCount: info?.nodeCount,
          edgeCount: info?.edgeCount,
          error: info?.error,
          progress: info?.progress,
          phase: info?.phase,
          indexMtime: info?.indexMtime,
          stale: info?.stale,
          graphifyAvailable: info?.graphifyAvailable,
          graphifyMcpAvailable: info?.graphifyMcpAvailable,
          docsPending: info?.docsPending,
          hasSemantic: info?.hasSemantic,
        });
      },
      onGraphWatch: (root, gbin) => this.onGraphWatch?.(root, gbin, msg.projectId),
      onError: (err) => {
        // T-812: o erro (redatado de credenciais) também fica no dashboard local.
        try { recordAgentEvent(msg.agent.id, "error", msg.projectId ? redactCredentials(msg.projectId, String(err ?? "")) : String(err ?? "")); } catch { /* observação */ }
        // T-092: redact + cifra (messages.content), paridade com agent:text.
        this.emitAgentError(msg.agent.id, String(err ?? ""), msg.projectId);
      },
      onExit: (code) => {
        try { recordAgentEvent(msg.agent.id, "exit", `code=${code}${thisRunner && this.entries.get(msg.agent.id)?.runner !== thisRunner ? " (runner substituído)" : ""}`); } catch { /* observação */ }
        const e = this.entries.get(msg.agent.id);
        // Se este runner já foi substituído (reconfig/troca de runner), seu
        // exit tardio NÃO deve mexer no estado do agente — senão derruba o
        // runner novo que acabou de subir. Só o runner ativo reporta exit.
        if (e && e.runner !== thisRunner) {
          breadcrumb("agent", "exit-superseded", { agentId: msg.agent.id, code, runner: cliRunner });
          return;
        }
        if (e) e.runner = null;
        if (this.reexecuting) {
          // T-710b: re-exec do self-update — sem exit/running false (ver `reexecuting`).
          breadcrumb("agent", "exit-reexec", { agentId: msg.agent.id, code, runner: cliRunner });
          return;
        }
        this.deliver({ type: "agent:exit", agentId: msg.agent.id, code });
        this.deliver({ type: "agent:running", agentId: msg.agent.id, running: false });
        breadcrumb("agent", "exit", { agentId: msg.agent.id, code, runner: cliRunner });
        // Exit code 0 = normal; null = signal kill (provavelmente intencional);
        // resto = crash inesperado, vale capture.
        if (code !== 0 && code !== null) {
          captureWarn(`agent runner exited code=${code}`, {
            agentId: msg.agent.id,
            agentName: msg.agent.name,
            runner: cliRunner,
            code,
          });
        }
      },
    };
    const runner = new AgentRunner(msg.agent, opts);
    thisRunner = runner;
    try { recordAgentEvent(msg.agent.id, "spawn", `runner=${cliRunner} model=${msg.agent.model ?? "-"} effort=${msg.agent.effort ?? "-"} resume=${resumeSessionId ? "sim" : "não"} cwd=${cwd}`); } catch { /* observação */ }
    const subiu = runner.start().catch((e) => this.log("error", `agent ${msg.agent.id} start failed: ${(e as Error).message}`));
    this.entries.set(msg.agent.id, {
      info: msg.agent,
      runner,
      autoApprove: msg.autoApprove,
      projectId: msg.projectId,
      agentToken: msg.agentToken,
      ...(agentWorktree ? { worktreePath: agentWorktree.path, gitRoot: agentWorktree.gitRoot } : {}),
    });
    this.send({ type: "agent:running", agentId: msg.agent.id, running: true });
    // T-360/T-365: seed de migração cross-runner. É o PRIMEIRO input do usuário —
    // antes do flush do buffer, senão a mensagem que originou o spawn chegaria na
    // frente do contexto migrado. O digest chega CRU (cifrado sob E2EE): abrir a
    // chave, medir o limite e escrever a tag é trabalho daqui.
    const seedResult = migratedSeedFor(msg.agent, resumeSessionId, {
      projectId: msg.projectId,
      decrypt: (blob, projectId) => decryptForProject(
        blob,
        projectId,
        aadV2({ projectId, table: E2EE_TABLE.SUMMARIES, field: "summary" }),
      ),
    });
    if (seedResult.seed) {
      runner.pushUserMessage(seedResult.seed);
      this.log(
        "info",
        `migrate seed agent=${msg.agent.id} runner=${cliRunner} bytes=${seedResult.seed.length}`
        + (seedResult.truncated ? " (digest cortado ao limite de 8 KB)" : ""),
      );
      if (seedResult.truncated) {
        this.log("warn", `[migrate:${msg.agent.name}] digest excedia ${MIGRATED_SEED_LIMIT_BYTES} bytes em plaintext — cortado antes de injetar`);
      }
    } else if (seedResult.dropped) {
      // T-370: toda queda do seed é declarada — `no_key` (injetar era alimentar
      // o runner com base64) e `resume_skips_seed` (o resume ganhou; pode ter
      // nascido noutra família de CLI). O evento vai SEMPRE sem selo (H-092):
      // metadados fixos — constante do código + ids, zero bytes de conteúdo.
      const reason = seedResult.reason;
      this.log(
        "warn",
        reason === "resume_skips_seed"
          ? `[migrate:${msg.agent.name}] sessão retomada no runner alvo — seed de migração deixado de lado`
          : `[migrate:${msg.agent.name}] seed de migração cifrado sem chave do projeto — agente arranca sem contexto migrado`,
      );
      this.deliver({
        type: "agent:error",
        agentId: msg.agent.id,
        message: reason === "resume_skips_seed" ? MIGRATE_SEED_RESUME_SKIPS_REASON : MIGRATE_SEED_DROPPED_REASON,
        errorKind: "other",
        migrationId: msg.agent.seedFrom?.migrationId,
      });
    }
    // T-899: o agente voltou — reentrega a fila retida ANTES do buffer de
    // inbound (T-037), na ordem. `queueAutoRedeliver` desligado mantém retido.
    const entrada = this.entries.get(msg.agent.id);
    if (entrada) {
      // T-899: espera o runner SUBIR antes de entregar — o `start()` rearma a
      // sessão do runner e uma entrega cedo demais era zerada por ele (a fila
      // do agente sumia entre a entrega e a subida).
      await subiu;
      entrada.parado = false;
      entrada.queueAutoRedeliver = (msg.agent as { queueAutoRedeliver?: boolean }).queueAutoRedeliver !== false;
      this.entregarFilaRetida(msg.agent.id);
    }
    // T-037: agent:send que chegou no gap pré-spawn (self-update / auto-resume)
    this.flushInboundBuffer(msg.agent.id);
  }

  listAgentTokens(): { id: string; token: string }[] {
    const out: { id: string; token: string }[] = [];
    for (const [id, e] of this.entries) {
      if (e.runner && e.agentToken) out.push({ id, token: e.agentToken });
    }
    return out;
  }

  /**
   * T-852: elenco do projeto para a sombra do Jev nas tasks. WHITELIST:
   * só `name` e `role` (o AgentInfo carrega systemPrompt já decifrado).
   * Ordem estável por agentId para o rótulo não depender da ordem de spawn.
   */
  elencoDoProjeto(projectId: string): Array<{ agentId: string; name: string; role: string }> {
    const out: Array<{ agentId: string; name: string; role: string }> = [];
    for (const [agentId, e] of this.entries) {
      if (e.projectId !== projectId) continue;
      const info = e.info as { name?: string; role?: string } | undefined;
      out.push({
        agentId,
        name: typeof info?.name === "string" ? info.name : agentId,
        role: typeof info?.role === "string" ? info.role : "",
      });
    }
    return out.sort((a, b) => a.agentId.localeCompare(b.agentId, "en"));
  }

  stop(agentId: string) {
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    e.parado = true;
    e.runner.stop();
    // M25 (T-448): worktree do agente pára com ele — hoje ficava no disco.
    void this.removeWorktreeOf(e);
    // T-899: a fila NÃO INICIADA sai pelo callback do runner (source=stop);
    // `retainFromRunner` fica como fallback para runner sem callback (testes).
    this.retainFromRunner(agentId, e, "stop");
    try { recordAgentEvent(agentId, "stop", "agent:stop do orchestrator"); } catch { /* observação */ }
    // T-1005: depois do queue_retain, a fila ao vivo vai vazia.
    this.agendarFilaViva(agentId);
  }

  /* ---------------------- T-1005: fila de espera ao vivo ---------------------- */

  /** Agenda o snapshot (debounce). Chamado a cada mudança da fila. */
  agendarFilaViva(agentId: string): void {
    const t = this.filaVivaTimers.get(agentId);
    if (t) clearTimeout(t);
    const novo = setTimeout(() => {
      this.filaVivaTimers.delete(agentId);
      this.emitirFilaViva(agentId);
    }, QUEUE_LIVE_DEBOUNCE_MS);
    novo.unref?.();
    this.filaVivaTimers.set(agentId, novo);
    this.armarReconciliacaoFilaViva();
  }

  /**
   * T-1005 (pedido SERVER #1006): reemite o snapshot de TODOS os agentes
   * com fila publicada ao reconectar (hello). A desconexão limpa a fila no
   * server (`clearQueueLiveFrom`); sem isto a tela ficaria vazia até a
   * próxima mudança. Força o reenvio mesmo sem mudança (o `ultimo` é
   * esquecido), com debounce — o server trata o snapshot igual como no-op.
   */
  /**
   * T-822: o WS caiu e o estado NÃO crítico (running/state/context) foi
   * descartado — os três são SETTER de estado no server (idempotentes), não
   * evento, então reemitir o valor atual no open é seguro e suficiente. Sem
   * isto um `agent:running=false` perdido deixa o server achando que o agente
   * está vivo e as mensagens seguintes ficam retidas ("sem runner ativo —
   * enfileirado"); um `agent:state`/`agent:context` perdido deixa a UI mentindo.
   */
  reemitirEstadoNoHello(): void {
    for (const [agentId, e] of this.entries) {
      const runner = e.runner as unknown as { currentRuntimeState?: () => string } | null;
      let state: string | null = null;
      try { state = runner?.currentRuntimeState?.() ?? null; } catch { /* observação */ }
      // `runner` nulo = turno/processo morto (mesma verdade dos emissores de exit).
      this.send({ type: "agent:running", agentId, running: !!(e.runner && state) });
      if (state) this.send({ type: "agent:state", agentId, state });
      const ctx = this.ultimoContexto.get(agentId);
      if (ctx) this.send({ type: "agent:context", agentId, used: ctx.used, limit: ctx.limit });
    }
  }

  reemitirFilaVivaNoHello(): void {
    const agentes = new Set<string>([...this.filaVivaUltimo.keys(), ...this.filaVivaRegistros.keys()]);
    for (const [id, e] of this.entries) {
      if (e.runner) {
        try {
          const q = (e.runner as unknown as { peekQueue?: () => unknown[] }).peekQueue;
          if (typeof q === "function" && (q.call(e.runner) ?? []).length > 0) agentes.add(id);
        } catch { /* observação */ }
      }
      if (this.inboundBuffer.size(id) > 0) agentes.add(id);
      if ((this.drainHeld.get(id) ?? []).length > 0) agentes.add(id);
    }
    for (const id of agentes) {
      this.filaVivaUltimo.delete(id);
      this.agendarFilaViva(id);
    }
  }

  /** O que ainda não virou turno: fila do runner, buffer pré-spawn e retidas
   *  no dreno do update, na ordem. */
  private pendentesDaFilaViva(agentId: string): PendingItem[] {
    const e = this.entries.get(agentId);
    const doRunner = (e?.runner as unknown as { peekQueue?: () => PendingItem[] } | null)?.peekQueue;
    const out: PendingItem[] = typeof doRunner === "function" ? doRunner.call(e!.runner) ?? [] : [];
    for (const m of this.inboundBuffer.peek(agentId)) out.push({ content: m.content, images: m.images as ImageAttachment[] | undefined, deliveryId: m.deliveryId });
    for (const m of this.drainHeld.get(agentId) ?? []) out.push({ content: m.content, images: m.images, deliveryId: m.deliveryId });
    return out;
  }

  /** Publica o snapshot se mudou desde o último. Vazio também é notícia. */
  emitirFilaViva(agentId: string): boolean {
    const e = this.entries.get(agentId);
    const projectId = e?.projectId;
    const regs = this.filaVivaRegistros.get(agentId) ?? new Map<string, WireRecord>();
    const { items, truncated, omitidos } = montarSnapshot(this.pendentesDaFilaViva(agentId), regs, projectId);
    if (omitidos > 0) this.log("warn", `[fila-viva] ${omitidos} item(ns) de ${agentId} sem como selar no projeto cifrado — fora do snapshot (nunca em claro)`);
    const assinatura = JSON.stringify({ truncated, items });
    const anterior = this.filaVivaUltimo.get(agentId);
    // Nada a dizer: igual ao último, ou vazio sem nunca ter mandado nada.
    if (assinatura === anterior || (anterior === undefined && items.length === 0)) return false;
    // Registros de entregas que já saíram da fila (viraram turno) vão embora.
    const presentes = new Set(items.map((i) => i.deliveryId));
    for (const id of [...regs.keys()]) if (!presentes.has(id)) regs.delete(id);
    if (regs.size === 0) this.filaVivaRegistros.delete(agentId);
    const frame = { type: "agent:queue_live", agentId, projectId, at: Date.now(), ...(truncated ? { truncated: true } : {}), items };
    let ok = false;
    try { ok = this.deliver(frame as never); } catch { ok = false; }
    // Frame que não saiu não vira "último": a reconciliação tenta de novo.
    if (ok) this.filaVivaUltimo.set(agentId, assinatura);
    return ok;
  }

  /** server → daemon `agent:queue_live_remove`: tira a entrega se ainda não
   *  iniciou (runner, buffer pré-spawn ou dreno) e republica. Idempotente. */
  removerDaFilaViva(agentId: string, deliveryId: string): boolean {
    const e = this.entries.get(agentId);
    const doRunner = (e?.runner as unknown as { removeQueued?: (id: string) => boolean } | null)?.removeQueued;
    let ok = typeof doRunner === "function" ? doRunner.call(e!.runner, deliveryId) === true : false;
    if (!ok) ok = this.inboundBuffer.remove(agentId, deliveryId);
    if (!ok) {
      const held = this.drainHeld.get(agentId);
      const i = held?.findIndex((m) => m.deliveryId === deliveryId) ?? -1;
      if (held && i >= 0) { held.splice(i, 1); ok = true; }
    }
    if (ok) {
      this.log("info", `[fila-viva] ${agentId}: entrega ${deliveryId.slice(0, 8)} removida da fila (ainda não iniciada)`);
      this.filaVivaRegistros.get(agentId)?.delete(deliveryId);
    } else {
      this.log("info", `[fila-viva] ${agentId}: remover ${deliveryId.slice(0, 8)} ignorado — já iniciou ou não está na fila`);
    }
    this.agendarFilaViva(agentId);
    return ok;
  }

  /** Reconciliação: mutação da fila fora dos caminhos instrumentados (retry
   *  que re-enfileira, por exemplo) aparece em até ~1s. Só roda enquanto há
   *  fila ao vivo publicada ou registros pendentes. */
  private armarReconciliacaoFilaViva(): void {
    if (this.filaVivaReconcilia) return;
    this.filaVivaReconcilia = setInterval(() => {
      const agentes = new Set<string>([...this.filaVivaUltimo.keys(), ...this.filaVivaRegistros.keys()]);
      for (const id of agentes) if (!this.filaVivaTimers.has(id)) this.emitirFilaViva(id);
      // Tudo vazio e publicado: desarma.
      const algoVivo = [...this.filaVivaUltimo.values()].some((s) => s !== JSON.stringify({ truncated: false, items: [] })) || this.filaVivaRegistros.size > 0;
      if (!algoVivo && this.filaVivaReconcilia) { clearInterval(this.filaVivaReconcilia); this.filaVivaReconcilia = null; }
    }, QUEUE_LIVE_RECONCILE_MS);
    this.filaVivaReconcilia.unref?.();
  }

  /** T-938: retenção por agente das entries conhecidas (para o spool). */
  private entriesRetidos(): Array<[string, Array<{ content: string; images?: ImageAttachment[]; deliveryId?: string; enqueuedAt: number }>]> {
    const out: Array<[string, Array<{ content: string; images?: ImageAttachment[]; deliveryId?: string; enqueuedAt: number }>]> = [];
    for (const [agentId] of this.entries) {
      const itens = listarFilaRetida(agentId) as Array<{ content: string; images?: ImageAttachment[]; deliveryId?: string; enqueuedAt: number; source: string }>;
      if (itens.length > 0) out.push([agentId, itens]);
    }
    return out;
  }

  /** T-899: GC do TTL do item retido — o host é quem tem log. */
  private gcFilaRetida(): void {
    const saiu = expirarFilaRetida();
    if (saiu > 0) this.log("warn", `[fila] ${saiu} item(ns) retido(s) expirou(aram) (TTL de ${Math.round(TTL_ITEM_MS / 3_600_000)}h) e saiu(íram) da fila`);
  }

  /** T-899: retenção vinda do runner (fila do agente), com source explícito. */
  private reterDoRunner(agentId: string, msgs: Array<{ content: string; images?: ImageAttachment[]; deliveryId?: string }>, source: "stop" | "context-clear" | "loop-stop" | "replace"): number {
    this.gcFilaRetida();
    const r = reterFila(agentId, msgs.map((m) => ({ content: m.content, images: m.images, deliveryId: m.deliveryId, enqueuedAt: Date.now(), source })));
    if (r.retidos > 0) this.log("info", `[fila] ${r.retidos} msg(s) de ${agentId} retida(s) (source=${source}) — entregues no próximo spawn`);
    if (r.duplicados > 0) this.log("info", `[fila] ${r.duplicados} msg(s) de ${agentId} já estavam retidas (idempotência por deliveryId)`);
    if (r.descartados > 0) this.log("warn", `[fila] cap de ${CAP_POR_AGENTE} estourado para ${agentId} — descarte declarado`);
    this.enviarFilaRetida(agentId, this.entries.get(agentId)?.projectId);
    return r.retidos;
  }

  /** T-899: colhe o que o runner parou de segurar e retém (idempotente). */
  private retainFromRunner(agentId: string, e: Entry, source: "stop" | "context-clear" | "replace"): number {
    const take = (e.runner as unknown as { takeQueueForRetain?: () => Array<{ content: string; images?: ImageAttachment[]; deliveryId?: string }> } | null)?.takeQueueForRetain;
    const itens = typeof take === "function" ? take.call(e.runner) ?? [] : [];
    if (itens.length === 0) return 0;
    const r = reterFila(agentId, itens.map((m) => ({ content: m.content, images: m.images, deliveryId: m.deliveryId, enqueuedAt: Date.now(), source })));
    if (r.retidos > 0) this.log("info", `[fila] ${r.retidos} msg(s) de ${agentId} retida(s) no stop (source=${source}) — entregues no próximo spawn`);
    if (r.duplicados > 0) this.log("info", `[fila] ${r.duplicados} msg(s) de ${agentId} já estavam retidas (idempotência por deliveryId)`);
    if (r.descartados > 0) this.log("warn", `[fila] cap de ${CAP_POR_AGENTE} estourado para ${agentId} — ${r.descartados} item(ns) mais antigo(s) descartado(s)`);
    this.enviarFilaRetida(agentId, e.projectId);
    return r.retidos;
  }

  /** T-899: melhor esforço para o server (o WEB lista por lá, #898/#900).
   *  O daemon NÃO depende de ack nesta fase: a cópia local é a fonte. */
  private enviarFilaRetida(agentId: string, projectId?: string): void {
    if (!projectId) return;
    const itens = listarFilaRetida(agentId);
    if (itens.length === 0) return;
    const { enviar, semChave } = paraFio(agentId, projectId, itens);
    if (semChave.length > 0) {
      this.log("warn", `[fila] ${semChave.length} item(ns) de ${agentId} SEM chave do projeto — ficam locais (nunca em claro)`);
    }
    if (enviar.length === 0) return;
    try {
      this.send({ type: "agent:queue_retain", agentId, projectId, reason: "stop", items: enviar } as never);
    } catch { /* best-effort: a cópia local segue valendo */ }
  }

  /** T-899: agente removido/limpo — a fila retida dele vai embora junto. */
  esquecerFilaRetida(agentId: string): number {
    const n = esquecerFilaRetida(agentId);
    if (n > 0) this.log("info", `[fila] ${n} msg(s) retida(s) de ${agentId} esquecida(s) (agente removido)`);
    return n;
  }

  /** T-899: itens retidos de um agente (visibilidade/dashboard). */
  filaRetida(agentId: string) {
    return { itens: listarFilaRetida(agentId), total: totalRetido() };
  }

  /** T-899 (correção de desenho): a CONTAGEM é por AGENTE — é o número que o
   *  card do agente exibe, e vale com o agente parado (é justamente o caso da
   *  fila retida). O que estiver retido no server entra quando o #898 subir. */
  filaRetidaPorAgente(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [agentId] of this.entries) {
      const n = tamanhoFilaRetida(agentId);
      if (n > 0) out[agentId] = n;
    }
    return out;
  }

  /** T-899: entrega a fila retida NO SPAWN, antes do buffer de inbound, na
   *  ordem, uma vez só. `queueAutoRedeliver` false mantém retido. */
  entregarFilaRetida(agentId: string): number {
    this.gcFilaRetida();
    const e = this.entries.get(agentId);
    if (!e?.runner) return 0;
    if (e.queueAutoRedeliver === false) {
      const n = tamanhoFilaRetida(agentId);
      if (n > 0) this.log("info", `[fila] ${n} msg(s) retida(s) de ${agentId} — reentrega DESLIGADA (ficam na fila)`);
      return 0;
    }
    const itens = tomarFilaRetida(agentId);
    if (itens.length === 0) return 0;
    let entregues = 0;
    for (const item of itens) {
      try {
        // Direto no runner: fora do `deliveryDedup` do main (o id já foi visto
        // no aceite; reentregar por `agent:send` seria descartado como duplicata).
        e.runner.pushUserMessage(item.content, item.images, undefined, item.deliveryId);
        entregues++;
      } catch {
        devolverFilaRetida(agentId, [item]);
      }
    }
    this.log("info", `[fila] reentrega agent=${agentId}: ${entregues} msg(s) retida(s) na ordem`);
    return entregues;
  }

  /**
   * T-846: outro processo com o mesmo token assumiu a conexão (close 4000).
   * Mata os CLIs locais para não duplicar trabalho. Os agentes seguem running
   * no server (quem ficou é o dono); se aquele processo morrer, o replay dos
   * agentes no nosso hello passivo devolve cada um ao spawn.
   *
   * Worktree fica (o outro processo pode estar usando): o re-spawn reconcilia.
   * Sem agent:exit: quem anuncia isso é o processo que ficou.
   */
  stopLocalClis(motivo: string): number {
    let n = 0;
    for (const [agentId, e] of this.entries) {
      if (!e.runner) continue;
      try { e.runner.stop(); } catch { /* segue os outros */ }
      try { recordAgentEvent(agentId, "stop", motivo); } catch { /* observação */ }
      n++;
    }
    if (n > 0) this.log("warn", `[handoff] ${n} CLI(s) local(is) parado(s) — aguardando o processo que ficou`);
    return n;
  }

  /** M25 (T-448): remove (1×) o worktree do entry. Limpa o campo antes pra
   *  stop/shutdown duplo não repetir. */
  private removeWorktreeOf(e: Entry): Promise<void> {
    const wt = e.worktreePath;
    const gitRoot = e.gitRoot;
    if (!wt || !gitRoot) return Promise.resolve();
    e.worktreePath = undefined;
    return runGitWorktreeRemove(gitRoot, wt, this.dropTo)
      .then((r) => this.log(r.ok ? "info" : "warn", `[worktree] ${r.ok ? "removido" : "remoção falhou"} ${wt}${r.detail ? ` (${r.detail})` : ""}`))
      .catch((err) => this.log("warn", `[worktree] remoção falhou ${wt}: ${(err as Error).message}`));
  }

  send_message(agentId: string, content: string, images?: ImageAttachment[], deliveryId?: string, wire?: WireRecord | null) {
    if (deliveryId && wire) {
      const regs = this.filaVivaRegistros.get(agentId) ?? new Map<string, WireRecord>();
      regs.set(deliveryId, wire);
      this.filaVivaRegistros.set(agentId, regs);
    }
    try {
      this.sendMessageInner(agentId, content, images, deliveryId);
    } finally {
      this.agendarFilaViva(agentId);
    }
  }

  private sendMessageInner(agentId: string, content: string, images?: ImageAttachment[], deliveryId?: string) {
    if (this.draining) {
      // T-720: dreno — não alimenta o runner (turno novo atrasaria o re-exec);
      // a mensagem vai no spool cifrado e é entregue pelo processo novo.
      this.holdForDrain(agentId, { content, images, deliveryId, enqueuedAt: Date.now() });
      this.log("info", `${this.drainReason === "update" ? "[self-update] dreno" : "[shutdown] dreno"}: send_message para ${agentId} retido para o próximo processo (${this.drainHeld.get(agentId)?.length ?? 0} retidas)`);
      // T-824: no dreno do update o agente parece travado na UI (a mensagem
      // não vira turno até os turnos em curso terminarem) e o dono reiniciava
      // o daemon. Avisa no chat do agente, uma vez por dreno.
      if (this.entries.has(agentId) && !this.drainNotified.has(agentId)) {
        this.drainNotified.add(agentId);
        this.emitAgentError(agentId, this.drainReason === "update"
          ? "[daemon] atualização do daemon pendente: esta mensagem e as próximas ficam retidas até os turnos em curso terminarem e são entregues logo depois da troca. Não precisa reiniciar."
          : "[daemon] daemon reiniciando: esta mensagem fica retida e é entregue quando o processo novo subir.");
      }
      return;
    }
    const e = this.entries.get(agentId);
    // T-1000: com spool do processo anterior ainda por entregar (o spawn do
    // replay está subindo), a mensagem nova espera no buffer — o flush entrega
    // o spool (mais antigo) antes dela e a ordem de chegada se mantém.
    if (!e?.runner || this.spooled.has(agentId)) {
      // T-037: em vez de dropar, buffera até o spawn (gap self-update / auto-resume).
      // Se o agente nunca subir, TTL 15min limpa. Antes: drop + agent:error e a
      // TASK_ASSIGN sumia mesmo com o server reenviando.
      this.inboundAgentIds.add(agentId);
      const evicted = this.inboundBuffer.push(agentId, {
        deliveryId,
        content,
        images,
        enqueuedAt: Date.now(),
      });
      if (evicted > 0) {
        // Revisão T-818: o buffer de antes do spawn descartava a mais antiga
        // em silêncio. Mesmo formato de linha que o histórico do dashboard
        // conta como descarte por fila cheia.
        this.log("warn", `[cli:${agentId}:inbound] pendingMessages cheia (${this.inboundBuffer.size(agentId)}) — drop de ${evicted} mensagem(ns) mais antiga(s) antes do spawn`);
      }
      if (e?.runner) {
        this.log("info", `send_message para ${agentId} espera o spool do processo anterior — enfileirado (${this.inboundBuffer.size(agentId)} pending)`);
      } else {
        this.log(
          "warn",
          `send_message para ${agentId} sem runner ativo (entry=${e ? "existe" : "ausente"}) — enfileirado (${this.inboundBuffer.size(agentId)} pending)`,
        );
      }
      return;
    }
    // T-899: agente PARADO — antes a mensagem caía num runner morto e morria
    // com ele (maior parte da perda). Agora vai para a retenção e sai no
    // próximo spawn, na ordem.
    if (e.parado) {
      const r = reterFila(agentId, [{ content, images, deliveryId, enqueuedAt: Date.now(), source: "inbound" }]);
      if (r.descartados > 0) this.log("warn", `[fila] cap de ${CAP_POR_AGENTE} estourado para ${agentId} — descarte declarado`);
      this.log("info", `[fila] agente ${agentId} parado — mensagem retida (${listarFilaRetida(agentId).length} na fila)`);
      this.enviarFilaRetida(agentId, e.projectId);
      return;
    }
    e.runner.pushUserMessage(content, images, undefined, deliveryId);
  }

  /** Chamado após spawn bem-sucedido — drena fila local T-037. */
  flushInboundBuffer(agentId: string): number {
    // T-720: spool do re-exec anterior (mais antigo) antes do buffer local.
    this.deliverSpoolFor(agentId);
    if (this.draining) {
      for (const m of this.inboundBuffer.drain(agentId)) this.holdForDrain(agentId, { ...m, images: m.images as ImageAttachment[] | undefined });
      this.inboundAgentIds.delete(agentId);
      return 0;
    }
    this.inboundAgentIds.delete(agentId);
    const pending = this.inboundBuffer.drain(agentId);
    const e = this.entries.get(agentId);
    if (!e?.runner || pending.length === 0) return 0;
    for (const m of pending) {
      e.runner.pushUserMessage(m.content, m.images as ImageAttachment[] | undefined, undefined, m.deliveryId);
    }
    this.log("info", `flushInboundBuffer agent=${agentId} entregou ${pending.length} msg(s) buffered`);
    return pending.length;
  }

  async clear(agentId: string) {
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    try { await e.runner.clearContext(); } catch (err) {
      this.emitAgentError(agentId, `clear failed: ${(err as Error).message}`);
    }
  }

  async compact(agentId: string, saveMemory = true) {
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    try { await e.runner.compactContext(saveMemory); } catch (err) {
      this.emitAgentError(agentId, `compact failed: ${(err as Error).message}`);
    }
  }

  /** M25 (T-448): async — além de parar os runners, remove os worktrees
   *  (com teto de 2s; main espera 2.5s antes do re-exec). */
  /* ---------------------- T-720: dreno + spool do re-exec ---------------------- */

  private holdForDrain(agentId: string, item: SpoolItem, opts: { primeiro?: boolean } = {}): void {
    const list = this.drainHeld.get(agentId) ?? [];
    if (item.deliveryId && list.some((m) => m.deliveryId === item.deliveryId)) return;
    // T-1000: o turno em voo é a mensagem mais antiga do agente — vai na frente
    // do que o dreno tirou da fila, senão o processo novo inverte a conversa.
    if (opts.primeiro) list.unshift(item);
    else list.push(item);
    this.drainHeld.set(agentId, list);
  }

  /** T-720: liga o dreno. Tira dos runners as mensagens enfileiradas e ainda
   *  NÃO iniciadas (o turno em curso segue e termina normalmente) e passa a
   *  reter todo send_message novo. @returns mensagens retiradas das filas. */
  startDrain(reason: "update" | "shutdown" = "update"): number {
    this.draining = true;
    this.drainReason = reason;
    let moved = 0;
    for (const [agentId, e] of this.entries) {
      const take = (e.runner as unknown as { takeQueuedForDrain?: () => Array<{ content: string; images?: ImageAttachment[]; deliveryId?: string }> } | null)?.takeQueuedForDrain;
      if (!e.runner || typeof take !== "function") continue;
      for (const m of take.call(e.runner)) {
        this.holdForDrain(agentId, { content: m.content, images: m.images, deliveryId: m.deliveryId, enqueuedAt: Date.now() });
        moved++;
      }
    }
    this.log("info", `[self-update] dreno ligado: ${moved} msg(s) tiradas das filas dos runners; nenhum turno novo até o re-exec; segura: ${formatDrainHolders(this.drainHolders())}`);
    return moved;
  }

  isDraining(): boolean { return this.draining; }

  /** T-842: no SIGTERM o turno em curso morre com o processo. A mensagem
   *  vai para o spool (o id continua visto, então o replay não a duplica).
   *  Idempotente: o runner entrega o in-flight uma vez. */
  holdInFlightForShutdown(): number {
    let n = 0;
    for (const [agentId, e] of this.entries) {
      const take = (e.runner as unknown as {
        takeInFlightForShutdown?: () => { content: string; images?: ImageAttachment[]; deliveryId?: string } | null;
      } | null)?.takeInFlightForShutdown;
      if (!e.runner || typeof take !== "function") continue;
      const m = take.call(e.runner);
      if (!m) continue;
      this.holdForDrain(agentId, { content: m.content, images: m.images, deliveryId: m.deliveryId, enqueuedAt: Date.now() }, { primeiro: true });
      n++;
    }
    if (n > 0) this.log("info", `[shutdown] ${n} mensagem(ns) em turno retida(s) para o spool`);
    return n;
  }

  /** T-842: aviso de reinício enquanto o WS ainda aceita envio. Uma vez
   *  por agente que tem mensagem retida neste dreno. */
  announceRestart(): number {
    let n = 0;
    for (const agentId of this.drainHeld.keys()) {
      if (!this.entries.has(agentId) || this.drainNotified.has(agentId)) continue;
      this.drainNotified.add(agentId);
      this.emitAgentError(agentId, "[daemon] daemon reiniciando: esta mensagem fica retida e é entregue quando o processo novo subir.");
      n++;
    }
    return n;
  }

  /** Revisão T-824: SIGTERM no meio do dreno do update — o aviso passa a ser
   *  o de reinício (o de "não precisa reiniciar" viraria mentira). */
  setDrainReason(reason: "update" | "shutdown"): void { this.drainReason = reason; }

  /** T-720: grava o spool ANTES do re-exec. Só blob e2e:v2 re-cifrado com a
   *  chave do projeto; sem chave (ou projeto desconhecido) a mensagem NÃO vai
   *  para o disco — perda declarada no log, nunca plaintext. Arquivo 0600 em
   *  diretório 0700, escrita atômica (tmp + rename). */
  writeReexecSpool(dir: string = reexecSpoolDir()): { spooled: number; lost: number; lostDeliveryIds: string[]; path: string | null } {
    // T-938 (verificação do SECURITY): a fila RETIDA também entra no spool do
    // re-exec. Sem isto ela vivia só na RAM e morria no próximo re-exec — e o
    // daemon re-executa 13-17x/dia (#817), ou seja: a promessa da feature
    // morria justamente no cenário mais comum. Só sai da retenção DEPOIS de o
    // spool gravar (nunca limpar antes).
    const doSpool: string[] = [];
    for (const [agentId, itens] of this.entriesRetidos()) {
      for (const it of itens) this.holdForDrain(agentId, { content: it.content, images: it.images, deliveryId: it.deliveryId, enqueuedAt: it.enqueuedAt });
      doSpool.push(agentId);
    }
    for (const agentId of this.inboundAgentIds) {
      for (const m of this.inboundBuffer.drain(agentId)) this.holdForDrain(agentId, { ...m, images: m.images as ImageAttachment[] | undefined });
    }
    this.inboundAgentIds.clear();
    const records: SpoolRecord[] = [];
    let lost = 0;
    // T-824 (prova): id da mensagem que NÃO entrou no spool não pode ir para os
    // vistos — o replay do server é a única chance dela no processo novo.
    const lostDeliveryIds: string[] = [];
    for (const [agentId, items] of this.drainHeld) {
      const projectId = this.entries.get(agentId)?.projectId;
      for (const item of items) {
        const blob = projectId
          ? encryptForProject(JSON.stringify({ content: item.content, images: item.images }), projectId, spoolAad(projectId))
          : null;
        if (!projectId || !blob || !blob.startsWith("e2e:v2:")) {
          lost++;
          if (item.deliveryId) lostDeliveryIds.push(item.deliveryId);
          this.log("warn", `[self-update] spool: msg para ${agentId} (project=${projectId ?? "?"}) sem chave do projeto — NÃO gravada em claro; perdida no re-exec`);
          continue;
        }
        records.push({ agentId, projectId, deliveryId: item.deliveryId, enqueuedAt: item.enqueuedAt, blob });
      }
    }
    // Revisão T-824: o spool do boot anterior que ainda não foi entregue
    // entra junto. T-842: só esvazia a memória DEPOIS do rename — um throw
    // no write deixa as mensagens no drainHeld e o caller não grava os vistos.
    const pendentes = [...this.spooled.values()].flat();
    records.push(...pendentes);
    if (records.length === 0) {
      this.drainHeld.clear();
      return { spooled: 0, lost, lostDeliveryIds, path: null };
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, SPOOL_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, createdAt: Date.now(), records }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.drainHeld.clear();
    this.spooled.clear();
    // Só agora: o que foi para o spool sai da retenção (dentro da mesma função
    // e após o rename — um throw antes mantém tudo na retenção).
    for (const agentId of doSpool) esquecerFilaRetida(agentId);
    return { spooled: records.length, lost, lostDeliveryIds, path: file };
  }

  /** T-720: boot do processo novo — carrega o spool (entregue no spawn de
   *  cada agente). Só aceita e2e:v2; registros vencidos saem com log. */
  loadReexecSpool(dir: string = reexecSpoolDir(), now = Date.now()): number {
    const file = path.join(dir, SPOOL_FILE);
    let parsed: { v?: number; records?: SpoolRecord[] };
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { v?: number; records?: SpoolRecord[] };
    } catch {
      return 0;
    }
    this.spoolPath = file;
    let n = 0;
    for (const r of Array.isArray(parsed.records) ? parsed.records : []) {
      if (!r || typeof r.agentId !== "string" || typeof r.projectId !== "string" || typeof r.blob !== "string" || !r.blob.startsWith("e2e:v2:")) {
        this.log("warn", `[self-update] spool: registro inválido descartado`);
        continue;
      }
      if (now - Number(r.enqueuedAt || 0) > SPOOL_TTL_MS) {
        this.log("warn", `[self-update] spool: msg para ${r.agentId} vencida (> ${SPOOL_TTL_MS / 60_000}min) — descartada`);
        continue;
      }
      const list = this.spooled.get(r.agentId) ?? [];
      list.push(r);
      this.spooled.set(r.agentId, list);
      n++;
    }
    this.persistSpool();
    if (n > 0) this.log("info", `[self-update] spool do re-exec: ${n} msg(s) para ${this.spooled.size} agente(s), entregues no spawn`);
    return n;
  }

  private deliverSpoolFor(agentId: string): void {
    const list = this.spooled.get(agentId);
    if (!list || list.length === 0) return;
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    this.spooled.delete(agentId);
    let ok = 0;
    const deliver = (content: string, images?: ImageAttachment[]) => {
      // Dreno de um NOVO update já ligado: segue retido para o próximo spool.
      if (this.draining) this.holdForDrain(agentId, { content, images, enqueuedAt: Date.now() });
      else e.runner!.pushUserMessage(content, images);
    };
    for (const r of list) {
      const plain = decryptForProject(r.blob, r.projectId, spoolAad(r.projectId));
      if (plain == null) {
        this.log("warn", `[self-update] spool: msg para ${agentId} não autenticou com a chave do projeto — descartada`);
        continue;
      }
      try {
        const m = JSON.parse(plain) as { content?: unknown; images?: ImageAttachment[] };
        if (typeof m.content !== "string") continue;
        deliver(m.content, m.images);
        ok++;
      } catch {
        this.log("warn", `[self-update] spool: msg para ${agentId} com payload inválido — descartada`);
      }
    }
    this.log("info", `[self-update] spool: entregue ${ok}/${list.length} msg(s) a ${agentId}`);
    this.persistSpool();
  }

  /** Reescreve o spool com o que falta entregar; remove o arquivo quando vazio. */
  private persistSpool(): void {
    if (!this.spoolPath) return;
    const records = [...this.spooled.values()].flat();
    try {
      if (records.length === 0) {
        fs.rmSync(this.spoolPath, { force: true });
        this.spoolPath = null;
        return;
      }
      const tmp = `${this.spoolPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, createdAt: Date.now(), records }), { mode: 0o600 });
      fs.renameSync(tmp, this.spoolPath);
    } catch (err) {
      this.log("warn", `[self-update] spool: falha ao persistir (${(err as Error).message})`);
    }
  }

  /** T-720: pendente de entrega no spool (teste/health). */
  spoolPendingCount(): number {
    return [...this.spooled.values()].reduce((n, l) => n + l.length, 0);
  }

  /** T-710b: re-exec do self-update em curso (T-824: e shutdown por sinal) —
   *  os CLIs morrem, mas o agente NÃO parou para o time. onExit não anuncia exit/running false ao server
   *  (ele seguiria marcando parada normal, e o hello do processo novo não
   *  teria o que religar). O server mantém running=true, a graça de offline
   *  cobre o gap e o replay do hello re-spawna. Processo novo que não volta:
   *  a graça expira e daemonWentOffline marca + auto-resume. */
  private reexecuting = false;

  /** @param opts.reexec re-exec do self-update (exit 42): não anuncia exit.
   *  Shutdown normal (SIGTERM/stop): anuncia, como sempre.
   *  @returns quantos agentes com runner foram parados (mantidos running no server se reexec). */
  async shutdown(opts: { reexec?: boolean } = {}): Promise<number> {
    if (opts.reexec) this.reexecuting = true;
    let comRunner = 0;
    const removals: Promise<void>[] = [];
    for (const e of this.entries.values()) {
      if (e.runner) comRunner++;
      if (e.runner) try { e.runner.stop(); } catch {}
      removals.push(this.removeWorktreeOf(e));
    }
    await Promise.race([
      Promise.allSettled(removals),
      new Promise<void>((r) => setTimeout(r, 2_000)),
    ]);
    return comRunner;
  }
}
