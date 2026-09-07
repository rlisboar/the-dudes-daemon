export type NormalizedTurnEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown; id?: string }
  | { type: "usage"; input: number; output: number; cacheCreate: number; cacheRead: number; cumulative: boolean }
  | { type: "plan" }
  | { type: "result" }
  | { type: "thought"; text: string }
  | { type: "error"; message: string };

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function parseCodexTurnEvent(raw: unknown): NormalizedTurnEvent[] {
  const event = record(raw);
  if (!event || typeof event.type !== "string") return [];
  const item = record(event.item);
  if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
    return [{ type: "session", sessionId: event.thread_id }];
  }
  if (event.type === "item.started" && item?.type === "mcp_tool_call") {
    return [{ type: "tool", name: typeof item.tool === "string" ? item.tool : "", input: item.arguments ?? {} }];
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
 * Grok headless `--output-format streaming-json` (docs/user-guide/14-headless-mode.md):
 *   thought | text | tool_call | tool_call_update | usage | plan | end | error
 *
 * `tool_call` / `tool_call_update` existem desde o stream ACP — não depender
 * só do poll de chat_history.jsonl pra estado/RUNS.
 */
export function parseGrokStreamEvent(raw: unknown): NormalizedTurnEvent[] {
  const event = record(raw);
  if (!event) return [];
  if (event.type === "text" && typeof event.data === "string") return [{ type: "text", text: event.data }];
  if (event.type === "thought" && typeof event.data === "string") return [{ type: "thought", text: event.data }];
  if (event.type === "tool_call" || event.type === "tool_call_update") {
    // tool_call: início (in_progress). tool_call_update: progresso/conclusão.
    // Estado "thinking" em ambos — o agente ainda está no loop de tools.
    const name = String(event.toolName ?? event.title ?? event.name ?? "");
    const input = event.rawInput ?? event.input ?? {};
    const id = typeof event.toolCallId === "string" && event.toolCallId
      ? event.toolCallId
      : undefined;
    const tool: NormalizedTurnEvent = id
      ? { type: "tool", name, input, id }
      : { type: "tool", name, input };
    return [tool];
  }
  if (event.type === "end") return typeof event.sessionId === "string" && event.sessionId
    ? [{ type: "session", sessionId: event.sessionId }, { type: "result" }]
    : [{ type: "result" }];
  if (event.type === "error") return [{ type: "error", message: String(event.message ?? event.data ?? "grok error") }];
  // T-055: usage/plan = progresso real (billing mid-turn, plano de tools) —
  // contam como atividade pro hang watch. Antes eram descartados e o relógio
  // só avançava em text/tool, gerando hard recover em turns legítimos longos.
  if (event.type === "usage") {
    const u = record(event.data) ?? record(event.usage) ?? event;
    return [{
      type: "usage",
      input: Number(u.input_tokens ?? u.input ?? 0),
      output: Number(u.output_tokens ?? u.output ?? 0),
      cacheCreate: Number(u.cache_creation_input_tokens ?? u.cacheCreate ?? 0),
      cacheRead: Number(u.cache_read_input_tokens ?? u.cached_input_tokens ?? u.cacheRead ?? 0),
      cumulative: false,
    }];
  }
  if (event.type === "plan") return [{ type: "plan" }];
  // JSON final (output-format json): { text, sessionId, … }
  if (!event.type && typeof event.text === "string") {
    const out: NormalizedTurnEvent[] = [{ type: "text", text: event.text }];
    if (typeof event.sessionId === "string" && event.sessionId) out.push({ type: "session", sessionId: event.sessionId });
    out.push({ type: "result" });
    return out;
  }
  // T-055: JSON válido com type desconhecido = batimento de vida do CLI
  // (não vira mensagem; só conta atividade via sawSemantic no runner).
  if (typeof event.type === "string" && event.type.length > 0) {
    return [{ type: "plan" }]; // reusa tag leve de "progresso sem texto"
  }
  return [];
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
