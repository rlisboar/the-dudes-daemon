import type { ImageAttachment } from "../types.js";
import { sameTurnPrincipal, type InboundTurnPrincipal } from "./turn-security.js";

export interface QueuedMessage {
  content: string;
  images?: ImageAttachment[];
  /** T-364: origem não-user na fila (ex.: "hang-recover"). */
  synthetic?: string;
  /** T-842: id de entrega, para o spool do SIGTERM não perder o dedup. */
  deliveryId?: string;
  /** T-1300: server-authenticated actor for this individual delivery. */
  principal?: InboundTurnPrincipal;
  /** T-1005: ids das mensagens agrupadas NESTE item (T-818) — a fila ao vivo
   *  mostra cada uma; remover qualquer delas tira o item inteiro. */
  coalescedIds?: string[];
}

/** T-818: o que `enqueueOrCoalesce` fez com a mensagem. */
export type EnqueueOutcome = "queued" | "coalesced" | "dropped";

/** T-818: separador entre mensagens agrupadas no mesmo item da fila. */
export const COALESCE_SEPARATOR = "\n\n--- mensagem seguinte (agrupada: a fila do agente estava no teto) ---\n\n";

export interface FirstTurnSnapshot {
  firstTurn: boolean;
  pendingSummary?: string;
}

export class PerMessageSessionState {
  constructor(private readonly observe?: {
    reset(): void;
    queued(message: QueuedMessage, retry: boolean): void;
    discarded(message: QueuedMessage, reason: "queue-cleared" | "drained"): void;
  }) {}
  sessionId?: string;
  needsPrime = false;
  busy = false;
  firstTurn = true;
  pendingSummary?: string;
  epoch = 0;
  private queue: QueuedMessage[] = [];

  resume(sessionId: string, input: { needsPrime: boolean; alreadyHasSystemPrompt: boolean }): void {
    this.sessionId = sessionId;
    this.needsPrime = input.needsPrime;
    if (input.alreadyHasSystemPrompt) this.firstTurn = false;
  }

  reset(summary?: string): void {
    this.observe?.reset();
    this.epoch++;
    this.sessionId = undefined;
    this.needsPrime = false;
    this.firstTurn = true;
    this.pendingSummary = summary;
  }

  resetForRetry(summary?: string): void {
    this.sessionId = undefined;
    this.firstTurn = true;
    this.pendingSummary = summary;
  }

  /**
   * Invalida turnos em voo (close/finish tardio do proc morto).
   * Sem isso, finishGrokTurn.finally zera busy de um turno NOVO e o
   * agente fica mudo até restart manual (sintoma: Claude→Grok “para”).
   */
  bumpEpoch(): void {
    this.observe?.reset();
    this.epoch++;
  }

  enqueue(message: QueuedMessage, maxSize: number): boolean {
    if (this.queue.length >= maxSize) return false;
    this.observe?.queued(message, false);
    this.queue.push(message);
    return true;
  }

  /**
   * T-818: com a fila no teto, a mensagem nova era DESCARTADA em silêncio (59
   * descartes em 7 dias nos dois perfis do dono; quem mandou nunca soube).
   * Agora ela entra no fim da última mensagem de usuário ainda não iniciada:
   * nada se perde, a ordem de chegada se mantém e a fila continua com no
   * máximo `maxSize` turnos. Só descarta quando o item agrupado passaria de
   * `maxBytes` em UTF-8 (flood, loop agent↔agent) — o caller avisa. O teto é
   * em BYTES porque grok/codex/gemini/crush levam o prompt no argv, e o Linux
   * limita cada argumento a 128 KiB (E2BIG perderia o item inteiro).
   * Sintética (hang-recover) não recebe mensagem de usuário: o dreno a deixa
   * de fora.
   */
  enqueueOrCoalesce(message: QueuedMessage, maxSize: number, maxBytes: number): EnqueueOutcome {
    if (this.enqueue(message, maxSize)) return "queued";
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const alvo = this.queue[i]!;
      if (alvo.synthetic) continue;
      if (!sameTurnPrincipal(alvo.principal, message.principal)) continue;
      const content = alvo.content + COALESCE_SEPARATOR + message.content;
      if (Buffer.byteLength(content, "utf8") > maxBytes) return "dropped";
      alvo.content = content;
      if (message.images?.length) alvo.images = [...(alvo.images ?? []), ...message.images];
      if (message.deliveryId) alvo.coalescedIds = [...(alvo.coalescedIds ?? []), message.deliveryId];
      return "coalesced";
    }
    return "dropped";
  }

  prepend(message: QueuedMessage): void { this.observe?.queued(message, true); this.queue.unshift(message); }
  dequeue(): QueuedMessage | undefined { return this.queue.shift(); }
  queuedCount(): number { return this.queue.length; }

  /** T-720: dreno do self-update — devolve e esvazia a fila de mensagens
   *  ainda NÃO iniciadas (o turno em curso não está aqui). Sintéticas
   *  (ex.: hang-recover) não são do usuário e ficam de fora. */
  takeAllForDrain(): QueuedMessage[] {
    const out = this.queue.filter((m) => !m.synthetic);
    for (const m of this.queue) this.observe?.discarded(m, "drained");
    this.queue = [];
    return out;
  }

  /** T-1005: fila ao vivo — cópia do que ainda não virou turno (sintéticas
   *  ficam de fora: não são do usuário). Não consome. */
  peekAll(): QueuedMessage[] {
    return this.queue.filter((m) => !m.synthetic).map((m) => ({ ...m }));
  }

  /** T-1005: tira da fila o item (ainda não iniciado) desta entrega — pelo id
   *  próprio ou por um id agrupado nele. `null` se não está na fila. */
  removeByDeliveryId(deliveryId: string): QueuedMessage | null {
    const i = this.queue.findIndex((m) => !m.synthetic && (m.deliveryId === deliveryId || m.coalescedIds?.includes(deliveryId)));
    if (i < 0) return null;
    const [m] = this.queue.splice(i, 1);
    this.observe?.discarded(m!, "queue-cleared");
    return m!;
  }

  clearQueue(): number {
    const count = this.queue.length;
    for (const m of this.queue) this.observe?.discarded(m, "queue-cleared");
    this.queue = [];
    return count;
  }

  owns(epoch: number, sessionId?: string): boolean {
    return epoch === this.epoch && (sessionId === undefined || sessionId === this.sessionId);
  }

  consumeFirstTurn(): FirstTurnSnapshot {
    const snapshot = { firstTurn: this.firstTurn, pendingSummary: this.pendingSummary };
    this.firstTurn = false;
    this.pendingSummary = undefined;
    return snapshot;
  }

  consumeFirstTurnIfNeeded(): FirstTurnSnapshot {
    return this.firstTurn ? this.consumeFirstTurn() : { firstTurn: false };
  }

  restoreFirstTurn(snapshot: FirstTurnSnapshot): void {
    if (!snapshot.firstTurn || this.firstTurn) return;
    this.firstTurn = true;
    if (this.pendingSummary === undefined) this.pendingSummary = snapshot.pendingSummary;
  }
}
