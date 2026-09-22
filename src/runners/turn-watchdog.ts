/**
 * Hang detection sem tokens: thresholds por runner e helpers de activity.
 * Grok headless é o pior caso (busy preso sem stream) → soft/hard mais curtos.
 */

import { isGrokFamily } from "./index.js";

export type HangPhase = "ok" | "soft" | "hard";

export interface HangThresholds {
  /** Sem atividade → estado stalled + aviso (ainda não mata). */
  softMs: number;
  /** Sem atividade → SIGKILL do turno + liberar busy. Piso do teto EFETIVO:
   *  com firstEventMs (T-593) ou postEventMs (T-685) declarados, o teto sobe
   *  nessa fase — ver effectiveHardMs. */
  hardMs: number;
  /** Processo morto com busy=true por este tempo → hard recover. */
  deadProcMs: number;
  /** T-240 (a): teto ABSOLUTO de tool in-flight com processo VIVO — passado
   *  isso, assume tool_result perdido e reavalia o hang (grok: ~10min). */
  toolsHardMs: number;
  /** T-371 (d) / T-749: janela de LIFETIME sem PROGRESSO (ociosidade semântica
   *  desde o último evento). Um stream em loop de tokens renova-a para sempre
   *  e nenhum hardMs o apanha; para isso existe o `lifetimeCapMs`.
   *  Ausente = sem teto (comportamento anterior preservado). */
  lifetimeMs?: number;
  /** T-749: teto ABSOLUTO de lifetime do turno (elapsed desde o início, NÃO
   *  renovado por atividade). É o backstop do loop que emite eventos sem
   *  nunca terminar (F4): a janela `lifetimeMs` renovaria para sempre.
   *  Ausente = sem cap (comportamento T-598 preservado para outros runners). */
  lifetimeCapMs?: number;
  /** T-593: teto de hard ANTES do primeiro evento semântico do turno (cold
   *  start: carga do binário + config + prompt inicial + 1ª resposta do
   *  provedor). Medido no host do dono em 2026-09-16: 121 de 124 hard recovers
   *  caíram no limiar seco de 120s com o turno ainda sem UMA linha semântica,
   *  e 191 avisos soft a ~60-65s — os dois limiares ficavam abaixo do
   *  time-to-first-event real. Ausente = sem janela (comportamento anterior). */
  firstEventMs?: number;
  /** T-685: teto de hard DEPOIS do primeiro evento semântico, SEM tool em voo.
   *  O silêncio do MODELO entre eventos (effort alto, contexto grande) não é
   *  zumbi; medido no host do dono em 2026-09-18: 11 kills da classe em
   *  120-124s com turno VIVO e toolsInFlight==0 — o 1º token fechava a janela
   *  firstEventMs (T-593) e o hardMs seco voltava a valer. Ausente = hardMs
   *  (comportamento anterior preservado). */
  postEventMs?: number;
}

/** T-598/T-749: janela de lifetime do turno qwen, agora RENOVÁVEL por evento
 *  semântico. Era um teto absoluto de 8min (T-371 (d)), depois 30min fixo
 *  (T-598); a medição da T-730 mostrou 79 cortes em 17–19/09 (todos qwen),
 *  48,1% com atividade <60s antes do corte — trabalho vivo morria só por
 *  elapsed. Com a renovação, 30min passa a significar "sem NENHUM evento há
 *  30min"; turno produtivo segue até o cap. */
export const QWEN_TURN_LIFETIME_MS = 30 * 60_000;

/** T-749: teto ABSOLUTO de lifetime do turno qwen, NÃO renovável. Preserva o
 *  apanhe do loop que emite eventos para sempre (F4, que motivou o T-598):
 *  com a janela renovável, só o cap o corta. 2× a janela = 60min — os 2
 *  cortes de QA em 19/09 (1803/1804s, ambos com progresso) completariam
 *  dentro dele.
 *
 *  T-749 (review T-748): os 3 TIERS derivam JUNTOS daqui, com esta ordem
 *  obrigatória — `window < cap < hard-timeout < stream-max`:
 *  - `QWEN_TURN_LIFETIME_MS` (janela, renovável) é o corte por progresso;
 *  - este cap é o corte absoluto (não renovável);
 *  - `QWEN_HARD_TIMEOUT_MS` é o backstop do PROCESSO, acima do cap para o
 *    watchdog cortar primeiro (e, se disparar, passa pelo mesmo recover);
 *  - `QWEN_STREAM_MAX_LIFETIME_MS` é o guard do CLI, acima de todos para o
 *    CLI nunca abortar sozinho e perder a mensagem em voo.
 *  Se um tier não-renovável ficar ABAIXO do cap, o turno saudável morre pelo
 *  tier errado (o cap nunca é alcançado). Teste: t598 (C6). */
