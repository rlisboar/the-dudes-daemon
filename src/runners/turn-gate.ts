/**
 * Semáforo global de turnos de CLI per-message.
 *
 * Cada turno de runner per-message (grok/gemini/codex/crush/opencode cold)
 * sobe um processo novo de ~100–130MB. Sem teto, N agentes respondendo ao
 * mesmo tempo somam N processos simultâneos — medido em produção: 4 turnos de
 * grok concorrentes num host com swap a 98,6%, e turnos pequenos (400 bytes)
 * congelando em 0% CPU até estourar o watchdog de 720s. O gargalo não era o
 * CLI: era a máquina paginando.
 *
 * O gate serializa o EXCESSO: até MAX_TURNS rodam livres; o resto espera na
 * fila em ordem de chegada. Um turno enfileirado custa latência; um turno
 * thrashando custa a sessão inteira (hard recover + reenvio de 40–50KB).
 *
 * Guarda anti-deadlock: se um slot não for liberado em MAX_HOLD_MS (o caso
 * "close nunca veio"), ele é liberado à força com warn — a fila nunca trava
 * por causa de um processo zumbi.
 */

type Log = (level: "info" | "warn", msg: string) => void;

const MAX_TURNS = (() => {
  const raw = parseInt(process.env.THE_DUDES_MAX_CLI_TURNS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 3;
})();

/** Acima do hard-timeout do grok (720s) + folga: só dispara em slot vazado. */
const MAX_HOLD_MS = 15 * 60_000;

let ativos = 0;
const fila: Array<() => void> = [];

function proximo(): void {
  while (fila.length > 0 && ativos < MAX_TURNS) {
    fila.shift()!();
  }
}

/**
 * Espera um slot e devolve o release. O release é idempotente; chame no
 * 'close' do processo E nos caminhos de erro — chamadas repetidas são no-op.
 */
export function acquireTurnSlot(label: string, log?: Log): Promise<() => void> {
  return new Promise((resolve) => {
    const conceder = () => {
      ativos++;
      let liberado = false;
      const release = () => {
        if (liberado) return;
        liberado = true;
        clearTimeout(guarda);
        ativos--;
        proximo();
      };
      const guarda = setTimeout(() => {
        log?.("warn", `[turn-gate] slot de ${label} preso há ${MAX_HOLD_MS / 60000}min — liberando à força`);
        release();
      }, MAX_HOLD_MS);
      guarda.unref?.();
      resolve(release);
    };
    if (ativos < MAX_TURNS) {
      conceder();
    } else {
      log?.("info", `[turn-gate] ${label} aguardando slot (${ativos} ativos, ${fila.length + 1} na fila, max ${MAX_TURNS})`);
      fila.push(conceder);
    }
  });
}

/** Visibilidade pra logs/testes. */
export function turnGateStats(): { ativos: number; fila: number; max: number } {
  return { ativos, fila: fila.length, max: MAX_TURNS };
}
