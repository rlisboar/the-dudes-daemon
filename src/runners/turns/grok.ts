/* R7 (T-462): turno extraído do agent-runner — `self` é o AgentRunner. */
import {ImageAttachment} from "../../types.js";
import {ChildProcess} from "node:child_process";
import {GROK_TURN_TIMEOUT_MS, grokSignalsCandidatesFor, grokUpdatesCandidatesFor, resolveGrokChatHistoryPath, sweepGrokChatToolCallsFromPath} from "../../agent-runner.js";
import {GrokContextSignals, GrokTurnBilling, mergeGrokContextOccupancy, parseGrokContextSignals, parseGrokTurnBillingFromUpdates, parseGrokUpdatesContextTokens} from "../parsers.js";
import {acquireTurnSlot} from "../turn-gate.js";
import {grokAbsoluteTimeoutShouldKill, hangThresholds, markTurnStart} from "../turn-watchdog.js";
import {appendPathAttachmentPrompt} from "../attachments.js";
import {armHardTimeout, processAlive as procAlive} from "../process-lifecycle.js";
import {buildGrokEnv} from "../env.js";
import {buildGrokMcpToml} from "../mcp-config.js";
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {grokHeadlessArgs} from "../args.js";
import {isAbortedFailure, isAuthenticationFailure, isMissingSessionFailure as isMissingSessionMessage} from "../error-classifier.js";
import {parseGrokStreamEvent} from "../turn-parsers.js";
import {recordTurnEnd, recordTurnStart} from "../../health-monitor.js";
import {spawnDropped} from "../../privileges.js";

import path from "node:path";
/**
 * T-712: o CLI grok emite `thought` POR TOKEN (QA mediu 24-36 por turno) e
 * cada onThinkingText vira um bloco na UI. O segmento contíguo de thought é
 * acumulado e sai como UM bloco quando termina (text, tool, result/error ou
 * close). Os tetos abaixo mantêm o raciocínio longo visível durante o turno:
 *  - 8s desde o 1º token do segmento: a UI não fica muda num raciocínio
 *    longo e, com ~5-30 tokens/s, um bloco reúne dezenas/centenas de tokens;
 *  - 2000 chars (~400 palavras): um bloco legível sem rolagem longa; acima
 *    disso vira bloco novo. Nunca 1 bloco por token.
 */
export const GROK_THINKING_FLUSH_MS = 8_000;
export const GROK_THINKING_FLUSH_CHARS = 2_000;

export function buildGrokHeadlessArgs(self: any, 
    prompt: string,
    opts: { resume?: string; outputFormat: "streaming-json" | "json" | "plain"; forCompact?: boolean },
  ): string[] {
    return grokHeadlessArgs({
      prompt,
      outputFormat: opts.outputFormat,
      workspaceRoot: self.opts.workspaceRoot,
      model: self.info.model,
      effort: self.info.effort,
      // T-423/M34: AgentInfo do wire tem `boolean | null` (herança de projeto);
      // grokHeadlessArgs só distingue true/false/ausente.
      collectThinking: self.info.collectThinking ?? undefined,
      planMode: self.info.planMode,
      sessionId: opts.resume,
      forCompact: opts.forCompact,
      leaderSocket: self.runtimeFiles.grokLeaderSocket(),
      runner: self.opts.cliRunner,
    });
  }
  /** Project MCP config `.grok/config.toml` (docs: project-scoped MCP).
   *  Valores por agente via `${VAR}`. Auth NÃO mora aqui — ver runtimeFiles.grokHome().
   *  Nunca criar auth.json/sessions aqui (poluiria se GROK_HOME errasse). */
export function writeGrokConfig(self: any) {
    const dir = path.join(self.opts.workspaceRoot, ".grok");
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
    if (self.opts.bridgeSocketPath) {
      bridgeEnv.THE_DUDES_BRIDGE_SOCKET = "${THE_DUDES_BRIDGE_SOCKET}";
    }
    for (const k of Object.keys(self.featuresEnv())) {
      bridgeEnv[k] = `\${${k}}`;
    }
    const built = buildGrokMcpToml(self.opts.extraMcpServers, {
      command: self.opts.bridgeCommand, args: self.opts.bridgeArgs, env: bridgeEnv,
    });
    for (const warning of built.warnings) self.opts.log("warn", `[grok:${self.info.name}] ${warning}`);
    try {
      writeFileSync(path.join(dir, "config.toml"), built.toml, { mode: 0o600 });
    } catch (e) {
      self.opts.log("warn", `[grok:${self.info.name}] failed to write .grok/config.toml: ${(e as Error).message}`);
    }
  }
  /**
   * HOME canônico do Grok Build (auth.json, sessions). Nunca usar o
   * `.grok/` do workspace — esse path é só project-config (MCP); se o CLI
   * confundir com GROK_HOME, headless cai em 401 (sem credenciais).
   */
