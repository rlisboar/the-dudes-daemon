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

/** T-1249: `type` pronto para eco em mensagem de erro — sem C0/C1/DEL,
 *  zero-width/bidi, NFC e com espaço colapsado. O envelope só limita o
 *  TAMANHO (1..100); esta é a limpeza de CONTEÚDO. */
export declare function sanitizeCommandType(t: unknown): string;
