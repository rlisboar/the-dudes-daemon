import { z } from "zod";

export const MAX_WIRE_MESSAGE_BYTES = 8 * 1024 * 1024;

export const wireEnvelopeSchema = z.object({
  type: z.string().min(1).max(100),
}).passthrough();

function byteLength(raw) {
  if (typeof raw === "string") return new TextEncoder().encode(raw).byteLength;
  if (raw instanceof Uint8Array) return raw.byteLength;
  return new TextEncoder().encode(String(raw)).byteLength;
}

export function parseWireMessage(raw, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_WIRE_MESSAGE_BYTES;
  if (byteLength(raw) > maxBytes) throw new Error(`wire message exceeds ${maxBytes} bytes`);
  const decoded = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  const message = wireEnvelopeSchema.parse(decoded);
  if (options.allowedTypes && !options.allowedTypes.has(message.type)) {
    throw new Error(`unsupported wire message type: ${message.type}`);
  }
  return message;
}

export function validateWireMessage(value, options = {}) {
  const message = wireEnvelopeSchema.parse(value);
  if (options.allowedTypes && !options.allowedTypes.has(message.type)) {
    throw new Error(`unsupported wire message type: ${message.type}`);
  }
  return message;
}
