export const MAX_WIRE_MESSAGE_BYTES = 8 * 1024 * 1024;

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
  if (bytes > maxBytes) throw new Error(`wire message exceeds ${maxBytes} bytes`);
  return assertEnvelope(JSON.parse(text), options.allowedTypes);
}

export function validateWireMessage(value, options = {}) {
  return assertEnvelope(value, options.allowedTypes);
}
