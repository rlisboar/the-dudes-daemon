/* R7 (T-462): turno extraído do agent-runner — `self` é o AgentRunner. */
import {AgentUsage, ImageAttachment} from "../../types.js";
import {ChildProcess} from "node:child_process";
import {PER_MSG_TURN_TIMEOUT_MS} from "../../agent-runner.js";
import {RUNNER_OUTPUT_CAP_BYTES, armHardTimeout, collectProcessOutput} from "../process-lifecycle.js";
import {appendPathAttachmentPrompt} from "../attachments.js";
import {buildBridgeAwareEnv} from "../env.js";
import {buildCrushMcpConfig} from "../mcp-config.js";
import {isMissingSessionFailure as isMissingSessionMessage} from "../error-classifier.js";
import {parseCrushSessionMeta} from "../turn-parsers.js";
import {spawnDropped} from "../../privileges.js";
import {writeFileSync} from "node:fs";

import path from "node:path";
export function writeCrushConfig(self: any) {
    const configPath = path.join(self.opts.workspaceRoot, ".crush.json");
    // Bridge the-dudes: os valores POR AGENTE (id/name/token-file) via $VAR —
    // o token file path não é secreto (o conteúdo é, mode 0600) e o env do
    // processo crush já carrega tudo (buildEnv + crushTurnEnv).
    const built = buildCrushMcpConfig(self.mcpServersForSpawn(), {
      command: self.opts.bridgeCommand,
      args: self.opts.bridgeArgs,
      env: {
        THE_DUDES_AGENT_ID: "$THE_DUDES_AGENT_ID",
        THE_DUDES_AGENT_NAME: "$THE_DUDES_AGENT_NAME",
        THE_DUDES_ORCH_URL: "$THE_DUDES_ORCH_URL",
        THE_DUDES_AGENT_TOKEN_FILE: "$THE_DUDES_AGENT_TOKEN_FILE",
        ...(self.opts.bridgeSocketPath ? { THE_DUDES_BRIDGE_SOCKET: "$THE_DUDES_BRIDGE_SOCKET" } : {}),
        ...Object.fromEntries(Object.keys(self.featuresEnv()).map((k) => [k, `$${k}`])),
      },
    });
    for (const warning of built.warnings) self.opts.log("warn", `[crush:${self.info.name}] ${warning}`);
    // T-426: valores de env/headers dos extras NÃO vão pro arquivo (que vive
    // no workspace e é stagediável) — só a referência `$VAR`; o literal entra
    // no env do processo crush (crushTurnEnv).
    self.crushMcpEnvRefs = built.envRefs;
    try {
      writeFileSync(configPath, JSON.stringify(built.config, null, 2), { mode: 0o600 });
    } catch (e) {
      self.opts.log("warn", `[crush:${self.info.name}] failed to write .crush.json: ${(e as Error).message}`);
    }
  }
  /** Env por turno do crush: buildEnv + os valores que o `.crush.json`
   *  compartilhado referencia por `$VAR` (token file é por agente). */
export function crushTurnEnv(self: any, ): NodeJS.ProcessEnv {
    return {
      ...buildBridgeAwareEnv(self.buildEnv(), self.runtimeFiles.tokenFile(), self.featuresEnv()),
      ...self.crushMcpEnvRefs,
    };
  }
  /** Roda um subcomando `crush session ...` e devolve o JSON parseado (null em
   *  erro/timeout). Usado pra capturar o uuid da sessão criada pelo run e o
   *  meta cumulativo de tokens (o `crush run` não emite nada disso no stdout). */
