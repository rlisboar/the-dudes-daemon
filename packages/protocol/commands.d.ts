import type { z } from "zod";

export declare const commandSchemas: Record<string, z.ZodTypeAny>;

/** Comandos cujo handler persiste no Postgres. Todo nome tem schema. */
export declare const DB_WRITE_COMMANDS: readonly string[];

export type CommandValidation =
  | { ok: true; error?: undefined }
  | { ok: false; error: string };

/** Valida a forma de um comando já aprovado no envelope. T-422 (A5):
 *  fail-closed por padrão — `type` sem schema é recusado. O canal FromDaemon
 *  passa `{failClosed:false}` até a T-423 publicar os schemas daquele canal. */
export declare function validateCommand(
  command: { type: string },
  opts?: { failClosed?: boolean },
): CommandValidation;
