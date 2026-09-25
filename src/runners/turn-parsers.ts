export type NormalizedTurnEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  /** T-819: `delta` = chunk de ARGUMENTOS da mesma tool (não é tool nova). */
  | { type: "tool"; name: string; input: unknown; id?: string; delta?: boolean }
  /** T-829/T-819: tool (com id) concluída — desconta o in-flight. */
  | { type: "tool_done"; id: string }
  | { type: "usage"; input: number; output: number; cacheCreate: number; cacheRead: number; cumulative: boolean }
  | { type: "plan" }
  | { type: "result" }
  | { type: "thought"; text: string }
  | { type: "error"; message: string };

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Codex resume errors caused by an absolute rollout path left in its state
 *  DB after a home move. Keep this narrow: other resume failures must remain
 *  visible to the caller rather than silently creating a new conversation. */
export function isCodexMissingRolloutError(message: string): boolean {
  return /no rollout found for thread id|state db returned stale rollout path/i.test(message);
}

/** T-829: tool iniciada SEM id (formato antigo/incompleto) ainda conta em voo —
 *  id sintético que nenhum completed desconta; o turn.completed zera, como antes. */
let codexAnonToolSeq = 0;

export function parseCodexTurnEvent(raw: unknown): NormalizedTurnEvent[] {
  const event = record(raw);
  if (!event || typeof event.type !== "string") return [];
  const item = record(event.item);
  if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
    return [{ type: "session", sessionId: event.thread_id }];
  }
  // T-829: id do item liga o started ao completed (in-flight por tool).
  const itemId = typeof item?.id === "string" && item.id ? item.id : undefined;
  if (event.type === "item.started" && item?.type === "mcp_tool_call") {
    return [{ type: "tool", name: typeof item.tool === "string" ? item.tool : "", input: item.arguments ?? {}, id: itemId ?? `anon-${++codexAnonToolSeq}` }];
  }
  // T-829: shell, build e testes são o grosso do trabalho do codex e não viravam
  // tool (sumiam da RUNS, da "última tool" e do turn-latency). codex-cli 0.156:
  // item.started/completed {type:"command_execution", command, aggregated_output, exit_code, status}.
  if (event.type === "item.started" && item?.type === "command_execution") {
    return [{ type: "tool", name: "shell", input: { command: typeof item.command === "string" ? item.command : "" }, id: itemId ?? `anon-${++codexAnonToolSeq}` }];
  }
  if (event.type === "item.completed" && itemId && (item?.type === "command_execution" || item?.type === "mcp_tool_call")) {
    return [{ type: "tool_done", id: itemId }];
  }
  // Edição de arquivo e busca chegam como item concluído: tool instantânea,
  // sem in-flight (não há par started para descontar).
  if (event.type === "item.completed" && item?.type === "file_change") {
    return [{ type: "tool", name: "file_change", input: { changes: Array.isArray(item.changes) ? item.changes : [] } }];
  }
  if (event.type === "item.completed" && item?.type === "web_search") {
    return [{ type: "tool", name: "web_search", input: { query: typeof item.query === "string" ? item.query : "" } }];
  }
  if (event.type === "item.completed" && item?.type === "reasoning" && typeof item.text === "string" && item.text.trim()) {
    return [{ type: "thought", text: item.text.trim() }];
  }
  if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
    return [{ type: "text", text: item.text.trim() }];
  }
  if (event.type === "turn.completed") {
    const usage = record(event.usage);
    if (!usage) return [];
    return [{ type: "usage", input: Number(usage.input_tokens ?? 0), output: Number(usage.output_tokens ?? 0), cacheCreate: 0, cacheRead: Number(usage.cached_input_tokens ?? 0), cumulative: false }];
  }
  if (event.type === "turn.failed") {
    const error = record(event.error);
    return [{ type: "error", message: String(error?.message ?? event.error ?? "turn failed") }];
  }
  if (event.type === "error") {
    const error = record(event.error);
    const message = String(event.message ?? error?.message ?? "");
    return message ? [{ type: "error", message }] : [];
  }
  return [];
}

