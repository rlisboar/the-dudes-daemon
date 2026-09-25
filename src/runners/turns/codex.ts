/* R7 (T-462): turno extraído do agent-runner — `self` é o AgentRunner. */
import { beginTurn, endTurn } from "./end-turn.js";
import {AgentUsage, ImageAttachment} from "../../types.js";
import {ChildProcess} from "node:child_process";
import {PER_MSG_TURN_TIMEOUT_MS} from "../../agent-runner.js";
import {appendFilePrompt, codexImageArgs} from "../attachments.js";
import {armHardTimeout} from "../process-lifecycle.js";
import {buildCodexMcpToml} from "../mcp-config.js";
import {chmodSync, chownSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {codexEffort} from "../model-policy.js";
import {isCodexMissingRolloutError, parseCodexRolloutSessionId, parseCodexRolloutSignals, parseCodexTurnEvent} from "../turn-parsers.js";
import {spawnDropped} from "../../privileges.js";
import os from "node:os";
import path from "node:path";
export function writeCodexConfig(self: any, ): void {
    const home = self.runtimeFiles.codexHomeDir();
    const built = buildCodexMcpToml(self.mcpServersForSpawn(), {
      command: self.opts.bridgeCommand,
      args: self.opts.bridgeArgs,
      env: self.bridgeEnv(),
    });
    for (const warning of built.warnings) self.opts.log("warn", `[codex:${self.info.name}] ${warning}`);
    const file = path.join(home, "config.toml");
    writeFileSync(file, built.toml, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch {}
    // Daemon root → CLI dropado: arquivo/dir precisam pertencer ao user do
    // drop, senão o codex (uid drop) não lê o config nem escreve no home.
    if (self.opts.dropTo) {
      try { chownSync(home, self.opts.dropTo.uid, self.opts.dropTo.gid); } catch {}
      try { chownSync(file, self.opts.dropTo.uid, self.opts.dropTo.gid); } catch {}
    }
  }
/** T-829: espera do `close` depois do `exit`. O close só vem quando TODOS os
 *  pipes fecham; neto que herdou stdout/stderr (MCP do codex, comando em
 *  background) segura o pipe e o turno ficava busy até o watchdog dar HARD
 *  recover ("process dead for 20s while busy", 41× no log de 21/09). */
export const CODEX_CLOSE_GRACE_MS = 2_000;

export async function runCodexMessage(self: any, content: string, images?: ImageAttachment[]) {
    const timing = self.turnLatency?.current;
    if (self.stopped) return;
    if (!self.ensureRunnerAvailable("codex")) return;
    // T-251: gate de turno para todos os runners (antes só Grok).
    if (!(await self.gateTurn())) { self.messageSession.busy = false; return; }
    // T-829: contador de tools é por turno; resto de turno anterior não vale.
    self.codexToolItems?.clear();
    self.clearGrokToolsInFlight();
    self.setState("thinking");
    let message = content;
    const firstTurnSnapshot = self.messageSession.consumeFirstTurnIfNeeded();
    if (firstTurnSnapshot.firstTurn) message = self.initialMessage(content, firstTurnSnapshot.pendingSummary);
    self.writeCodexConfig();
    const configArgs: string[] = [];
    const commonFlags = [
      "--json",
      "--skip-git-repo-check",
      // Codex has no way to show approval prompts when stdin is closed;
      // our MCP tools are safe (no shell execution) so bypass is fine.
      "--dangerously-bypass-approvals-and-sandbox",
      ...configArgs,
      ...(self.info.model ? ["-m", self.info.model] : []),
      ...(self.info.effort ? ["-c", `model_reasoning_effort="${codexEffort(self.info.effort)}"`] : []),
    ];
    // Imagens: codex aceita `-i <FILE>` (repetido). Grava temp e anexa.
    // `-i` é SÓ imagem — PDF/txt por ali o codex recusa; esses vão por
    // caminho no prompt, pra tool de leitura dele abrir.
    let imgCleanup = () => {};
    let imageArgs: string[] = [];
    if (images && images.length) {
      const { files, cleanup } = self.writeAttachmentFiles(images);
      imgCleanup = cleanup;
      imageArgs = codexImageArgs(files.filter((f: any) => f.inline).map((f: any) => f.path));
      message = appendFilePrompt(message, files.filter((f: any) => !f.inline));
    }
    // Trace depois dos anexos: o que vai no argv é o prompt já com os paths.
    self.traceCli("codex", "argv", message);
    const args = self.messageSession.sessionId
      ? ["exec", "resume", ...commonFlags, self.messageSession.sessionId, ...imageArgs, message]
      : ["exec", ...commonFlags, ...imageArgs, message];
    self.traceSpawn("codex", args);
    let proc: ChildProcess;
    try {
      proc = spawnDropped(self.runnerCommand("codex"), args, {
      cwd: self.opts.workspaceRoot,
      env: self.buildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }, self.opts.dropTo ?? null);
    } catch (e) {
      self.failTurnSpawn("codex", e, self.messageSession.epoch, imgCleanup, firstTurnSnapshot);
      return;
    }
    timing?.bootStart();
    self.ocActiveProc = proc;
    // T-820: registra o pid no rastreio do runner — `killTrackedTurnPids` (stop,
    // hard recover, shutdown) alcança o CLI MESMO depois de um close tardio anular
    // `ocActiveProc` (kill no-op). Antes só o grok fazia isso (T-593): turno órfão
    // sobrevivia ao stop e o stub detached pendurava a suíte sem `--test-force-exit`.
    self.trackTurnPid(proc.pid);
    armHardTimeout(proc, PER_MSG_TURN_TIMEOUT_MS, () => {
      timing?.finish("hard-recover", "hard-timeout", "lifetime");
      self.opts.log("warn", `[codex:${self.info.name}] turno excedeu ${PER_MSG_TURN_TIMEOUT_MS / 1000}s — SIGKILL`);
    });
    // Epoch do spawn: eventos deste turno só valem enquanto a sessão não foi
    // resetada (clear/compact) — ver handleCodexEvent.
    const epoch = self.messageSession.epoch;
    const resumedSessionId = self.messageSession.sessionId;
    const turnKey = beginTurn(self);
    let buf = "";
    let stderrForResume = "";
    let resumeRolloutMissing = false;
    let semanticActivity = false;
    const handleEvent = (event: unknown) => {
      const normalized = parseCodexTurnEvent(event);
      if (resumedSessionId && normalized.some((e) => e.type === "error" && isCodexMissingRolloutError(e.message))) {
        resumeRolloutMissing = true;
      }
      if (normalized.some((e) => e.type !== "session" && e.type !== "error")) semanticActivity = true;
      self.handleCodexEvent(event, epoch);
    };
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      self.traceCli("codex", "stdout", chunk);
      buf = self.capAccum("codex", buf, chunk);
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("{")) continue;
        try { handleEvent(JSON.parse(line)); } catch {}
      }
    });
    proc.stderr!.on("data", (chunk: string) => {
      if (resumedSessionId) {
        stderrForResume = `${stderrForResume}${chunk}`.slice(-8_192);
        if (isCodexMissingRolloutError(stderrForResume)) resumeRolloutMissing = true;
      }
      const msg = chunk.trim();
      if (!msg) return;
      self.traceCli("codex", "stderr", msg);
      // Único runner cujo stderr não passava pelos CONTEXT_FULL_PATTERNS
      // (claude e gemini passam) — estouro reportado só no stderr era mudo.
      self.checkContextFullError(msg);
      if (msg.includes(" ERROR ") && !msg.includes("failed to record rollout items")) {
        self.opts.onError(msg);
      }
    });
    // T-829: o turno fecha UMA vez — no close ou, se ele não vier, no exit +
    // CODEX_CLOSE_GRACE_MS (ver a constante).
    let fechado = false;
    const fecharTurno = (code: number | null) => {
      if (fechado) return;
      fechado = true;
      if (buf.trim().startsWith("{")) {
        try { handleEvent(JSON.parse(buf.trim())); } catch {}
      }
      buf = "";
      const resumeFallback = !!resumedSessionId
        && resumeRolloutMissing
        && !semanticActivity
        && !self.stopped
        && self.messageSession.owns(epoch);
      if (resumeFallback) {
        const hasSummary = !!self.messageSession.pendingSummary;
        self.messageSession.resetForRetry(self.messageSession.pendingSummary);
        self.info.sessionId = undefined;
        self.opts.onSessionId?.("");
        const currentTurn = self.currentTurn;
        self.messageSession.prepend({
          content,
          images,
          ...(currentTurn?.deliveryId ? { deliveryId: currentTurn.deliveryId } : {}),
        });
        self.opts.log(
          "warn",
          `[codex:${self.info.name}] resume falhou (no rollout found); mensagem re-enfileirada em sessão nova; resumo de contexto ${hasSummary ? "preservado" : "indisponível"}`,
        );
      }
      // R7: fim de turno único/idempotente (T-417 + T-251 preservados dentro).
      timing?.finish(resumeFallback ? "retry" : code === 0 ? "completed" : "process-exit");
      endTurn(self, { epoch, turnKey, code, imgCleanup });
      if (!self.stopped && self.messageSession.owns(epoch)) {
        // T-245: ocupação REAL pós-turno (último token_count do rollout). O
        // billing do turn.completed já reportado acima é substituído pelo
        // valor absoluto do último step — se o rollout não tiver sinal, o
        // comportamento atual permanece (fallback).
        void self.pollCodexContextOccupancy(epoch);
        self.drainOcQueue();
      }
    };
    proc.on("close", (code) => {
      self.untrackTurnPid(proc.pid);
      fecharTurno(code);
    });
    proc.on("exit", (code, signal) => {
      const t = setTimeout(() => {
        if (fechado) return;
        self.opts.log("warn", `[codex:${self.info.name}] close não veio ${CODEX_CLOSE_GRACE_MS}ms após o exit (code=${code} signal=${signal ?? "-"}) — fechando o turno (neto segurando o pipe)`);
        try { proc.stdout?.destroy(); } catch { /* já fechado */ }
        try { proc.stderr?.destroy(); } catch { /* já fechado */ }
        // Colhe os netos que ficaram no grupo do codex (spawnDropped é detached).
        try { if (proc.pid) process.kill(-proc.pid, "SIGTERM"); } catch { /* grupo vazio */ }
        fecharTurno(code ?? (signal ? null : 0));
      }, CODEX_CLOSE_GRACE_MS);
      t.unref?.();
    });
  }
