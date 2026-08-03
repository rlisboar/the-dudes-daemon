import type { z } from "zod";

export declare const commandSchemas: Record<string, z.ZodTypeAny>;

export type CommandValidation =
  | { ok: true; error?: undefined }
  | { ok: false; error: string };

/** Valida a forma de um comando já aprovado no envelope. Comando sem schema
 *  registrado passa (`ok: true`) — a cobertura é um allowlist progressivo. */
export declare function validateCommand(command: { type: string }): CommandValidation;