/* ---------- T-245: sinais reais de contexto do rollout do codex ---------- */

export interface CodexRolloutSignals {
  /** Contexto REAL do último step (last_token_usage.total_tokens do último
   *  event_msg token_count) — NÃO o billing do turno (soma dos steps). */
  usedTokens: number;
  /** Janela REAL reportada pelo codex (model_context_window; ex. 258.400 =
   *  272k − 5% de reserve). Ausente em rollouts velhos. */
  contextWindow?: number;
}

/**
 * Extrai o último `event_msg token_count` de um rollout codex
 * (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). O stdout de `exec --json`
 * NÃO emite token_count — essa é a única fonte do contexto real:
 * `turn.completed.usage.input_tokens` é BILLING do turno inteiro (soma dos
 * prompts re-enviados a cada step/tool call), não a ocupação da janela.
 * Linha por linha (JSONL append-only); linhas malformadas são ignoradas.
 * null = arquivo sem token_count utilizável (fallback: comportamento atual).
 */
export function parseCodexRolloutSignals(text: string): CodexRolloutSignals | null {
  let best: CodexRolloutSignals | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const event = record(parsed);
    if (!event || event.type !== "event_msg") continue;
    const payload = record(event.payload);
    if (!payload || payload.type !== "token_count") continue;
    const info = record(payload.info);
    if (!info) continue;
    const last = record(info.last_token_usage);
    if (!last) continue;
    const usedTokens = Number(last.total_tokens);
    if (!Number.isFinite(usedTokens) || usedTokens <= 0) continue;
    const contextWindow = Number(info.model_context_window);
    best = {
      usedTokens: Math.floor(usedTokens),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {}),
    };
  }
  return best;
}

/** ID da sessão no rollout (1ª linha, session_meta) — usado pra confirmar
 *  que o arquivo é do thread procurado (o nome contém o id, mas o conteúdo
 *  é o vínculo forte). null se a linha não for session_meta legível. */
export function parseCodexRolloutSessionId(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const event = record(parsed);
    if (!event || event.type !== "session_meta") continue;
    const payload = record(event.payload);
    const id = payload && (payload.id ?? payload.session_id);
    return typeof id === "string" && id ? id : null;
  }
  return null;
}

export function parseGeminiTurnEvent(raw: unknown): NormalizedTurnEvent[] {
  const event = record(raw);
  if (!event || typeof event.type !== "string") return [];
  if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
    return event.content ? [{ type: "text", text: event.content }] : [];
  }
  if (event.type === "tool_call" || event.type === "tool_use") {
    return [{ type: "tool", name: typeof event.name === "string" ? event.name : "", input: event.args ?? {} }];
  }
  if (event.type === "result") {
    const stats = record(event.stats) ?? {};
    return [
      { type: "usage", input: Number(stats.input_tokens ?? stats.input ?? 0), output: Number(stats.output_tokens ?? 0), cacheCreate: 0, cacheRead: Number(stats.cached ?? 0), cumulative: true },
      { type: "result" },
    ];
  }
  return [];
}

/** Qwen Code 0.23+ (stream-json): JSONL estilo Claude — init com session_id,
 *  assistant com message.content[] (text/thinking/tool_use) e usage POR
 *  REQUEST (igual Claude: input_tokens ≈ ocupação da janela, não delta de
 *  turno — o route "anthropic" de billing/ocupação é o mesmo). O evento
 *  `result` traz usage ACUMULADO do processo (não usar p/ delta) e is_error.
 *  `stream_event` (parciais) e eventos de telemetria são ignorados. */