export function crushSessionJson(self: any, argv: string[]): Promise<any> {
    return new Promise((resolve) => {
      if (!self.opts.cliCommands.crush.available) { resolve(null); return; }
      let proc: ChildProcess;
      try {
        proc = spawnDropped(self.runnerCommand("crush"), [...argv, "--json", "--data-dir", self.runtimeFiles.crushDataDir()], {
          cwd: self.opts.workspaceRoot,
          env: self.buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, self.opts.dropTo ?? null);
      } catch { resolve(null); return; }
      void collectProcessOutput(proc, {
        timeoutMs: 15_000,
        onTruncated: () => self.opts.log("warn", `[crush:${self.info.name}] session json exceeded ${RUNNER_OUTPUT_CAP_BYTES} bytes — truncated`),
      }).then((result) => {
        if (result.timedOut) { resolve(null); return; }
        try { resolve(JSON.parse(result.stdout.trim())); } catch { resolve(null); }
      });
    });
  }
export async function runCrushMessage(self: any, content: string, images?: ImageAttachment[]) {
    const timing = self.turnLatency?.current;
    if (self.stopped) { self.messageSession.busy = false; return; }
    if (!self.ensureRunnerAvailable("crush")) { self.messageSession.busy = false; return; }
    // T-251: gate de turno para todos os runners (antes só Grok).
    if (!(await self.gateTurn())) { self.messageSession.busy = false; return; }
    self.setState("thinking");
    self.writeCrushConfig();
    let message = content;
    const firstTurnSnapshot = self.messageSession.consumeFirstTurnIfNeeded();
    const firstTurn = firstTurnSnapshot.firstTurn;
    // Preservados pra restaurar se o turno morrer sem output (mesma lógica do
    // gemini): perder o firstTurn num turno falho descartaria system prompt e
    // resumo pendente pra sempre.
    const pendingSummary = firstTurnSnapshot.pendingSummary;
    const epoch = self.messageSession.epoch;
    if (firstTurn) {
      message = self.initialMessage(content, pendingSummary);
    }
    // Anexos: crush run não tem flag de attachment — grava temp e referencia
    // por path no prompt (a tool `view` do crush lê o arquivo do disco).
    let imgCleanup = () => {};
    if (images && images.length) {
      const { files, cleanup } = self.writeAttachmentFiles(images);
      imgCleanup = cleanup;
      message = appendPathAttachmentPrompt(message, files, "crush");
    }
    self.traceCli("crush", "argv", message);
    // Sessão RESUMIDA (daemon restart): prime da base de billing ANTES do
    // turno — o meta é cumulativo e a base zero re-faturaria o histórico.
    if (self.messageSession.sessionId && self.crushUsage.current() === null) {
      const meta = await self.crushSessionJson(["session", "show", self.messageSession.sessionId]);
      const parsed = parseCrushSessionMeta(meta);
      self.crushUsage.prime({
        prompt: parsed.prompt,
        completion: parsed.completion,
      });
      if (self.stopped) { self.messageSession.busy = false; return; }
    }
    self.crushUsage.prime({ prompt: 0, completion: 0 });
    const args = ["run", "--quiet", "--data-dir", self.runtimeFiles.crushDataDir()];
    if (self.info.model) args.push("-m", self.info.model);
    // Resume por UUID (campo `uuid` do session list — o `id` curto NÃO
    // funciona no --session do run, testado na v0.82.0).
    if (self.messageSession.sessionId) args.push("--session", self.messageSession.sessionId);
    args.push(message);
    self.traceSpawn("crush", args);
    let proc: ChildProcess;
    try {
      proc = spawnDropped(self.runnerCommand("crush"), args, {
        cwd: self.opts.workspaceRoot,
        env: self.crushTurnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, self.opts.dropTo ?? null);
    } catch (e) {
      self.failTurnSpawn("crush", e, epoch, imgCleanup, firstTurnSnapshot);
      return;
    }
    timing?.bootStart();
    self.ocActiveProc = proc;
    armHardTimeout(proc, PER_MSG_TURN_TIMEOUT_MS, () => {
      timing?.finish("hard-recover", "hard-timeout", "lifetime");
      self.opts.log("warn", `[crush:${self.info.name}] turno excedeu ${PER_MSG_TURN_TIMEOUT_MS / 1000}s — SIGKILL`);
    });
    let out = "";
    let errOut = "";
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      if (self.messageSession.owns(epoch) && chunk.trim()) timing?.semantic("text");
      self.ingestCrushChunk(chunk);
      self.traceCli("crush", "stdout", chunk);
      out = self.capAccum("crush", out, chunk);
    });
    proc.stderr!.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (!msg) return;
      self.traceCli("crush", "stderr", msg);
      errOut = self.capAccum("crush", errOut, chunk);
      self.checkContextFullError(msg);
    });
    proc.on("close", (code) => {
      imgCleanup();
      // T-417: mesmo guarda do bloco qwen (T-371) — close TARDIO de turno já
      // recuperado não liberta o slot nem apaga o proc do turno NOVO. O busy é
      // do finishCrushTurn (finally já é epoch-guardado). Sem o epoch atual
      // não há slot nosso para libertar (hard recover devolve o dele antes do
      // bump; clear/compact devolvem no resetWithSummary).
      if (self.messageSession.owns(epoch) || self.stopped) {
        self.releaseActiveTurnSlot(); // T-251: slot volta com o processo (o pós-turno não spawnada CLI)
        self.ocActiveProc = null;
      }
      if (self.stopped) { self.messageSession.busy = false; self.emitExit(code); return; }
      timing?.finish(code === 0 ? "completed" : "process-exit");
      void self.finishCrushTurn({ out, errOut, code, epoch, firstTurn, pendingSummary, content, images });
    });
  }
  /** Pós-turno do crush: emite o texto, captura o uuid da sessão nova, fatura
   *  o delta de tokens e trata falha de resume (sessão sumida do crush.db).
   *  Só libera a fila (busy) DEPOIS da captura de sessão — um segundo turno
   *  spawnado antes criaria OUTRA sessão e a conversa se partiria em duas. */
