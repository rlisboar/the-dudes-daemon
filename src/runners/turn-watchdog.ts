/**
 * Hang detection sem tokens: thresholds por runner e helpers de activity.
 * Grok headless é o pior caso (busy preso sem stream) → soft/hard mais curtos.
 */

export type HangPhase = "ok" | "soft" | "hard";

export interface HangThresholds {
  /** Sem atividade → estado stalled + aviso (ainda não mata). */
  softMs: number;
  /** Sem atividade → SIGKILL do turno + liberar busy. */
  hardMs: number;
  /** Processo morto com busy=true por este tempo → hard recover. */
  deadProcMs: number;
}

export function hangThresholds(runner?: string): HangThresholds {
  if (runner === "grok") {
    return { softMs: 90_000, hardMs: 5 * 60_000, deadProcMs: 15_000 };
  }
  if (runner === "opencode") {
    return { softMs: 180_000, hardMs: 10 * 60_000, deadProcMs: 20_000 };
  }
  // claude continuous / codex / crush / gemini
  return { softMs: 150_000, hardMs: 8 * 60_000, deadProcMs: 20_000 };
}

export function hangPhase(idleMs: number, t: HangThresholds): HangPhase {
  if (idleMs >= t.hardMs) return "hard";
  if (idleMs >= t.softMs) return "soft";
  return "ok";
}

export interface TurnActivityClock {
  lastActivityAt: number;
  softReported: boolean;
  /** Desde quando o processo do turno está morto (busy sem PID). */
  deadSince: number | null;
}

export function createActivityClock(now = Date.now()): TurnActivityClock {
  return { lastActivityAt: now, softReported: false, deadSince: null };
}

export function touchActivityClock(clock: TurnActivityClock, now = Date.now()): void {
  clock.lastActivityAt = now;
  clock.softReported = false;
  clock.deadSince = null;
}