export function parseQwenTurnEvent(raw: unknown): NormalizedTurnEvent[] {
  const event = record(raw);
  if (!event || typeof event.type !== "string") return [];
  const out: NormalizedTurnEvent[] = [];
  if (typeof event.session_id === "string" && event.session_id) out.push({ type: "session", sessionId: event.session_id });
  if (event.type === "assistant") {
    const message = record(event.message);
    const blocks = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
    for (const b of blocks) {
      const block = record(b);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text) out.push({ type: "text", text: block.text });
      else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) out.push({ type: "thought", text: block.thinking.trim() });
      else if (block.type === "tool_use") out.push({ type: "tool", name: typeof block.name === "string" ? block.name : "", input: block.input ?? {}, ...(typeof block.id === "string" && block.id ? { id: block.id } : {}) });
    }
    const usage = record(message?.usage);
    if (usage) {
      const input = Number(usage.input_tokens ?? 0);
      const output = Number(usage.output_tokens ?? 0);
      // Eventos de streaming com usage zerado não são billing; ignorar.
      if (input || output) {
        out.push({ type: "usage", input, output, cacheCreate: Number(usage.cache_creation_input_tokens ?? 0), cacheRead: Number(usage.cache_read_input_tokens ?? 0), cumulative: false });
      }
    }
    return out;
  }
  if (event.type === "result") {
    out.push({ type: "result" });
    return out;
  }
  if (event.type === "assistant") return out;
  // init/stream_event/telemetria: só o session_id (se havia) interessa.
  return out;
}

function usageFromTokens(tokens: Record<string, unknown>): NormalizedTurnEvent {
  const cache = record(tokens.cache) ?? {};
  return { type: "usage", input: Number(tokens.input ?? 0), output: Number(tokens.output ?? 0), cacheCreate: Number(cache.write ?? 0), cacheRead: Number(cache.read ?? 0), cumulative: false };
}

export function parseOpenCodeTurnEvent(raw: unknown): NormalizedTurnEvent[] {
  const event = record(raw);
  if (!event) return [];
  const out: NormalizedTurnEvent[] = [];
  if (typeof event.sessionID === "string" && event.sessionID) out.push({ type: "session", sessionId: event.sessionID });
  const part = record(event.part) ?? event;
  const type = String(event.type ?? part.type ?? "").replace(/-/g, "_");
  if (type === "text" && typeof part.text === "string" && part.text.trim()) {
    // TextPart tem `synthetic` (texto que o próprio opencode injeta — resumo
    // do compact, avisos) e `ignored` (part que ele descartou): nenhum dos
    // dois é fala do modelo, e o resumo ecoado vira mensagem duplicada.
    if (!part.synthetic && !part.ignored) out.push({ type: "text", text: part.text.trim() });
  } else if (type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
    out.push({ type: "thought", text: part.text.trim() });
  } else if (["tool", "tool_use", "tool_call"].includes(type)) {
    const state = record(part.state);
    // ToolState: pending → running → completed|error. `pending` ainda não tem
    // o input resolvido (só o raw), então o RUN sairia sem argumentos; de
    // `running` em diante já dá pra mostrar a tool ao vivo.
    if (!state?.status || ["running", "completed", "error"].includes(String(state.status))) {
      const id = typeof part.id === "string" && part.id ? part.id : undefined;
      out.push({
        type: "tool",
        name: String(part.tool ?? part.name ?? state?.name ?? ""),
        input: state?.input ?? part.input ?? {},
        ...(id ? { id } : {}),
      });
    }
  } else if (type === "step_start") out.push({ type: "result" });
  else if (type === "step_finish") {
    const tokens = record(part.tokens);
    if (tokens) out.push(usageFromTokens(tokens));
  }
  return out;
}

/**
 * Grok headless `--output-format streaming-json`:
 *   legado (medido 1.0.34 / grok-custom 1.6.3): thought | text | tool_call |
 *     tool_call_update | usage | plan | end | error
 *   defesa ACP (help 1.0.34: "one ACP session update per line"):
 *     sessionUpdate / jsonrpc session/update. Sem isso, um stdout ACP
 *     sem `type` devolveria [] e o watchdog leria silêncio.
 */
