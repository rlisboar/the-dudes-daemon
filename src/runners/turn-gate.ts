/**
 * Semáforo de turnos de CLI per-message (dois pools).
 *
 * Cada turno de runner per-message (grok/gemini/codex/crush/opencode cold)
 * sobe um processo novo de ~100–130MB. Sem teto, N agentes respondendo ao
 * mesmo tempo somam N processos simultâneos — medido em produção: 4 turnos de
 * grok concorrentes num host com swap a 98,6%, e turnos pequenos (400 bytes)
 * congelando em 0% CPU até estourar o watchdog de 720s. O gargalo não era o
 * CLI: era a máquina paginando.
 *
 * T-055: dois pools — `main` (turnos de agente) e `bg` (summarizer / one-shot
 * auxiliar). Antes summarizer e sub-trabalhos competiam no mesmo MAX=3 e a
 * fila do gate era contada como hang. Pools separados evitam que TTS/graph
 * roubem slots dos agentes e vice-versa.
 *
 * O gate serializa o EXCESSO: até MAX rodam livres; o resto espera na
 * fila em ordem de chegada. Guarda anti-deadlock: slot não liberado em
 * MAX_HOLD_MS é liberado à força.
 */

import { QWEN_HARD_TIMEOUT_MS } from "./turn-watchdog.js";

type Log = (level: "info" | "warn", msg: string) => void;

export type TurnGatePool = "main" | "bg";

