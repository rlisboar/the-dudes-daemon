/**
 * Entrega outbound daemon→server (WS).
 *
 * Hipótese T-009 (dono): hang “mudo” em WAN mas não em orch local.
 * Causa compatível no código: `ws.send` era fire-and-forget e, se o socket
 * não estava OPEN (ou backpressure), o frame era descartado em silêncio —
 * o CLI já tinha terminado, busy=false, watchdog de processo não dispara.
 *
 * Este módulo:
 *  - classifica mensagens críticas (texto/erro/hung/exit do agente);
 *  - decide se o canal aceita envio (OPEN + bufferedAmount);
 *  - enfileira críticas quando o envio falha, pra flush no reconnect.
 */

export type OutboundWire = { type: string; [k: string]: unknown };

const CRITICAL_TYPES = new Set([
  "agent:text",
  "agent:error",
  "agent:hung",
  "agent:exit",
  "agent:thinking",
  "agent:tool_use",
]);

export function isCriticalOutbound(msg: OutboundWire): boolean {
  return CRITICAL_TYPES.has(msg.type);
}

export interface ChannelState {
  readyState: number;
  /** OPEN do WebSocket (ws package = 1). */
  openState: number;
  bufferedAmount: number;
}

/** true se o socket aceita um envio agora (sem garantia de ACK do peer). */
export function channelCanSend(
  ch: ChannelState | null | undefined,
  maxBuffered = 4 * 1024 * 1024,
): boolean {
  if (!ch) return false;
  if (ch.readyState !== ch.openState) return false;
  if (ch.bufferedAmount > maxBuffered) return false;
  return true;
}

export interface OutboundQueue {
  /** JSON já serializado — evita re-stringificar no flush. */
  items: Array<{ type: string; json: string }>;
  max: number;
}

export function createOutboundQueue(max = 80): OutboundQueue {
  return { items: [], max };
}

export function enqueueCritical(
  q: OutboundQueue,
  msg: OutboundWire,
  json: string,
): void {
  if (!isCriticalOutbound(msg)) return;
  q.items.push({ type: msg.type, json });
  while (q.items.length > q.max) q.items.shift();
}

/**
 * Tenta enviar; se falhar e for crítica, enfileira.
 * @returns true se o frame foi passado ao socket.
 */
export function trySendOutbound(input: {
  msg: OutboundWire;
  json: string;
  canSend: boolean;
  send: (json: string) => void;
  queue: OutboundQueue;
}): boolean {
  if (input.canSend) {
    try {
      input.send(input.json);
      return true;
    } catch {
      enqueueCritical(input.queue, input.msg, input.json);
      return false;
    }
  }
  enqueueCritical(input.queue, input.msg, input.json);
  return false;
}

/** Flush FIFO; para no primeiro falha (canal caiu de novo). Retorna enviados. */
export function flushOutboundQueue(input: {
  queue: OutboundQueue;
  canSend: () => boolean;
  send: (json: string) => void;
}): number {
  let n = 0;
  while (input.queue.items.length > 0) {
    if (!input.canSend()) break;
    const item = input.queue.items[0]!;
    try {
      input.send(item.json);
      input.queue.items.shift();
      n++;
    } catch {
      break;
    }
  }
  return n;
}
