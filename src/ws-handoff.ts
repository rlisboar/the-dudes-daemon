/**
 * T-846 — handoff de token entre processos.
 *
 * O #843 (server) faz o hello de uma conexão NOVA com o mesmo token fechar a
 * anterior com 4000 "superseded" (acaba com a entrega duplicada de dois
 * processos vivos). O hello `passive: true` é a retomada: com o token ocupado o
 * server fecha a NOVA com 4001 "occupied"; se o vencedor morreu, ela é aceita.
 *
 * Regra do daemon:
 *  - 4000 "superseded": para os CLIs locais, loga uma vez e volta PASSIVO
 *    depois de um cooldown (30s), com backoff até 5min. NÃO sai do processo.
 *  - 4001 "occupied": o outro processo segue vivo; fica parado e tenta de novo
 *    passivo, com o mesmo backoff. Sem replay e sem revezamento.
 *  - qualquer outro close: comportamento de sempre (reconexão normal).
 *
 * Processo que sobe (boot/restart/update) manda hello normal e substitui o
 * antigo — por isso o passivo vale só para quem foi superseded.
 */

export const CODE_SUPERSEDED = 4000;
export const CODE_OCCUPIED = 4001;

/** Cooldown mínimo antes de tentar voltar passivo. */
export const PASSIVO_BASE_MS = 30_000;
/** Teto do backoff do passivo. */
export const PASSIVO_CAP_MS = 5 * 60_000;

/** Base mutável só para teste (o cooldown real de 30s deixaria o teste lento). */
let passivoBaseMs = PASSIVO_BASE_MS;
export function _setPassivoBaseForTest(ms: number): void {
  passivoBaseMs = ms;
}

export type DecisaoClose = "normal" | "passivo-superseded" | "passivo-occupied";

/** Só o close combinando código E motivo exato entra no caminho passivo. */
export function decidirClose(code: number, reason: string): DecisaoClose {
  if (code === CODE_SUPERSEDED && reason === "superseded") return "passivo-superseded";
  if (code === CODE_OCCUPIED && reason === "occupied") return "passivo-occupied";
  return "normal";
}

/**
 * Próximo cooldown do passivo: 30s na primeira vez e dobrando até o teto de
 * 5min, com jitter de ±25% (dois hosts no mesmo token não batem de frente).
 */
export function proximoDelayPassivo(atualMs: number, aleatorio: () => number = Math.random): number {
  const bruto = atualMs > 0 ? atualMs * 2 : passivoBaseMs;
  const teto = Math.min(bruto, PASSIVO_CAP_MS);
  return Math.floor(teto * (0.75 + aleatorio() * 0.5));
}