export function handleCodexEvent(self: any, event: any, epoch: number) {
    // Turno spawnado num epoch anterior: clear/compact já resetou a sessão —
    // TODO evento dele é da conversa descartada (thread.started ressuscitaria
    // a sessão antiga pós-reset; turn.completed envenenaria a contabilidade
    // nova). Comparar epoch (e não `compacting`) preserva os eventos LEGÍTIMOS
    // do turno em voo durante o waitOcIdle — descartar thread.started nessa
    // fase deixava o primeiro turno órfão e o one-shot resumia thread vazia.
    if (!self.messageSession.owns(epoch)) return;
    // T-416/A10: linha parseada = progresso mesmo se setState for no-op.
    self.touchActivity();
    for (const normalized of parseCodexTurnEvent(event)) {
      if (normalized.type === "session") self.turnLatency?.current?.bootReady();
      if (normalized.type === "text" && normalized.text) self.turnLatency?.current?.semantic("text");
      if (normalized.type === "thought" && normalized.text) self.turnLatency?.current?.semantic("thinking");
      if (normalized.type === "tool") self.turnLatency?.current?.semantic("tool");
      if (normalized.type === "session") {
        if (normalized.sessionId !== self.messageSession.sessionId) {
          self.messageSession.sessionId = normalized.sessionId;
          self.opts.onSessionId?.(normalized.sessionId);
        }
      } else if (normalized.type === "tool") {
        // T-829/T-819: in-flight por item (id) no contador COMPARTILHADO, que
        // já é idempotente por id. Antes o turn.completed zerava tudo e o
        // contador inflava (11 "em voo" no WEB) — watchdog no teto de tools.
        // SEM id NÃO abre: `file_change` e `web_search` são tool instantânea
        // (não têm item.completed par), e a chave sintética `sem-id:N` ficaria
        // em voo pra sempre — 20 file_change + 10 web_search = 30 "em voo" e o
        // HARD do codex ia de 12min para o teto de tools (20min). Repro do QA-A.
        if (normalized.id) self.noteGrokToolInFlight(normalized.id);
        self.opts.onToolUse(normalized.name, normalized.input);
        self.setState(normalized.name.includes("send_message") ? "sending" : "thinking");
      } else if (normalized.type === "tool_done") {
        self.noteToolFechada(normalized.id);
      } else if (normalized.type === "thought") {
        // T-829: raciocínio do codex (item reasoning) não chegava à UI.
        if (self.info.collectThinking) self.opts.onThinkingText?.(normalized.text);
        if (self.currentState !== "speaking") self.setState("thinking");
      } else if (normalized.type === "text") {
        self.setState("speaking");
        self.opts.onAssistantText(normalized.text);
      } else if (normalized.type === "usage") {
          const delta: AgentUsage = {
            input: normalized.input,
            output: normalized.output,
            cacheCreate: normalized.cacheCreate,
            cacheRead: normalized.cacheRead,
          };
          self.opts.onUsageDelta?.(delta);
          // T-271: billing do turn.completed NÃO vira ocupação aqui — é a
          // soma dos prompts re-enviados no turno (multi-step) e cravava
          // 100% do mapa fallback, pedindo compact antes do poll pós-turno
          // aplicar o last_token_usage real do rollout. Guardado pro poll
          // usar como fallback (rollout ausente).
          self.codexTurnBilling = { epoch, delta };
          self.clearGrokToolsInFlight();
          self.codexToolItems?.clear();
      } else if (normalized.type === "error") {
        self.checkContextFullError(normalized.message);
        self.opts.onError(`codex: ${normalized.message}`);
      }
    }
  }
  /* ---------- T-245: contexto real do codex via rollout ---------- */
  /** T-271: billing do turn.completed do turno em voo, com o epoch do spawn.
   *  NÃO aplica ocupação sincronamente (podia cravar 100% do mapa fallback e
   *  pedir compact antes do poll pós-turno ler o rollout — billing multi-step
   *  soma os prompts re-enviados, não é ocupação de janela). O poll decide:
   *  sinal real do rollout vence; sem rollout, billing+mapa segue fallback. */
  /** Raiz dos rollouts do codex (~/.codex/sessions/YYYY/MM/DD/*.jsonl).
   *  CODEX_HOME respeitado (mesmo contrato do próprio CLI). */