export async function finishCrushTurn(self: any, t: {
    out: string; errOut: string; code: number | null; epoch: number;
    firstTurn: boolean; pendingSummary: string | undefined;
    content: string; images?: ImageAttachment[];
  }): Promise<void> {
    try {
      // Epoch trocado (clear/compact no meio do turno): nada deste turno pode
      // falar/faturar/ressuscitar sessão pós-reset.
      if (!self.messageSession.owns(t.epoch)) return;
      self.clearGrokToolsInFlight();
      const text = t.out.trim();
      const failed = (t.code ?? 1) !== 0 && !text;
      // Resume apontando pra sessão que sumiu do crush.db (reboot limpou o
      // data dir, delete manual): "session not found". Larga o id e re-tenta
      // o turno UMA vez como sessão nova (a mensagem não pode se perder).
      if (failed && self.messageSession.sessionId && isMissingSessionMessage(t.errOut)) {
        self.opts.onError(`[crush] sessão ${self.messageSession.sessionId} não existe mais — recomeçando sessão nova`);
        self.messageSession.resetForRetry(t.pendingSummary);
        self.crushUsage.reset({ prompt: 0, completion: 0 });
        self.info.sessionId = undefined;
        if (self.opts.onSessionId) self.opts.onSessionId("");
        self.messageSession.prepend({ content: t.content, images: t.images });
        return; // finally libera busy e drena — o retry roda como turno novo
      }
      if (failed) {
        // Primeiro turno que morreu sem output (key inválida, modelo errado,
        // provider fora): restaurar firstTurn/summary pro retry não perder o
        // system prompt (mesma proteção do gemini).
        self.messageSession.restoreFirstTurn(t);
        const err = t.errOut.trim() || `crush exit ${t.code ?? "?"} sem output`;
        self.checkContextFullError(err);
        self.opts.onError(`crush: ${err.slice(0, 500)}`);
        return;
      }
      if (text) {
        self.setState("speaking");
        self.opts.onAssistantText(text);
      }
      if (t.errOut.trim()) self.opts.onError(t.errOut.trim().slice(0, 500));
      // Captura da sessão criada pelo run (o stdout não traz o id): com o
      // data dir POR AGENTE, a mais recente é necessariamente a deste turno.
      if (!self.messageSession.sessionId) {
        const last = await self.crushSessionJson(["session", "last"]);
        // `session last --json` retorna {meta:{uuid,...},messages:[...]} —
        // o uuid mora em .meta (o shape raiz {uuid} é só do `session list`).
        const uuid = parseCrushSessionMeta(last).sessionId;
        if (!self.messageSession.owns(t.epoch)) return; // reset durante a captura
        if (uuid) {
          self.messageSession.sessionId = uuid;
          if (self.opts.onSessionId) self.opts.onSessionId(uuid);
        } else {
          self.opts.log("warn", `[crush:${self.info.name}] não consegui capturar o uuid da sessão — próximo turno cria sessão nova`);
        }
      }
      // Billing: meta cumulativo → delta contra a base. Ocupação de janela NÃO
      // é derivável daqui (turno com N tool-calls soma N prompts) — contexto
      // cheio do crush é detectado pela rota reativa (checkContextFullError no
      // stderr), igual ao gemini.
      if (self.messageSession.sessionId) {
        const show = await self.crushSessionJson(["session", "show", self.messageSession.sessionId]);
        if (!self.messageSession.owns(t.epoch)) return;
        const parsed = parseCrushSessionMeta(show);
        const prompt = parsed.prompt;
        const completion = parsed.completion;
        if (prompt > 0 || completion > 0) {
          const cumulative = self.crushUsage.delta({ prompt, completion });
          const delta: AgentUsage = {
            input: cumulative.prompt,
            output: cumulative.completion,
            cacheCreate: 0,
            cacheRead: 0,
          };
          if (delta.input > 0 || delta.output > 0) self.opts.onUsageDelta?.(delta);
        }
      }
    } finally {
      // Mesmo invariante do finishGrokTurn: não zerar busy se epoch stale.
      if (self.messageSession.owns(t.epoch)) {
        self.messageSession.busy = false;
        if (!self.stopped) {
          self.setState("idle");
          self.drainOcQueue();
        }
      }
    }
  }
  /** Anexo já gravado em disco: `inline` marca o que o modelo também aceita
   *  no payload (imagem raster) — o resto só existe como arquivo. */
  /** Grava anexos (base64) em arquivos temp no tmpdir do agente — pros runners
   *  per-message que recebem por caminho (codex `-i`, gemini `@path`) e pro
   *  não-imagem do claude/opencode, que mandam imagem inline mas não arquivo. */
export function ingestCrushChunk(self: any, _chunk: string): void {
    self.touchActivity();
    if (self.toolsInFlight === 0) self.noteGrokToolInFlight();
  }
  /* ---------- Gemini per-message model ---------- */
  /** T-416: uma linha JSON parseada — touchActivity mesmo se setState for no-op. */