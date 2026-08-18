/**
 * Lista canônica dos campos E2EE — o CONTRATO entre quem cifra e quem decifra.
 *
 * Quem cifra é o daemon (bridge-relay, na subida) e o web (na escrita da UI);
 * quem decifra é o web (e2ee.ts) e o daemon (na descida pro LLM). Três bugs
 * em produção vieram da mesma raiz: um campo cifrado de um lado sem o
 * decifrador correspondente do outro — e `maybeDecrypt` sem chave devolve o
 * ciphertext EM SILÊNCIO, então o erro só aparece como "e2e:..." na tela de
 * alguém. O quadro inteiro, a lista de quadros e os títulos dos boards caíram
 * assim, um por vez.
 *
 * Esta lista é importada pelos testes DOS DOIS lados: adicionar um campo
 * cifrado sem atualizar o decifrador (ou vice-versa) derruba a suíte de quem
 * ficou pra trás, em vez de virar reclamação de usuário.
 */

/** Campos de texto do quadro de explicações (board_* no relay ↔ decryptBoard). */
export const BOARD_TEXT_FIELDS = ["title", "body", "say", "text", "label"];
export const BOARD_STEP_FIELDS = ["label", "detail"];
export const BOARD_CHART_SERIES_FIELDS = ["name"];
/** chart.labels é um array de strings cifradas item a item. */
export const BOARD_CHART_HAS_LABELS = true;
export const BOARD_ANNOTATION_FIELDS = ["label"];

/** Mensagem de agente (send no relay ↔ log/decryptForProject no web). */
export const MESSAGE_FIELDS = ["content"];

/** Memória (memory_add: title/body viram titleCipher/bodyCipher). */
export const MEMORY_PLAIN_TO_CIPHER = { title: "titleCipher", body: "bodyCipher" };

/** Task (web cifra na escrita ↔ decryptTask). */
export const TASK_FIELDS = ["title", "description"];

/** Comentário de task. */
export const COMMENT_FIELDS = ["content"];

/** Goal. */
export const GOAL_FIELDS = ["title", "description"];

/** Resumo de sessão (summarize:result no daemon ↔ store no web). */
export const SUMMARY_FIELDS = ["summary"];

/**
 * Tabelas lógicas do AAD (T-062). Sem recordId — IDs são gerados no server
 * depois da cifra. Fecha cross-table/cross-field; não fecha cópia intra-campo.
 */
export const E2EE_TABLE = Object.freeze({
  TASKS: "tasks",
  TASK_COMMENTS: "task_comments",
  GOALS: "goals",
  MEMORIES: "memories",
  MESSAGES: "messages",
  BOARDS: "explanation_boards",
  SUMMARIES: "tts_summaries",
});

/** Prefixos de wire. v2 leva AAD; v1 abortado é fail-closed; `e2e:` é legado. */
export const E2E_PREFIX = "e2e:";
export const E2E_V2_PREFIX = "e2e:v2:";
export const E2E_V1_REJECT_PREFIX = "e2e:v1:";

/**
 * AAD canônico: utf8 `v2|{projectId}|{table}|{field}`.
 * Uma string, dois lados (web SubtleCrypto + daemon node:crypto).
 */
export function aadV2({ projectId, table, field }) {
  if (typeof projectId !== "string" || !projectId
    || typeof table !== "string" || !table
    || typeof field !== "string" || !field) {
    throw new Error("aadV2: projectId, table e field são obrigatórios");
  }
  return `v2|${projectId}|${table}|${field}`;
}

export function isE2eV2(stored) {
  return typeof stored === "string" && stored.startsWith(E2E_V2_PREFIX);
}

export function isE2eV1Rejected(stored) {
  return typeof stored === "string" && stored.startsWith(E2E_V1_REJECT_PREFIX);
}
