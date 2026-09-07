import { z } from "zod";

/* ---------- orçamento de tamanho do canal ----------
 *
 * Fonte única dos tetos de cada salto (web → orch → daemon). Antes cada
 * camada tinha seu próprio número e eles não fechavam: o cliente montava
 * até 20MB de anexo, o frame WS aceitava 32MB, e o parser cortava em 8MB
 * — então uma mensagem com 2 imagens sumia sem erro nenhum (o `catch` do
 * dispatch engolia). O mesmo furo existia no daemon.
 *
 * A invariante entre eles é verificada em index.test.js; mudar um número
 * aqui sem mudar os outros quebra o teste em vez de virar drop silencioso
 * em produção.
 */

/** Teto do frame no canal web ↔ orchestrator. */
export const MAX_WIRE_MESSAGE_BYTES = 32 * 1024 * 1024;
/** Teto do frame no canal orchestrator ↔ daemon. Igual ao do web porque o
 *  orchestrator repassa `agent:send` com os anexos intactos. */
export const MAX_DAEMON_WIRE_MESSAGE_BYTES = 32 * 1024 * 1024;
/** Teto de UM anexo, em bytes decodificados (o que o `File.size` reporta). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Teto da soma dos anexos de uma mensagem, em bytes decodificados. */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;
/** Folga reservada pro resto do envelope (texto, prefixo de sistema, IDs). */
export const WIRE_ENVELOPE_HEADROOM_BYTES = 1024 * 1024;

/* ---------- catálogo de runners (T-187 — fonte única) ----------
 *
 * Allowlist de runners CLI antes vivia duplicada em ≥4 fontes (brain-policy,
 * db, orchestrator e daemon/runner-policy) e o grok-custom já tinha sido
 * esquecido 5×. Agora o catálogo abaixo é a ÚNICA fonte: server e daemon
 * importam daqui, e o teste de parity (index.test.js) garante que os
 * espelhos de tipo (.d.ts) não divergem.
 *
 * Adicionar um runner = acrescentar UMA linha aqui (o teste de parity
 * documenta; os consumers herdam allowlist, gates e ordem de descoberta).
 */
export const RUNNER_CATALOG = [
  { value: "claude", label: "Claude" },
  { value: "opencode", label: "OpenCode" },
  { value: "gemini", label: "Gemini" },
  { value: "qwen", label: "Qwen" },
  { value: "codex", label: "Codex" },
  { value: "crush", label: "Crush" },
  { value: "grok", label: "Grok" },
  { value: "grok-custom", label: "Grok Custom" },
];

/** Ordem canônica de iteração (ex.: descoberta de models no daemon). */
export const RUNNERS = RUNNER_CATALOG.map((runner) => runner.value);

const RUNNER_VALUES = new Set(RUNNERS);

/** Allowlist canônica: `runner` é um runner conhecido? */
export function isKnownCliRunner(runner) {
  return typeof runner === "string" && RUNNER_VALUES.has(runner);
}

/** Custo no fio de `decodedBytes` depois do base64 (expande 4/3, com padding). */
export function base64WireCost(decodedBytes) {
  return Math.ceil(decodedBytes / 3) * 4;
}

export const wireEnvelopeSchema = z.object({
  type: z.string().min(1).max(100),
}).passthrough();

/** Erro distinguível de "grande demais" — o caller precisa separar isso de
 *  JSON malformado pra avisar o usuário em vez de descartar em silêncio. */
export class WireMessageTooLargeError extends Error {
  constructor(bytes, maxBytes) {
    super(`wire message exceeds ${maxBytes} bytes (got ${bytes})`);
    this.name = "WireMessageTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

function byteLength(raw) {
  if (typeof raw === "string") return new TextEncoder().encode(raw).byteLength;
  if (raw instanceof Uint8Array) return raw.byteLength;
  return new TextEncoder().encode(String(raw)).byteLength;
}

export function parseWireMessage(raw, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_WIRE_MESSAGE_BYTES;
  const bytes = byteLength(raw);
  if (bytes > maxBytes) throw new WireMessageTooLargeError(bytes, maxBytes);
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
