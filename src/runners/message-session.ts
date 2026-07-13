import type { ImageAttachment } from "../types.js";

export interface QueuedMessage {
  content: string;
  images?: ImageAttachment[];
}

export interface FirstTurnSnapshot {
  firstTurn: boolean;
  pendingSummary?: string;
}

export class PerMessageSessionState {
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

  enqueue(message: QueuedMessage, maxSize: number): boolean {
    if (this.queue.length >= maxSize) return false;
    this.queue.push(message);
    return true;
  }

  prepend(message: QueuedMessage): void { this.queue.unshift(message); }
  dequeue(): QueuedMessage | undefined { return this.queue.shift(); }
  queuedCount(): number { return this.queue.length; }

  clearQueue(): number {
    const count = this.queue.length;
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
