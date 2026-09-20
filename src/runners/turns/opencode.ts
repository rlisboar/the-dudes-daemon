/* R7 (T-462): turno extraído do agent-runner — `self` é o AgentRunner. */
import {AgentRunner, OPENCODE_TURN_TIMEOUT_MS} from "../../agent-runner.js";
import {AgentUsage, ImageAttachment} from "../../types.js";
import {OPENCODE_MANAGED_AGENT} from "../opencode-effort.js";
import {UsageSemantics} from "../context-tracker.js";
import {buildOpenCodeParts} from "../attachments.js";
import {parseOpenCodeTurnEvent} from "../turn-parsers.js";
import {providerModelParts} from "../model-policy.js";
import {resolveOcCatalogContextLimit} from "../../model-discovery.js";


export function ensureOcServer(self: any, ): Promise<void> {
    return self.openCodeTransport.ensureServer();
  }
  /** Janela de contexto do catálogo do opencode serve (/config/providers +
   *  /config): coleta automática — é a janela que o próprio CLI aplica,
   *  cobre qualquer provider/modelo (inclusive novos e display names sem
   *  prefixo provider/) sem depender do mapa estático, que envelhece. Uma
   *  busca por vida do runner (o model do agente não muda). */
export async function fetchOcCatalogLimit(self: any, ): Promise<void> {
    if (self.contextTracker.catalogLimitValue() !== undefined) return Promise.resolve();
    if (self.ocCatalogLimitFetch) return self.ocCatalogLimitFetch;
    self.ocCatalogLimitFetch = (async () => {
      try {
        const cfg = await self.ocServeFetch("/config/providers", "GET");
        // T-137: modelo SEM prefixo `provider/` (ex.: display name colado da
        // UI) roda o default do serve — em vez de abortar, resolve a janela
        // pelos catálogos do próprio CLI: (a) provider/modelo explícito,
        // (b) match por display name, (c) default do serve (/config.model).
        let config: unknown;
        try { config = await self.ocServeFetch("/config", "GET"); } catch { /* best-effort */ }
        const resolvido = resolveOcCatalogContextLimit({
          configuredModel: self.info.model,
          config,
          providers: cfg,
        });
        if (resolvido) {
          self.contextTracker.setCatalogLimit(resolvido.limit);
          self.opts.log("info", `[opencode:${self.info.name}] janela do catálogo: ${self.contextTracker.catalogLimitValue()} (via ${resolvido.via}: ${self.info.model})`);
          // UI: re-emite a ocupação com o denominador certo já — sem isto,
          // a barra só corrigiria o teto no próximo turno. NUNCA re-emitir
          // 0 (pós-restart sem ocupação apagaria a barra que o server
          // ainda tem — mesmo invariante do finishGrokTurn).
          if (self.contextTracker.lastUsed() > 0) {
            self.opts.onContextUsage?.(self.contextTracker.lastUsed(), self.contextLimit());
          }
          return;
        }
      } catch { /* best-effort — mapa estático cobre o fallback */ }
      finally { self.ocCatalogLimitFetch = undefined; }
    })();
    return self.ocCatalogLimitFetch;
  }
  /** Semântica do usage do opencode segue o PROVIDER, não a forma do delta:
   *  Anthropic reporta `input` EXCLUINDO cache (total = soma das parcelas);
   *  os demais (deepseek/zai/openai/google) incluem o cache lido no input.
   *  A heurística "auto" fica só pro provider desconhecido — ela subconta
   *  turnos Anthropic em que o input não-cacheado excede as parcelas de
   *  cache (tool result gigante ainda não cacheado). */
export function ocUsageSemantics(self: any, ): UsageSemantics {
    const { providerID } = providerModelParts(self.info.model);
    return providerID.startsWith("anthropic") ? "anthropic" : "auto";
  }
/** T-750: erro do runner visível no LOG local além do chat (padrão T-743 do
 *  dsh): o endReason=error da instrumentação não carrega texto, e o onError
 *  sozinho não escreve no daemon.log — sem isto o turno morre mudo no log. */