export function codexSessionsRoot(_self: any, ): string {
    const home = process.env.CODEX_HOME?.trim();
    return path.join(home && home.length > 0 ? home : path.join(os.homedir(), ".codex"), "sessions");
  }
  /** Lê o sinal de contexto REAL do rollout da sessão (último event_msg
   *  token_count): last_token_usage.total_tokens (contexto do último step,
   *  não billing) + model_context_window (janela real do codex, ex. 258.400).
   *  null se o rollout não existir / não tiver token_count — fallback é o
   *  comportamento atual (billing do turn.completed + janela do mapa).
   *  Padrão do readGrokContextSignals (fonte de verdade em arquivo do CLI). */
export function readCodexRolloutSignals(self: any, sessionId: string): { used: number; window?: number } | null {
    if (!sessionId) return null;
    const root = self.codexSessionsRoot();
    let candidates: string[] = [];
    try {
      // rollouts ficam em YYYY/MM/DD (3 níveis); varre do mais recente pro
      // mais antigo — o turno acabou de terminar, o arquivo é de hoje.
      const years = readdirSync(root).sort().reverse();
      for (const year of years) {
        const yearDir = path.join(root, year);
        let months: string[] = [];
        try { months = readdirSync(yearDir).sort().reverse(); } catch { continue; }
        for (const month of months) {
          const monthDir = path.join(yearDir, month);
          let days: string[] = [];
          try { days = readdirSync(monthDir).sort().reverse(); } catch { continue; }
          for (const day of days) {
            let files: string[] = [];
            try { files = readdirSync(path.join(monthDir, day)); } catch { continue; }
            for (const f of files) {
              if (f.endsWith(".jsonl") && f.includes(sessionId)) candidates.push(path.join(monthDir, day, f));
            }
          }
          // O rollout do turno em curso costuma estar no mês mais recente;
          // varrer meses anteriores só se nada encontrado neles.
          if (candidates.length > 0) break;
        }
        if (candidates.length > 0) break;
      }
    } catch { return null; }
    for (const p of candidates) {
      try {
        const text = readFileSync(p, "utf8");
        if (parseCodexRolloutSessionId(text) !== sessionId) continue;
        const sig = parseCodexRolloutSignals(text);
        if (sig) return { used: sig.usedTokens, window: sig.contextWindow };
      } catch { /* tenta próximo */ }
    }
    return null;
  }
  /** Poll pós-turno: o rollout pode ser flushado um pouco depois do exit
   *  (mesma janela de corrida do signals.json do grok). Só reporta com
   *  sinal válido; turno de epoch antigo (clear/compact) é descartado.
   *  T-271: billing do turn.completed (guardado em codexTurnBilling) só é
   *  aplicado como fallback se o rollout NÃO der sinal — e só se o epoch
   *  continua dono da sessão (billing de conversa descartada não envenena
   *  a contabilidade nova). */
export async function pollCodexContextOccupancy(self: any, epoch: number): Promise<void> {
    const billing = self.codexTurnBilling?.epoch === epoch ? self.codexTurnBilling.delta : null;
    self.codexTurnBilling = null;
    for (let i = 0; i < 6; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 200));
      if (self.stopped) return;
      // Sessão resetada durante o poll: o rollout é da conversa descartada.
      if (!self.messageSession.owns(epoch)) return;
      const sessionId = self.messageSession.sessionId;
      if (!sessionId) break; // sem thread não há rollout → fallback billing
      const sig = self.readCodexRolloutSignals(sessionId);
      if (!sig) continue;
      // Janela REAL do codex (ex. 258.400) vira catálogo: vence o mapa
      // estático (272k) no resolveContextLimit — resolve o defeito 2 da T-245.
      if (sig.window && sig.window > 0) self.contextTracker.setCatalogLimit(sig.window);
      // Ocupação ABSOLUTA do último step (não delta de billing) — defeito 1.
      self.reportContextOccupancy(sig.used);
      return;
    }
    // Fallback: rollout indisponível → comportamento anterior (billing+mapa).
    if (billing && !self.stopped && self.messageSession.owns(epoch)) {
      self.checkContextUsage(billing, "inclusive");
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
