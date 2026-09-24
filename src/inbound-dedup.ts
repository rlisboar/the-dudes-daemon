import fs from "node:fs";
import path from "node:path";
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
  /** true se deve processar; false se duplicata. Marca como visto na hora. */
  accept: (deliveryId: string | undefined) => boolean;
  /** T-252: só consulta (não marca) — usado quando o "aceite" da mensagem só
   *  existe após decrypt+processamento; marcar cedo descartaria o retry do
   *  server como duplicata quando o decrypt falha (chave em rotação). */
  isSeen: (deliveryId: string | undefined) => boolean;
  /** T-252: registra como visto no ponto de aceite (após decrypt+process). */
  markSeen: (deliveryId: string | undefined) => void;
  size: () => number;
  clear: () => void;
  /** T-824: ids vistos, do mais antigo ao mais novo (persistidos no reinício). */
  snapshot: () => string[];
} {
  const seen = new Set<string>();
  const order: string[] = [];
  return {
    isSeen(deliveryId) {
      return !!deliveryId && seen.has(deliveryId);
    },
    markSeen(deliveryId) {
      if (!deliveryId) return; // legado sem id — nada a deduplicar
      if (seen.has(deliveryId)) return;
      seen.add(deliveryId);
      order.push(deliveryId);
      while (order.length > maxSeen) {
        const old = order.shift();
        if (old) seen.delete(old);
      }
    },
    accept(deliveryId) {
      if (!deliveryId) return true; // legado sem id — processa
      if (seen.has(deliveryId)) return false;
      this.markSeen(deliveryId);
      return true;
    },
    size: () => seen.size,
    clear: () => {
      seen.clear();
      order.length = 0;
    },
    snapshot: () => [...order],
  };
}

export function createAgentInboundBuffer(opts: {
  maxPerAgent?: number;
  ttlMs?: number;
} = {}): {
  /** Revisão T-818: devolve quantas mensagens MAIS ANTIGAS saíram pelo teto. */
  push: (agentId: string, msg: BufferedInbound) => number;
  drain: (agentId: string) => BufferedInbound[];
  size: (agentId?: string) => number;
  clear: () => void;
  /** T-1005: fila ao vivo — cópia, sem consumir. */
  peek: (agentId: string) => BufferedInbound[];
  /** T-1005: tira a entrega (ainda não entregue ao runner). */
  remove: (agentId: string, deliveryId: string) => boolean;
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
      if (msg.deliveryId && list.some((m) => m.deliveryId === msg.deliveryId)) return 0;
      list.push({ ...msg, enqueuedAt: msg.enqueuedAt || Date.now() });
      let evicted = 0;
      while (list.length > max) { list.shift(); evicted++; }
      byAgent.set(agentId, list);
      return evicted;
    },
    drain(agentId) {
      gc(agentId);
      const list = byAgent.get(agentId) ?? [];
      byAgent.delete(agentId);
      return list;
    },
    peek(agentId) {
      gc(agentId);
      return (byAgent.get(agentId) ?? []).map((m) => ({ ...m }));
    },
    remove(agentId, deliveryId) {
      const list = byAgent.get(agentId);
      if (!list) return false;
      const i = list.findIndex((m) => m.deliveryId === deliveryId);
      if (i < 0) return false;
      list.splice(i, 1);
      if (list.length === 0) byAgent.delete(agentId);
      return true;
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

/**
 * T-824 (revisão): o processo novo manda resumeFromSeq=0 e o server reenvia o
 * buffer inteiro (até 200 msgs dos últimos 5 min). Sem os ids vistos pelo
 * processo anterior, mensagem já processada voltava ao agente e a retida
 * chegava 2× (spool + replay). O processo que sai grava; o novo carrega antes
 * de conectar. Ids não são segredo (identificam entrega, não conteúdo).
 */
export const DELIVERY_SEEN_FILE = "delivery-seen.json";
export const DELIVERY_SEEN_TTL_MS = 15 * 60_000;

export function saveDeliverySeen(dir: string, ids: string[], now = Date.now()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, DELIVERY_SEEN_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: now, ids }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadDeliverySeen(dir: string, now = Date.now()): string[] {
  const file = path.join(dir, DELIVERY_SEEN_FILE);
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8")) as { savedAt?: number; ids?: unknown };
    if (!Array.isArray(d.ids) || now - Number(d.savedAt || 0) > DELIVERY_SEEN_TTL_MS) return [];
    return d.ids.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}
