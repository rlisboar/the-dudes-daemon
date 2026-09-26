/**
 * R7 (T-462): turno contínuo do claude extraído do bootstrap — spawn persistente,
 * stdout/handlers de stream. Callers seguem via bootstrap (re-export).
 */
import {type ChildProcessWithoutNullStreams} from "node:child_process";
import {randomUUID} from "node:crypto";

import {spawnDropped} from "../../privileges.js";

import {isMissingSessionFailure as isMissingSessionMessage, classifyRunnerFailure, isApiErrorMessage} from "../error-classifier.js";
import type {AgentUsage} from "../../types.js";

type ClaudePermissionMode = "default" | "bypassPermissions";

/** Change Claude's permission mode over the documented stream-json control channel. */
export function requestClaudePermissionMode(self: any, mode: ClaudePermissionMode): Promise<void> {
  if (!self.proc?.stdin?.writable) return Promise.reject(new Error("Claude stdin is not writable"));
  const requestId = `daemon-${randomUUID()}`;
  const pending = self.claudeControlRequests ??= new Map();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Claude set_permission_mode(${mode}) timed out`));
    }, 5_000);
    pending.set(requestId, {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (error: Error) => { clearTimeout(timer); reject(error); },
    });
    try {
      self.proc.stdin.write(`${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "set_permission_mode", mode },
      })}\n`);
    } catch (error) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function failPendingClaudeControlRequests(self: any, reason: string): void {
  const pending: Map<string, { reject: (error: Error) => void }> | undefined = self.claudeControlRequests;
  if (!pending) return;
  for (const [requestId, request] of pending) {
    pending.delete(requestId);
    request.reject(new Error(reason));
  }
}

export function startClaude(self: any) {
    self.claudeBootStartedAt = performance.now();
    const args = self.buildClaudeArgs();
    const env = self.buildEnv();
    const appendPromptIndex = args.indexOf("--append-system-prompt");
    if (appendPromptIndex >= 0 && typeof args[appendPromptIndex + 1] === "string") {
      self.traceCli("claude", "argv", args[appendPromptIndex + 1]);
    }
    self.traceSpawn("claude", args);
    self.proc = spawnDropped(self.runnerCommand("claude"), args, {
      cwd: self.opts.workspaceRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }, self.opts.dropTo ?? null) as ChildProcessWithoutNullStreams;
    // Fragmento de linha (sem \n) deixado pelo processo anterior SIGKILLado
    // se colaria à primeira linha do novo → JSON.parse falha e o init
    // (resolvedModel + idle) é perdido silenciosamente.
    self.buffer = "";
    self.claudeSawInit = false;
    self.claudePermissionMode = self.opts.autoApprove ? "bypassPermissions" : "default";
    // Identidade capturada: chunks/exit tardios do processo antigo (entregues
    // entre exit e close, ou de um órfão) não podem re-emitir session_id/usage
    // da sessão descartada nem clobberar o processo novo.
    const proc = self.proc;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    // Flush mensagens bufferadas durante restart. Pequeno delay pra
    // Claude inicializar; CLI bufferará stdin entretanto.
    if (self.pendingMessages.length > 0) {
      const pending = self.pendingMessages.splice(0);
      self.opts.log("info", `[cli:${self.info.id}:claude] flushing ${pending.length} buffered message(s) after restart`);
      if (pending.length > 0) self.queueChanged?.();
      setTimeout(() => {
        for (const m of pending) self.pushUserMessage(m.content, m.images, m);
      }, 300);
    }
    proc.stdout.on("data", (chunk: string) => {
      if (self.proc !== proc) return; // chunk tardio de processo substituído
      self.touchActivity();
      self.traceCli("claude", "stdout", chunk);
      self.handleStdout(chunk);
    });
    // M17 (T-440): spawn que FALHA (ENOENT/EACCES) emite 'error' e NÃO 'exit'
    // — sem listener o runner ficava "vivo" pra sempre (UI running, nada roda).
    // emitExit é idempotente; proc=null desarma qualquer exit tardio.
    proc.on("error", (err: any) => {
      if (self.proc !== proc) return;
      failPendingClaudeControlRequests(self, `Claude process error: ${err.message}`);
      self.opts.onError(`[claude] spawn error: ${err.message}`);
      self.proc = null;
      self.emitExit(1);
    });
    proc.stderr.on("data", (chunk: string) => {
      if (self.proc !== proc) return;
      const msg = chunk.trim();
      if (!msg) return;
      self.touchActivity();
      self.traceCli("claude", "stderr", msg);
      if (!self.claudeSawInit && isMissingSessionMessage(msg)) {
        self.sessionInvalid = true;
        self.opts.resumeSessionId = undefined;
        self.info.sessionId = undefined;
        self.opts.onSessionId?.("");
        self.opts.onSessionInvalid?.();
        return;
      }
      self.checkContextFullError(msg);
      self.opts.onError(msg);
    });
    proc.on("exit", (code: any) => {
      // Exit de um órfão já substituído (kill pulado numa corrida de restart):
      // sem o guard, ele anularia self.proc do processo NOVO e chamaria
      // emitExit — agente marcado como morto com o processo vivo.
      if (self.proc !== proc) return;
      failPendingClaudeControlRequests(self, "Claude process exited during permission mode change");
      if (self.sessionInvalid) {
        self.sessionInvalid = false;
        self.opts.resumeSessionId = undefined;
        if (!self.stopped) {
          self.proc = null;
          // sessão nova e vazia — contadores da antiga não podem sobrar
          self.resetContextAccounting();
          self.startClaude();
          return;
        }
      }
      if (self.restarting) {
        // caller manages restart manually; just clear proc and don't notify project
        self.proc = null;
        return;
      }
      self.emitExit(code);
    });
  }

export function handleStdout(self: any, chunk: string) {
    self.buffer = self.capAccum("claude", self.buffer, chunk);
    let idx: number;
    while ((idx = self.buffer.indexOf("\n")) >= 0) {
      const line = self.buffer.slice(0, idx).trim();
      self.buffer = self.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        self.handleStreamEvent(event);
      } catch {
        // ignore malformed
      }
    }
  }

export function handleStreamEvent(self: any, event: any) {
    // Qualquer evento de stream = atividade real (deltas, tools, etc.).
    self.touchActivity();
    if (event.type === "control_response") {
      const response = event.response;
      const requestId = response?.request_id;
      const pending = typeof requestId === "string" ? self.claudeControlRequests?.get(requestId) : undefined;
      if (pending) {
        self.claudeControlRequests.delete(requestId);
        if (response.subtype === "error") pending.reject(new Error(String(response.error ?? "Claude rejected permission mode change")));
        else if (response.subtype === "success") pending.resolve();
        else pending.reject(new Error("Claude returned an invalid permission mode response"));
      }
      return;
    }
    // claude emits session_id on every stream event. Only forward to
    // the orchestrator when it actually changes — otherwise we'd flood
    // listeners with redundant agent:session messages (one per chunk).
    if (typeof event.session_id === "string" && self.opts.onSessionId && event.session_id !== self.info.sessionId) {
      self.info.sessionId = event.session_id;
      self.opts.onSessionId(event.session_id);
    }
    if (event.type === "system" && event.subtype === "init") {
      // T-755: o claude contínuo emite um init POR mensagem consumida do stdin
      // (medido no transcript/probe). O timing mais antigo (FIFO) é o dono
      // deste marco: write→init = espera na fila do CLI, que o firstEventMs
      // sozinho confundia com demora do modelo.
      self.claudeTimings?.[0]?.accept();
      // T-758: aceite observado — desarma o watchdog de stdin parado.
      self.claudeUnacceptedSince = null;
      self.claudeUnacceptedWarned = false;
      if (!self.claudeSawInit) self.claudeTimings?.[0]?.setBootMs(performance.now() - self.claudeBootStartedAt);
      self.claudeSawInit = true;
      // CLI reporta o model realmente resolvido (alias→ID, default da conta).
      if (typeof event.model === "string" && event.model) self.contextTracker.setResolvedModel(event.model);
      self.toolsInFlight = 0;
      self.toolsInFlightSince = null;
      self.setState("idle");
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
        self.opts.onUsageDelta?.(delta);
        // Sidechains (subagentes Task) reportam o contexto do SUBAGENTE:
        // contam pro billing (onUsageDelta acima), mas não podem sobrescrever
        // a ocupação do thread principal — mascarariam um contexto a 95%.
        if (!event.parent_tool_use_id) self.checkContextUsage(delta, "anthropic");
      }
      const textParts: string[] = [];
      let hasToolUse = false;
      for (const b of blocks) {
        if (b.type === "text" && b.text) textParts.push(b.text);
        if (b.type === "thinking") {
          const t = typeof b.thinking === "string" ? b.thinking.trim() : "";
          self.traceInternalCli("info", `[cli:${self.info.id}:claude:thinking] block_received len=${t.length} collectFlag=${self.info.collectThinking}`);
          if (t) self.claudeTimings?.[0]?.semantic("thinking");
          if (self.info.collectThinking && t) self.opts.onThinkingText?.(t);
        }
        if (b.type === "redacted_thinking") {
          self.claudeTimings?.[0]?.semantic("thinking");
          self.traceInternalCli("info", `[cli:${self.info.id}:claude:thinking] redacted_block_received collectFlag=${self.info.collectThinking}`);
          if (self.info.collectThinking) {
            self.opts.onThinkingText?.("[raciocínio omitido pelo modelo]", { redacted: true });
          }
        }
        if (b.type === "tool_use") {
          self.claudeTimings?.[0]?.semantic("tool");
          hasToolUse = true;
          if (self.toolsInFlight === 0) self.toolsInFlightSince = Date.now();
          self.toolsInFlight++;
          self.opts.onToolUse(b.name, b.input);
          if (b.name?.includes("send_message")) self.setState("sending");
          else self.setState("thinking");
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
              self.setState("idle");
              self.opts.onError(text);
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
              self.setState("idle");
              self.opts.onError(text);
              self.notifyContextFull();
              return;
            }
          }
          self.claudeTimings?.[0]?.semantic("text");
          self.setState("speaking");
          self.opts.onAssistantText(text);
        }
      }
      if (!hasToolUse && !textParts.length) self.setState("thinking");
      return;
    }
    if (event.type === "user") {
      // tool_result volta como content blocks do user — fecha tools em voo.
      const blocks = event.message?.content ?? event.content ?? [];
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b?.type === "tool_result") {
            self.toolsInFlight = Math.max(0, self.toolsInFlight - 1);
            if (self.toolsInFlight === 0) self.toolsInFlightSince = null;
          }
        }
      }
      self.setState("thinking");
      return;
    }
    if (event.type === "result") {
      // T-760: result durante o kill do restart por não-aceitação = a mensagem
      // antiga foi respondida (o timing dela já foi finalizado) → sem re-envio.
      if (self.claudeUnacceptedRestartPending && (self.claudeTimings?.length ?? 0) === 0) {
        self.claudeUnacceptedReplied = true;
      }
      // T-758: turno fechou — libera a fila serializada do stdin.
      self.claudeInflight = null;
      self.claudeTimings?.shift()?.finish(event.is_error || String(event.subtype).startsWith("error") ? "error" : "completed");
      self.toolsInFlight = 0;
      self.toolsInFlightSince = null;
      self.setState("idle");
      // Resultado de erro (ex rate limit) que não veio como texto do assistant:
      // surfacia como erro p/ auto-retry. result/error pode estar em vários campos.
      if (event.is_error || event.subtype === "error_during_execution" || event.subtype === "error_max_turns") {
        const r = String(event.result ?? event.error ?? event.message ?? "");
        if (r) {
          if (classifyRunnerFailure(r) === "rate_limit") self.opts.onError(r);
          self.checkContextFullError(r);
        }
      }
      self.drainClaudeWriteQueue?.();
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