function grokInnerEvent(raw: unknown): Record<string, unknown> | null {
  const event = record(raw);
  if (!event) return null;
  const method = typeof event.method === "string" ? event.method : "";
  if (method === "session/update" || method === "_x.ai/session_notification") {
    const params = record(event.params);
    if (!params) return event;
    const update = record(params.update) ?? params;
    if (typeof params.sessionId === "string" && update.sessionId == null) {
      return { ...update, sessionId: params.sessionId };
    }
    return update;
  }
  return event;
}

function grokDeltaText(event: Record<string, unknown>): string {
  if (typeof event.data === "string") return event.data;
  if (typeof event.text === "string") return event.text;
  const content = event.content;
  if (typeof content === "string") return content;
  const rec = record(content);
  if (rec && typeof rec.text === "string") return rec.text;
  return "";
}

function grokEventKind(event: Record<string, unknown>): string {
  if (typeof event.sessionUpdate === "string" && event.sessionUpdate) return event.sessionUpdate;
  if (typeof event.type === "string" && event.type) return event.type;
  return "";
}

export function parseGrokStreamEvent(raw: unknown): NormalizedTurnEvent[] {
  const event = grokInnerEvent(raw);
  if (!event) return [];
  const kind = grokEventKind(event);
  if (kind === "thought" || kind === "agent_thought_chunk") {
    const text = grokDeltaText(event);
    return text ? [{ type: "thought", text }] : [{ type: "plan" }];
  }
  if (kind === "text" || kind === "agent_message_chunk") {
    const text = grokDeltaText(event);
    return text ? [{ type: "text", text }] : [{ type: "plan" }];
  }
  if (kind === "tool_call" || kind === "tool_call_update" || kind === "tool_call_delta_chunk") {
    const name = String(event.toolName ?? event.title ?? event.name ?? "");
    const input = event.rawInput ?? event.input ?? {};
    const idRaw = event.toolCallId ?? event.tool_call_id;
    const id = typeof idRaw === "string" && idRaw ? idRaw : undefined;
    // T-819: antes os TRÊS kinds viravam `tool` e cada um somava um "em voo":
    // o delta de argumentos não é tool nova, e o update terminal é a CONCLUSÃO
    // (virava mais um em voo, nunca descontava — 391 no log de prod).
    if (kind === "tool_call_update") {
      const status = typeof event.status === "string" ? event.status : undefined;
      if ((status === "completed" || status === "failed") && id) return [{ type: "tool_done", id }];
    }
    const tool: NormalizedTurnEvent = id
      ? { type: "tool", name, input, id, ...(kind === "tool_call_delta_chunk" ? { delta: true } : {}) }
      : { type: "tool", name, input, ...(kind === "tool_call_delta_chunk" ? { delta: true } : {}) };
    return [tool];
  }
  if (kind === "end") return typeof event.sessionId === "string" && event.sessionId
    ? [{ type: "session", sessionId: event.sessionId }, { type: "result" }]
    : [{ type: "result" }];
  if (kind === "error") return [{ type: "error", message: String(event.message ?? event.data ?? "grok error") }];
  if (kind === "usage" || kind === "usage_update") {
    const u = record(event.data) ?? record(event.usage) ?? event;
    return [{
      type: "usage",
      input: Number(u.input_tokens ?? u.input ?? u.used ?? 0),
      output: Number(u.output_tokens ?? u.output ?? 0),
      cacheCreate: Number(u.cache_creation_input_tokens ?? u.cacheCreate ?? 0),
      cacheRead: Number(u.cache_read_input_tokens ?? u.cached_input_tokens ?? u.cacheRead ?? 0),
      cumulative: false,
    }];
  }
  if (kind === "plan") return [{ type: "plan" }];
  // JSON final (output-format json): { text, sessionId, … }
  if (!kind && typeof event.text === "string") {
    const out: NormalizedTurnEvent[] = [{ type: "text", text: event.text }];
    if (typeof event.sessionId === "string" && event.sessionId) out.push({ type: "session", sessionId: event.sessionId });
    out.push({ type: "result" });
    return out;
  }
  // T-055: JSON válido com kind desconhecido = batimento de vida do CLI.
  if (kind.length > 0) {
    return [{ type: "plan" }];
  }
  return [];
}