export function ocReportError(self: any, message: string): void {
    self.opts.log("warn", `[cli:${self.info.id}:opencode] ${message}`);
    self.opts.onError(message);
  }

/** T-750: distingue o timeout do NOSSO POST (cliente) de erro do provider e
 *  devolve texto útil — o run pode seguir no serve após o abort do POST. */
export function ocTurnFailureReason(errorMessage: string): { timedOut: boolean; detail: string } {
    const m = /^timeout (\d+)ms/.exec(errorMessage);
    if (!m) return { timedOut: false, detail: errorMessage };
    const min = Math.round(Number(m[1]) / 60_000);
    return { timedOut: true, detail: `teto de ${min}min do POST excedido (run pode seguir no serve) — ${errorMessage}` };
  }

export async function runOpenCodeMessage(self: any, content: string, images?: ImageAttachment[], retry = 0) {
    const timing = self.turnLatency?.current;
    if (self.stopped) return;
    if (!self.ensureRunnerAvailable("opencode")) return;
    // T-251: gate de turno também para o opencode — o processo serve é
    // persistente, mas o POST /message SÍNCRONO é o turno (tools, minutes).
    // Sem isto o gate ficava vazio com turno opencode vivo e o self-update
    // (idle = gate vazio, T-088) matava o serve no meio.
    if (!(await self.gateTurn())) { self.messageSession.busy = false; return; }
    self.setState("thinking");
    timing?.bootStart();
    self.ensureOcServer().then(
      () => { timing?.bootReady(); return void self.runOpenCodeMessageAttached(content, images, retry)
        .catch((e: any) => { timing?.finish("error"); self.opts.log("warn", `[cli:${self.info.id}:opencode] attached threw: ${(e as Error).message}`); })
        .finally(() => { timing?.finish("completed"); self.releaseActiveTurnSlot(); }); },
      (err: any) => {
        timing?.finish("spawn-error");
        self.releaseActiveTurnSlot();
        ocReportError(self, `opencode serve falhou: ${err?.message ?? err}`);
        self.messageSession.busy = false;
        self.setState("idle");
        self.drainOcQueue();
      }
    );
  }
  /** Máx. de retries por mensagem quando a run volta SEM output produtivo
   *  (sintoma de ECONNRESET do provider: o modelo começa o stream e a
   *  conexão TLS cai no meio → opencode sai sem emitir text/step_finish).
   *  1 retry cobre o flap intermitente (ex.: Z.AI) sem loop infinito. */
