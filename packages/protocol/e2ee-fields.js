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
/**
 * Anexo de mensagem (T-103). AAD: table=messages field=images, por anexo.
 * Cifra BYTES crus do base64 (não o ASCII). mimeType e name SEMPRE claros.
 */
export const MESSAGE_IMAGE_FIELD = "images";

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

/** Plan (create_plan / plans_create). */
export const PLAN_FIELDS = ["title", "description"];
/**
 * Membership do plano. title/prompt.
 * Drafts materializados como board task: o relay cifra title com
 * tasks.title e prompt com tasks.description (addTask); o snapshot da
 * membership herda o mesmo blob. update_plan_task cifra com plan_tasks.*.
 */
export const PLAN_TASK_FIELDS = ["title", "prompt"];
/** Mission (create_mission). */
export const MISSION_FIELDS = ["title", "description"];
/** Mission step (add_mission_step / apply_plan_steps). */
export const MISSION_STEP_FIELDS = ["title", "prompt"];
/** Schedule (add_schedule). title + prompt (não há payload). */
export const SCHEDULE_FIELDS = ["title", "prompt"];

/** T-094: agents.system_prompt (JS: spec.systemPrompt). AAD field=system_prompt. */
export const AGENT_FIELDS = ["system_prompt"];
/** T-094: credentials.value. */
export const CREDENTIAL_FIELDS = ["value"];
/** T-094: summarize:request.text (RPC efêmero, NÃO tts_summaries). */
export const SUMMARIZE_FIELDS = ["text"];

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
  PLANS: "plans",
  PLAN_TASKS: "plan_tasks",
  MISSIONS: "missions",
  MISSION_STEPS: "mission_steps",
  SCHEDULES: "schedules",
  AGENTS: "agents",
  CREDENTIALS: "credentials",
  SUMMARIZE: "summarize",
});

/**
 * T-083 call-out A — fallback de AAD SÓ na leitura.
 *
 * startPlan (server) copia o blob opaco cross-tabela: plan.title/description →
 * mission.title/description, item.title/prompt (AAD tasks.*) → mission_steps.*.
 * O server não tem a chave, então não re-cifra. EXATAMENTE 4 pares;
 * proibido loop genérico por todas as AAD. Destino primeiro, depois
 * UMA fonte. apply_plan_steps nascido no destino continua 1:1 (o
 * destino abre sozinho; a fonte não é consultada).
 */
export const AAD_READ_FALLBACK = Object.freeze([
  Object.freeze({ destTable: E2EE_TABLE.MISSIONS, destField: "title", sourceTable: E2EE_TABLE.PLANS, sourceField: "title" }),
  Object.freeze({ destTable: E2EE_TABLE.MISSIONS, destField: "description", sourceTable: E2EE_TABLE.PLANS, sourceField: "description" }),
  Object.freeze({ destTable: E2EE_TABLE.MISSION_STEPS, destField: "title", sourceTable: E2EE_TABLE.TASKS, sourceField: "title" }),
  Object.freeze({ destTable: E2EE_TABLE.MISSION_STEPS, destField: "prompt", sourceTable: E2EE_TABLE.TASKS, sourceField: "description" }),
]);

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

/**
 * Cadeia de AAD pra LEITURA: [destino, fonte?] — 1 ou 2 strings.
 * Nunca varre o catálogo inteiro.
 */
export function aadReadChain({ projectId, table, field }) {
  const dest = aadV2({ projectId, table, field });
  const pair = AAD_READ_FALLBACK.find((p) => p.destTable === table && p.destField === field);
  if (!pair) return [dest];
  return [dest, aadV2({ projectId, table: pair.sourceTable, field: pair.sourceField })];
}

export function isE2eV2(stored) {
  return typeof stored === "string" && stored.startsWith(E2E_V2_PREFIX);
}

export function isE2eV1Rejected(stored) {
  return typeof stored === "string" && stored.startsWith(E2E_V1_REJECT_PREFIX);
}

/** Texto de conteúdo em claro: string não-vazia sem prefixo e2e:. */
export function isPlainCatalogText(v) {
  return typeof v === "string" && v.length > 0 && !v.startsWith(E2E_PREFIX);
}

/**
 * T-117: pares AAD permitidos em agent:send.parts cipher.
 * Lista fechada — o daemon NÃO varre o catálogo.
 */
