/**
 * Hang detection sem tokens: thresholds por runner e helpers de activity.
 * Grok headless é o pior caso (busy preso sem stream) → soft/hard mais curtos.
 */

import { isGrokFamily } from "./index.js";

export type HangPhase = "ok" | "soft" | "hard";

export interface HangThresholds {
  /** Sem atividade → estado stalled + aviso (ainda não mata). */
  softMs: number;
  /** Sem atividade → SIGKILL do turno + liberar busy. */
  hardMs: number;
  /** Processo morto com busy=true por este tempo → hard recover. */
  deadProcMs: number;
  /** T-240 (a): teto ABSOLUTO de tool in-flight com processo VIVO — passado
   *  isso, assume tool_result perdido e reavalia o hang (grok: ~10min). */
  toolsHardMs: number;
}

export function hangThresholds(runner?: string): HangThresholds {
  if (isGrokFamily(runner)) {
    // Headless + swap thrash: o CLI pode ficar minutos emitindo stderr/stdout
    // de ruído (spinner, logs) sem NENHUM evento semântico (text/tool/result).
    // Se o activity clock contar bytes brutos, soft/hard NUNCA disparam —
    // medido em prod 2026-08-04: turno 21:00:10 sem UMA linha [hang] no log.
    // T-240: hard ≤120s SEM tool in-flight (critério T-009 reinterpretado);
    // COM tool em voo e processo vivo, o teto absoluto é toolsHardMs (~10min)
    // — tsc/suíte/watch de CI rodam minutos sem evento e o hard de 120s
    // matava turnos saudáveis (119 falsos positivos, 67 re-enfileirados no
    // attempt 1 e TODOS completando).
    return { softMs: 60_000, hardMs: 120_000, deadProcMs: 12_000, toolsHardMs: 10 * 60_000 };
  }
  if (runner === "opencode") {
    return { softMs: 180_000, hardMs: 10 * 60_000, deadProcMs: 20_000, toolsHardMs: 20 * 60_000 };
  }
  if (runner === "claude") {
    // Continuous: tools longas (build, test, MCP) não emitem stream por minutos.
    // Soft alto evita "stalled" falso; hard só mata per-message (busy), não o proc contínuo.
    return { softMs: 12 * 60_000, hardMs: 25 * 60_000, deadProcMs: 20_000, toolsHardMs: 20 * 60_000 };
  }
  // codex / crush / gemini (per-message)
  return { softMs: 5 * 60_000, hardMs: 12 * 60_000, deadProcMs: 20_000, toolsHardMs: 20 * 60_000 };
}

export function hangPhase(idleMs: number, t: HangThresholds): HangPhase {
  if (idleMs >= t.hardMs) return "hard";
  if (idleMs >= t.softMs) return "soft";
  return "ok";
}

/** T-240 (a): tool in-flight passou do teto absoluto? (tool_result perdido
 *  ou tool realmente eterna — reavalia o hang em vez de proteger forever.) */
export function toolsInFlightHardDue(toolsAgeMs: number, t: HangThresholds): boolean {
  return toolsAgeMs >= t.toolsHardMs;
}

/** T-240 (d): política de notificação de hard recover. `attempt` = contador
 *  de re-enfileiramento ANTES do recover (0 = 1º attempt dessa mensagem;
 *  attempt≥1 = re-enfileirado antes). `eventsInLastHour` = eventos na janela
 *  de 1h POR AGENTE, incluindo o atual. 1º attempt não notifica
 *  individualmente (agregado: ≥3 na hora vira 1 resumo); a partir do 2º
 *  attempt notifica individualmente. */
export const HARD_RECOVER_SUMMARY_THRESHOLD = 3;

export type HardRecoverNotify = "suppress" | "summary" | "immediate";

export function hardRecoverNotifyPolicy(attempt: number, eventsInLastHour: number): HardRecoverNotify {
  if (attempt >= 1) return "immediate";
  if (eventsInLastHour >= HARD_RECOVER_SUMMARY_THRESHOLD) return "summary";
  return "suppress";
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
