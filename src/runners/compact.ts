/* R7 (T-462): compact extraído do agent-runner — `self` é o AgentRunner. */
import {ONE_SHOT_TIMEOUT_MS} from "../agent-runner.js";
import {AgentUsage} from "../types.js";
import {MemoryExtractItem, memoryBodySame, memoryTitleNearDup as memoryTitleNearDupUtil, parseAndStripMemory as parseAndStripMemoryUtil} from "../memory-utils.js";
import {UsageSemantics} from "./context-tracker.js";
import {isApiErrorMessage} from "./error-classifier.js";
import {isGrokFamily} from "./index.js";
import {providerModelParts} from "./model-policy.js";
import {recordHardRecover} from "../health-monitor.js";
import http from "node:http";


export async function compactContext(self: any, saveMemory = true): Promise<void> {
    // Guard de reentrância: compactContexts concorrentes (context_full em
    // rajada, clique duplo) fariam killClaudeForRestart + startClaude em
    // paralelo → processo claude órfão + resumo duplicado na conversa.
    if (self.compacting) {
      self.opts.onError("[ctx] compact já em andamento — ignorado");
      return;
    }
    // Simétrico ao check de `compacting` no clearContext: compact entrando na
    // janela do kill de um clear capturaria a sessão antiga e subiria um
    // segundo processo (o early-return do killClaudeForRestart via proc.killed
    // era o buraco; o guard fecha a porta pelo outro lado também).
    if (self.clearing) {
      self.opts.onError("[ctx] compact ignorado — clear em andamento");
      return;
    }
    self.compacting = true;
    self.compactingSince = Date.now();
    try {
      await self.compactContextInner(saveMemory);
    } finally {
      self.compacting = false;
      self.compactingSince = null;
      // A fila oc fica pausada durante o compact (drainOcQueue checa
      // `compacting`) — mensagens chegadas no meio precisam drenar agora.
      if (self.opts.cliRunner !== "claude") self.drainOcQueue();
    }
  }