export const QWEN_TURN_LIFETIME_CAP_MS = 2 * QWEN_TURN_LIFETIME_MS;

/** T-598/T-749: par do teto no CLI do qwen (`QWEN_STREAM_MAX_LIFETIME_MS`).
 *  O guard do CLI é por RESPOSTA de streaming (upstream wait, não turno);
 *  fica ACIMA do cap do daemon para o daemon cortar primeiro — kill com
 *  re-fila e sessão preservada — e o CLI nunca abortar sozinho (aborto do
 *  CLI fecha o turno sem recover e a mensagem em voo se perde). */
export const QWEN_STREAM_MAX_LIFETIME_MS = QWEN_TURN_LIFETIME_CAP_MS + 10 * 60_000;

/** T-598/T-749: backstop do processo do turno qwen (armHardTimeout). Acima do
 *  cap de lifetime para o watchdog cortar primeiro; se ele próprio disparar,
 *  passa pelo mesmo recover (re-fila + sessão preservada), não por um
 *  SIGKILL seco que perde a mensagem em voo. */
export const QWEN_HARD_TIMEOUT_MS = QWEN_TURN_LIFETIME_CAP_MS + 5 * 60_000;

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
    // T-685: e DEPOIS do 1º evento o silêncio real do modelo (effort xhigh,
    // contexto ~138k) estourava o hardMs seco — 11 kills da classe em 120-124s
    // em 2026-09-18, todos com turno vivo e 0 tool em voo. O teto pós-evento
    // ganha o mesmo orçamento de 5min (postEventMs): trava real segue
    // recolhida, aos 5min em vez de 2min (custo aceito pela direção).
    // T-784: soft aos 60s era FALSO stalled — o log real cai em 60–65s com o
    // turno VIVO. Cold start (firstEventAt null) não pode virar stalled antes
    // da janela firstEventMs (5min); pós-1º evento, soft sobe para 3min.
    // Hard segue no teto pós-evento (postEventMs, 5min). Stderr bruto segue
    // sem contar (touch é só semântico).
    return {
      softMs: 3 * 60_000,
      hardMs: 120_000,
      deadProcMs: 12_000,
      toolsHardMs: 10 * 60_000,
      firstEventMs: 5 * 60_000,
      postEventMs: 5 * 60_000,
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
    // T-598: lifetime 30min (era 8min). T-749: a janela de 30min agora RENOVA
    // a cada evento semântico; o que apanha o loop que cospe tokens para
    // sempre (F4) é o cap absoluto de 60min (abaixo, hardMs nenhum o apanha).
    // O cap fica ACIMA da duração típica do turno (o kill vira backstop) e
    // ABAIXO dos pares do CLI/hard-timeout (abaixo), para o corte sair com
    // re-fila + sessão preservada, nunca em SIGKILL seco.
    return {
      softMs: 6 * 60_000,
      hardMs: 10 * 60_000,
      deadProcMs: 20_000,
      toolsHardMs: 20 * 60_000,
      lifetimeMs: QWEN_TURN_LIFETIME_MS,
      lifetimeCapMs: QWEN_TURN_LIFETIME_CAP_MS,
    };
  }
  if (runner === "dsh") {
    // T-690: ACP v1 stdio (persistent) — NÃO família grok, o hard seco de
    // 120s não vale. Medição (PM, 16:5xZ): boot+compose do profile ~13-19s,
    // session/new ~1s, prompt trivial ~2s; updates semânticos (message/
    // thought/tool/usage) repõem o clock durante o turno. Sem tool em voo:
    // soft 3min / hard 6min (compor contexto pode ficar minutos sem update);
    // tool em voo: teto próprio de 15min (build/suíte). Cold start: janela de
    // 5min cobre boot+compose com >3× de margem.
    return {
      softMs: 3 * 60_000,
      hardMs: 6 * 60_000,
      deadProcMs: 15_000,
      toolsHardMs: 15 * 60_000,
      firstEventMs: 5 * 60_000,
    };
  }
  // codex / crush / gemini (per-message)
  return { softMs: 5 * 60_000, hardMs: 12 * 60_000, deadProcMs: 20_000, toolsHardMs: 20 * 60_000 };
}