export async function runOpenCodeMessageAttached(self: any, content: string, images?: ImageAttachment[], retry = 0) {
    const timing = self.turnLatency?.current;
    // Descarte silencioso: sem este log não dá pra distinguir "mensagem nunca
    // chegou" de "chegou e morreu aqui" — que é o sintoma de ficar mudo.
    if (self.stopped || !self.openCodeTransport.ready()) {
      self.opts.log(
        "warn",
        `[cli:${self.info.id}:opencode] mensagem DESCARTADA — stopped=${self.stopped} transportReady=${self.openCodeTransport.ready()}`,
      );
      return;
    }
    // Coleta a janela real do catálogo em paralelo ao turno (idempotente).
    void self.fetchOcCatalogLimit();
    self.ocRunSawOutput = false;
    // provider/modelID + reasoning effort (sufixo ":high"/":max" ou effort do agente).
    const { providerID, modelID } = providerModelParts(self.info.model);
    // Garante sessão no serve (POST /session). Reusa sessionId se já existe.
    if (!self.messageSession.sessionId) {
      try {
        const sess = await self.ocServeFetch("/session", "POST", {
          ...(providerID && modelID ? { model: { id: modelID, providerID }, agent: OPENCODE_MANAGED_AGENT } : {}),
        });
        if (!sess?.id) throw new Error("sessão sem id");
        self.messageSession.sessionId = sess.id;
        if (self.opts.onSessionId) self.opts.onSessionId(sess.id);
      } catch (e) {
        timing?.finish("error");
        ocReportError(self, `opencode: falha criando sessão no serve: ${(e as Error).message}`);
        self.messageSession.busy = false; self.setState("idle"); self.drainOcQueue(); return;
      }
    }
    // Sessão deste turno: clear no meio do POST síncrono troca sessionId —
    // o resultado do turno antigo tem que ser descartado quando resolver
    // (texto velho "falando" pós-clear + usage da sessão cheia envenenando a
    // contabilidade recém-zerada).
    const turnSession = self.messageSession.sessionId;
    const turnEpoch = self.messageSession.epoch;
    // Resume: marca o histórico da sessão como já visto antes do 1º turno —
    // senão a drain por GET reemitiria tool calls/textos antigos nos RUNS.
    if (self.messageSession.needsPrime) {
      self.messageSession.needsPrime = false;
      try {
        const hist = await self.ocServeFetch(`/session/${self.messageSession.sessionId}/message`, "GET");
        if (Array.isArray(hist)) for (const m of hist) for (const p of (m?.parts ?? [])) { if (p?.id) self.ocSeenPartIds.add(p.id); }
      } catch { /* best-effort */ }
    }
    let message = content;
    const firstTurnSnapshot = self.messageSession.consumeFirstTurnIfNeeded();
    if (firstTurnSnapshot.firstTurn) {
      message = self.initialMessage(content, firstTurnSnapshot.pendingSummary);
    }
    self.traceCli("opencode", "stdin", message);
    // Transporte via API do serve (POST síncrono /session/:id/message) em vez
    // de `opencode run` — cujo stdout NÃO serializa o `text` de reasoning
    // models (ex: deepseek-v4-pro) → agente mudo. O serve retorna a message
    // completa {info, parts:[step-start, reasoning, text, tool, step-finish]}.
    // Imagens viram FilePartInput com data-URL (opencode aceita inline; sem temp).
    const anexosOc = self.attachNonImageFiles(message, images);
    const parts = buildOpenCodeParts(anexosOc.content, images);
    self.scheduleAttachmentCleanup(anexosOc.cleanup);
    let resp: any;
    try {
      resp = await self.ocServeFetch(
        `/session/${self.messageSession.sessionId}/message`,
        "POST",
        { ...(providerID && modelID ? { model: { providerID, modelID }, agent: OPENCODE_MANAGED_AGENT } : {}), parts },
        OPENCODE_TURN_TIMEOUT_MS,
      );
    } catch (e) {
      if (self.stopped) { self.messageSession.busy = false; return; }
      // Clear trocou a sessão durante o POST: este turno NÃO é mais dono de
      // busy/estado — o clear já zerou a flag e um turno NOVO pode tê-la
      // re-armado. Zerar/drenar aqui clobberaria o dono (waitOcIdle veria
      // falso-idle e o compact rodaria em paralelo com o turno novo).
      if (!self.messageSession.owns(turnEpoch, turnSession)) return;
      self.messageSession.busy = false;
      timing?.finish("error");
      const emsg = (e as Error).message;
      // T-750: timeout do POST ganha texto próprio (run pode seguir no serve).
      const fail = ocTurnFailureReason(emsg);
      if (fail.timedOut) self.traceCli("opencode", "stderr", `[turn-timeout] ${fail.detail}`);
      if (retry < AgentRunner.OC_EMPTY_RETRIES) {
        ocReportError(self, `opencode: turno falhou (${fail.detail}) — retry ${retry + 1}/${AgentRunner.OC_EMPTY_RETRIES}`);
        self.messageSession.restoreFirstTurn(firstTurnSnapshot);
        self.messageSession.busy = true;
        const retryMessage = {};
        self.turnLatency?.enqueue(retryMessage, true);
        setTimeout(() => {
          if (self.stopped) { self.messageSession.busy = false; return; }
          // Clear na janela de 1,2s descartou a mensagem — re-postá-la numa
          // sessão nova ressuscitaria o conteúdo que o usuário abortou (com
          // side effects de tools). Não toca busy: o clear já zerou e um
          // turno novo pode ser o dono agora.
          if (!self.messageSession.owns(turnEpoch, turnSession)) return;
          self.turnLatency?.activate(retryMessage, self.messageSession.sessionId ? "resume" : "cold");
          void self.runOpenCodeMessage(content, images, retry + 1);
        }, 1200);
        return;
      }
      ocReportError(self, `opencode: turno falhou após retry: ${fail.detail}`);
      // Estouro de janela chega como reject do POST (HTTP 4xx com o banner do
      // provider no corpo) — única rota reativa do transporte via serve; sem
      // isso o agente trava repetindo o mesmo erro até clear manual.
      self.checkContextFullError(emsg);
      self.setState("idle");
      self.drainOcQueue();
      return;
    }
    // Clear durante o POST: resultado pertence à sessão descartada. Retorna
    // SEM tocar busy/estado/fila — este turno não é mais o dono (ver catch).
    if (self.stopped) { self.messageSession.busy = false; return; }
    if (!self.messageSession.owns(turnEpoch, turnSession)) return;
    // Serve pode responder 200 com o erro do provider embutido em info.error
    // (nunca passa pelas parts) — cobre a variante que o reject do POST não vê.
    // Erro do provider vem DENTRO de um 200 do serve. Ele era extraído aqui e
    // entregue só ao checkContextFullError — qualquer erro que não fosse
    // "contexto cheio" (403 prompt injection, 401 chave, 429 cota) era
    // descartado, e o turno terminava mudo. O caminho do claude (ver ~1222) já
    // fazia checkContextFullError + onError; aqui faltava o segundo.
    const infoErr = resp?.info?.error;
    if (infoErr) {
      const im = typeof infoErr === "string" ? infoErr : String(infoErr?.data?.message ?? infoErr?.message ?? JSON.stringify(infoErr));
      self.checkContextFullError(im);
      const status = infoErr?.data?.statusCode;
      const nome = infoErr?.name ? `${infoErr.name}: ` : "";
      ocReportError(self, `opencode: ${nome}${status ? `${status} — ` : ""}${im}`);
    }
    // O POST /message só retorna a ÚLTIMA mensagem do assistant; as tool calls
    // ficam em mensagens INTERMEDIÁRIAS do loop (uma msg por step). Busca TODAS
    // as msgs da sessão e processa só as parts novas (dedup por id) — senão os
    // RUNS (tool executions) nunca apareciam no opencode.
    await self.ocProcessNewParts(resp, turnSession);
    // Clear durante o GET do ocProcessNewParts: mesma regra de posse.
    if (self.stopped) { self.messageSession.busy = false; return; }
    if (!self.messageSession.owns(turnEpoch, turnSession)) return;
    self.ocActiveProc = null;
    self.messageSession.busy = false;
    // "resposta vazia" só descreve turno SEM erro conhecido. Com erro já
    // reportado acima, repetir isso escondia a causa atrás de um palpite
    // ("provável flap") — e retentar 401/403 só queima chamada.
    if (!self.ocRunSawOutput && !infoErr && retry < AgentRunner.OC_EMPTY_RETRIES) {
      ocReportError(self, `opencode: resposta vazia (provável flap do provider) — retry ${retry + 1}/${AgentRunner.OC_EMPTY_RETRIES}`);
      self.messageSession.restoreFirstTurn(firstTurnSnapshot);
      self.messageSession.busy = true;
      timing?.finish("retry");
      const retryMessage = {};
      self.turnLatency?.enqueue(retryMessage, true);
      setTimeout(() => {
        if (self.stopped) { self.messageSession.busy = false; return; }
        if (!self.messageSession.owns(turnEpoch, turnSession)) return; // clear descartou a mensagem (ver retry do catch)
        self.turnLatency?.activate(retryMessage, self.messageSession.sessionId ? "resume" : "cold");
        void self.runOpenCodeMessage(content, images, retry + 1);
      }, 1200);
      return;
    }
    if (!self.ocRunSawOutput) {
      ocReportError(self, `opencode: turno terminou sem texto — o modelo "${self.info.model ?? "?"}" pode não retornar resposta. Troque o modelo.`);
    }
    timing?.finish(infoErr || !self.ocRunSawOutput ? "error" : "completed");
    self.setState("idle");
    self.drainOcQueue();
  }
  /** HTTP ao opencode serve (loopback). Resolve com JSON parseado; rejeita
   *  em status !2xx ou erro de rede/timeout. Usado pelo transporte por API
   *  (POST /session, POST /session/:id/message). */
