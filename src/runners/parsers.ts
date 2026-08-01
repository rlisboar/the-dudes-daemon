import path from "node:path";
import { realpathSync } from "node:fs";
import type { CliRunner } from "../types.js";

export interface GrokContextSignals {
  contextTokensUsed: number;
  contextWindowTokens: number;
  contextWindowUsage: number;
}

export function parseGrokContextSignals(raw: unknown): GrokContextSignals | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const used = Number(value.contextTokensUsed ?? 0);
  const limit = Number(value.contextWindowTokens ?? 0);
  const pct = Number(value.contextWindowUsage ?? 0);
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(limit) || limit <= 0) return null;
  return {
    contextTokensUsed: Math.floor(used),
    contextWindowTokens: Math.floor(limit),
    contextWindowUsage: Number.isFinite(pct) ? pct : Math.round((used / limit) * 100),
  };
}

/**
 * Ocupação da janela a partir de updates.jsonl do Grok CLI.
 *
 * NÃO use `usage.totalTokens` / max regex: no turn_completed multi-step
 * (`modelCalls`/`numTurns` > 1) esses campos somam billing do loop de tools
 * e inflacionam 4–12× a janela real (ex.: 939k vs signals 78k; vimos turns
 * com usage.inputTokens > 10M).
 *
 * Fonte correta no stream: último `params._meta.totalTokens` (espelha
 * `signals.contextTokensUsed`). Rejeita valores absurdo (> teto da janela).
 */
export function parseGrokUpdatesContextTokens(text: string, maxTokens = 2_000_000): number {
  let last = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('"totalTokens"')) continue;
    try {
      const event = JSON.parse(trimmed) as {
        params?: { _meta?: { totalTokens?: unknown; updateType?: unknown } };
      };
      const meta = event.params?._meta;
      const n = Number(meta?.totalTokens);
      // Só confia em meta de chunk de mensagem (não em billing de turn_completed).
      if (!Number.isFinite(n) || n <= 0) continue;
      if (n > maxTokens) continue; // billing multi-step disfarçado
      last = Math.floor(n);
    } catch { /* linha incompleta / ruído */ }
  }
  return last;
}

/** Usage de billing do último turn_completed (somatório do loop de tools do turno). */
export interface GrokTurnBilling {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * Lê o último `turn_completed.usage` do updates.jsonl.
 * Campos são do TURNO (não cumulativos da sessão) — ok somar no billing.
 * NÃO usar pra janela de contexto (inputTokens multi-step infla).
 */
export function parseGrokTurnBillingFromUpdates(text: string): GrokTurnBilling | null {
  let last: GrokTurnBilling | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("turn_completed")) continue;
    try {
      const event = JSON.parse(trimmed) as {
        params?: {
          update?: {
            sessionUpdate?: string;
            usage?: Record<string, unknown>;
          };
        };
      };
      const upd = event.params?.update;
      if (upd?.sessionUpdate !== "turn_completed") continue;
      const u = upd.usage;
      if (!u || typeof u !== "object") continue;
      const input = Math.floor(Number(u.inputTokens ?? 0));
      const output = Math.floor(Number(u.outputTokens ?? 0));
      const cacheRead = Math.floor(Number(u.cachedReadTokens ?? 0));
      const cacheCreate = Math.floor(Number(u.cacheCreationTokens ?? 0));
      if (!Number.isFinite(input) || input < 0) continue;
      last = {
        input: Math.max(0, input),
        output: Math.max(0, Number.isFinite(output) ? output : 0),
        cacheRead: Math.max(0, Number.isFinite(cacheRead) ? cacheRead : 0),
        cacheCreate: Math.max(0, Number.isFinite(cacheCreate) ? cacheCreate : 0),
      };
    } catch { /* ignore */ }
  }
  return last;
}

/**
 * Combina signals.json (preferido) com fallback de updates.jsonl.
 * Nunca promove billing acumulado acima da ocupação real do signals.
 * Se used > limit (ex.: contaminação com usage multi-step), clamp no limit.
 */
