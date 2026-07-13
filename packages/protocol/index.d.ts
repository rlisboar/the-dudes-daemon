import type { z } from "zod";

export type AgentRuntimeState = "idle" | "thinking" | "speaking" | "sending" | "stopping";
export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type CliRunner = "claude" | "opencode" | "gemini" | "codex" | "crush" | "grok";
export type ProjectMemberRole = "admin" | "member";

export declare const MAX_WIRE_MESSAGE_BYTES: number;
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
