/**
 * T-899 — fila de espera retida.
 *
 * Hoje o stop do agente DESCARTA a fila não iniciada (`clearQueue`) e o que
 * chega com o agente parado vai para um runner morto. Aqui a fila passa a ser
 * retida por agente e reentregue no spawn, na ordem, uma vez só.
 *
 * Espelha o dreno do T-720 (`takeQueuedForDrain`): o MESMO conjunto de fontes
 * (fila do message-session, buffer de restart do claude, stdin em voo do claude
 * e fila do dsh) — a diferença é o destino: lá o spool do re-exec, aqui a
 * retenção por agente.
 *
 * Regras do parecer do SECURITY (#901):
 *  - cifra na saída (AAD v2 de `messages/content` + `messages/images`), nunca
 *    plaintext; sem chave o item FICA local e o log declara;
 *  - `deliveryId` é a chave de idempotência (reentrega/retenção repetida não
 *    duplica);
 *  - cap por agente com descarte DECLARADO (nunca silencioso);
 *  - `source` explícito por call site (stop | context-clear | inbound).
 */
import { createHash } from "node:crypto";
import type { ImageAttachment } from "./types.js";
import type { InboundTurnPrincipal } from "./runners/turn-security.js";
import { encryptForProject, encryptImageBase64, isE2eEncrypted } from "./daemon-crypto.js";
import { aadV2, E2EE_TABLE } from "@the-dudes/protocol/e2ee-fields";

/**
 * Origem do item. `replace` = o runner do agente foi substituído (respawn/
 * reconfig) com fila em mãos: a fila é do AGENTE e passa para o runner novo.
 */
export type FonteRetencao = "stop" | "inbound-ttl" | "manual" | "inbound" | "replace" | "context-clear" | "loop-stop" | "migrate";

export interface ItemRetido {
  deliveryId?: string;
  content: string;
  images?: ImageAttachment[];
  enqueuedAt: number;
  source: FonteRetencao;
  /** Proveniência autenticada local; no fio só enviamos `from` como sender. */
  principal?: InboundTurnPrincipal;
}

/** Cap por agente. Acima disso o mais antigo sai (declarado no log). */
export const CAP_POR_AGENTE = 200;

/**
 * T-899 (parecer do SECURITY): TTL PRÓPRIO do item retido. O `SPOOL_TTL_MS` é de
 * 1 h, afinado para um re-exec — não para um stop que dura o fim de semana. O
 * dono pediu "sobrevive até ser entregue ou apagado", então o padrão aqui é
 * DIAS (override por env). Item vencido sai com log, nunca em silêncio.
 */
export const TTL_ITEM_MS = Math.max(60_000, Number(process.env.THE_DUDES_QUEUE_RETAINED_TTL_MS ?? 7 * 24 * 60 * 60_000));

/** Remove itens vencidos e devolve quantos saíram (o host loga). */
export function expirar(agora = Date.now()): number {
  let saiu = 0;
  for (const [agentId, estado] of porAgente) {
    const antes = estado.itens.length;
    estado.itens = estado.itens.filter((i) => agora - i.enqueuedAt <= TTL_ITEM_MS);
    const removidos = antes - estado.itens.length;
    if (removidos > 0) {
      saiu += removidos;
      const chaves = chavesDe.get(agentId);
      if (chaves) {
        // as chaves dos itens que ficaram são reconstruídas no próximo take
        chavesDe.set(agentId, new Set(estado.itens.map(chaveItem)));
      }
      if (estado.itens.length === 0) porAgente.delete(agentId);
    }
  }
  return saiu;
}

/** Item já pronto para o fio: cipher, nunca claro. */
export interface ItemNoFio {
  deliveryId?: string;
  cipher: string;
  imagesCipher?: string[];
  enqueuedAt: number;
  source: FonteRetencao;
  ack: string;
  sender?: NonNullable<InboundTurnPrincipal["from"]>;
}

interface Estado {
  itens: ItemRetido[];
  descartados: number;
}

const porAgente = new Map<string, Estado>();

/** Testes: zera a retenção (as DUAS estruturas — o set de chaves também). */
export function _resetFilaRetidaForTest(): void {
  porAgente.clear();
  chavesDe.clear();
}