export function ocServeFetch(self: any, path: string, method: string, body?: unknown, timeoutMs = 20_000): Promise<any> {
    return self.openCodeTransport.fetch(path, method, body, timeoutMs);
  }
  /* ---------- OpenCode permission (auto-approve OFF) ---------- */
  /** Abre o stream SSE /event do serve p/ receber `permission.asked`. Só roda
   *  com auto-approve OFF (com ON o config já libera tudo, nenhum ask é emitido).
   *  Reabre se a conexão cair (serve vivo = sessão do agente viva). */
  /** Resolve um permission.asked: consulta a política do orquestrador (mesma do
   *  approve_action do claude) e responde ao serve (once = libera / reject = nega). */
export async function ocHandlePermissionAsked(self: any, props: any): Promise<void> {
    const permId = props?.id as string | undefined;
    const sessionID = props?.sessionID as string | undefined;
    const tool = String(props?.permission ?? "");
    if (!permId || !sessionID) return;
    // input p/ exibir na UI: metadata (ex bash {command, description}) + patterns
    const input = { ...(props?.metadata ?? {}), patterns: props?.patterns };
    let allow = false;
    try {
      const r = await self.bridgePost("permission", { tool, input });
      allow = !!r?.allow;
    } catch (e) {
      // fail-closed: nega se a política não respondeu (igual approve_action)
      self.opts.log("warn", `[cli:${self.info.id}:opencode] permission '${tool}' negada (erro política): ${(e as Error).message}`);
    }
    try {
      await self.ocServeFetch(`/session/${sessionID}/permissions/${permId}`, "POST", { response: allow ? "once" : "reject" });
    } catch (e) {
      self.opts.log("warn", `[cli:${self.info.id}:opencode] falha respondendo permission: ${(e as Error).message}`);
    }
  }
  /** POST ao orquestrador /api/bridge/<agentId>/<route> (via socket se houver,
   *  senão HTTP). Bearer = agentToken. Timeout longo: aprovação humana pode
   *  demorar (waiter do server expira em 5min). */
