/**
 * Daemon ↔ Orchestrator wire protocol.
 *
 * T-423/R3: o CONTRATO (tipos + schemas zod) vive em
 * `@the-dudes/protocol/daemon-wire`. Aqui só ficam os 2 helpers puros que o
 * daemon usa; o server importa o contrato direto do pacote.
 */
export * from "@the-dudes/protocol/daemon-wire";

import type { AgentSendPart, AssemblePartsResult } from "@the-dudes/protocol/daemon-wire";
import { aadReadChain, resolveAgentSendCipherAad } from "@the-dudes/protocol/e2ee-fields";

export function cipherWirePrefix(text: string): "e2e:v2" | "e2e:v1" | "e2e" | "none" {
  if (text.startsWith("e2e:v2:")) return "e2e:v2";
  if (text.startsWith("e2e:v1:")) return "e2e:v1";
  if (text.startsWith("e2e:")) return "e2e";
  return "none";
}

/**
 * Concatena parts; cada cipher usa AAD declarado ou fallback legado
 * messages.content. Sem varredura.
 *
 * T-581: o AAD declarado é o do campo de DESTINO; a decifragem usa a mesma
 * cadeia de leitura do web (destino → no máx. UMA fonte canônica,
 * `aadReadChain`). É o que permite o blob copiado pelo server cross-tabela
 * (startPlan: plan item → mission step) decifrar no destino sem o server ter
 * a chave — antes o part declarava o destino, o decrypt falhava e a mensagem
 * era dropada com agent:error.
 */
export function assembleAgentSendParts(
  parts: AgentSendPart[],
  projectId: string | undefined,
  decrypt: (blob: string, projectId: string, aad: string) => string | null,
  isEncrypted: (s: string) => boolean,
): AssemblePartsResult {
  const out: string[] = [];
  for (const p of parts) {
    if (p.kind === "plain") { out.push(p.text); continue; }
    if (!isEncrypted(p.text)) { out.push(p.text); continue; }
    const prefix = cipherWirePrefix(p.text);
    if (!projectId) return { ok: false, reason: "missing_project", prefix };
    const resolved = resolveAgentSendCipherAad(p);
    if (!resolved.ok) return { ok: false, reason: resolved.reason, prefix };
    let dec: string | null = null;
    for (const aad of aadReadChain({ projectId, table: resolved.table, field: resolved.field })) {
      dec = decrypt(p.text, projectId, aad);
      if (dec !== null) break;
    }
    if (dec === null) return { ok: false, reason: "decrypt", prefix };
    out.push(dec);
  }
  return { ok: true, content: out.join("") };
}