/** Chave de idempotência do item: deliveryId quando existe; senão o conteúdo. */
function chaveItem(item: ItemRetido): string {
  if (item.deliveryId) return `d:${item.deliveryId}`;
  return `h:${createHash("sha256").update(`${item.source}\n${item.content}`, "utf8").digest("hex").slice(0, 16)}`;
}

const chavesDe = new Map<string, Set<string>>();

/**
 * Retém os itens NÃO iniciados de um agente, na ordem. Idempotente por
 * deliveryId (ou pelo hash do conteúdo em mensagem legada sem id).
 */
export function reter(agentId: string, itens: ItemRetido[]): { retidos: number; duplicados: number; descartados: number } {
  let retidos = 0;
  let duplicados = 0;
  let descartados = 0;
  expirar();
  if (itens.length === 0) return { retidos, duplicados, descartados };
  const estado = porAgente.get(agentId) ?? { itens: [], descartados: 0 };
  const chaves = chavesDe.get(agentId) ?? new Set<string>();
  for (const item of itens) {
    const k = chaveItem(item);
    if (chaves.has(k)) { duplicados++; continue; }
    chaves.add(k);
    estado.itens.push(item);
    retidos++;
    while (estado.itens.length > CAP_POR_AGENTE) {
      const velho = estado.itens.shift();
      if (velho) chaves.delete(chaveItem(velho));
      estado.descartados++;
      descartados++;
    }
  }
  porAgente.set(agentId, estado);
  chavesDe.set(agentId, chaves);
  return { retidos, duplicados, descartados };
}

/** Itens retidos, na ordem de chegada (sem remover). */
export function listar(agentId: string): ItemRetido[] {
  return [...(porAgente.get(agentId)?.itens ?? [])];
}

export function tamanho(agentId: string): number {
  return porAgente.get(agentId)?.itens.length ?? 0;
}

export function totalRetido(): number {
  let n = 0;
  for (const e of porAgente.values()) n += e.itens.length;
  return n;
}

/** Tira tudo (a reentrega chama isto e re-entrega na ordem). */
export function tomar(agentId: string): ItemRetido[] {
  const estado = porAgente.get(agentId);
  if (!estado) return [];
  const itens = estado.itens.splice(0);
  chavesDe.set(agentId, new Set());
  return itens;
}

/** Itens que não entregaram (reentrega desligada ou spawn que falhou). */
export function devolver(agentId: string, itens: ItemRetido[]): void {
  if (itens.length === 0) return;
  const estado = porAgente.get(agentId) ?? { itens: [], descartados: 0 };
  estado.itens.unshift(...itens);
  const chaves = chavesDe.get(agentId) ?? new Set<string>();
  for (const i of itens) chaves.add(chaveItem(i));
  chavesDe.set(agentId, chaves);
  porAgente.set(agentId, estado);
}

/** Esquece um agente (removido). */
export function esquecer(agentId: string): number {
  const n = porAgente.get(agentId)?.itens.length ?? 0;
  porAgente.delete(agentId);
  chavesDe.delete(agentId);
  return n;
}

/**
 * Prepara os itens para o fio: cipher com o AAD de mensagem. Item sem chave do
 * projeto NÃO vira claro — sai do lote e o chamador mantém local.
 */
export function paraFio(agentId: string, projectId: string, itens: ItemRetido[]): { enviar: ItemNoFio[]; semChave: ItemRetido[] } {
  const enviar: ItemNoFio[] = [];
  const semChave: ItemRetido[] = [];
  for (const item of itens) {
    const cipher = isE2eEncrypted(item.content)
      ? item.content
      : encryptForProject(item.content, projectId, aadV2({ projectId, table: E2EE_TABLE.MESSAGES, field: "content" }));
    if (!cipher) { semChave.push(item); continue; }
    const imagesCipher = item.images?.length
      ? item.images.map((img) => (isE2eEncrypted(img.base64) ? img.base64 : encryptImageBase64(img.base64, projectId) ?? "")).filter(Boolean)
      : undefined;
    enviar.push({
      deliveryId: item.deliveryId,
      cipher,
      imagesCipher: imagesCipher && imagesCipher.length ? imagesCipher : undefined,
      enqueuedAt: item.enqueuedAt,
      source: item.source,
      ack: createHash("sha256").update(`${agentId}\n${item.deliveryId ?? ""}\n${cipher}`, "utf8").digest("hex").slice(0, 12),
      sender: item.principal?.from,
    });
  }
  return { enviar, semChave };
}