export async function ocProcessNewParts(self: any, resp: any, sessionId?: string): Promise<void> {
    const sid = sessionId ?? self.messageSession.sessionId;
    let messages: any[] | null = null;
    try {
      const r = await self.ocServeFetch(`/session/${sid}/message`, "GET");
      if (Array.isArray(r)) messages = r;
    } catch { /* cai pro fallback abaixo */ }
    // Clear durante o GET: não despachar parts da sessão descartada (texto
    // velho "falando" pós-clear + step-finish envenenando a contabilidade).
    if (sessionId && self.messageSession.sessionId !== sessionId) return;
    const groups: any[][] = messages
      ? messages
          .filter((m) => (m?.info?.role ?? m?.role) === "assistant")
          .map((m) => (Array.isArray(m?.parts) ? m.parts : []))
      : [Array.isArray(resp?.parts) ? resp.parts : []];
    for (const parts of groups) {
      for (const p of parts) {
        const id = p?.id;
        if (id) {
          if (self.ocSeenPartIds.has(id)) continue;
          self.ocSeenPartIds.add(id);
        }
        self.ocDispatchPart(p);
      }
    }
  }
  /** Despacha uma part da resposta opencode (text/tool/step-finish). */
export function ocDispatchPart(self: any, p: any): void {
    self.applyOpenCodeEvents(p);
  }
  /**
   * Part chegando pelo SSE `/event` do serve (`message.part.updated`) — é o
   * que faz RUN, reasoning e usage aparecerem DURANTE o turno; antes tudo
   * esperava o POST /message retornar.
   *
   * Filtros que importam:
   *  - sessão: o serve é por agente, mas o compact resume num FORK e o
   *    one-shot roda em sessão própria — part de outra sessão não pode
   *    "falar" na conversa (nem mover a sessão corrente);
   *  - texto/reasoning sem `time.end`: a part ainda cresce (o serve reenvia o
   *    texto ACUMULADO a cada delta) e a UI cria uma mensagem por emissão —
   *    emitir antes do fim publicaria o mesmo bloco várias vezes;
   *  - dedup no MESMO `ocSeenPartIds` que o POST final consulta: o que sai
   *    aqui não sai duas vezes lá.
   */
