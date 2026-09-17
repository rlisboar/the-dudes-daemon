/**
 * Daemon ↔ Orchestrator wire protocol.
 *
 * T-423/R3: o CONTRATO (tipos + schemas zod) vive em
 * `@the-dudes/protocol/daemon-wire`. Aqui só ficam os 2 helpers puros que o
 * daemon usa; o server importa o contrato direto do pacote.
 */
export * from "@the-dudes/protocol/daemon-wire";

import type { AgentSendPart, AssemblePartsResult } from "@the-dudes/protocol/daemon-wire";
import { aadReadChain, E2EE_TABLE, resolveAgentSendCipherAad } from "@the-dudes/protocol/e2ee-fields";

export function cipherWirePrefix(text: string): "e2e:v2" | "e2e:v1" | "e2e" | "none" {
  if (text.startsWith("e2e:v2:")) return "e2e:v2";
  if (text.startsWith("e2e:v1:")) return "e2e:v1";
  if (text.startsWith("e2e:")) return "e2e";
  return "none";
}

/**
 * T-597 F1 — abre um cipher tentando o pid da linha e, se não abrir, TODOS os
 * pids candidatos (o par chave+AAD por candidato é responsabilidade do
 * `attempt`). Cobre remetente que selou com pid de OUTRO projeto (caminho
 * direto do bridge, sem passar pelo relay que selaria com o pid do entry).
 * Fail-closed: null = nenhum candidato abriu. Devolve o valor + o pid que
 * abriu (o caller usa o pid p/ log e p/ os anexos do mesmo frame).
 */
export function openWithAnyHeldProject<T>(
  projectId: string | undefined,
  candidatePids: readonly string[],
  attempt: (pid: string) => T | null,
): { value: T; pid: string } | null {
  if (projectId) {
    const v = attempt(projectId);
    if (v !== null) return { value: v, pid: projectId };
  }
  for (const pid of candidatePids) {
    if (pid === projectId) continue;
    const v = attempt(pid);
    if (v !== null) return { value: v, pid };
  }
  return null;
}

/**
 * T-649 — cadeia de AAD do caminho de `content` (frame SEM parts). O remetente
 * pode ter selado o blob com o AAD de OUTRO table/field (blob copiado
 * cross-tabela — ex.: o dispatch de step carrega a `description` da task) e o
 * content só tentava `messages.content`, então o frame dropava mesmo com a
 * chave detida. Conjunto pequeno e na ordem canônica: messages.content e, em
 * seguida, tasks.description. Fail-closed: lista vazia = nada abre (o caller
 * dropa como antes). Espelha o `aadReadChain` do campo de destino.
 */
export function contentAadChain(projectId: string): string[] {
  const out: string[] = [];
  for (const aad of [
    ...aadReadChain({ projectId, table: E2EE_TABLE.MESSAGES, field: "content" }),
    ...aadReadChain({ projectId, table: E2EE_TABLE.TASKS, field: "description" }),
  ]) {
    if (!out.includes(aad)) out.push(aad);
  }
  return out;
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