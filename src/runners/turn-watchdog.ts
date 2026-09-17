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
  /** T-371 (d): teto ABSOLUTO de LIFETIME do turno (elapsed desde o início,
   *  não ociosidade). O relógio de soft/hard é de OCIOSIDADE SEMÂNTICA: um
   *  stream em loop de tokens renova-o para sempre e nenhum hardMs o apanha.
   *  Ausente = sem teto (comportamento anterior preservado). */
  lifetimeMs?: number;
  /** T-593: teto de hard ANTES do primeiro evento semântico do turno (cold
   *  start: carga do binário + config + prompt inicial + 1ª resposta do
   *  provedor). Medido no host do dono em 2026-09-16: 121 de 124 hard recovers
   *  caíram no limiar seco de 120s com o turno ainda sem UMA linha semântica,
   *  e 191 avisos soft a ~60-65s — os dois limiares ficavam abaixo do
   *  time-to-first-event real. Ausente = sem janela (comportamento anterior). */
  firstEventMs?: number;
}

/** T-598: teto ABSOLUTO de lifetime do turno qwen. Era 8min (T-371 (d)) —
 *  turnos reais do time (reviews, builds, suítes) duram mais e eram mortos
 *  em rajada sincronizada a cada 8min, cada kill descartando a parcial.
 *  30min: turno real completa; o TextLoopGuard (c) já apanha loop de token
 *  em segundos, então este teto é BACKSTOP de verdade, não o relógio do dia.
 *  FONTE ÚNICA: o par do CLI (QWEN_STREAM_MAX_LIFETIME_MS) deriva daqui. */
export const QWEN_TURN_LIFETIME_MS = 30 * 60_000;

/** T-598: par do teto no CLI do qwen (`QWEN_STREAM_MAX_LIFETIME_MS`).
 *  O guard do CLI é por RESPOSTA de streaming (upstream wait, não turno);
 *  fica ACIMA do teto do daemon para o daemon cortar primeiro — kill com
 *  re-fila e sessão preservada — e o CLI nunca abortar sozinho (aborto do
 *  CLI fecha o turno sem recover e a mensagem em voo se perde). */
export const QWEN_STREAM_MAX_LIFETIME_MS = QWEN_TURN_LIFETIME_MS + 10 * 60_000;

/** T-598: backstop do processo do turno qwen (armHardTimeout). Acima do teto
 *  de lifetime para o watchdog cortar primeiro; se ele próprio disparar,
 *  passa pelo mesmo recover (re-fila + sessão preservada), não por um
 *  SIGKILL seco que perde a mensagem em voo. */
export const QWEN_HARD_TIMEOUT_MS = QWEN_TURN_LIFETIME_MS + 5 * 60_000;

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
    // T-593: o mesmo argumento vale para o cold start, que o toolsInFlight não
    // cobre (a tool só existe DEPOIS do 1º evento). 5min fica 2,4× abaixo do
    // GROK_TURN_TIMEOUT_MS (720s), então um turno travado ANTES de emitir
    // qualquer coisa continua sendo recolhido, só não aos 120s.
    return {
      softMs: 60_000,
      hardMs: 120_000,
      deadProcMs: 12_000,
      toolsHardMs: 10 * 60_000,
      firstEventMs: 5 * 60_000,
    };
  }
  if (runner === "opencode") {
    return { softMs: 180_000, hardMs: 10 * 60_000, deadProcMs: 20_000, toolsHardMs: 20 * 60_000 };
  }
  if (runner === "claude") {
    // Continuous: tools longas (build, test, MCP) não emitem stream por minutos.
    // Soft alto evita "stalled" falso; hard só mata per-message (busy), não o proc contínuo.
    return { softMs: 12 * 60_000, hardMs: 25 * 60_000, deadProcMs: 20_000, toolsHardMs: 20 * 60_000 };
  }
  if (runner === "qwen") {
    // T-371: per-message com resume. Rodadas de API do provedor degradado
    // medem ~85s sem emitir texto — com (e) cada evento de stream repõe o
    // clock, e soft 6min dá margem ao thinking profundo sem esconder o resto.
    // T-598: lifetime 30min (era 8min). O teto é por elapsed e não se renova
    // com atividade — é o que apanha o loop que cospe tokens para sempre (F4),
    // logo hardMs nenhum o apanhava. Fica ACIMA da duração típica do turno
    // (o kill vira backstop) e ABAIXO dos pares do CLI/hard-timeout (abaixo),
    // para o corte sair com re-fila + sessão preservada, nunca em SIGKILL seco.
    return {
      softMs: 6 * 60_000,
      hardMs: 10 * 60_000,
      deadProcMs: 20_000,
      toolsHardMs: 20 * 60_000,
      lifetimeMs: QWEN_TURN_LIFETIME_MS,
    };
  }
  // codex / crush / gemini (per-message)
  return { softMs: 5 * 60_000, hardMs: 12 * 60_000, deadProcMs: 20_000, toolsHardMs: 20 * 60_000 };
}

