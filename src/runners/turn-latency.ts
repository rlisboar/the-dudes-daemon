import { randomUUID } from "node:crypto";

export type SemanticKind = "text" | "thinking" | "tool";
export type SessionMode = "cold" | "resume";
export type TurnEndReason = "completed" | "error" | "process-exit" | "spawn-error" | "stopped" | "cancelled" | "reset" | "retry" | "hard-recover" | "queue-cleared" | "drained";
export type RecoverKind = "hang" | "lifetime";
export type KilledBy = "watchdog" | "hard-timeout" | "stop" | "context-reset" | "token-loop";

/** Metadata only. Durations use a monotonic clock; no payload is retained. */
export class TurnTiming {
  readonly turnId = randomUUID();
  readonly enqueuedAt: number;
  private startedAt: number | null = null;
  private firstAt: number | null = null;
  private firstKind: SemanticKind | null = null;
  private gateAt: number | null = null;
  private gateMs: number | null = null;
  private bootAt: number | null = null;
  private bootMs: number | null = null;
  private ended = false;
  sessionMode: SessionMode | null = null;

  constructor(readonly attempt: number, private readonly emit: (data: Record<string, unknown>) => void,
    private readonly now: () => number = () => performance.now()) { this.enqueuedAt = now(); }

  gateStart(): void { if (!this.ended) this.gateAt = this.now(); }
  gateEnd(): void { if (!this.ended && this.gateAt !== null) this.gateMs = this.now() - this.gateAt; }
  start(): void { if (!this.ended && this.startedAt === null) this.startedAt = this.now(); }
  bootStart(): void { if (!this.ended) this.bootAt = this.now(); }
  bootReady(): void { if (!this.ended && this.bootAt !== null && this.bootMs === null) this.bootMs = this.now() - this.bootAt; }
  setBootMs(ms: number): void { if (!this.ended) this.bootMs = ms; }
  semantic(kind: SemanticKind): void {
    if (this.ended || this.startedAt === null || this.firstAt !== null) return;
    this.firstAt = this.now(); this.firstKind = kind;
  }
  finish(endReason: TurnEndReason, killedBy: KilledBy | null = null, recoverKind: RecoverKind | null = null): void {
    if (this.ended) return;
    this.ended = true;
    const end = this.now();
    const ms = (n: number | null) => n === null ? null : Math.round(n * 1000) / 1000;
    this.emit({ turnId: this.turnId, attempt: this.attempt, phase: "end",
      queueMs: ms(this.startedAt === null ? null : this.startedAt - this.enqueuedAt),
      gateWaitMs: ms(this.gateMs),
      firstEventMs: ms(this.firstAt === null || this.startedAt === null ? null : this.firstAt - this.startedAt),
      durationMs: ms(this.startedAt === null ? null : end - this.startedAt),
      firstEventKind: this.firstKind, endReason, killedBy, recoverKind,
      sessionMode: this.sessionMode, bootMs: ms(this.bootMs) });
  }
}

/** Object identity keeps equal messages distinct; never matches on prompt text. */
export class TurnLatency {
  current: TurnTiming | undefined;
  private readonly queued = new Map<object, TurnTiming>();
  private nextBootMs: number | null = null;
  constructor(private readonly agentId: string, private readonly runner: string,
    private readonly log: (level: "info", message: string) => void) {}
  create(attempt = 0): TurnTiming {
    return new TurnTiming(attempt, fields => {
      // Explicit allowlist in TurnTiming: no names, session IDs, model output or raw errors.
      try { this.log("info", `[turn-latency] ${JSON.stringify({ agentId: this.agentId, runner: this.runner, ...fields })}`); }
      catch { /* Observation must not change runner execution. */ }
    });
  }
  enqueue(message: object, retry = false): void {
    if (!this.queued.has(message)) this.queued.set(message, this.create(retry ? (this.current?.attempt ?? 0) + 1 : 0));
  }
  activate(message: object, mode: SessionMode): TurnTiming {
    const timing = this.queued.get(message) ?? this.create();
    this.queued.delete(message);
    this.current = timing;
    timing.sessionMode = mode;
    if (this.nextBootMs !== null) { timing.setBootMs(this.nextBootMs); this.nextBootMs = null; }
    return timing;
  }
  ensure(mode: SessionMode): TurnTiming { return this.current ?? this.activate({}, mode); }
  bootReady(ms: number): void { this.nextBootMs = ms; }
  discard(message: object, reason: "queue-cleared" | "drained"): void {
    this.queued.get(message)?.finish(reason); this.queued.delete(message);
  }
  finishAll(reason: TurnEndReason, killedBy: KilledBy | null = null, kind: RecoverKind | null = null): void {
    this.current?.finish(reason, killedBy, kind);
    for (const timing of this.queued.values()) timing.finish(reason, killedBy, kind);
    this.queued.clear();
  }
}
