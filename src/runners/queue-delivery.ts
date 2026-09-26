import type { AgentSendPart, QueueSender } from "@the-dudes/protocol/daemon-wire";

export interface QueueDeliveryPayload {
  deliveryId: string;
  systemPrefix?: string;
  systemSuffix?: string;
  parts?: AgentSendPart[];
  mem?: Record<string, string>;
  telegram?: { botToken: string; chatId: string } | null;
  taskId?: string;
  origin?: "user" | "agent" | "system";
  silent?: boolean;
}

export interface QueueDeliveryInput {
  id: string;
  content: string;
  images?: unknown[];
  ts?: number;
  deliveryId?: string;
  payload?: unknown;
  from?: QueueSender | null;
  isAgentOwner?: boolean;
}

export interface MergedQueueDeliveryItem extends QueueDeliveryInput {
  deliveryId: string;
  payload?: QueueDeliveryPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Campos que o payload persistido pode trazer (validados abaixo). */
const PAYLOAD_KEYS = new Set([
  "deliveryId", "systemPrefix", "systemSuffix", "parts", "mem", "telegram", "taskId", "origin", "silent",
]);

/**
 * Autoria NUNCA vem do payload: `from`/`isAgentOwner` são do frame externo.
 * Se aparecerem aqui, são registrados e descartados — sem invalidar o resto.
 */
const FORBIDDEN_PAYLOAD_KEYS = new Set(["from", "isAgentOwner"]);

export type QueueDeliveryLogLevel = "info" | "warn";

export interface MergeQueueDeliveryOptions {
  /** Recebe o NOME da chave, nunca o valor. */
  log?: (level: QueueDeliveryLogLevel, message: string) => void;
}

/** Chaves fora do contrato são descartadas UMA A UMA (com log), preservando as permitidas. */
function reportForeignKeys(value: Record<string, unknown>, log: MergeQueueDeliveryOptions["log"]): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
      log?.("warn", `[fila] payload do queue_deliver traz "${key}" — ignorado (autoria vem do frame externo)`);
    } else if (!PAYLOAD_KEYS.has(key)) {
      log?.("info", `[fila] payload do queue_deliver traz chave desconhecida "${key}" — ignorada`);
    }
  }
}

function parsePayload(value: unknown, outerDeliveryId?: string, log?: MergeQueueDeliveryOptions["log"]): QueueDeliveryPayload | undefined {
  if (!isRecord(value)) return undefined;
  reportForeignKeys(value, log);
  if (typeof value.deliveryId !== "string" || !value.deliveryId || value.deliveryId.length > 120) return undefined;
  if (outerDeliveryId && value.deliveryId !== outerDeliveryId) return undefined;
  if (value.systemPrefix !== undefined && typeof value.systemPrefix !== "string") return undefined;
  if (value.systemSuffix !== undefined && typeof value.systemSuffix !== "string") return undefined;
  if (value.taskId !== undefined && typeof value.taskId !== "string") return undefined;
  if (value.origin !== undefined && value.origin !== "user" && value.origin !== "agent" && value.origin !== "system") return undefined;
  if (value.silent !== undefined && typeof value.silent !== "boolean") return undefined;
  if (value.mem !== undefined && (!isRecord(value.mem) || Object.values(value.mem).some((entry) => typeof entry !== "string"))) return undefined;
  if (value.telegram !== undefined && value.telegram !== null) {
    if (!isRecord(value.telegram)
      || Object.keys(value.telegram).some((key) => key !== "botToken" && key !== "chatId")
      || typeof value.telegram.botToken !== "string"
      || typeof value.telegram.chatId !== "string") return undefined;
  }
  if (value.parts !== undefined) {
    if (!Array.isArray(value.parts) || value.parts.length > 100) return undefined;
    for (const part of value.parts) {
      if (!isRecord(part) || Object.keys(part).some((key) => !["kind", "text", "table", "field"].includes(key))
        || typeof part.text !== "string") return undefined;
      if (part.kind === "plain") {
        if (part.table !== undefined || part.field !== undefined) return undefined;
      } else if (part.kind === "cipher") {
        if ((part.table !== undefined && typeof part.table !== "string")
          || (part.field !== undefined && typeof part.field !== "string")) return undefined;
      } else return undefined;
    }
  }

  return {
    deliveryId: value.deliveryId,
    ...(typeof value.systemPrefix === "string" ? { systemPrefix: value.systemPrefix } : {}),
    ...(typeof value.systemSuffix === "string" ? { systemSuffix: value.systemSuffix } : {}),
    ...(Array.isArray(value.parts) ? { parts: value.parts as AgentSendPart[] } : {}),
    ...(isRecord(value.mem) ? { mem: value.mem as Record<string, string> } : {}),
    ...(value.telegram === null || isRecord(value.telegram) ? { telegram: value.telegram as QueueDeliveryPayload["telegram"] } : {}),
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    ...(value.origin === "user" || value.origin === "agent" || value.origin === "system" ? { origin: value.origin } : {}),
    ...(typeof value.silent === "boolean" ? { silent: value.silent } : {}),
  };
}

/** Merge authenticated outer metadata with validated persisted message payload. */
export function mergeQueueDeliveryPayload(item: QueueDeliveryInput, opts?: MergeQueueDeliveryOptions): MergedQueueDeliveryItem {
  const outerDeliveryId = typeof item.deliveryId === "string" && item.deliveryId ? item.deliveryId : undefined;
  const payload = parsePayload(item.payload, outerDeliveryId, opts?.log);
  return {
    ...item,
    content: item.content,
    images: item.images,
    deliveryId: outerDeliveryId ?? payload?.deliveryId ?? item.id,
    // Never source authorship or authorization from the retained payload.
    from: item.from,
    isAgentOwner: item.isAgentOwner,
    ...(payload ? { payload } : { payload: undefined }),
  };
}
