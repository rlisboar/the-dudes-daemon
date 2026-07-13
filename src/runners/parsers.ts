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
