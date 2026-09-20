/* R7 (T-462): turno extraído do agent-runner — `self` é o AgentRunner. */
import {AgentUsage, ImageAttachment} from "../../types.js";
import {ChildProcess} from "node:child_process";
import {TextLoopGuard, parseQwenTurnEvent} from "../turn-parsers.js";
import {appendPathAttachmentPrompt} from "../attachments.js";
import {armHardTimeout, killProcess} from "../process-lifecycle.js";
import {buildQwenEnv} from "../env.js";
import {isMissingSessionFailure as isMissingSessionMessage} from "../error-classifier.js";
import {markTurnStart, QWEN_HARD_TIMEOUT_MS} from "../turn-watchdog.js";
import {randomUUID} from "node:crypto";
import {spawnDropped} from "../../privileges.js";


export async function runQwenMessage(self: any, content: string, images?: ImageAttachment[]) {
    const timing = self.turnLatency?.current;
    if (self.stopped) return;
    if (!self.ensureRunnerAvailable("qwen")) return;
    // T-251: gate de turno para todos os runners per-message.
    if (!(await self.gateTurn())) { self.messageSession.busy = false; return; }
    self.setState("thinking");
    self.writeQwenConfig();
    // T-371 (b): o hard recover só re-enfileira se houver inflight registrado
    // (mecanismo herdado do caminho grok, :2898). O turno qwen nunca o
    // populava ⇒ null ⇒ zero prepend ⇒ mensagem perdida. (d) / T-749: a
    // janela de lifetime mede ociosidade semântica desde o último evento
    // (renova a cada touchActivityClock); só o cap absoluto conta do início
    // deste turno e não se renova.
    const prevAttempt =
      self.inflightPerMessage?.content === content
        ? self.inflightPerMessage.attempt
        : 0;
    self.inflightPerMessage = { content, images, attempt: prevAttempt };
    markTurnStart(self.activityClock);
    // T-371 (c): janela anti-repetição sobre os deltas de texto do turno.
    const loopGuard = new TextLoopGuard();
    let message = content;
    const firstTurnSnapshot = self.messageSession.consumeFirstTurnIfNeeded();
    const firstTurn = firstTurnSnapshot.firstTurn;
    const epoch = self.messageSession.epoch;
    if (firstTurn) message = self.initialMessage(content, firstTurnSnapshot.pendingSummary);
    // Anexos: qwen (herança Gemini CLI) lê arquivos referenciados por @<path>.
    let imgCleanup = () => {};
    if (images && images.length) {
      const { files, cleanup } = self.writeAttachmentFiles(images);
      imgCleanup = cleanup;
      message = appendPathAttachmentPrompt(message, files, "qwen");
    }
    self.traceCli("qwen", "argv", message);
    // Sessão: uuid NOSSO. Primeira vez gera e registra (persistimos só quando
    // o turno completa — ver close); seguintes retomam com -r. Se o primeiro
    // turno morrer antes do evento result, a sessão pode não ter sido gravada:
    // restoreFirstTurn + sessionId=undefined (turno falho = como se não tivesse
    // acontecido, mesmo contrato do gemini/codex).
    let createdSessionId: string | undefined;
    if (!self.messageSession.sessionId) {
      createdSessionId = randomUUID();
      self.messageSession.sessionId = createdSessionId;
      self.opts.onSessionId?.(createdSessionId);
    }
    const resumeSessionId = createdSessionId ? undefined : self.messageSession.sessionId;
    const allowedMcp = ["the-dudes", ...Object.keys(self.opts.extraMcpServers ?? {})]
      .filter((n, i, a) => a.indexOf(n) === i)
      .join(",");
    const args = [
      "--output-format", "stream-json",
      "--include-directories", self.opts.workspaceRoot,
      "--allowed-mcp-server-names", allowedMcp,
      "-y",
    ];
    if (self.info.model) args.push("--model", self.info.model);
    if (createdSessionId) args.push("--session-id", createdSessionId);
    else if (resumeSessionId) args.push("-r", resumeSessionId);
    const env = buildQwenEnv(self.buildEnv());
    self.traceSpawn("qwen", args);
    // Prompt via STDIN (não `-p`): a flag é deprecated e o parser do yargs
    // parte um prompt iniciado por `-` (transcrições/quotes) — medido na
    // 0.23.0. stdin é a via canónica do doc headless.
    // cwd = qwenCwdDir (estável por agente): sessões são project-scoped pelo
    // cwd; com tempDir aleatório o `-r` não acharia a sessão pós-restart.
    let proc: ChildProcess;
    try {
      proc = spawnDropped(self.runnerCommand("qwen"), args, {
      cwd: self.runtimeFiles.qwenCwdDir(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }, self.opts.dropTo ?? null);
    } catch (e) {
      self.failTurnSpawn("qwen", e, epoch, imgCleanup, firstTurnSnapshot);
      return;
    }
    proc.stdin?.on("error", () => { /* EPIPE: o CLI morreu cedo — o close cuida */ });
    proc.stdin?.end(message);
    timing?.bootStart();
    self.ocActiveProc = proc;
    // T-598: backstop do processo ACIMA do teto de lifetime do watchdog — o
    // watchdog corta primeiro, com re-fila + sessão preservada. Se este
    // disparar mesmo assim, passa pelo MESMO recover em vez de um SIGKILL
    // seco (close sem result não re-enfileira e a mensagem em voo se perdia).
    armHardTimeout(proc, QWEN_HARD_TIMEOUT_MS, () => {
      self.opts.log("warn", `[qwen:${self.info.name}] turno excedeu o backstop de ${QWEN_HARD_TIMEOUT_MS / 60_000}min — recover`);
      self.turnLatency?.current?.setLifetimeLimit("cap");
      self.recoverHungTurn(
        `hard timeout ${Math.round(QWEN_HARD_TIMEOUT_MS / 1000)}s`,
        Date.now() - self.activityClock.lastActivityAt,
        "lifetime",
      );
    });
    let buf = "";
    let pendingText = "";
    let sawResult = false;
    let resultError = false;
    let loopAborted = false;
    let errOut = "";
    const flush = () => {
      if (!self.messageSession.owns(epoch)) { pendingText = ""; return; }
      const t = pendingText.trim();
      if (t) {
        self.setState("speaking");
        self.opts.onAssistantText(t);
      }
      pendingText = "";
    };
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      self.traceCli("qwen", "stdout", chunk);
      buf = self.capAccum("qwen", buf, chunk);
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("{")) continue;
        if (!self.messageSession.owns(epoch)) continue;
        try {
          const raw = JSON.parse(line);
          for (const event of parseQwenTurnEvent(raw)) {
            // T-371 (e): TODO evento semântico do stream é uma rodada de API
            // concluída ou progresso real — repõe o clock de ociosidade.
            // O complementar do teto absoluto de lifetime (d): thinking
            // profundo com rodadas de ~85s deixa de ser "stalled" falso.
            if (event.type === "session") timing?.bootReady();
            if (event.type === "text" && event.text) timing?.semantic("text");
            if (event.type === "thought" && event.text) timing?.semantic("thinking");
            if (event.type === "tool") timing?.semantic("tool");
            self.touchActivity();
            if (event.type === "session") {
              // uuid ecoado = o que já registramos; adota se divergir (CLI
              // gerou o dele — só possível se --session-id for rejeitado).
              if (event.sessionId !== self.messageSession.sessionId) {
                self.messageSession.sessionId = event.sessionId;
                self.opts.onSessionId?.(event.sessionId);
              }
            } else if (event.type === "text") {
              pendingText += event.text;
              // T-371 (c): 'ductduct…' morre aos primeiros segundos de loop,
              // não aos 12-15min de watchdog/CLI cap.
              if (!loopAborted && loopGuard.feed(event.text)) {
                loopAborted = true;
                self.opts.log("warn", `[qwen:${self.info.name}] token loop detectado (janela anti-repetição) — SIGKILL`);
                killProcess(proc, "SIGKILL");
              }
            }
            else if (event.type === "thought") {
              self.traceInternalCli("info", `[cli:${self.info.id}:qwen:thinking] block_received len=${event.text.length} collectFlag=${self.info.collectThinking}`);
              if (self.info.collectThinking) self.opts.onThinkingText?.(event.text);
            }
            else if (event.type === "tool") {
              flush();
              self.opts.onToolUse(event.name, event.input);
              self.setState(event.name.includes("send_message") ? "sending" : "thinking");
            } else if (event.type === "result") {
              resultError = raw.is_error === true || String(raw.subtype).startsWith("error");
              sawResult = true;
              flush();
            } else if (event.type === "usage") {
              // usage POR REQUEST (fork do Gemini CLI emula o shape Anthropic):
              // mesmo contrato da rota "anthropic" do Claude — billing via
              // delta com cacheRead e ocupação pela janela do evento.
              const delta: AgentUsage = {
                input: event.input,
                output: event.output,
                cacheCreate: event.cacheCreate,
                cacheRead: event.cacheRead,
              };
              self.opts.onUsageDelta?.(delta);
              self.checkContextUsage(delta, "anthropic");
            }
          }
        } catch {}
      }
    });
    proc.stderr!.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (msg) {
        if (errOut.length < 8_192) errOut += msg + "\n";
        self.traceCli("qwen", "stderr", chunk);
        self.checkContextFullError(msg);
      }
    });
    proc.on("close", (code) => {
      self.releaseActiveTurnSlot(); // T-251
      flush();
      imgCleanup();
      // T-371: close TARDIO de um turno já recuperado (SIGKILL do hard
      // recover) não pode zerar busy/proc do turno NOVO que o drain do
      // recover pôs em voo — o guarda que o caminho grok aprendeu na T-240.
      // Em stop(), o teardown completo é do stop(), não daqui.
      if (self.messageSession.owns(epoch) || self.stopped) {
        self.ocActiveProc = null;
        self.messageSession.busy = false;
      }
      if (self.stopped) { self.emitExit(code); return; }
      // T-371 (c): loop abortado por janela anti-repetição = hard recover
      // completo (sessão neutralizada (a) + mensagem re-enfileirada (b)),
      // não um close qualquer.
      if (loopAborted && self.messageSession.owns(epoch)) {
        self.recoverHungTurn(
          `token loop detectado (janela anti-repetição, turno ${Math.round((Date.now() - self.activityClock.turnStartedAt) / 1000)}s)`,
          Date.now() - self.activityClock.lastActivityAt,
        );
        return;
      }
      timing?.finish(sawResult ? resultError ? "error" : "completed" : code === 0 ? "error" : "process-exit");
      if (sawResult) self.inflightPerMessage = null; // T-371 (b): turno completo
      // Resume apontando pra sessão que sumiu do disco (reboot limpou o
      // QWEN_HOME efêmero antigo, delete manual): "No saved session found".
      // Larga o id e re-tenta o turno UMA vez como sessão nova (mesmo
      // contrato do crush/grok — a mensagem não pode se perder).
      if (!sawResult && resumeSessionId && self.messageSession.owns(epoch) && isMissingSessionMessage(errOut)) {
        self.opts.onError(`[qwen] sessão ${resumeSessionId.slice(0, 8)}… não existe mais — recomeçando sessão nova`);
        self.messageSession.resetForRetry(firstTurnSnapshot.pendingSummary);
        self.info.sessionId = undefined;
        self.opts.onSessionId?.("");
        self.inflightPerMessage = null; // a mensagem acaba de ser re-posta
        self.messageSession.prepend({ content, images });
        self.setState("idle");
        self.drainOcQueue();
        return;
      }
      // Turno fundador que morreu sem result: sessão pode não ter sido gravada
      // — desfaz o registro e restaura firstTurn/summary (mesmo contrato gemini).
      if (!sawResult && self.messageSession.owns(epoch)) {
        if (createdSessionId && self.messageSession.sessionId === createdSessionId) {
          self.messageSession.sessionId = undefined;
          self.opts.onSessionId?.("");
        }
        self.messageSession.restoreFirstTurn(firstTurnSnapshot);
        // stderr só é erro quando o turno não completou (antes era encaminhado
        // ao vivo: warnings tipo o do yolo apareciam como erros na UI).
        if (errOut.trim()) {
          self.checkContextFullError(errOut);
          self.opts.onError(`qwen: ${errOut.trim().slice(0, 500)}`);
        }
      }
      self.setState("idle");
      self.drainOcQueue();
    });
  }
  /* ---------- Codex per-message model ---------- */
  /** T-426 (A15): MCPs do codex vão para `<CODEX_HOME>/config.toml` (0600,
   *  fora do repo) em vez de `-c mcp_servers.x.env={KEY="valor"}` — o valor do
   *  token não aparece mais em `ps`/cmdline. O CODEX_HOME é POR AGENTE
   *  (runtimeFiles.codexHomeDir), com auth/sessions linkados ao home do dono. */