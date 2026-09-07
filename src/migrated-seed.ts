/**
 * T-365: seed de migração cross-runner no daemon.
 *
 * O servidor NÃO pode embrulhar o digest: sob E2EE o `summarize:result` devolve-o
 * já cifrado (o canal do summarize sela com a chave do projeto — está correcto) e
 * o servidor não tem a chave. `<migrated-context>` à volta de base64 não é
 * contexto: o runner receberia um blob e responderia a ele. Então o server manda
 * o digest CRU + a origem, e aqui se decripta, se mede o limite e se escreve a
 * tag. Sem chave não injetamos nada — arranque limpo é melhor que alucinação.
 *
 * O limite de 8 KB é re-medido no PLAINTEXT: é o plaintext que entra no prompt.
 * O gate do servidor, sobre o blob cifrado, é mais conservador (AES-GCM + base64
 * inflate ~1.37×), por isso este é o que protege o runner.
 */

import type { AgentInfo } from "./types.js";

export interface SeedOrigin {
  runner: string;
  model?: string;
  ts: number;
}

export interface SeedContext {
  projectId?: string;
  /** `null` = sem chave para este projeto. */
  decrypt?: (blob: string, projectId: string) => string | null;
  now?: () => number;
}

export type SeedDropReason = "no_key" | "resume_skips_seed";

export type SeedResult =
  | { seed: string; dropped: false; truncated: boolean }
  | { seed: undefined; dropped: false; truncated: false }
  | { seed: undefined; dropped: true; truncated: false; reason: SeedDropReason };

export const MIGRATED_SEED_LIMIT_BYTES = 8 * 1024;

export function wrapMigratedContext(digest: string, from: SeedOrigin): string {
  const ts = new Date(from.ts).toISOString();
  return `<migrated-context from-runner="${from.runner}" from-model="${from.model ?? "?"}" ts="${ts}">\n${digest}\n</migrated-context>`;
}

/** Corta em limite de UTF-8 sem partir surrogate nem meio de linha. */
export function clipToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = s;
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, Math.floor(out.length * 0.9));
  const cut = out.lastIndexOf("\n");
  return (cut > maxBytes * 0.5 ? out.slice(0, cut) : out) + "\n…[cortado]";
}

/**
 * `resumeSessionId` é o que sobrou do `compatibleSessionId` do runner alvo:
 * sessão viva ⇒ o runner nativo já carrega o contexto e o seed é dispensável.
 * T-370: sessão viva COM seed pendurado é queda DECLARADA, não silêncio — o
 * premain provou que o id pode ter nascido noutra família de CLI (o
 * `compatibleSessionId` só valida formato) e o contexto migrado evaporou sem
 * uma linha. O server passou a limpar a sessão no archive; se ainda assim o
 * resume ganhar, o dono é dito. Sem seed em espera, resume é o caminho
 * normal (troca só de modelo) e continua sem queda.
 */
export function migratedSeedFor(
  agent: AgentInfo,
  resumeSessionId: string | undefined,
  ctx: SeedContext = {},
): SeedResult {
  const raw = agent.seedDigest;
  if (!raw) return { seed: undefined, dropped: false, truncated: false };
  if (resumeSessionId) return { seed: undefined, dropped: true, truncated: false, reason: "resume_skips_seed" };

  let digest = raw;
  if (raw.startsWith("e2e:")) {
    const { projectId, decrypt } = ctx;
    const plain = projectId && decrypt ? decrypt(raw, projectId) : null;
    if (plain === null) return { seed: undefined, dropped: true, truncated: false, reason: "no_key" };
    digest = plain;
  }

  const clipped = clipToBytes(digest, MIGRATED_SEED_LIMIT_BYTES);
  const truncated = clipped !== digest;
  const from: SeedOrigin = agent.seedFrom
    ?? { runner: "desconhecido", ts: ctx.now?.() ?? Date.now() };
  const instruction = agent.seedInstruction?.trim();
  const seed = instruction
    ? `${wrapMigratedContext(clipped, from)}\n\n---\n\n${instruction}`
    : wrapMigratedContext(clipped, from);
  return { seed, dropped: false, truncated };
}
