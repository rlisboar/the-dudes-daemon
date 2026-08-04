/**
 * Monitor de saúde do daemon — a fonte dos indicadores da UI e do visor de
 * logs de debug.
 *
 * Motivação: diagnosticar o daemon exigia SSH/tail no arquivo de log da
 * máquina onde ele roda. Os três hangs de grok e o vazamento de plaintext
 * foram todos investigados assim — quem não tem o terminal aberto não vê
 * nada além de "agente não responde". Este módulo mantém, em memória:
 *
 *  - um ring buffer das últimas linhas de log (JÁ passadas pelo scrub — o
 *    hook fica depois da redação de tokens/e2e em main.log);
 *  - contadores de turnos por runner (iniciado/ok/falha/hard-recover/hang);
 *  - durações recentes de turnos para p50/p95;
 *  - o RTT do ping WS com o orchestrator.
 *
 * O snapshot vai pro server a cada heartbeat (daemon:health) e o server
 * repassa aos clientes do dono. Os logs só saem sob demanda
 * (daemon:logs:get) — são maiores e raramente necessários.
 */

export type HealthLogLevel = "info" | "warn" | "error";

export interface HealthLogLine {
  ts: number;
  level: HealthLogLevel;
  msg: string;
}

export interface TurnCounters {
  started: number;
  ok: number;
  failed: number;
  hardRecovers: number;
  hangs: number;
}

export interface HealthSnapshot {
  ts: number;
  uptimeS: number;
  memRssMb: number;
  wsRttMs: number | null;
  turnGate: { active: number; queued: number; max: number };
  turns: TurnCounters;
  turnP50Ms: number | null;
  turnP95Ms: number | null;
  byRunner: Record<string, TurnCounters>;
  agentsRunning: number;
  e2eeProjects: number;
}

const LOG_CAP = 600;
const DURATION_CAP = 200;

const startedAt = Date.now();
const ring: HealthLogLine[] = [];
const durations: number[] = [];
let wsRttMs: number | null = null;

const zero = (): TurnCounters => ({ started: 0, ok: 0, failed: 0, hardRecovers: 0, hangs: 0 });
const total: TurnCounters = zero();
const byRunner = new Map<string, TurnCounters>();

function counters(runner: string): TurnCounters {
  let c = byRunner.get(runner);
  if (!c) { c = zero(); byRunner.set(runner, c); }
  return c;
}

/** Hook do log central. `msg` DEVE chegar já passada pelo scrub. */
export function recordLog(level: HealthLogLevel, msg: string): void {
  ring.push({ ts: Date.now(), level, msg });
  if (ring.length > LOG_CAP) ring.splice(0, ring.length - LOG_CAP);
}

/** Últimas `limit` linhas, mais antigas primeiro. */
export function recentLogs(limit = 300): HealthLogLine[] {
  const n = Math.max(1, Math.min(LOG_CAP, Math.floor(limit)));
  return ring.slice(-n);
}

export function recordTurnStart(runner: string): void {
  total.started++;
  counters(runner).started++;
}

export function recordTurnEnd(runner: string, durationMs: number, ok: boolean): void {
  const c = counters(runner);
  if (ok) { total.ok++; c.ok++; } else { total.failed++; c.failed++; }
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    durations.push(durationMs);
    if (durations.length > DURATION_CAP) durations.splice(0, durations.length - DURATION_CAP);
  }
}

export function recordHang(runner: string): void {
  total.hangs++;
  counters(runner).hangs++;
}

export function recordHardRecover(runner: string): void {
  total.hardRecovers++;
  counters(runner).hardRecovers++;
}

export function recordWsRtt(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) wsRttMs = Math.round(ms);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[i]!);
}

export function healthSnapshot(deps: {
  turnGate: { ativos: number; fila: number; max: number };
  agentsRunning: number;
  e2eeProjects: number;
}): HealthSnapshot {
  const sorted = [...durations].sort((a, b) => a - b);
  const runners: Record<string, TurnCounters> = {};
  for (const [k, v] of byRunner) runners[k] = { ...v };
  return {
    ts: Date.now(),
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    memRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    wsRttMs,
    turnGate: { active: deps.turnGate.ativos, queued: deps.turnGate.fila, max: deps.turnGate.max },
    turns: { ...total },
    turnP50Ms: percentile(sorted, 0.5),
    turnP95Ms: percentile(sorted, 0.95),
    byRunner: runners,
    agentsRunning: deps.agentsRunning,
    e2eeProjects: deps.e2eeProjects,
  };
}

/** Só para teste: zera o estado global do módulo. */
export function _resetForTest(): void {
  ring.length = 0;
  durations.length = 0;
  wsRttMs = null;
  Object.assign(total, zero());
  byRunner.clear();
}
