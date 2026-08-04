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
    // Headless + swap thrash: o CLI pode ficar minutos emitindo stderr/stdout
    // de ruído (spinner, logs) sem NENHUM evento semântico (text/tool/result).
    // Se o activity clock contar bytes brutos, soft/hard NUNCA disparam —
    // medido em prod 2026-08-04: turno 21:00:10 sem UMA linha [hang] no log.
    // hard ≤120s: aceitável pro user e critério de aceite T-009; soft avisa
    // antes. armHardTimeout de 12min continua como backstop absoluto.
    return { softMs: 60_000, hardMs: 120_000, deadProcMs: 12_000 };
  }
  if (runner === "opencode") {
    return { softMs: 180_000, hardMs: 10 * 60_000, deadProcMs: 20_000 };
  }
  if (runner === "claude") {
    // Continuous: tools longas (build, test, MCP) não emitem stream por minutos.
    // Soft alto evita "stalled" falso; hard só mata per-message (busy), não o proc contínuo.
    return { softMs: 12 * 60_000, hardMs: 25 * 60_000, deadProcMs: 20_000 };
  }
  // codex / crush / gemini (per-message)
  return { softMs: 5 * 60_000, hardMs: 12 * 60_000, deadProcMs: 20_000 };
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

/**
 * Enquanto há tool em voo e ainda dentro do teto, o hang watch NÃO deve
 * hard-recover (shell/MCP longos). Exportada pra teste (T-009 critério 5).
 */
export function toolsInFlightBlocksHang(
  toolsInFlight: number,
  toolsAgeMs: number,
  maxMs: number,
): boolean {
  return toolsInFlight > 0 && toolsAgeMs < maxMs;
}
