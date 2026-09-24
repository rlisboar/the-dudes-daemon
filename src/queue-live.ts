/**
 * T-1005 — fila de espera AO VIVO (daemon → server `agent:queue_live`).
 *
 * Até aqui o daemon só mandava a fila no stop/context-clear/replace
 * (`agent:queue_retain`): com o agente ocupado, as mensagens esperando ficavam
 * só na memória do runner e a tela não as via. Agora o host publica um
 * SNAPSHOT COMPLETO do que ainda não virou turno a cada mudança (debounce).
 *
 * Conteúdo: como veio do server. Em projeto E2EE vai o blob `e2e:` ORIGINAL
 * guardado junto do item — nunca o texto decifrado. Frames sem blob único
 * (`parts`: task notify, replay) e itens internos do daemon vão re-selados com
 * a chave do projeto (mesmo AAD do chat, messages.content); sem como
 * selar num projeto com chave, o item é omitido. Projeto sem chave: o texto
 * como chegou.
 *
 * Módulo puro: o host alimenta, o teste exercita sem runner nem WS.
 */
import type { ImageAttachment } from "./types.js";
import { encryptForProject, encryptImageBase64, hasProjectKey, isE2eEncrypted } from "./daemon-crypto.js";
import { aadV2, E2EE_TABLE } from "@the-dudes/protocol/e2ee-fields";
import { QUEUE_LIVE_MAX_BYTES, QUEUE_LIVE_MAX_ITEMS, queueLiveItemBytes } from "@the-dudes/protocol/daemon-wire";

export const QUEUE_LIVE_DEBOUNCE_MS = 250;
/** Reconciliação: pega mutações da fila fora dos caminhos instrumentados. */
export const QUEUE_LIVE_RECONCILE_MS = 1_000;
/**
 * T-1005 (decisão PM): tetos DO PROTOCOLO (`QUEUE_LIVE_MAX_ITEMS=200`,
 * `QUEUE_LIVE_MAX_BYTES=1 MiB`, `queueLiveItemBytes`) — os MESMOS que o
 * server usa no fail-closed (`server/T-1006 @53edcf21`). Sem constante
 * duplicada: o daemon importa e corta; o server recusa o que passar.
 * Re-exportados para o teste afirmar a paridade sem importar o protocolo.
 */
export { QUEUE_LIVE_MAX_BYTES, QUEUE_LIVE_MAX_ITEMS, queueLiveItemBytes };
/** Mesma medida do server: UTF-8 de `content` + `images` serializado. */
function medirItemProtocolo(it: { content: string; images?: unknown[] }): number {
  return queueLiveItemBytes(it);
}

export type QueueOrigin = "user" | "agent" | "system";

/** O que o host guarda de cada entrega, como veio do fio. */
export interface WireRecord {
  content: string;
  images?: unknown[];
  enqueuedAt: number;
  origin: QueueOrigin;
  silent?: boolean;
}

export interface QueueLiveItem {
  deliveryId: string;
  content: string;
  images?: unknown[];
  enqueuedAt: number;
  origin: QueueOrigin;
  silent?: boolean;
}

export interface QueueLiveFrame {
  type: "agent:queue_live";
  agentId: string;
  projectId?: string;
  at: number;
  truncated?: boolean;
  items: QueueLiveItem[];
}

/** Item pendente como o host o vê (runner, buffer pré-spawn, dreno). */
export interface PendingItem {
  content: string;
  images?: ImageAttachment[];
  deliveryId?: string;
  coalescedIds?: string[];
}

const aadMensagem = (projectId: string) => aadV2({ projectId, table: E2EE_TABLE.MESSAGES, field: "content" });

/** Sela conteúdo em claro com a chave do projeto (null = não deu). */
export function selar(projectId: string | undefined, content: string, images?: ImageAttachment[]): { content: string; images?: unknown[] } | null {
  if (!projectId || !hasProjectKey(projectId)) return null;
  const c = isE2eEncrypted(content) ? content : encryptForProject(content, projectId, aadMensagem(projectId));
  if (!c) return null;
  let imgs: unknown[] | undefined;
  if (images?.length) {
    imgs = [];
    for (const img of images) {
      const b = isE2eEncrypted(img.base64) ? img.base64 : encryptImageBase64(img.base64, projectId);
      if (!b) return null;
      imgs.push({ ...img, base64: b });
    }
  }
  return { content: c, images: imgs };
}

/** Origem pelo formato do frame. O server pode mandar `origin` explícito
 *  (campo novo, opcional) e ele vence. */
export function origemDoFrame(msg: { origin?: unknown; parts?: unknown[]; systemPrefix?: string }): QueueOrigin {
  if (msg.origin === "user" || msg.origin === "agent" || msg.origin === "system") return msg.origin;
  if (typeof msg.systemPrefix === "string" && msg.systemPrefix.trimStart().startsWith("[from ")) return "agent";
  if (Array.isArray(msg.parts) && msg.parts.length > 0) return "system";
  return "user";
}