/**
 * T-371 (c): janela anti-repetição para o stream de texto.
 *
 * O caso da forense: provider degradado emite um loop de tokens ('ductduct…')
 * que renova qualquer relógio de ociosidade — o turno morria aos 12-15min.
 * Detecção: quando o TOTAL alimentado passa `minFeedChars` (um turno são
 * chega lá com conteúdo VARIADO; um loop chega em segundos), o fim da janela
 * deslizante é verificado contra periodicidade curta: existir um período
 * p ≤ `maxPeriod` que cobre ≥ `coverage` dos últimos `windowChars` é um
 * degenerado — não prosa, não tabela, não código (essas repetem LINHAS
 * diferentes, não um período único). Abaixo do piso de feed NADA dispara:
 * saída legítima repetitiva de baixo volume é o negativo vinculativo.
 *
 * Uma instância por turno (estado de sliding window). `feed` devolve true
 * no momento em que o loop fica inequívoco — o caller aborta o turno.
 */
export class TextLoopGuard {
  private windowBuf = "";
  private fed = 0;
  private sinceCheck = 0;
  private tripped = false;
  private readonly minFeedChars: number;
  private readonly windowChars: number;
  private readonly maxPeriod: number;
  private readonly coverage: number;
  private readonly checkEvery: number;

  constructor(opts: { minFeedChars?: number; windowChars?: number; maxPeriod?: number; coverage?: number } = {}) {
    this.minFeedChars = opts.minFeedChars ?? 32_768;
    this.windowChars = opts.windowChars ?? 16_384;
    this.maxPeriod = opts.maxPeriod ?? 64;
    this.coverage = opts.coverage ?? 0.95;
    this.checkEvery = Math.floor(this.windowChars / 2);
  }

  /** Alimenta o delta de texto do turno; true = loop degenerado detectado. */
  feed(text: string): boolean {
    if (this.tripped || !text) return this.tripped;
    this.fed += text.length;
    this.sinceCheck += text.length;
    this.windowBuf = this.windowBuf.length + text.length > this.windowChars
      ? this.windowBuf.slice(this.windowBuf.length + text.length - this.windowChars) + text
      : this.windowBuf + text;
    if (this.fed < this.minFeedChars || this.sinceCheck < this.checkEvery) return false;
    this.sinceCheck = 0;
    if (this.isDegenerate(this.windowBuf)) this.tripped = true;
    return this.tripped;
  }

  /** Existe período ≤ maxPeriod cobrindo ≥ coverage do fim da janela? */
  private isDegenerate(tail: string): boolean {
    if (tail.length < this.windowChars / 2) return false;
    const sample = tail.slice(-this.windowChars);
    for (let p = 1; p <= this.maxPeriod; p++) {
      let mismatches = 0;
      const budget = Math.ceil(sample.length * (1 - this.coverage));
      for (let i = p; i < sample.length && mismatches <= budget; i++) {
        if (sample[i] !== sample[i - p]) mismatches++;
      }
      if (mismatches <= budget) return true;
    }
    return false;
  }
}

export interface CrushSessionMeta { sessionId?: string; prompt: number; completion: number }

export function parseCrushSessionMeta(raw: unknown): CrushSessionMeta {
  const root = record(raw);
  const meta = record(root?.meta) ?? root ?? {};
  return {
    sessionId: typeof meta.uuid === "string" && meta.uuid ? meta.uuid : undefined,
    prompt: Number(meta.prompt_tokens ?? 0),
    completion: Number(meta.completion_tokens ?? 0),
  };
}
