/**
 * T-037: dedup de agent:send por deliveryId + fila local se runner ausente.
 *
 * Server pode reenviar o mesmo deliveryId (pending queue + resume buffer).
 * Daemon ignora o segundo. Se o runner ainda não existe (gap pós-spawn /
 * self-update), buffera até o spawn completar.
 */

export interface BufferedInbound {
  deliveryId?: string;
  content: string;
  images?: unknown[];
  enqueuedAt: number;
}

export function createDeliveryDeduper(maxSeen = 500): {
  /** true se deve processar; false se duplicata. */
  accept: (deliveryId: string | undefined) => boolean;
  size: () => number;
  clear: () => void;
} {
  const seen = new Set<string>();
  const order: string[] = [];
  return {
    accept(deliveryId) {
      if (!deliveryId) return true; // legado sem id — processa
      if (seen.has(deliveryId)) return false;
      seen.add(deliveryId);
      order.push(deliveryId);
      while (order.length > maxSeen) {
        const old = order.shift();
        if (old) seen.delete(old);
      }
      return true;
    },
    size: () => seen.size,
    clear: () => {
      seen.clear();
      order.length = 0;
    },
  };
}

export function createAgentInboundBuffer(opts: {
  maxPerAgent?: number;
  ttlMs?: number;
} = {}): {
  push: (agentId: string, msg: BufferedInbound) => void;
  drain: (agentId: string) => BufferedInbound[];
  size: (agentId?: string) => number;
  clear: () => void;
} {
  const max = opts.maxPerAgent ?? 20;
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  const byAgent = new Map<string, BufferedInbound[]>();

  const gc = (agentId: string) => {
    const list = byAgent.get(agentId);
    if (!list) return;
    const cutoff = Date.now() - ttlMs;
    const next = list.filter((m) => m.enqueuedAt >= cutoff);
    if (next.length === 0) byAgent.delete(agentId);
    else byAgent.set(agentId, next);
  };

  return {
    push(agentId, msg) {
      gc(agentId);
      const list = byAgent.get(agentId) ?? [];
      if (msg.deliveryId && list.some((m) => m.deliveryId === msg.deliveryId)) return;
      list.push({ ...msg, enqueuedAt: msg.enqueuedAt || Date.now() });
      while (list.length > max) list.shift();
      byAgent.set(agentId, list);
    },
    drain(agentId) {
      gc(agentId);
      const list = byAgent.get(agentId) ?? [];
      byAgent.delete(agentId);
      return list;
    },
    size(agentId) {
      if (agentId) {
        gc(agentId);
        return byAgent.get(agentId)?.length ?? 0;
      }
      let n = 0;
      for (const list of byAgent.values()) n += list.length;
      return n;
    },
    clear: () => byAgent.clear(),
  };
}