/**
 * Registro do item no fio a partir do frame `agent:send`. `conteudoFinal`/
 * `imagensFinal` são o que o runner recebe (decifrado e montado): só entram no
 * fio re-selados (parts) ou num projeto sem chave. `null` = não há como mandar
 * sem vazar texto claro.
 */
export function registroDoFrame(
  msg: { content?: string; parts?: unknown[]; images?: unknown[]; projectId?: string; origin?: unknown; silent?: unknown; systemPrefix?: string },
  conteudoFinal: string,
  imagensFinal: ImageAttachment[] | undefined,
  agora = Date.now(),
): WireRecord | null {
  const origin = origemDoFrame(msg);
  const silent = msg.silent === true ? true : undefined;
  const temParts = Array.isArray(msg.parts) && msg.parts.length > 0;
  const cifrado = !temParts && typeof msg.content === "string" && isE2eEncrypted(msg.content);
  if (cifrado) {
    // O blob ORIGINAL do server; os anexos também como vieram.
    return { content: msg.content!, images: msg.images?.length ? msg.images : undefined, enqueuedAt: agora, origin, silent };
  }
  const pid = msg.projectId;
  if (pid && hasProjectKey(pid)) {
    // Projeto cifra mas o frame veio em partes (ou montado): re-sela.
    const s = selar(pid, conteudoFinal, imagensFinal);
    if (!s) return null;
    return { content: s.content, images: s.images, enqueuedAt: agora, origin, silent };
  }
  // Projeto sem chave: o texto como chegou.
  return { content: conteudoFinal, images: imagensFinal?.length ? imagensFinal : undefined, enqueuedAt: agora, origin, silent };
}

/**
 * Snapshot a partir dos itens pendentes, na ordem. Cada id (próprio e
 * agrupados) vira um item do fio com o registro dele; item sem registro
 * (interno do daemon) é re-selado ou omitido. Tetos DO PROTOCOLO
 * (`maxItens`/`maxBytes` vindos de `QUEUE_LIVE_MAX_ITEMS`/
 * `QUEUE_LIVE_MAX_BYTES` de `@the-dudes/protocol/daemon-wire`, medidos com
 * `queueLiveItemBytes` — o MESMO número do fail-closed do server),
 * cortando os MAIS NOVOS.
 */
export function montarSnapshot(
  pendentes: PendingItem[],
  registros: Map<string, WireRecord>,
  projectId: string | undefined,
  opts: { agora?: number; maxItens?: number; maxBytes?: number } = {},
): { items: QueueLiveItem[]; truncated: boolean; omitidos: number } {
  const agora = opts.agora ?? Date.now();
  const maxItens = opts.maxItens ?? QUEUE_LIVE_MAX_ITEMS;
  const maxBytes = opts.maxBytes ?? QUEUE_LIVE_MAX_BYTES;
  const items: QueueLiveItem[] = [];
  let bytes = 0;
  let truncated = false;
  let omitidos = 0;
  let semId = 0;
  const vistos = new Set<string>();
  const empurrar = (it: QueueLiveItem): boolean => {
    if (items.length >= maxItens) { truncated = true; return false; }
    const b = medirItemProtocolo(it);
    if (bytes + b > maxBytes) { truncated = true; return false; }
    bytes += b;
    items.push(it);
    return true;
  };
  for (const p of pendentes) {
    if (truncated) break;
    const ids = [p.deliveryId, ...(p.coalescedIds ?? [])];
    for (const id of ids) {
      if (id && vistos.has(id)) continue;
      if (id) vistos.add(id);
      const reg = id ? registros.get(id) : undefined;
      let it: QueueLiveItem | null = null;
      if (reg) {
        it = { deliveryId: id!, content: reg.content, ...(reg.images ? { images: reg.images } : {}), enqueuedAt: reg.enqueuedAt, origin: reg.origin, ...(reg.silent ? { silent: true } : {}) };
      } else if (id === p.deliveryId) {
        // Sem registro do fio (interno, ou chegou antes do daemon novo): sela.
        const cifrado = projectId && hasProjectKey(projectId);
        const s = cifrado ? selar(projectId, p.content, p.images) : { content: p.content, images: p.images?.length ? p.images : undefined };
        if (!s) { omitidos++; continue; }
        it = { deliveryId: id ?? `sem-id:${semId++}`, content: s.content, ...(s.images ? { images: s.images } : {}), enqueuedAt: agora, origin: "system" };
      } else {
        continue; // id agrupado sem registro: o texto já está no item-base
      }
      if (!empurrar(it)) break;
    }
  }
  return { items, truncated, omitidos };
}
