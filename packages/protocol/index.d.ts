import type { z } from "zod";

export type AgentRuntimeState = "idle" | "queued" | "thinking" | "speaking" | "sending" | "stopping" | "stalled";
export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type CliRunner = "claude" | "opencode" | "gemini" | "qwen" | "codex" | "crush" | "grok" | "grok-custom" | "dsh";
export type ProjectMemberRole = "admin" | "member";

/** Entrada do catálogo único de runners (T-187) — fonte de allowlist/gates. */
export interface RunnerCatalogEntry {
    label: string;
    value: CliRunner;
}
/** Catálogo único de runners: nova entrada aqui vale para server e daemon. */
export declare const RUNNER_CATALOG: readonly RunnerCatalogEntry[];
/** Ordem canônica de iteração sobre os runners (derivada do catálogo).
 *  Tupla literal: mantém `z.enum(...)` e `Record<Runner, …` funcionando. */
export declare const RUNNERS: readonly ["claude", "opencode", "gemini", "qwen", "codex", "crush", "grok", "grok-custom", "dsh"];
/** Allowlist canônica: `runner` é um runner conhecido? */
export declare function isKnownCliRunner(runner: unknown): runner is CliRunner;

export declare const MAX_WIRE_MESSAGE_BYTES: number;
export declare const MAX_DAEMON_WIRE_MESSAGE_BYTES: number;
export declare const MAX_ATTACHMENT_BYTES: number;
export declare const MAX_ATTACHMENTS_TOTAL_BYTES: number;
export declare const WIRE_ENVELOPE_HEADROOM_BYTES: number;
/** Sentinela de autor externo (webhook/inbound) gravado em `fromUserId`.
 *  A UI mostra "Externo"; não colide com ids de usuário. */
export declare const INBOUND_EXTERNAL_AUTHOR: "inbound";
export declare function base64WireCost(decodedBytes: number): number;
export declare class WireMessageTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;
  constructor(bytes: number, maxBytes: number);
}
export declare const wireEnvelopeSchema: z.ZodObject<
  { type: z.ZodString },
  "passthrough",
  z.ZodTypeAny,
  { type: string; [key: string]: unknown },
  { type: string; [key: string]: unknown }
>;

export interface WireParseOptions {
  maxBytes?: number;
  allowedTypes?: ReadonlySet<string>;
}

export declare function parseWireMessage<T extends { type: string }>(raw: string | Uint8Array, options?: WireParseOptions): T;
export declare function validateWireMessage<T extends { type: string }>(value: unknown, options?: WireParseOptions): T;
