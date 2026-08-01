import type { AgentUsage } from "../types.js";
import { classifyRunnerFailure } from "./error-classifier.js";
export { CONTEXT_FULL_PATTERNS, RATE_LIMIT_TEXT_RE } from "./error-classifier.js";

export type UsageSemantics = "anthropic" | "inclusive" | "auto";

export function contextTokensOf(delta: AgentUsage, semantics: UsageSemantics): number {
  if (semantics === "anthropic") return delta.input + delta.cacheCreate + delta.cacheRead;
  if (semantics === "inclusive") return delta.input;
  return delta.cacheCreate + delta.cacheRead <= delta.input
    ? delta.input
    : delta.input + delta.cacheCreate + delta.cacheRead;
}

const CONTEXT_WARN_PCT = 0.85;
const CONTEXT_FULL_COOLDOWN_MS = 120_000;
const MAX_COMPACT_FAIL_STREAK = 3;

export class ContextTracker {
  private used = 0;
  private resolvedModel?: string;
  private catalogLimit?: number;
  private warned = false;
  private lastFullAt = 0;
  private compactFailStreak = 0;

  constructor(private readonly input: {
    resolveLimit: (resolvedModel: string | undefined, catalogLimit: number | undefined) => number;
    onUsage?: (used: number, limit: number) => void;
    onWarning?: (used: number, limit: number) => void;
    onFull?: () => void;
    onError?: (message: string) => void;
    now?: () => number;
  }) {}

  lastUsed(): number { return this.used; }
  limit(): number { return this.input.resolveLimit(this.resolvedModel, this.catalogLimit); }
  catalogLimitValue(): number | undefined { return this.catalogLimit; }
  setResolvedModel(model: string): void { if (model) this.resolvedModel = model; }
  setCatalogLimit(limit: number): void { if (Number.isFinite(limit) && limit > 0) this.catalogLimit = Math.floor(limit); }

  reset(): void {
    this.warned = false;
    this.lastFullAt = 0;
    this.used = 0;
    this.compactFailStreak = 0;
    this.input.onUsage?.(0, this.limit());
  }

  reportUsage(delta: AgentUsage, semantics: UsageSemantics): void {
    const total = contextTokensOf(delta, semantics);
    if (total > 0) this.reportOccupancy(total);
  }

  reportOccupancy(used: number, limitHint?: number): void {
    if (!Number.isFinite(used) || used < 0) return;
    const mapped = this.limit();
    const limit = limitHint && Number.isFinite(limitHint) && limitHint > 0
      ? Math.max(mapped, Math.floor(limitHint)) : mapped;
    // Ocupação da janela nunca deve exceder o teto. Valores > limit costumam
    // ser billing multi-step (Grok usage.inputTokens soma modelCalls) vazando
    // pra barra — clamp pra UI/pct e pra auto-compact não disparar em falso.
    let next = Math.floor(used);
    if (limit > 0 && next > limit) {
      next = limit;
    }
    this.used = next;
    this.input.onUsage?.(this.used, limit);
    if (this.used <= 0) return;
    const pct = this.used / limit;
    if (pct >= 1) this.notifyFull();
    else if (pct >= CONTEXT_WARN_PCT && !this.warned) {
      this.warned = true;
      this.input.onWarning?.(this.used, limit);
    }
  }

  notifyFull(): void {
    if (this.compactFailStreak >= MAX_COMPACT_FAIL_STREAK) return;
    const now = (this.input.now ?? Date.now)();
    if (now - this.lastFullAt < CONTEXT_FULL_COOLDOWN_MS) return;
    this.lastFullAt = now;
    this.input.onFull?.();
  }

  checkFullError(message: string): void {
    if (classifyRunnerFailure(message) === "context_full") this.notifyFull();
  }

  registerCompactFailure(): void {
    this.compactFailStreak++;
    if (this.compactFailStreak >= MAX_COMPACT_FAIL_STREAK) {
      this.input.onError?.(`[ctx] compact falhou ${this.compactFailStreak}x seguidas — auto-compaction suspensa; limpe o contexto manualmente`);
    } else {
      this.input.onError?.("[ctx] compact: sem resumo utilizável — sessão antiga preservada; tente de novo ou limpe o contexto");
    }
  }
}

export class CumulativeUsageTracker<T extends Record<string, number>> {
  constructor(private base: T | null) {}

  reset(base: T): void { this.base = base; }
  current(): T | null { return this.base; }

  prime(base: T): void { if (this.base === null) this.base = base; }

  delta(next: T): T {
    const base = this.base;
    this.base = next;
    return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, Math.max(0, value - (base?.[key] ?? 0))])) as T;
  }
}
