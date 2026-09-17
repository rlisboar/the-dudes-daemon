/**
 * T-581 — contrato do texto da delegação (Brain `delegate`).
 *
 * Por que este módulo existe: quem CIFRA `goal`/`context` é o daemon
 * (bridge-relay, na subida) e quem grava é o server, que NÃO tem a chave — os
 * blobs chegam opacos. O prompt entregue ao subagente precisa citar o nome do
 * agente pai, então quem monta o texto é o relay (é ele que tem o plaintext);
 * o server usa o MESMO texto como fallback quando o daemon é antigo (sem
 * cifra). Duas cópias do template divergiriam em silêncio — por isso ele mora
 * aqui: uma fonte, os dois lados, coberto por teste.
 *
 * `parentName` é o nome do agente que delegou: o subagente responde por
 * `send_message` usando exatamente esse nome.
 */

/** Teto do `context` — o mesmo dos dois lados: quem corta é o relay (tem o
 *  plaintext); o server NÃO pode cortar o blob cifrado (cortaria o base64). */
export const DELEGATION_CONTEXT_MAX = 8000;

/** Título da mission de delegação (aparece na lista de missions). */
export function delegationMissionTitle(goal) {
  return `Delegação: ${String(goal).slice(0, 60)}`;
}

/** Título do step (aparece na lista de steps da mission). */
export function delegationStepTitle(goal) {
  return String(goal).slice(0, 80);
}

/** Prompt entregue ao subagente — o "focused task" + background opcional. */
export function delegationTaskPrompt(goal, context, parentName) {
  return `# Delegated task (from ${parentName})\n${goal}`
    + (context ? `\n\n## Context\n${context}` : "")
    + `\n\nWhen you finish, send your concise result to "${parentName}" using mcp__the-dudes__send_message (to: "${parentName}"). Then you are done.`;
}