export function mergeGrokContextOccupancy(
  signals: GrokContextSignals | null,
  updatesTokens: number,
  fallbackLimit: number,
): GrokContextSignals | null {
  const limit = signals?.contextWindowTokens && signals.contextWindowTokens > 0
    ? signals.contextWindowTokens
    : fallbackLimit;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  // updates só como fallback e nunca acima da janela (billing multi-step
  // tipo 5.13M não vaza pra barra).
  const fromUpdates = Number.isFinite(updatesTokens) && updatesTokens > 0
    ? Math.min(Math.floor(updatesTokens), Math.floor(limit))
    : 0;
  // signals com used>0 é a fonte autoritativa da janela.
  let used = signals && signals.contextTokensUsed > 0
    ? signals.contextTokensUsed
    : fromUpdates > 0
      ? fromUpdates
      : signals?.contextTokensUsed ?? 0;
  if (used <= 0 && !signals) return null;
  // Contaminação / overflow: ocupação da UI nunca > limit.
  if (used > limit) used = limit;
  return {
    contextTokensUsed: Math.floor(used),
    contextWindowTokens: Math.floor(limit),
    contextWindowUsage: Math.min(100, Math.round((used / limit) * 100)),
  };
}

export function normalizeGrokCwd(cwd: string): string {
  const resolved = path.resolve(cwd || ".");
  try { return realpathSync(resolved); } catch { return resolved; }
}

export function grokSignalsPath(grokHome: string, cwd: string, sessionId: string): string {
  return path.join(grokHome, "sessions", encodeURIComponent(normalizeGrokCwd(cwd)), sessionId, "signals.json");
}

export interface GrokChatToolCall { id: string; name: string; input: unknown }

export function parseGrokChatToolCalls(line: string): GrokChatToolCall[] {
  if (!line.includes('"tool_calls"')) return [];
  try {
    const event = JSON.parse(line) as { type?: string; tool_calls?: { id?: string; name?: string; arguments?: unknown }[] };
    if (event.type !== "assistant" || !Array.isArray(event.tool_calls)) return [];
    return event.tool_calls.flatMap((call) => {
      if (typeof call?.id !== "string" || !call.id) return [];
      let input: unknown = {};
      if (typeof call.arguments === "string") {
        try { input = JSON.parse(call.arguments); } catch { input = { raw: call.arguments }; }
      } else if (call.arguments && typeof call.arguments === "object") input = call.arguments;
      return [{ id: call.id, name: typeof call.name === "string" ? call.name : "", input }];
    });
  } catch { return []; }
}

function parseNdjson(out: string, select: (event: Record<string, unknown>) => string | undefined): string[] {
  const texts: string[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const text = select(event);
      if (text) texts.push(text);
    } catch { /* ignore malformed/provider noise */ }
  }
  return texts;
}

export function extractOneShotText(out: string, runner: CliRunner): string {
  if (runner === "codex") {
    return parseNdjson(out, (event) => {
      const item = event.item as Record<string, unknown> | undefined;
      return event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string" ? item.text : undefined;
    }).join("\n").trim();
  }
  if (runner === "gemini") {
    return parseNdjson(out, (event) => event.type === "message" && event.role === "assistant" ? String(event.content ?? "") : undefined).join("\n").trim();
  }
  if (runner === "opencode") {
    const clean = out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    return parseNdjson(clean, (event) => {
      const part = event.part as Record<string, unknown> | undefined;
      return event.type === "text" && typeof part?.text === "string" ? part.text : undefined;
    }).join("\n").trim();
  }
  if (runner === "grok") {
    const trimmed = out.trim();
    if (trimmed.startsWith("{")) {
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof event.text === "string" && event.text.trim()) return event.text.trim();
        if (event.type === "error") return "";
      } catch { /* try NDJSON */ }
    }
    return parseNdjson(out, (event) => event.type === "text" && typeof event.data === "string"
      ? event.data
      : typeof event.text === "string" ? event.text : undefined).join("").trim();
  }
  return out.trim();
}