const MAX_MAIN = (() => {
  const raw = parseInt(process.env.THE_DUDES_MAX_CLI_TURNS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 3;
})();

/** Pool de background (summarizer, shim, compact one-shot). Default 2. */
const MAX_BG = (() => {
  const raw = parseInt(process.env.THE_DUDES_MAX_BG_CLI_TURNS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 2;
})();

/** Acima do MAIOR hard-timeout legítimo (qwen, T-598: 35min) + folga: só
 *  dispara em slot vazado. Antes era 15min (grok 720s + folga) e um turno
 *  qwen saudável >15min — que a T-598 tornou o caso normal — era "liberado à
 *  força" no meio do turno com log falso de slot preso. */
const MAX_HOLD_MS = QWEN_HARD_TIMEOUT_MS + 5 * 60_000;

/** Exposto pra teste (T-598): o valve anti-deadlock tem de ficar ACIMA do
 *  maior hold legítimo, senão um turno saudável é liberado à força. */
export const TURN_GATE_MAX_HOLD_MS = MAX_HOLD_MS;

interface PoolState {
  max: number;
  ativos: number;
  fila: Array<() => void>;
  name: TurnGatePool;
}

const pools: Record<TurnGatePool, PoolState> = {
  main: { max: MAX_MAIN, ativos: 0, fila: [], name: "main" },
  bg: { max: MAX_BG, ativos: 0, fila: [], name: "bg" },
};

/* T-812: quem segura e quem espera slot, e desde quando — o dashboard de
 * debug mostra o gargalo por nome em vez de só "3 ativos, 2 na fila". */
interface SlotInfo { label: string; pool: TurnGatePool; since: number }
const WAIT_SAMPLES = 300;
let slotSeq = 0;
const holders = new Map<number, SlotInfo>();
const waiters = new Map<number, SlotInfo>();
const poolStats: Record<TurnGatePool, { grants: number; waited: number; forced: number; waitMs: number[] }> = {
  main: { grants: 0, waited: 0, forced: 0, waitMs: [] },
  bg: { grants: 0, waited: 0, forced: 0, waitMs: [] },
};

function proximo(p: PoolState): void {
  while (p.fila.length > 0 && p.ativos < p.max) {
    p.fila.shift()!();
  }
}

/**
 * Espera um slot e devolve o release. O release é idempotente; chame no
 * 'close' do processo E nos caminhos de erro — chamadas repetidas são no-op.
 *
 * @param pool `main` (default) = turnos de agente; `bg` = summarizer/one-shot.
 */
export function acquireTurnSlot(
  label: string,
  log?: Log,
  pool: TurnGatePool = "main",
): Promise<() => void> {
  const p = pools[pool] ?? pools.main;
  const id = ++slotSeq;
  const pedidoEm = Date.now();
  let enfileirado = false;
  return new Promise((resolve) => {
    const conceder = () => {
      p.ativos++;
      waiters.delete(id);
      holders.set(id, { label, pool: p.name, since: Date.now() });
      const st = poolStats[p.name];
      st.grants++;
      if (enfileirado) {
        st.waited++;
        st.waitMs.push(Date.now() - pedidoEm);
        if (st.waitMs.length > WAIT_SAMPLES) st.waitMs.splice(0, st.waitMs.length - WAIT_SAMPLES);
      }
      let liberado = false;
      const release = () => {
        if (liberado) return;
        liberado = true;
        clearTimeout(guarda);
        holders.delete(id);
        p.ativos--;
        proximo(p);
      };
      const guarda = setTimeout(() => {
        log?.(
          "warn",
          `[turn-gate:${p.name}] slot de ${label} preso há ${MAX_HOLD_MS / 60000}min — liberando à força`,
        );
        poolStats[p.name].forced++;
        release();
      }, MAX_HOLD_MS);
      guarda.unref?.();
      resolve(release);
    };
    if (p.ativos < p.max) {
      conceder();
    } else {
      log?.(
        "info",
        `[turn-gate:${p.name}] ${label} aguardando slot (${p.ativos} ativos, ${p.fila.length + 1} na fila, max ${p.max})`,
      );
      enfileirado = true;
      waiters.set(id, { label, pool: p.name, since: pedidoEm });
      p.fila.push(conceder);
    }
  });
}

/** Visibilidade pra logs/testes/health (pool main = o que a UI mostra). */
export function turnGateStats(): {
  ativos: number;
  fila: number;
  max: number;
  bg: { ativos: number; fila: number; max: number };
} {
  return {
    ativos: pools.main.ativos,
    fila: pools.main.fila.length,
    max: pools.main.max,
    bg: {
      ativos: pools.bg.ativos,
      fila: pools.bg.fila.length,
      max: pools.bg.max,
    },
  };
}

export interface TurnGateDebug {
  pools: Record<TurnGatePool, {
    max: number;
    active: number;
    queued: number;
    grants: number;
    /** Concessões que esperaram fila (> 0ms). */
    waited: number;
    /** Slots liberados à força pelo anti-deadlock (MAX_HOLD_MS). */
    forced: number;
    waitP50Ms: number | null;
    waitP95Ms: number | null;
    waitMaxMs: number | null;
  }>;
  holders: Array<{ label: string; pool: TurnGatePool; heldMs: number }>;
  waiters: Array<{ label: string; pool: TurnGatePool; waitingMs: number }>;
  maxHoldMs: number;
}

/** T-812: visão detalhada do gate para o dashboard de debug. */
export function turnGateDebug(now = Date.now()): TurnGateDebug {
  const pct = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]! : null);
  const pool = (name: TurnGatePool) => {
    const st = poolStats[name];
    const sorted = [...st.waitMs].sort((a, b) => a - b);
    return {
      max: pools[name].max,
      active: pools[name].ativos,
      queued: pools[name].fila.length,
      grants: st.grants,
      waited: st.waited,
      forced: st.forced,
      waitP50Ms: pct(sorted, 0.5),
      waitP95Ms: pct(sorted, 0.95),
      waitMaxMs: sorted.length ? sorted[sorted.length - 1]! : null,
    };
  };
  return {
    pools: { main: pool("main"), bg: pool("bg") },
    holders: [...holders.values()].map((h) => ({ label: h.label, pool: h.pool, heldMs: now - h.since })).sort((a, b) => b.heldMs - a.heldMs),
    waiters: [...waiters.values()].map((w) => ({ label: w.label, pool: w.pool, waitingMs: now - w.since })).sort((a, b) => b.waitingMs - a.waitingMs),
    maxHoldMs: MAX_HOLD_MS,
  };
}

/** Testes: zera contadores (não cancela promises pendentes). */
export function _resetTurnGateForTest(): void {
  for (const p of Object.values(pools)) {
    p.ativos = 0;
    p.fila.length = 0;
  }
  holders.clear();
  waiters.clear();
  for (const st of Object.values(poolStats)) {
    st.grants = 0;
    st.waited = 0;
    st.forced = 0;
    st.waitMs.length = 0;
  }
}