export function grokTurnEnv(self: any, ): NodeJS.ProcessEnv {
    return buildGrokEnv({
      base: self.buildEnv(),
      tokenFile: self.runtimeFiles.tokenFile(),
      features: self.featuresEnv(),
      grokHome: self.runtimeFiles.grokHome(),
      dropTo: self.opts.dropTo,
      runner: self.opts.cliRunner,
    });
  }
export async function runGrokMessage(self: any, content: string, images?: ImageAttachment[]) {
    const timing = self.turnLatency?.current;
    if (self.stopped) { self.messageSession.busy = false; return; }
    if (!self.ensureRunnerAvailable(self.opts.cliRunner)) { self.messageSession.busy = false; return; }
    // Nunca manda ciphertext pro CLI — hang/resposta lixo. Decryption falhou
    // no spawn (sem project key): aborta o turno em vez de travar o runner.
    if (typeof self.info.systemPrompt === "string" && self.info.systemPrompt.startsWith("e2e:")) {
      self.messageSession.busy = false;
      self.opts.onError(
        `[grok] systemPrompt ainda cifrado (sem project key no daemon) — abra o projeto no browser pra re-share da chave E2EE e reinicie o agente`,
      );
      self.setState("idle");
      self.drainOcQueue();
      return;
    }
    // Rastreia inflight pra re-fila no hard recover (hang / SIGKILL sem close).
    const epoch0 = self.messageSession.epoch;
    const prevAttempt =
      self.inflightPerMessage?.content === content
        ? self.inflightPerMessage.attempt
        : 0;
    self.inflightPerMessage = { content, images, attempt: prevAttempt };
    // T-055: fila do turn-gate NÃO é hang. Estado "queued" + flag interna
    // suspendem o watchdog até o slot ser concedido e o CLI spawnar.
    timing?.gateStart();
    self.waitingTurnGate = true;
    self.setState("queued");
    // Mesmo semáforo do runOneShot: turnos grok de resume são o caso medido
    // (4 simultâneos × ~120MB com swap saturado). O release fica amarrado ao
    // 'close' do processo; o guard interno do gate cobre o "close não veio".
    // T-055: ephemeral (Brain subagent) compete no pool `bg`, não no main.
    const pool = self.info.ephemeral ? "bg" as const : "main" as const;
    const releaseSlot = await acquireTurnSlot(`${self.opts.cliRunner}:${self.info.name}`, self.opts.log, pool);
    timing?.gateEnd();
    timing?.start();
    self.waitingTurnGate = false;
    if (self.stopped || !self.messageSession.owns(epoch0)) { releaseSlot(); return; }
    // Guarda o release pro hard recover: close pós-SIGKILL não é garantido
    // (netos herdam pipes) e sem isto o slot trava a fila por até 15min.
    self.activeTurnRelease = releaseSlot;
    self.setState("thinking");
    recordTurnStart(self.opts.cliRunner);
    const grokTurnT0 = Date.now();
    self.writeGrokConfig();
    let message = content;
    const firstTurn = self.messageSession.firstTurn;
    const pendingSummary = self.messageSession.pendingSummary;
    const epoch = self.messageSession.epoch;
    // Resume: NÃO re-injeta system+skills (já na sessão). Só first-turn cold.
    if (firstTurn && !self.messageSession.sessionId) {
      self.messageSession.consumeFirstTurn();
      message = self.initialMessage(content, pendingSummary);
    } else if (firstTurn) {
      // Tinha resumeSessionId mas firstTurn ainda true (legado) — só avança flag.
      self.messageSession.firstTurn = false;
    }
    // Anexos: grava temp e referencia por path (tool read_file do Grok).
    let imgCleanup = () => {};
    if (images && images.length) {
      const { files, cleanup } = self.writeAttachmentFiles(images);
      imgCleanup = cleanup;
      message = appendPathAttachmentPrompt(message, files, self.opts.cliRunner);
    }
    // Prime do dedupe de tool_calls: em resume de sessão com histórico,
    // marca as tools de turnos antigos como vistas SEM emitir.
    if (!self.grokToolsPrimed) {
      self.grokToolsPrimed = true;
      if (self.messageSession.sessionId) self.grokSweepToolCalls(self.messageSession.sessionId, false);
    }
    const args = self.buildGrokHeadlessArgs(message, {
      resume: self.messageSession.sessionId,
      outputFormat: "streaming-json",
    });
    self.traceCli(self.opts.cliRunner, "argv", message);
    self.traceSpawn(self.opts.cliRunner, args);
    let proc: ChildProcess;
    try {
      proc = spawnDropped(self.runnerCommand(self.opts.cliRunner), args, {
        cwd: self.opts.workspaceRoot,
        env: self.grokTurnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, self.opts.dropTo ?? null);
    } catch (e) {
      timing?.finish("spawn-error");
      self.releaseActiveTurnSlot();
      imgCleanup();
      self.messageSession.busy = false;
      self.opts.onError(`grok spawn falhou: ${(e as Error).message}`);
      self.setState("idle");
      self.drainOcQueue();
      return;
    }
    proc.once("close", (code: number | null) => {
      // T-593: um close TARDIO (SIGKILL de um hard recover anterior) não pode
      // devolver o slot do turn-gate do turno NOVO — o recover já devolveu o do
      // turno morto. Mesmo guarda do endTurn (T-417) e do qwen (T-371); o grok
      // era o único runner per-message sem ela.
      if (self.messageSession.owns(epoch) || self.stopped) self.releaseActiveTurnSlot();
      recordTurnEnd(self.opts.cliRunner, Date.now() - grokTurnT0, code === 0);
    });
    timing?.bootStart();
    self.ocActiveProc = proc;
    // T-593: o pid é rastreado para o hard recover matar por PID mesmo quando
    // `ocActiveProc` já tiver sido anulado por um close tardio do turno
    // anterior (killProcess(null) é no-op — ver liveTurnPids no agent-runner).
    self.trackTurnPid(proc.pid);
    const grokTurnStartedAt = Date.now();
    // Marco de INÍCIO do turno. Sem ele o log só tinha o fim (soft hang aos
    // 92s, SIGKILL aos 720s) e não dava pra distinguir "CLI subiu e ficou
    // mudo" de "turno nem começou" na hora de investigar silêncio em prod.
    self.opts.log(
      "info",
      `[grok:${self.info.name}] turno iniciado pid=${proc.pid ?? "?"} session=${self.messageSession.sessionId?.slice(0, 8) ?? "nova"} firstTurn=${firstTurn} bytes=${message.length}`,
    );
    // Zera o relógio de hang no spawn — o acquireTurnSlot pode ter esperado
    // na fila e o setState("thinking") anterior não reflete o início real.
    self.touchActivity();
    // T-593: nenhum evento SEMÂNTICO ainda — reabre a janela de cold start
    // (firstEventMs) para o hard de 120s não matar o turno enquanto o CLI só
    // está carregando. Depois de `touchActivity`, que fecha a janela.
    markTurnStart(self.activityClock);
    // T-705: GROK_TURN_TIMEOUT_MS (720s) deixa de ser SIGKILL absoluto.
    // Decisão: AMARRAR no watchdog (não subir o teto). shouldKill só
    // autoriza se idle ≥ postEventMs e a tool em voo (se houver) já
    // venceu toolsHardMs. Skip re-arma no postEventMs — senão o backstop
    // morria no primeiro thought recente aos 720s.
    // Pós-SIGKILL o 'close' NÃO é garantido (netos herdam pipes) — se busy
    // continuar, force recoverHungTurn em 3s (senão agente mudo até restart).
    const grokHang = hangThresholds(self.opts.cliRunner);
    const grokRearmMs = grokHang.postEventMs ?? grokHang.hardMs;
    armHardTimeout(proc, GROK_TURN_TIMEOUT_MS, () => {
      timing?.finish("hard-recover", "hard-timeout", "hang");
      self.opts.log("warn", `[grok:${self.info.name}] turno excedeu ${GROK_TURN_TIMEOUT_MS / 1000}s — SIGKILL (session=${self.messageSession.sessionId?.slice(0, 8) ?? "nova"})`);
      setTimeout(() => {
        if (self.stopped || !self.messageSession.owns(epoch)) return;
        if (self.ocActiveProc === proc || self.messageSession.busy) {
          self.opts.log("warn", `[grok:${self.info.name}] close não veio após SIGKILL — force recover (busy preso)`);
          self.recoverHungTurn(
            `grok hard-timeout ${GROK_TURN_TIMEOUT_MS / 1000}s without clean close`,
            Date.now() - grokTurnStartedAt,
          );
        }
      }, 3_000);
    }, () => {
      if (!self.messageSession.owns(epoch)) return false;
      const idleMs = Date.now() - self.activityClock.lastActivityAt;
      const toolsAgeMs = self.toolsInFlightSince ? Date.now() - self.toolsInFlightSince : 0;
      const kill = grokAbsoluteTimeoutShouldKill({
        idleMs,
        toolsInFlight: self.toolsInFlight ?? 0,
        toolsAgeMs,
        runner: self.opts.cliRunner,
      });
      if (!kill) {
        self.opts.log(
          "info",
          `[grok:${self.info.name}] lifetime ${GROK_TURN_TIMEOUT_MS / 1000}s adiado (idle=${Math.round(idleMs / 1000)}s, evento semântico recente)`,
        );
      }
      return kill;
    }, grokRearmMs);
    // Tool calls ao vivo durante o turno (só possível em resume, quando o
    // sessionId já é conhecido; turno cold emite tudo no sweep final).
    // Auto-limpa quando o turno morreu: 'close' NÃO é garantido pós-SIGKILL
    // se um neto herdou os pipes de stdio (mesmo caveat do one-shot) — sem
    // isto cada turno wedged vazava um interval de 3s pra sempre.
    const toolPoll = setInterval(() => {
      if (self.stopped || !self.messageSession.owns(epoch) || !procAlive(proc)) {
        clearInterval(toolPoll);
        return;
      }
      if (self.messageSession.sessionId) self.grokSweepToolCalls(self.messageSession.sessionId, true);
    }, 3000);
    const clearGrokPoll = () => clearInterval(toolPoll);
    proc.on("close", clearGrokPoll);
    proc.on("exit", clearGrokPoll);
    proc.on("error", clearGrokPoll);
    // Texto de assistant: acumula o turno e emite UMA vez no final.
    // onAssistantText no orch cria uma mensagem por chamada — flush por
    // chunk/newline virava dezenas de balões "PM → Você" (UI quebrada).
    // Thought (T-705) NÃO entra nesse buffer: sai em stream via
    // onThinkingText (wire agent:thinking), como claude/qwen.
    //
    // Estado: thought/tools → thinking; speaking só na entrega final.
    let buf = "";
    let fullText = "";
    let sawEnd = false;
    let endSessionId: string | undefined;
    let errOut = "";
    let errFromJson = "";
    let emittedAny = false;
    // T-712: segmento de thought em curso (ver GROK_THINKING_FLUSH_*).
    let thinkingSeg = "";
    let thinkingTimer: NodeJS.Timeout | undefined;
    /** @returns true se parseou ≥1 evento semântico (conta pro hang watch). */
    const ingestLine = (line: string): boolean => {
      if (!line.startsWith("{") || !self.messageSession.owns(epoch)) return false;
      try {
        let sawSemantic = false;
        for (const event of parseGrokStreamEvent(JSON.parse(line))) {
          if (event.type === "session") timing?.bootReady();
          if (event.type === "text" && event.text) timing?.semantic("text");
          if (event.type === "thought" && event.text) timing?.semantic("thinking");
          if (event.type === "tool") timing?.semantic("tool");
          sawSemantic = true;
          // Fim do segmento de thought: sai ANTES do text/tool (T-705 + T-712).
          if (event.type === "text" || event.type === "tool" || event.type === "result" || event.type === "error") {
            flushThinking();
          }
          if (event.type === "text") {
            fullText += event.text;
            // Texto de assistant após tools = tool loop andou; libera proteção.
            if (event.text.trim()) self.clearGrokToolsInFlight();
            // Mantém thinking: texto é bufferizado; "speaking" só no emitOnce.
          } else if (event.type === "thought") {
            // T-705: thought em STREAM (paridade claude/qwen). Antes só
            // emitOnce() no close — UI sem thinking durante o turno.
            self.traceInternalCli(
              "info",
              `[cli:${self.info.id}:grok:thinking] block_received len=${event.text.length} collectFlag=${self.info.collectThinking}`,
            );
            if (self.info.collectThinking && event.text) {
              thinkingSeg += event.text;
              if (thinkingSeg.length >= GROK_THINKING_FLUSH_CHARS) flushThinking();
              else if (!thinkingTimer) thinkingTimer = setTimeout(flushThinking, GROK_THINKING_FLUSH_MS);
            }
            self.setState("thinking");
          } else if (event.type === "tool") {
            // Stream ACP emite tool_call ao vivo (CLI ≥0.2) — não esperar poll 3s.
            // Dedupe por toolCallId (mesmo id no chat_history.jsonl do sweep).
            if (event.name) {
              const toolKey = event.id || `stream:${event.name}:${JSON.stringify(event.input).slice(0, 120)}`;
              if (!self.grokSeenToolCallIds.has(toolKey)) {
                self.grokSeenToolCallIds.add(toolKey);
                self.opts.onToolUse(event.name, event.input);
              }
            }
            // Tools longas (shell/MCP) podem ficar >120s sem novo evento
            // semântico — sem toolsInFlight o hard hang mata o turno legítimo
            // (QA T-009 critério 5). Marca em voo; result/text zera.
            self.noteGrokToolInFlight();
            self.setState(
              event.name.includes("send_message") ? "sending" : "thinking",
            );
          } else if (event.type === "session") endSessionId = event.sessionId;
          else if (event.type === "result") {
            sawEnd = true;
            self.clearGrokToolsInFlight();
          } else if (event.type === "error") {
            errFromJson = event.message;
            self.checkContextFullError(event.message);
          }
        }
        // text/result/session não passam por setState — ainda assim são progresso.
        if (sawSemantic) self.touchActivity();
        return sawSemantic;
      } catch { /* linha incompleta / ruído */ return false; }
    };
    /** T-712: emite o segmento acumulado como UM agent:thinking (texto cru,
     *  espaços dos tokens preservados). Chamado no fim do segmento e no close. */
    const flushThinking = (): void => {
      if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = undefined; }
      const seg = thinkingSeg;
      thinkingSeg = "";
      if (!seg.trim() || !self.messageSession.owns(epoch)) return;
      self.opts.onThinkingText?.(seg);
    };
    /** Emite no máximo 1 agent_to_user por turno. @returns false se WS dropou. */
    const emitOnce = (): boolean => {
      if (!self.messageSession.owns(epoch) || emittedAny) return true;
      const t = fullText.trim();
      if (t) {
        self.setState("speaking");
        const ok = self.opts.onAssistantText(t);
        emittedAny = true;
        // false explícito = canal WS não aceitou (mudo WAN sem hang de processo).
        if (ok === false) {
          self.handleUndeliveredTurnResult("agent:text não entregue ao server (WS down/backpressure)");
          return false;
        }
      }
      // Billing real vem do turn_completed em finishGrokTurn (usage do loop).
      // Char-estimate só como fallback se updates.jsonl não tiver usage.
      // Ocupação da janela: signals.json / _meta.totalTokens — NUNCA usage.totalTokens.
      return true;
    };
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    // Hang watch NÃO reseta em bytes brutos: sob swap thrash o CLI cospe
    // stderr/stdout sem evento útil e o soft/hard nunca disparavam (prod
    // 2026-08-04: zero linhas [hang] no log). Só ingestLine semântico conta.
    proc.stdout!.on("data", (chunk: string) => {
      self.traceCli(self.opts.cliRunner, "stdout", chunk);
      buf = self.capAccum(self.opts.cliRunner, buf, chunk);
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
      self.traceCli(self.opts.cliRunner, "stderr", msg);
      errOut = self.capAccum(self.opts.cliRunner, errOut, chunk);
      self.checkContextFullError(msg);
    });
    proc.on("close", (code) => {
      // Resto de buffer sem newline final (json single-object ou última linha).
      if (buf.trim()) ingestLine(buf.trim());
      flushThinking();
      emitOnce();
      if (errFromJson && !emittedAny) {
        self.opts.onError(`grok: ${errFromJson.slice(0, 500)}`);
      }
      imgCleanup();
      // T-593: o processo saiu — sai do rastreamento de pids do recover.
      self.untrackTurnPid(proc.pid);
      // T-593: `ocActiveProc` só é anulado se ESTE turno ainda for dono do
      // epoch. Antes era incondicional, e um close TARDIO (SIGKILL de um hard
      // recover anterior) apagava a referência do turno NOVO que o drain tinha
      // acabado de pôr em voo. O recover seguinte chamava killProcess(null) —
      // no-op em process-lifecycle (`!processAlive(null)` → return false) — e o
      // CLI sobrevivia por horas: 10 processos `grok -p` vivos no host do dono
      // (2026-09-16), carga que sustentava a T-592. Mesmo guarda do endTurn
      // (T-417) / qwen (T-371).
      if (self.messageSession.owns(epoch) || self.stopped) self.ocActiveProc = null;
      if (self.stopped) { self.messageSession.busy = false; self.emitExit(code); return; }
      timing?.finish(sawEnd && !errFromJson ? "completed" : code === 0 ? "error" : "process-exit");
      void self.finishGrokTurn({
        code, epoch, firstTurn, pendingSummary, content, images,
        sawEnd, endSessionId, errOut, errFromJson, emittedAny,
      });
    });
  }