export function ocHandleStreamPart(self: any, props: any): void {
    const part = props?.part;
    const sid = part?.sessionID ?? props?.sessionID;
    if (!part || !sid || sid !== self.messageSession.sessionId) return;
    // Sinal de vida pro watchdog: sem stream, um turno longo em tools ficava
    // sem nenhum toque de atividade e batia no limiar de hang.
    self.touchActivity();
    const type = String(part.type ?? "");
    if (type === "text" && part.text) self.turnLatency?.current?.semantic("text");
    if (type === "reasoning" && part.text) self.turnLatency?.current?.semantic("thinking");
    if (type.startsWith("tool") && part.state?.status === "running") self.turnLatency?.current?.semantic("tool");
    if ((type === "text" || type === "reasoning") && !part.time?.end) return;
    // Tool começa em `pending` (sem input resolvido): o parser não emite nada
    // aí, e marcar o id como visto agora enterraria o `running` que vem logo
    // depois — a tool nunca apareceria.
    if (type.startsWith("tool") && String(part.state?.status ?? "") === "pending") return;
    const id = typeof part.id === "string" ? part.id : undefined;
    if (id) {
      if (self.ocSeenPartIds.has(id)) return;
      self.ocSeenPartIds.add(id);
    }
    self.ocDispatchPart(part);
  }
export function applyOpenCodeEvents(self: any, raw: unknown): void {
    for (const event of parseOpenCodeTurnEvent(raw)) {
      if (event.type === "text" && event.text) self.turnLatency?.current?.semantic("text");
      if (event.type === "thought" && event.text) self.turnLatency?.current?.semantic("thinking");
      if (event.type === "tool") self.turnLatency?.current?.semantic("tool");
      if (event.type === "session") {
        if (event.sessionId !== self.messageSession.sessionId) {
          self.messageSession.sessionId = event.sessionId;
          self.opts.onSessionId?.(event.sessionId);
        }
      } else if (event.type === "text") {
        self.ocRunSawOutput = true;
        self.setState("speaking");
        self.opts.onAssistantText(event.text);
      } else if (event.type === "tool") {
        self.ocRunSawOutput = true;
        self.opts.onToolUse(event.name, event.input);
        self.setState("thinking");
      } else if (event.type === "thought") {
        // ReasoningPart: mesmo canal do extended thinking do claude e do
        // `thought` do grok — gated por collectThinking.
        self.setState("thinking");
        if (self.info.collectThinking) self.opts.onThinkingText?.(event.text);
      } else if (event.type === "usage") {
        const delta: AgentUsage = {
          input: event.input,
          output: event.output,
          cacheCreate: event.cacheCreate,
          cacheRead: event.cacheRead,
        };
        self.opts.onUsageDelta?.(delta);
        self.checkContextUsage(delta, self.ocUsageSemantics());
      } else if (event.type === "result") self.setState("thinking");
    }
  }
export function handleOpenCodeEvent(self: any, event: any) {
    self.applyOpenCodeEvents(event);
  }
  /** T-416: crush não emite JSON no turno — cada chunk de stdout é progresso. */