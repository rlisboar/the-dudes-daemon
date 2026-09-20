import type { ImageAttachment } from "../types.js";

export interface QueuedMessage {
  content: string;
  images?: ImageAttachment[];
  /** T-364: origem não-user na fila (ex.: "hang-recover"). */
  synthetic?: string;
}

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