/** T-593: hard EFETIVO do turno. Antes do primeiro evento semântico vale a
 *  janela de cold start (firstEventMs); depois, o hardMs normal — um turno
 *  que já emitiu e ficou quieto continua sendo recolhido aos 120s. */
export function effectiveHardMs(t: HangThresholds, coldStart: boolean): number {
  return coldStart && t.firstEventMs != null ? Math.max(t.hardMs, t.firstEventMs) : t.hardMs;
}

/** `coldStart` (T-593) = o turno ainda não emitiu nenhum evento semântico.
 *  Default false preserva todos os call sites anteriores à T-593. */
export function hangPhase(idleMs: number, t: HangThresholds, coldStart = false): HangPhase {
  if (idleMs >= effectiveHardMs(t, coldStart)) return "hard";
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
 *  attempt≥1 = re-enfileirado antes). `eventsInLastHour` = eventos de HANG na
 *  janela de 1h POR AGENTE, incluindo o atual. 1º attempt não notifica
 *  individualmente (agregado: ≥3 na hora vira 1 resumo); a partir do 2º
 *  attempt notifica individualmente.
 *
 *  T-598: `kind` separa o corte por TETO DE LIFETIME do hang clássico. Turno
 *  saudável cortado pelo teto é backstop esperado — 1º attempt não notifica
 *  (nem entra no resumo, que é de hang); já re-enfileirado (attempt≥1) segue
 *  imediato porque aí o turno não converge. */
export const HARD_RECOVER_SUMMARY_THRESHOLD = 3;

export type HardRecoverNotify = "suppress" | "summary" | "immediate";
export type HardRecoverKind = "hang" | "lifetime";

export function hardRecoverNotifyPolicy(
  attempt: number,
  eventsInLastHour: number,
  kind: HardRecoverKind = "hang",
): HardRecoverNotify {
  if (attempt >= 1) return "immediate";
  if (kind === "lifetime") return "suppress";
  if (eventsInLastHour >= HARD_RECOVER_SUMMARY_THRESHOLD) return "summary";
  return "suppress";
}

export interface TurnActivityClock {
  lastActivityAt: number;
  softReported: boolean;
  /** Desde quando o processo do turno está morto (busy sem PID). */
  deadSince: number | null;
  /** T-371 (d): início do turno corrente — base do teto de lifetime.
   *  `touchActivityClock` NÃO o move: o teto não se renova com atividade. */
  turnStartedAt: number;
  /** T-593: quando o turno corrente emitiu o PRIMEIRO evento semântico.
   *  `null` = ainda em cold start (janela firstEventMs). `markTurnStart`
   *  reabre a janela a cada spawn; `touchActivityClock` a fecha uma única vez. */
  firstEventAt: number | null;
}

export function createActivityClock(now = Date.now()): TurnActivityClock {
  return { lastActivityAt: now, softReported: false, deadSince: null, turnStartedAt: now, firstEventAt: null };
}

export function touchActivityClock(clock: TurnActivityClock, now = Date.now()): void {
  clock.lastActivityAt = now;
  clock.softReported = false;
  clock.deadSince = null;
  // T-593: primeiro evento semântico do turno fecha a janela de cold start.
  // Uma vez fechada não reabre por atividade — só o próximo spawn.
  if (clock.firstEventAt == null) clock.firstEventAt = now;
}

/** T-371 (d): marca o início do turno corrente (chamar no spawn do turno).
 *  T-593: e reabre a janela de cold start — nenhum evento semântico ainda. */
export function markTurnStart(clock: TurnActivityClock, now = Date.now()): void {
  clock.turnStartedAt = now;
  clock.firstEventAt = null;
}

/** T-371 (d): o turno já passou do teto absoluto de lifetime? Runners sem
 *  `lifetimeMs` nunca vencem (comportamento anterior preservado). */
export function turnLifetimeDue(clock: TurnActivityClock, t: HangThresholds, now = Date.now()): boolean {
  return t.lifetimeMs != null && now - clock.turnStartedAt >= t.lifetimeMs;
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
