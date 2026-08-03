/* Espelho browser do orçamento de tamanho definido em index.js. Os valores
 * são comparados entre os dois arquivos por index.test.js — divergir aqui
 * quebra o teste. Ver o comentário longo em index.js pro porquê. */
export const MAX_WIRE_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_DAEMON_WIRE_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;
export const WIRE_ENVELOPE_HEADROOM_BYTES = 1024 * 1024;

export function base64WireCost(decodedBytes) {
  return Math.ceil(decodedBytes / 3) * 4;
}

export class WireMessageTooLargeError extends Error {
  constructor(bytes, maxBytes) {
    super(`wire message exceeds ${maxBytes} bytes (got ${bytes})`);
    this.name = "WireMessageTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

function assertEnvelope(value, allowedTypes) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("wire message must be an object");
  const type = value.type;
  if (typeof type !== "string" || type.length < 1 || type.length > 100) throw new Error("invalid wire message type");
  if (allowedTypes && !allowedTypes.has(type)) throw new Error(`unsupported wire message type: ${type}`);
  return value;
}

export function parseWireMessage(raw, options = {}) {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const bytes = new TextEncoder().encode(text).byteLength;
  const maxBytes = options.maxBytes ?? MAX_WIRE_MESSAGE_BYTES;
  if (bytes > maxBytes) throw new WireMessageTooLargeError(bytes, maxBytes);
  return assertEnvelope(JSON.parse(text), options.allowedTypes);
}

export function validateWireMessage(value, options = {}) {
  return assertEnvelope(value, options.allowedTypes);
}