export async function finishGrokTurn(self: any, t: {
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
    // Turno stale (hard recover já bumpou epoch / iniciou outro): NÃO mexer
    // em busy/fila — era o bug que silenciava Grok até restart manual.
    if (!self.messageSession.owns(t.epoch)) {
      self.opts.log(
        "info",
        `[grok:${self.info.name}] finishGrokTurn ignorado (epoch stale ${t.epoch}≠${self.messageSession.epoch})`,
      );
      return;
    }
    try {
      // Sweep de tool calls ANTES dos branches de falha: turno abortado é
      // justamente o que precisa de auditoria na RUNS — e os branches de
      // retry descartam a sessão (sweep só no sucesso perdia o registro das
      // tools executadas pra sempre).
      const sweepSid = t.endSessionId ?? self.messageSession.sessionId;
      if (sweepSid) self.grokSweepToolCalls(sweepSid, true);
      const failed = (t.code ?? 1) !== 0 && !t.emittedAny && !t.sawEnd;
      const combinedErr = `${t.errOut}\n${t.errFromJson}`;
      // Resume de sessão inexistente / expurgada.
      if (failed && self.messageSession.sessionId && isMissingSessionMessage(combinedErr)) {
        self.opts.onError(`[grok] sessão ${self.messageSession.sessionId} não existe mais — recomeçando sessão nova`);
        self.messageSession.resetForRetry(t.pendingSummary);
        self.info.sessionId = undefined;
        if (self.opts.onSessionId) self.opts.onSessionId("");
        self.messageSession.prepend({ content: t.content, images: t.images });
        return;
      }
      // Timeout / kill sem output em resume: descarta sessão e tenta 1x cold.
      // Evita loop infinito de hang no mesmo sessionId.
      if (failed && self.messageSession.sessionId && !t.emittedAny && isAbortedFailure(combinedErr, t.code)) {
        self.opts.onError(
          `[grok] turno abortado sem output (code=${t.code ?? "?"}) — limpando sessão ${self.messageSession.sessionId.slice(0, 8)}… e recomeçando`,
        );
        self.messageSession.resetForRetry(t.pendingSummary);
        self.info.sessionId = undefined;
        if (self.opts.onSessionId) self.opts.onSessionId("");
        self.messageSession.prepend({ content: t.content, images: t.images });
        return;
      }
      if (failed) {
        self.messageSession.restoreFirstTurn(t);
        const err = combinedErr.trim() || `grok exit ${t.code ?? "?"} sem output`;
        self.checkContextFullError(err);
        // 401 / credenciais: mensagem acionável (login OAuth do CLI, não do the-dudes).
        if (isAuthenticationFailure(err)) {
          const home = self.runtimeFiles.grokHome();
          self.opts.onError(
            `[grok] autenticação falhou (401). Rode \`grok login\` no mesmo user do daemon ` +
            `(auth em ${home}/auth.json). Se usou XAI_API_KEY inválida, remova do env. ` +
            `Detalhe: ${err.slice(0, 300)}`,
          );
          return;
        }
        self.opts.onError(`grok: ${err.slice(0, 500)}`);
        return;
      }
      if (t.errOut.trim() && !t.emittedAny) {
        // stderr sem texto útil no stdout (auth/rate limit).
        self.opts.onError(t.errOut.trim().slice(0, 500));
      }
      // Captura sessionId do evento end (ou já tinha de resume).
      const sid = t.endSessionId ?? self.messageSession.sessionId;
      if (sid && sid !== self.messageSession.sessionId) {
        self.messageSession.sessionId = sid;
        if (self.opts.onSessionId) self.opts.onSessionId(sid);
      } else if (sid && !self.info.sessionId && self.opts.onSessionId) {
        self.opts.onSessionId(sid);
      }
      // Tool calls do turno: streaming-json não as emite no stdout — a fonte
      // é o chat_history.jsonl (turno cold só ganha sessionId aqui no end).
      if (sid) self.grokSweepToolCalls(sid, true);
      // Ocupação real da janela: signals.json / updates.jsonl (igual /context).
      // NÃO re-emitir 0 se a leitura falhar — isso apagava a barra (e em
      // dual-daemon um processo "cego" zerava o valor do outro).
      // Billing: turn_completed.usage (somatório do tool-loop do turno).
      // NÃO misturar: usage.inputTokens multi-step pode ser 5–10M enquanto a
      // janela real fica em ~200–400k — só a janela alimenta a barra.
      if (sid) {
        const sig = await self.pollGrokContextOccupancy(sid);
        if (sig && sig.contextTokensUsed > 0) {
          self.opts.log(
            "info",
            `[grok] context window ${sig.contextTokensUsed}/${sig.contextWindowTokens} (${sig.contextWindowUsage}%) session=${sid.slice(0, 8)}…`,
          );
          self.reportContextOccupancy(sig.contextTokensUsed, sig.contextWindowTokens);
        } else if (sig) {
          // sessão nova ainda com used=0 — só reporta se ainda não temos valor
          if (self.contextTracker.lastUsed() <= 0) {
            self.reportContextOccupancy(0, sig.contextWindowTokens);
          }
        }
        const billing = self.readGrokTurnBilling(sid);
        if (billing && (billing.input > 0 || billing.output > 0)) {
          // Grok reporta input inclusivo de cache (input ≈ cacheRead + fresh).
          // Normaliza pra estilo anthropic: input = fresh, cacheRead separado.
          const cacheRead = billing.cacheRead;
          const exclusiveIn = cacheRead > 0 && cacheRead <= billing.input
            ? billing.input - cacheRead
            : billing.input;
          self.opts.onUsageDelta?.({
            input: exclusiveIn,
            output: billing.output,
            cacheCreate: billing.cacheCreate,
            cacheRead,
          });
        } else if (t.emittedAny || t.content.length > 0) {
          // Fallback: headless sem usage no updates — estima por chars.
          const estIn = Math.max(1, Math.ceil(t.content.length / 4));
          // output estimado não temos facilmente aqui; 0 é ok (billing parcial)
          self.opts.onUsageDelta?.({
            input: estIn,
            output: 0,
            cacheCreate: 0,
            cacheRead: 0,
          });
        }
      }
      // Sucesso (ou falha terminal tratada): limpa inflight
      if (self.inflightPerMessage?.content === t.content) {
        self.inflightPerMessage = null;
      }
    } finally {
      // Só o dono do epoch libera busy — evita race com hard recover.
      if (self.messageSession.owns(t.epoch)) {
        self.messageSession.busy = false;
        if (!self.stopped) {
          self.setState("idle");
          self.drainOcQueue();
        }
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
export function grokSignalsCandidates(self: any, sessionId: string): string[] {
    return grokSignalsCandidatesFor(self.runtimeFiles.grokHome(), self.opts.workspaceRoot, sessionId);
  }
  /** Lê `signals.json` da sessão Grok (ocupação real da janela). */
export function readGrokContextSignals(self: any, sessionId: string): GrokContextSignals | null {
    for (const p of self.grokSignalsCandidates(sessionId)) {
      try {
        if (!existsSync(p)) continue;
        const sig = parseGrokContextSignals(JSON.parse(readFileSync(p, "utf8")) as unknown);
        if (sig) return sig;
      } catch { /* tenta próximo */ }
    }
    // Fallback: scan por sessionId (cwd do CLI pode divergir por symlink).
    try {
      const sessionsRoot = path.join(self.runtimeFiles.grokHome(), "sessions");
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
export function grokChatHistoryPath(self: any, sessionId: string): string | null {
    return resolveGrokChatHistoryPath(self.runtimeFiles.grokHome(), self.opts.workspaceRoot, sessionId);
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
export function grokSweepToolCalls(self: any, sessionId: string, emit: boolean): boolean {
    const p = self.grokChatHistoryPath(sessionId);
    if (!p) return false;
    const result = sweepGrokChatToolCallsFromPath(
      p,
      self.grokChatSweepState,
      self.grokSeenToolCallIds,
      emit
        ? (call) => {
          self.opts.onToolUse(call.name, call.input);
          // Poll 3s de chat_history: tool em andamento sem stream JSON.
          self.noteGrokToolInFlight();
          // Volta pra thinking/sending: o stream pode ter marcado "speaking"
          // com text intermediário, mas o agente ainda está no tool-loop.
          self.setState(call.name.includes("send_message") ? "sending" : "thinking");
        }
        : undefined,
    );
    if (!result) return false;
    self.grokChatSweepState = result.cursor;
    return result.emitted;
  }
  /** Caminhos candidatos de updates.jsonl da sessão Grok (cwd variants + scan). */
export function grokUpdatesCandidates(self: any, sessionId: string): string[] {
    return grokUpdatesCandidatesFor(self.runtimeFiles.grokHome(), self.opts.workspaceRoot, sessionId);
  }
  /**
   * Fallback de ocupação via updates.jsonl: último `_meta.totalTokens`
   * (espelha a janela). NÃO usar max de `usage.totalTokens` — billing de
   * tool-loops multi-step infla 4–12× vs signals.contextTokensUsed
   * (ex.: 5.13M vs janela real ~244k).
   */
export function readGrokUpdatesContextTokens(self: any, sessionId: string): number {
    // Teto = ~janela: rejeita billing multi-step disfarçado de totalTokens.
    const maxTokens = Math.max(Math.floor(self.contextLimit() * 1.1), 600_000);
    let best = 0;
    const seen = new Set<string>();
    for (const p of self.grokUpdatesCandidates(sessionId)) {
      if (seen.has(p) || !existsSync(p)) continue;
      seen.add(p);
      try {
        const n = parseGrokUpdatesContextTokens(readFileSync(p, "utf8"), maxTokens);
        if (n > best) best = n;
      } catch { /* next */ }
    }
    return best;
  }
  /**
   * Billing do último turn_completed no updates.jsonl.
   * Soma do loop de tools do turno — correto pra billing, NÃO pra janela.
   */
export function readGrokTurnBilling(self: any, sessionId: string): GrokTurnBilling | null {
    let best: GrokTurnBilling | null = null;
    const seen = new Set<string>();
    for (const p of self.grokUpdatesCandidates(sessionId)) {
      if (seen.has(p) || !existsSync(p)) continue;
      seen.add(p);
      try {
        const b = parseGrokTurnBillingFromUpdates(readFileSync(p, "utf8"));
        if (!b) continue;
        // Prefere o arquivo com mais input (cwd canônico costuma ser o completo).
        if (!best || b.input > best.input) best = b;
      } catch { /* next */ }
    }
    return best;
  }
  /**
   * Poll pós-turno: o Grok às vezes flusha signals.json um pouco depois do
   * exit do processo. Nunca devolve "forçar 0" — null se ainda não souber.
   * Prefere signals; updates só como fallback (nunca infla acima do signals).
   */
export async function pollGrokContextOccupancy(self: any, sessionId: string): Promise<GrokContextSignals | null> {
    let best: GrokContextSignals | null = null;
    for (let i = 0; i < 6; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 200));
      if (self.stopped) return best;
      const sig = self.readGrokContextSignals(sessionId);
      if (sig) {
        best = sig;
        if (sig.contextTokensUsed > 0) break;
      }
    }
    // Só abre updates se signals ainda não deu ocupação (I/O em arquivo grande).
    const fromUpdates = best && best.contextTokensUsed > 0
      ? 0
      : self.readGrokUpdatesContextTokens(sessionId);
    return mergeGrokContextOccupancy(best, fromUpdates, self.contextLimit());
  }
  /** Dispara onContextFull no máximo uma vez por janela de cooldown. Sem
   *  isso, N eventos acima do limite no mesmo turno viram N compactContext
   *  concorrentes (processo claude órfão + resumo duplicado). Cooldown em vez
   *  de latch: se o compact falhar (provider flaky, timeout), o próximo sinal
   *  de contexto cheio re-dispara a compaction em vez de silenciar pra sempre. */