/** T-593/T-685: hard EFETIVO do turno. Antes do primeiro evento semântico
 *  vale a janela de cold start (firstEventMs); DEPOIS dele vale o teto
 *  pós-evento (postEventMs) — um turno que já emitiu e ficou quieto segue
 *  sendo recolhido, no teto declarado, não no hardMs seco. */
export function effectiveHardMs(t: HangThresholds, coldStart: boolean): number {
  if (coldStart) return t.firstEventMs != null ? Math.max(t.hardMs, t.firstEventMs) : t.hardMs;
  return t.postEventMs != null ? Math.max(t.hardMs, t.postEventMs) : t.hardMs;
}

/** `coldStart` (T-593) = o turno ainda não emitiu nenhum evento semântico.
 *  Default false = regime pós-evento (T-685: postEventMs quando declarado);
 *  para runners sem janelas declaradas preserva os call sites anteriores.
 *  T-784: em cold start o soft não acende antes de firstEventMs — "stalled"
 *  aos 60s com o CLI ainda carregando era falso. */
export function hangPhase(idleMs: number, t: HangThresholds, coldStart = false): HangPhase {
  if (idleMs >= effectiveHardMs(t, coldStart)) return "hard";
  const softMs = coldStart && t.firstEventMs != null ? Math.max(t.softMs, t.firstEventMs) : t.softMs;
  if (idleMs >= softMs) return "soft";
  return "ok";
}

/** T-240 (a): tool in-flight passou do teto absoluto? (tool_result perdido
 *  ou tool realmente eterna — reavalia o hang em vez de proteger forever.) */
export function toolsInFlightHardDue(toolsAgeMs: number, t: HangThresholds): boolean {
  return toolsAgeMs >= t.toolsHardMs;
}

/**
 * T-705: GROK_TURN_TIMEOUT_MS (720s) era SIGKILL absoluto — matava turno
 * saudável com thought/tool recentes. Amarrado no watchdog: só mata se o
 * relógio de ociosidade já venceu o teto pós-evento (e a proteção de tool
 * em voo, se houver). Turno SEM evento recente continua recolhido.
 */
export function grokAbsoluteTimeoutShouldKill(opts: {
  idleMs: number;
  toolsInFlight: number;
  toolsAgeMs: number;
  runner?: string;
}): boolean {
  const t = hangThresholds(opts.runner ?? "grok");
  const grace = t.postEventMs ?? t.hardMs;
  if (opts.idleMs < grace) return false;
  if (opts.toolsInFlight > 0 && !toolsInFlightHardDue(opts.toolsAgeMs, t)) return false;
  return true;
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
  /** T-371 (d) / T-749: início do turno corrente — base do cap ABSOLUTO de
   *  lifetime. `touchActivityClock` NÃO o move (o cap não se renova); quem se
   *  renova é a janela, que usa `lastActivityAt`. */
  turnStartedAt: number;
  /** T-593: quando o turno corrente emitiu o PRIMEIRO evento semântico.
   *  `null` = ainda em cold start (janela firstEventMs). `markTurnStart`
   *  reabre a janela a cada spawn; `touchActivityClock` a fecha uma única vez.
   *  Fechada = regime pós-evento (T-685: teto postEventMs). */
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

export type LifetimeExceeded = "progress" | "cap";

/**
 * T-371 (d) / T-749: qual teto de lifetime venceu, se algum.
 * - `"cap"`: elapsed desde o início ≥ `lifetimeCapMs` — absoluto, NÃO renovável
 *   (backstop do loop que emite eventos para sempre, F4).
 * - `"progress"`: sem NENHUM evento semântico há `lifetimeMs` — a janela se
 *   renova a cada `touchActivityClock`.
 * `null` = turno dentro dos dois. Runners sem os campos nunca vencem
 * (comportamento anterior preservado).
 */
export function turnLifetimeExceeded(clock: TurnActivityClock, t: HangThresholds, now = Date.now()): LifetimeExceeded | null {
  // Cap primeiro: se ambos venceram, o absoluto é a causa mais forte da linha.
  if (t.lifetimeCapMs != null && now - clock.turnStartedAt >= t.lifetimeCapMs) return "cap";
  if (t.lifetimeMs != null && now - clock.lastActivityAt >= t.lifetimeMs) return "progress";
  return null;
}

/** T-371 (d): o turno já passou de algum teto de lifetime? */
export function turnLifetimeDue(clock: TurnActivityClock, t: HangThresholds, now = Date.now()): boolean {
  return turnLifetimeExceeded(clock, t, now) !== null;
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
