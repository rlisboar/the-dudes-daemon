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

/** Acima do hard-timeout do grok (720s) + folga: só dispara em slot vazado. */
const MAX_HOLD_MS = 15 * 60_000;

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
  return new Promise((resolve) => {
    const conceder = () => {
      p.ativos++;
      let liberado = false;
      const release = () => {
        if (liberado) return;
        liberado = true;
        clearTimeout(guarda);
        p.ativos--;
        proximo(p);
      };
      const guarda = setTimeout(() => {
        log?.(
          "warn",
          `[turn-gate:${p.name}] slot de ${label} preso há ${MAX_HOLD_MS / 60000}min — liberando à força`,
        );
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

/** Testes: zera contadores (não cancela promises pendentes). */
export function _resetTurnGateForTest(): void {
  for (const p of Object.values(pools)) {
    p.ativos = 0;
    p.fila.length = 0;
  }
}