export async function compactContextInner(self: any, saveMemory: boolean): Promise<void> {
    // OpenCode roda via serve HTTP. O one-shot runOneShot/resetWithSummary
    // abaixo NÃO toca a sessão do serve → "compact não faz nada". Aqui:
    // (1) AUTO-EXTRACT de memória (Fase 3) num FORK da sessão (não polui a
    //     conversa real) — pede MEMORY_JSON, parseia, salva via bridge;
    // (2) compacta a sessão real com o summarize NATIVO do serve.
    if (self.opts.cliRunner === "opencode") {
      if (!self.openCodeTransport.ready() || !self.messageSession.sessionId) {
        self.opts.onError("[ctx] compact: sessão opencode ainda não ativa — manda uma mensagem primeiro");
        return;
      }
      // ocModelParts remove o sufixo legado ":<effort>" — split inline aqui
      // mandava "deepseek-v4-pro:max" pro serve e o compact falhava sempre.
      const { providerID, modelID } = providerModelParts(self.info.model);
      if (!providerID || !modelID) { self.opts.onError("[ctx] compact: modelo inválido"); return; }
      // Turno em voo compartilha a sessão do serve: o prime pós-summarize
      // marcaria as parts dele como vistas (resposta engolida + retry
      // re-executa tools com side effect). A fila está pausada pelo guard
      // `compacting` — só falta o em-voo terminar.
      if (!(await self.waitOcIdle())) {
        if (!self.stopped) self.opts.onError("[ctx] compact: turno em andamento não terminou a tempo — tente de novo quando o agente estiver idle");
        return;
      }
      // (1) auto-extract via fork (mesmo prompt do claude) — só se pedido
      if (saveMemory) try {
        const existing = await self.fetchExistingMemories();
        const already = self.memoryAlreadyBlock(existing);
        const extractPrompt =
          "Extract NEW durable knowledge from this conversation worth keeping permanently — every explicit decision, convention, preference, architectural choice or stable fact. Be generous." + already +
          " Respond with ONLY one line: `MEMORY_JSON:` + a single-line JSON array, each item {\"title\":\"<short>\",\"body\":\"<full>\",\"type\":\"decision\"|\"fact\"|\"reference\"|\"preference\"|\"experience\",\"supersedes\":[\"<id>\"]?} in the conversation's language. Use `MEMORY_JSON: []` if nothing. No markdown.";
        const fork = await self.ocServeFetch(`/session/${self.messageSession.sessionId}/fork`, "POST", {});
        const forkId = fork?.id as string | undefined;
        if (forkId) {
          try {
            const resp = await self.ocServeFetch(`/session/${forkId}/message`, "POST",
              { model: { providerID, modelID }, parts: [{ type: "text", text: extractPrompt }] }, 120_000);
            const text = (Array.isArray(resp?.parts) ? resp.parts : [])
              .filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("\n");
            self.opts.onError(`[ctx] fork-extract respLen=${text.length} marker=${/MEMORY_JSON/.test(text)}`);
            const { items } = self.parseAndStripMemory(text);
            void self.saveExtractedMemory(items, existing);
            self.opts.onError(`[ctx] memória: ${items.length} fato(s) extraído(s) na compactação`);
          } finally {
            void self.ocServeFetch(`/session/${forkId}`, "DELETE").catch(() => {});
          }
        }
      } catch (e) {
        self.opts.onError(`[ctx] auto-extract falhou: ${(e as Error).message}`);
      }
      // (2) compacta a sessão real. Timeout 300s (= ONE_SHOT_TIMEOUT_MS):
      // com 120s, providers lentos (deepseek) estouravam DETERMINISTICAMENTE
      // em sessão grande — e como timeout não contava no streak, virava loop
      // infinito de compacts caros a cada cooldown.
      try {
        await self.ocServeFetch(`/session/${self.messageSession.sessionId}/summarize`, "POST", { providerID, modelID }, ONE_SHOT_TIMEOUT_MS);
        // O summarize cria uma mensagem nova na sessão (resumo + step-finish
        // com tokens do contexto PRÉ-compactação). Prime IMEDIATO marca essas
        // parts como vistas — a flag needsPrime só seria consumida no início
        // do próximo turno, e um turno em voo drenaria o step-finish antes,
        // re-disparando context_full logo após o reset (resumo-do-resumo).
        try {
          const hist = await self.ocServeFetch(`/session/${self.messageSession.sessionId}/message`, "GET");
          if (Array.isArray(hist)) for (const m of hist) for (const p of (m?.parts ?? [])) { if (p?.id) self.ocSeenPartIds.add(p.id); }
        } catch { self.messageSession.needsPrime = true; /* fallback: prime no próximo turno */ }
        self.resetContextAccounting();
        self.opts.onError(`[ctx] contexto compactado${saveMemory ? " + memória salva" : " (sem salvar memória)"}`);
      } catch (e) {
        // Timeout do cliente não desfaz o summarize no serve: se ele concluir
        // depois, as parts do resumo precisam de prime mesmo assim — senão o
        // próximo turno re-despacha o resumo como fala + context_full espúrio.
        self.messageSession.needsPrime = true;
        // Timeout CONTA no streak: isentá-lo reabria o loop infinito quando o
        // timeout é determinístico (o teto de 3 existe exatamente pra isso).
        // O falso positivo (summarize concluiu no serve após o timeout) fica
        // raro com 300s, e o prime + próximo compact bem-sucedido rearmam.
        self.registerCompactFailure();
        self.opts.onError(`[ctx] compact falhou: ${(e as Error).message}`);
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
    const existing = await self.fetchExistingMemories();
    const alreadyBlock = self.memoryAlreadyBlock(existing);
    const summaryPrompt =
      "Two tasks. Write BOTH the summary and the memory entries in the SAME LANGUAGE as the conversation (e.g. if the conversation is in Portuguese, respond in Portuguese). Only the `MEMORY_JSON:` marker and JSON keys stay in English.\n\n" +
      "TASK 1 — Summarize this conversation concisely (decisions made, tasks in progress, key findings, context needed to continue). Be brief.\n\n" +
      "TASK 2 — Extract NEW durable knowledge worth keeping permanently. Prefer decisions, conventions, preferences, and stable architectural facts. Skip ephemeral task chatter and one-off debug noise. Max 5 entries." + alreadyBlock + " Output it on a NEW FINAL LINE as exactly `MEMORY_JSON:` followed by a single-line JSON array. Each element MUST be {\"title\": \"<short>\", \"body\": \"<the fact in full>\", \"type\": \"decision\"|\"fact\"|\"reference\"|\"preference\"|\"experience\", \"supersedes\": [\"<id>\"]?} where title/body are in the conversation's language. Use type decision/preference for sticky rules; fact for neutral notes; experience for \"how a similar task was solved here\" (situation → what worked → pitfall). " +
      "Example: MEMORY_JSON: [{\"title\":\"DB engine\",\"body\":\"The project uses PostgreSQL partitioned by month\",\"type\":\"decision\"}]. " +
      "Output `MEMORY_JSON: []` ONLY if there is no NEW durable info. No markdown, no code fences, single line.";
    if (self.opts.cliRunner === "claude") {
      const oldSession = self.opts.resumeSessionId ?? self.info.sessionId;
      self.opts.onError(`[compact] killing process, oldSession=${oldSession ?? "none"}`);
      await self.killClaudeForRestart();
      self.opts.onError(`[compact] running summary one-shot…`);
      const summary = oldSession ? await self.runOneShotWithSession(summaryPrompt, oldSession) : "";
      self.opts.onError(`[compact] summary length=${summary.length}`);
      // stop()/reconfig durante o one-shot longo: não spawnar processo zumbi —
      // mas fecha o ciclo de vida (emitExit é idempotente): sem isso a UI fica
      // com o agente "running" pra sempre e o token-file sobra em /tmp.
      if (self.stopped) { self.emitExit(null); return; }
      // O one-shot herda a sessão antiga — se ela falhou (contexto estourado,
      // 401/500, billing...), o stdout é vazio ou é SÓ o banner de erro, que
      // sempre COMEÇA com "API Error". A âncora importa nos dois sentidos:
      // banner de qualquer erro é lixo, mas um resumo legítimo que MENCIONE
      // "API Error" no meio do texto (conversa sobre debugging) é válido.
      // NÃO descartar a conversa com base em resumo-lixo: preserva a sessão
      // antiga e deixa o retry (cooldown) ou o usuário decidir.
      const summaryIsError = isApiErrorMessage(summary);
      if (oldSession && (!summary || summaryIsError)) {
        self.registerCompactFailure();
        self.opts.resumeSessionId = oldSession;
        self.startClaude();
        return;
      }
      self.opts.resumeSessionId = undefined;
      self.info.sessionId = undefined;
      self.resetContextAccounting();
      self.startClaude();
      if (summary) {
        const { clean, items } = self.parseAndStripMemory(summary);
        if (saveMemory) void self.saveExtractedMemory(items, existing);
        await new Promise((r) => setTimeout(r, 600));
        self.pushUserMessage(`# Previous conversation summary\n${clean}\n\n---\n\nContinue from here.`);
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
    if (self.messageSession.firstTurn || ((self.opts.cliRunner === "codex" || self.opts.cliRunner === "crush" || isGrokFamily(self.opts.cliRunner)) && !self.messageSession.sessionId)) {
      self.opts.onError("[ctx] compact: sessão ainda não ativa — manda uma mensagem primeiro");
      return;
    }
    // Turno em voo primeiro: o one-shot escreveria na MESMA sessão (gemini)
    // ou o thread.started/turn.completed dele brigaria com o reset (codex).
    if (!(await self.waitOcIdle())) {
      if (!self.stopped) self.opts.onError("[ctx] compact: turno em andamento não terminou a tempo — tente de novo quando o agente estiver idle");
      return;
    }
    const summary = await self.runOneShot(summaryPrompt);
    // stop() durante o one-shot: emitExit já rodou e o tmpdir já era — não
    // tocar estado nem anunciar compact num agente finalizado.
    if (self.stopped) return;
    self.opts.onError(`[compact] ${self.opts.cliRunner} summary length=${(summary || "").length}`);
    const { clean, items } = self.parseAndStripMemory(summary || "");
    if (saveMemory) void self.saveExtractedMemory(items, existing);
    if (clean) {
      self.resetWithSummary(clean);
      // Notifica o server de que o sessionId antigo morreu (próximo end grava
      // o novo). Sem isso o DB guarda o UUID antigo até o próximo turno.
      self.info.sessionId = undefined;
      if (self.opts.onSessionId) self.opts.onSessionId("");
      self.opts.onError(`[ctx] contexto compactado${saveMemory ? ` (${items.length} memória(s) salvas)` : " (sem salvar memória)"}`);
    } else {
      // Sem resumo utilizável = falha de compact: precisa contar no streak —
      // senão o teto de MAX_COMPACT_FAIL_STREAK nunca engata nos runners
      // codex/gemini (falha determinística vira loop eterno de one-shots
      // caros a cada janela de cooldown).
      self.registerCompactFailure();
    }
  }
  /** Espera o turno oc em voo terminar (a fila fica pausada pelo guard
   *  `compacting`). true = idle; false = desistiu (turno mais longo que o
   *  teto) ou stop() no meio. */
export async function waitOcIdle(self: any, maxMs = 120_000): Promise<boolean> {
    const step = 250;
    for (let waited = 0; self.messageSession.busy && !self.stopped && waited < maxMs; waited += step) {
      await new Promise((r) => setTimeout(r, step));
    }
    return !self.messageSession.busy && !self.stopped;
  }
export function parseAndStripMemory(self: any, summary: string) {
    return parseAndStripMemoryUtil(summary);
  }
  /**
   * T-233: task ativa do agente — fonte AUTORITATIVA é o server, via
   * agent:send com taskId nas notificações de task (assignment/conclusão).
   * Nunca derivado de parse do texto (TASK_ASSIGN em texto livre não conta).
   * In-memory: restart perde — server re-notifica na próxima atribuição.
   */
  /** Define a task ativa (wire do main em agent:send com taskId explícito).
   *  Reatribuição sobrescreve a anterior. Id malformado é ignorado (log). */
export async function saveExtractedMemory(self: any, 
    items: Array<{ title: string; body: string; type: string; supersedes: string[] }>,
    existing: Array<{ id: string; title: string; body: string }> = [],
    /** T-343: forçar proveniência quando o caller já limpiu a task ativa
     *  (reflexão de task-done); por omissão usa activeTaskId (compact). */
    taskIdOverride?: string,
  ): Promise<void> {
    self.opts.onError(`[compact] memory extracted=${items.length}`);
    if (items.length === 0) return;
    const socket = self.opts.bridgeSocketPath;
    if (!socket) {
      self.opts.onError(`[compact] ${items.length} memory item(s) skipped — no bridge relay (would bypass E2EE)`);
      return;
    }
    const existingIds = new Set(existing.map((e) => e.id));
    let saved = 0, merged = 0, skippedNear = 0;
    for (const it of items) {
      try {
        // Near-dup: se já existe título muito parecido, consolida (supersede) em vez de criar ruído
        const near = existing.find((e) => self.memoryTitleNearDup(e.title, it.title));
        const supersedes = [...it.supersedes];
        if (near && !supersedes.includes(near.id)) supersedes.push(near.id);
        // Skip se near-dup e body essencialmente igual (normalizador
        // compartilhado — tolerante a acento/pontuação, igual ao manual)
        if (near) {
          if (memoryBodySame(near.body, it.body)) {
            skippedNear++;
            continue;
          }
        }
        // Compact: default NÃO pin. Só decision/preference sobem pro hot-set
        // (fatos genéricos ficam no catálogo — recall).
        const pin = it.type === "decision" || it.type === "preference";
        // T-343: reflexão de task-done passa override (activeTaskId já limpo
        // pelo clear síncrono quando o save async corre).
        const provTask = taskIdOverride ?? self.activeTaskId ?? undefined;
        const r = await self.postBridgeJson(socket, "memory_add", {
          title: it.title,
          body: it.body,
          type: it.type,
          scope: "agent",
          pinned: pin,
          supersedesId: supersedes[0] ?? undefined,
          // T-233: proveniência da task ativa — sinal autoritativo do server
          // (agent:send com taskId); ausente = sem o campo (retrocompat).
          ...(provTask ? { taskId: provTask } : {}),
        });
        saved++;
        const newId = r?.memory?.id as string | undefined;
        const isNew = !!newId && !existingIds.has(newId);
        if (isNew) {
          if (newId) existingIds.add(newId);
          existing.push({ id: newId!, title: it.title, body: it.body });
          for (const oldId of supersedes) {
            if (!existingIds.has(oldId) || oldId === newId) continue;
            try {
              await self.postBridgeJson(socket, "memory_remove", { id: oldId });
              merged++;
              existingIds.delete(oldId);
            } catch { /* 403 = não foi o agente que criou → mantém viva. ok. */ }
          }
        }
      } catch (e) {
        self.opts.onError(`[compact] memory save failed: ${(e as Error).message}`);
      }
    }
    if (saved > 0 || skippedNear > 0) {
      self.opts.onError(
        `[compact] auto-saved ${saved} memory entry(ies)` +
          `${merged > 0 ? `, consolidou ${merged} antiga(s)` : ""}` +
          `${skippedNear > 0 ? `, skip near-dup ${skippedNear}` : ""}`,
      );
    }
  }
  /** Memórias já existentes (project + camada agent) com id/title/body, via
   *  relay socket (decriptados no inbound). Usado pra dedup E pro merge
   *  (consolidação) da auto-extração. */
export async function fetchExistingMemories(self: any, ): Promise<Array<{ id: string; title: string; body: string }>> {
    const socket = self.opts.bridgeSocketPath;
    if (!socket) return [];
    try {
      // T-342: paginado (200/página até meta.total, teto 1000) — com um único
      // list o bloco "já existe" via só o top-80 e o modelo re-emitia factos
      // fora dele. A lista vai toda; o bloco de prompt é cortado em 60 títulos.
      const mems: any[] = [];
      for (let page = 0; page < 5; page++) {
        const r = await self.postBridgeJson(socket, "memory_list", { limit: 200, offset: page * 200 });
        const chunk = Array.isArray(r?.memories) ? r.memories : [];
        mems.push(...chunk);
        const total = Number(r?.meta?.total);
        if (chunk.length < 200 || (Number.isFinite(total) && mems.length >= total)) break;
      }
      return mems
        .map((m: any) => ({
          id: typeof m.id === "string" ? m.id : "",
          title: typeof m.title === "string" ? m.title.trim() : "",
          body: typeof m.body === "string" ? m.body.trim() : "",
        }))
        .filter((m: { id: string; title: string }) => m.id && m.title);
    } catch {
      return [];
    }
  }
  /** Bloco de prompt: lista as memórias existentes indexadas por id e instrui o
   *  modelo a marcar `supersedes` quando a nova entrada atualiza/substitui uma.
   *  T-342: com catálogo grande, os 60 primeiros (ranked) bastam p/ o modelo
   *  não repetir; o dedup duro (near-dup/skip) corre sobre a lista completa. */
export function memoryAlreadyBlock(self: any, existing: Array<{ id: string; title: string; body: string }>): string {
    if (existing.length === 0) return "";
    const list = existing.slice(0, 60)
      .map((m) => `[id=${m.id}] ${m.title}${m.body ? ` — ${m.body.slice(0, 160)}` : ""}`)
      .join("\n");
    return `\n\nEXISTING MEMORY (a new entry may UPDATE/REPLACE one of these):\n${list}\n` +
      `If your new entry is a better/updated version of an existing one, add "supersedes": ["<id>"] with its id(s) from the list above — ONLY when it is genuinely the same fact updated, not merely related. Otherwise omit "supersedes". Do NOT repeat an existing entry unchanged.`;
  }
export function parseEpisodeJson(self: any, raw: string): MemoryExtractItem[] {
    const { items } = parseAndStripMemoryUtil((raw || "").replace(/EPISODE_JSON:/g, "MEMORY_JSON:"));
    // type FORÇADO: a lição de como resolver é sempre episódica.
    return items.map((it) => ({ ...it, type: "experience" }));
  }
export function memoryTitleNearDup(self: any, a: string, b: string): boolean {
    return memoryTitleNearDupUtil(a, b);
  }
  /** Grava as memórias auto-extraídas via relay socket — o relay cifra
   *  title/body com a project key (server cego). Sem relay socket, pula
   *  pra não mandar plaintext ao server (E2EE fail-safe). Merge: quando o
   *  modelo marca `supersedes`, remove as memórias antigas que a nova
   *  consolida (só ids reais da lista existente; só se o add criou entry NOVA,
   *  não dedup-hit). Add ANTES, remove DEPOIS (sem transação — duplicata
   *  benigna é preferível a perda).
   *  Pin: só decision/preference por default (hot-set enxuto). */
export function postBridgeJson(self: any, socketPath: string, route: string, body: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body ?? {});
      const req = http.request(
        {
          socketPath,
          method: "POST",
          path: `/api/bridge/${self.info.id}/${route}`,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${self.opts.agentToken}`,
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
export function handleUndeliveredTurnResult(self: any, reason: string): void {
    recordHardRecover(self.opts.cliRunner);
    const line = `[hang:${self.info.name}] DELIVERY recover: ${reason} (runner=${self.opts.cliRunner})`;
    self.opts.log("warn", line);
    const inflight = self.inflightPerMessage;
    let retried = false;
    if (inflight && inflight.attempt < 1) {
      self.inflightPerMessage = { ...inflight, attempt: inflight.attempt + 1 };
      self.messageSession.prepend({ content: inflight.content, images: inflight.images });
      retried = true;
      self.opts.log(
        "warn",
        `[hang:${self.info.name}] re-enfileirando após falha de entrega WS (attempt ${self.inflightPerMessage.attempt})`,
      );
    } else {
      self.inflightPerMessage = null;
    }
    const full = retried
      ? `[hang] ${reason} — reenviando a última mensagem (1×); o texto também fica na fila outbound se o socket voltar`
      : `[hang] ${reason} — retry esgotado; texto crítico fica na fila outbound até reconnect`;
    self.opts.onHung?.({ soft: false, reason: full, idleMs: 0 });
    self.opts.onError(full);
  }
export function resetContextAccounting(self: any, ): void {
    self.contextTracker.reset();
  }
export function checkContextUsage(self: any, delta: AgentUsage, semantics: UsageSemantics): void {
    self.contextTracker.reportUsage(delta, semantics);
  }
  /**
   * Ocupação absoluta da janela (não delta de billing).
   * `limitHint` opcional: quando o CLI reporta a janela real (ex. Grok
   * `contextWindowTokens`), usa esse teto se for maior que o mapa estático
   * — evita false-full quando o mapa está desatualizado.
   * `used === 0` é válido (pós-clear); só warning/full com used > 0.
   */
export function reportContextOccupancy(self: any, used: number, limitHint?: number): void {
    self.contextTracker.reportOccupancy(used, limitHint);
  }
  /** Paths candidatos do signals.json (cwd canônico + raw + realpath variants). */
export function notifyContextFull(self: any, ): void {
    self.contextTracker.notifyFull();
  }
  /** Registra falha de compact; ao atingir o teto, suspende a auto-compaction
   *  (rearmada por sucesso de compact ou clear, via resetContextAccounting). */
export function registerCompactFailure(self: any, ): void {
    self.contextTracker.registerCompactFailure();
  }
export function checkContextFullError(self: any, msg: string): void {
    // Rate limit tem PRECEDÊNCIA (mesmo pré-filtro da rota de texto do
    // claude): o 429 TPM da Anthropic ("...rate limit of N input tokens per
    // minute... reduce the prompt length or the maximum tokens requested...")
    // casa /maximum.{0,20}token/ — sem o filtro, rajada de rate limit
    // compacta uma sessão saudável (lossy) e 3 rajadas suspendem a
    // auto-compaction via streak.
    self.contextTracker.checkFullError(msg);
  }
  /** M17 (T-440): liveness REAL pro AgentHost não tratar cadáver como
   *  reconnect. claude contínuo = processo vivo; per-message = não saiu (o
   *  processo do turno nasce/morre, o runner é que importa). */