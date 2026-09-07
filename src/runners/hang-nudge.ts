/**
 * T-364: auto-continue de hard stall com nudge sintético.
 *
 * O hard recover (recoverHungTurn) mata o turno zumbi, mas deixa o agente
 * idle: o trabalho interrompido só continua se o user mandar outra mensagem.
 * Aqui fica a política do empurrão automático — pura (sem timers, sem proc),
 * porque AgentRunner não é injetável e o monólito não tem como cobrir as
 * linhas 3 de orçamento. A chamada vive só dentro de recoverHungTurn, que é
 * o caminho da fase HARD; a fase soft nunca passa por aqui.
 */

import type { QueuedMessage } from "./message-session.js";

/** Conteúdo EXATO da mensagem sintética (contrato T-364). */
export const HANG_RECOVER_NUDGE_TEXT =
  "Última execução interrompida por falha do runner (hang detectado). Retoma o trabalho interrompido.";

/** Flag na fila: distingue o nudge de mensagem do user (T-364). */
export const HANG_RECOVER_NUDGE_FLAG = "hang-recover";

/** Orçamento: máx 2 auto-continues por janela rolante de 30 min por agente. */
export const HANG_RECOVER_NUDGE_MAX = 2;
export const HANG_RECOVER_NUDGE_WINDOW_MS = 30 * 60_000;

/**
 * Backoff antes de cada tentativa do orçamento: 1ª nudge 5s, 2ª 30s. Nunca
 * imediato — o proc recém-SIGKILL ainda pode estar caindo e um nudge na hora
 * herda o mesmo estado zumbi que acabou de ser morto.
 */
export const HANG_RECOVER_NUDGE_BACKOFF_MS = [5_000, 30_000];

/** Só o necessário de PerMessageSessionState (testável com a classe real). */
export interface HangNudgeQueue {
  queuedCount(): number;
  enqueue(message: QueuedMessage, maxSize: number): boolean;
}

export interface HangNudgePlan {
  /** Enfileirar um nudge (após `backoffMs`). */
  nudge: boolean;
  /** Orçamento esgotado: notificar o dono e parar de automatizar. */
  notify: boolean;
  /** Janela rolante APÓS o plano (nudge contabilizado quando planejado). */
  sentTimes: number[];
  backoffMs: number;
  /** Quantos nudges já constam da janela, incluindo este plano. */
  used: number;
}

/**
 * Decide o nudge de um hard recover. `queueLength` é o tamanho da fila DEPOIS
 * do re-enfileiramento legítimo da mensagem em voo: fila com trabalho real já
 * retoma sozinha e o nudge só duplicaria tokens. Fila vazia não queima
 * orçamento quando não há o que empurrar (motivo estrutural, não tentativa).
 */
export function planHangRecoverNudge(input: {
  queueLength: number;
  now: number;
  sentTimes: number[];
  windowMs?: number;
  max?: number;
  backoffMs?: number[];
}): HangNudgePlan {
  const max = input.max ?? HANG_RECOVER_NUDGE_MAX;
  const windowMs = input.windowMs ?? HANG_RECOVER_NUDGE_WINDOW_MS;
  const backoffs = input.backoffMs ?? HANG_RECOVER_NUDGE_BACKOFF_MS;
  const kept = input.sentTimes.filter((ts) => input.now - ts < windowMs);
  if (input.queueLength > 0) {
    return { nudge: false, notify: false, sentTimes: kept, backoffMs: 0, used: kept.length };
  }
  if (kept.length >= max) {
    return { nudge: false, notify: true, sentTimes: kept, backoffMs: 0, used: kept.length };
  }
  return {
    nudge: true,
    notify: false,
    sentTimes: [...kept, input.now],
    backoffMs: backoffs[kept.length] ?? backoffs[backoffs.length - 1] ?? 0,
    used: kept.length + 1,
  };
}

/**
 * Enfileira o nudge no mesmo queue do runner. Re-checa a fila no instante da
 * entrega: se chegou mensagem real durante o backoff, ela já retoma o agente
 * e o nudge é descartado (orçamento já gasto — anti-loop conservador).
 */
export function deliverHangRecoverNudge(queue: HangNudgeQueue, maxSize: number): boolean {
  if (queue.queuedCount() > 0) return false;
  return queue.enqueue(
    { content: HANG_RECOVER_NUDGE_TEXT, synthetic: HANG_RECOVER_NUDGE_FLAG },
    maxSize,
  );
}
