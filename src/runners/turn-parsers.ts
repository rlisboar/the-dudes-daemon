export type NormalizedTurnEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "usage"; input: number; output: number; cacheCreate: number; cacheRead: number; cumulative: boolean }
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
  if (type === "text" && typeof part.text === "string" && part.text.trim()) out.push({ type: "text", text: part.text.trim() });
  else if (["tool", "tool_use", "tool_call"].includes(type)) {
    const state = record(part.state);
    if (!state?.status || state.status === "completed" || state.status === "error") {
      out.push({ type: "tool", name: String(part.tool ?? part.name ?? state?.name ?? ""), input: state?.input ?? part.input ?? {} });
    }
  } else if (type === "step_start") out.push({ type: "result" });
  else if (type === "step_finish") {
    const tokens = record(part.tokens);
    if (tokens) out.push(usageFromTokens(tokens));
  }
  return out;
}

export function parseGrokStreamEvent(raw: unknown): NormalizedTurnEvent[] {
  const event = record(raw);
  if (!event) return [];
  if (event.type === "text" && typeof event.data === "string") return [{ type: "text", text: event.data }];
  if (event.type === "thought" && typeof event.data === "string") return [{ type: "thought", text: event.data }];
  if (event.type === "end") return typeof event.sessionId === "string" && event.sessionId
    ? [{ type: "session", sessionId: event.sessionId }, { type: "result" }]
    : [{ type: "result" }];
  if (event.type === "error") return [{ type: "error", message: String(event.message ?? event.data ?? "grok error") }];
  if (!event.type && typeof event.text === "string") {
    const out: NormalizedTurnEvent[] = [{ type: "text", text: event.text }];
    if (typeof event.sessionId === "string" && event.sessionId) out.push({ type: "session", sessionId: event.sessionId });
    out.push({ type: "result" });
    return out;
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