export const AGENT_SEND_CIPHER_AADS = Object.freeze([
  Object.freeze({ table: E2EE_TABLE.TASKS, field: "title" }),
  Object.freeze({ table: E2EE_TABLE.TASKS, field: "description" }),
  Object.freeze({ table: E2EE_TABLE.GOALS, field: "title" }),
  Object.freeze({ table: E2EE_TABLE.GOALS, field: "description" }),
  Object.freeze({ table: E2EE_TABLE.MEMORIES, field: "title" }),
  Object.freeze({ table: E2EE_TABLE.MEMORIES, field: "body" }),
  Object.freeze({ table: E2EE_TABLE.MESSAGES, field: "content" }),
]);

export function isAgentSendCipherAad(table, field) {
  return AGENT_SEND_CIPHER_AADS.some((p) => p.table === table && p.field === field);
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Resolve table/field de um cipher part.
 * - ambos ausentes/vazios → legado messages.content
 * - só um presente, ou inválido → drop (sem tentar outros AADs)
 */
export function resolveAgentSendCipherAad(part) {
  const table = typeof part?.table === "string" ? part.table.trim() : "";
  const field = typeof part?.field === "string" ? part.field.trim() : "";
  const hasT = nonEmptyString(table);
  const hasF = nonEmptyString(field);
  if (!hasT && !hasF) {
    return { ok: true, table: E2EE_TABLE.MESSAGES, field: "content", legacy: true };
  }
  if (!hasT || !hasF) return { ok: false, reason: "partial" };
  if (!isAgentSendCipherAad(table, field)) return { ok: false, reason: "invalid" };
  return { ok: true, table, field, legacy: false };
}

/** Construtor do produtor: cipher part com AAD explícito (fail-closed se o par não for permitido). */
export function agentSendCipherPart(text, table, field) {
  if (typeof text !== "string") throw new Error("agentSendCipherPart: text obrigatório");
  if (!isAgentSendCipherAad(table, field)) {
    throw new Error("agentSendCipherPart: table/field não permitido em agent:send.parts");
  }
  return { kind: "cipher", text, table, field };
}

function collectFields(obj, fields, prefix) {
  const hits = [];
  if (!obj || typeof obj !== "object") return hits;
  for (const f of fields) {
    if (isPlainCatalogText(obj[f])) hits.push(prefix ? `${prefix}.${f}` : f);
  }
  return hits;
}

function collectBoardHits(p) {
  const hits = collectFields(p, BOARD_TEXT_FIELDS, "board");
  if (Array.isArray(p.steps)) {
    for (const st of p.steps) hits.push(...collectFields(st, BOARD_STEP_FIELDS, "board.steps"));
  }
  if (p.chart && typeof p.chart === "object") {
    if (Array.isArray(p.chart.labels)) {
      for (const x of p.chart.labels) {
        if (isPlainCatalogText(x)) hits.push("board.chart.labels");
      }
    }
    if (Array.isArray(p.chart.series)) {
      for (const se of p.chart.series) hits.push(...collectFields(se, BOARD_CHART_SERIES_FIELDS, "board.chart.series"));
    }
  }
  if (Array.isArray(p.annotations)) {
    for (const a of p.annotations) hits.push(...collectFields(a, BOARD_ANNOTATION_FIELDS, "board.annotations"));
  }
  if (Array.isArray(p.blocks)) {
    for (const b of p.blocks) hits.push(...collectBoardHits(b));
  }
  return hits;
}

function collectMemoryHits(mem) {
  const hits = [];
  if (!mem || typeof mem !== "object") return hits;
  for (const [plain, cipher] of Object.entries(MEMORY_PLAIN_TO_CIPHER)) {
    if (isPlainCatalogText(mem[plain]) || isPlainCatalogText(mem[cipher])) hits.push(`memory.${plain}`);
  }
  return hits;
}

/** base64 do anexo em claro (sem e2e:) — mimeType/name nunca entram. */
function collectImageHits(images) {
  if (!Array.isArray(images)) return [];
  for (const img of images) {
    if (img && typeof img === "object" && isPlainCatalogText(img.base64)) {
      return ["message.images"];
    }
  }
  return [];
}

function collectListHits(list, fields, prefix) {
  const hits = [];
  if (!Array.isArray(list)) return hits;
  for (const item of list) hits.push(...collectFields(item, fields, prefix));
  return hits;
}

/**
 * Campos do catálogo em claro num write (comando WS ou op do bridge).
 * Usado pelo server (D4) pra recusar persistência quando e2eeRequired.
 */
export function catalogPlainHits(kind, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  switch (kind) {
    case "add_task":
    case "tasks_add":
      return collectFields(p.task ?? p, TASK_FIELDS, "task");
    case "update_task":
    case "tasks_update":
      return collectFields(p.patch ?? p, TASK_FIELDS, "task");
    case "add_task_comment":
    case "tasks_comment_add":
      return collectFields(p, COMMENT_FIELDS, "comment");
    case "add_goal":
      return collectFields(p.goal ?? p, GOAL_FIELDS, "goal");
    case "update_goal":
      return collectFields(p.patch ?? p, GOAL_FIELDS, "goal");
    case "add_memory":
    case "memory_add":
      return collectMemoryHits(p.memory ?? p);
    case "update_memory":
      return collectMemoryHits(p.patch ?? p);
    case "user_to_agent":
    case "broadcast":
    case "send":
    case "agent:text": {
      const hits = [];
      if (isPlainCatalogText(p.content) || isPlainCatalogText(p.text)) hits.push("message.content");
      if (p.msg) hits.push(...collectFields(p.msg, MESSAGE_FIELDS, "message"));
      hits.push(...collectImageHits(p.images ?? p.msg?.images));
      return hits;
    }
    case "save_tts_summary": {
      const e = p.entry ?? p;
      const hits = [];
      for (const f of SUMMARY_FIELDS) {
        if (isPlainCatalogText(e[f])) hits.push(`summary.${f}`);
      }
      if (isPlainCatalogText(e.original)) hits.push("summary.original");
      return hits;
    }
    case "board_set_title":
    case "board_set":
    case "board_say":
    case "board_upsert_block":
    case "board_create":
    case "board_draw":
    case "board":
      return collectBoardHits(p);
    case "create_plan":
    case "plans_create": {
      const src = p.plan ?? p;
      return [
        ...collectFields(src, PLAN_FIELDS, "plan"),
        ...collectListHits(src.tasks ?? p.tasks, PLAN_TASK_FIELDS, "plan_task"),
      ];
    }
    case "update_plan":
      return collectFields(p.patch ?? p, PLAN_FIELDS, "plan");
    case "add_plan_task":
    case "plans_add_task":
      return collectFields(p.task ?? p, PLAN_TASK_FIELDS, "plan_task");
    case "update_plan_task":
      return collectFields(p.patch ?? p, PLAN_TASK_FIELDS, "plan_task");
    case "apply_plan_tasks":
    case "plans_apply_tasks":
      return collectListHits(p.tasks, PLAN_TASK_FIELDS, "plan_task");
    case "apply_plan_steps":
      return collectListHits(p.steps, MISSION_STEP_FIELDS, "mission_step");
    case "create_mission": {
      const src = p.mission ?? p;
      return [
        ...collectFields(src, MISSION_FIELDS, "mission"),
        ...collectListHits(src.steps, MISSION_STEP_FIELDS, "mission_step"),
      ];
    }
    case "update_mission":
      return collectFields(p.patch ?? p, MISSION_FIELDS, "mission");
    case "add_mission_step":
      return collectFields(p.step ?? p, MISSION_STEP_FIELDS, "mission_step");
    case "update_mission_step":
      return collectFields(p.patch ?? p, MISSION_STEP_FIELDS, "mission_step");
    case "add_schedule":
      return collectFields(p.schedule ?? p, SCHEDULE_FIELDS, "schedule");
    case "update_schedule":
      return collectFields(p.patch ?? p, SCHEDULE_FIELDS, "schedule");
    case "save_agent":
    case "spawn": {
      const spec = p.spec ?? p.agent ?? p;
      const hits = [];
      if (isPlainCatalogText(spec.systemPrompt) || isPlainCatalogText(spec.system_prompt)) {
        hits.push("agent.system_prompt");
      }
      return hits;
    }
    case "add_credential":
      return collectFields(p.credential ?? p, CREDENTIAL_FIELDS, "credential");
    case "summarize":
      return isPlainCatalogText(p.text) ? ["summarize.text"] : [];
    default:
      if (typeof kind === "string" && kind.startsWith("board_")) return collectBoardHits(p);
      return [];
  }
}
