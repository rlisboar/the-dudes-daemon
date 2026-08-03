import { z } from "zod";

/**
 * Validação de FORMA por comando WS.
 *
 * O que existia antes: `parseWireMessage` checava só o envelope
 * (`{ type: string }` com `.passthrough()`), e daí o payload era tratado como
 * `ClientCommand` por asserção de tipo — nada verificava em runtime. Em 65
 * cases do dispatch havia 2 checagens de tipo inline. Um cliente autenticado
 * mandando `{type:"add_member", email:{}, role:[]}` chegava inteiro no
 * handler e virava erro genérico com correlation ID, ou dado torto no
 * Postgres.
 *
 * DECISÃO — o que estes schemas checam e o que NÃO checam:
 *
 *  - checam TIPO e PRESENÇA (é string mesmo? o enum é um dos valores? o campo
 *    obrigatório veio?). É exatamente o que faltava.
 *  - NÃO checam comprimento. O server já corta por truncagem (`capStr`), e
 *    rejeitar aqui mudaria comportamento: mensagem que hoje entra truncada
 *    passaria a ser recusada.
 *  - NÃO usam `.strict()`. Campo extra é ignorado pelo handler e barrar
 *    quebraria cliente antigo durante deploy escalonado.
 *
 * Cobertura é um allowlist progressivo: comando sem schema passa direto (o
 * envelope já foi validado). `commands.test.js` cobra que os de escrita em DB
 * e os de authz estejam aqui, então comando novo nessas famílias entra
 * deliberadamente e não por esquecimento.
 */

const id = z.string();
const text = z.string();
const flag = z.boolean();

const role = z.enum(["admin", "member"]);
const taskStatus = z.enum(["todo", "doing", "done", "blocked"]);
const memoryScope = z.enum(["project", "agent"]);
const memoryType = z.enum(["fact", "decision", "reference", "preference", "task_state"]);

/** Objeto do comando sem o discriminante — `type` já veio do envelope. */
const cmd = (shape) => z.object({ type: z.string(), ...shape });

export const commandSchemas = {
  /* ---------- membros (authz: só admin do projeto) ---------- */
  add_member: cmd({ email: text, role }),
  update_member: cmd({ userId: id, role }),
  remove_member: cmd({ userId: id }),

  /* ---------- admin global ---------- */
  "admin:set_super_admin": cmd({ userId: id, value: flag }),
  "admin:set_disabled": cmd({ userId: id, value: flag }),
  "admin:set_can_create_projects": cmd({ userId: id, value: flag }),
  "admin:set_project_role": cmd({ userId: id, projectId: id, role }),
  "admin:add_user_to_project": cmd({ userId: id, projectId: id, role }),
  "admin:remove_user_from_project": cmd({ userId: id, projectId: id }),
  // Só leitura, mas registrados de propósito: a família `admin:` inteira é
  // coberta pelo teste, então um comando novo lá não entra sem passar por aqui.
  "admin:list_users": cmd({}),
  "admin:get_system_stats": cmd({}),
  "admin:list_audit": cmd({
    actorUserId: id.optional(),
    action: text.optional(),
    limit: z.number().optional(),
  }),

  /* ---------- tasks ---------- */
  add_task: cmd({
    task: z.object({
      title: text,
      description: text.optional(),
      assigneeAgentId: id.optional(),
      status: taskStatus.optional(),
      blockedByTaskId: id.nullable().optional(),
      goalId: id.nullable().optional(),
    }),
  }),
  update_task: cmd({
    id,
    patch: z.object({
      title: text.optional(),
      description: text.optional(),
      status: taskStatus.optional(),
      assigneeAgentId: id.nullable().optional(),
      blockedByTaskId: id.nullable().optional(),
      labels: z.array(text).optional(),
      goalId: id.nullable().optional(),
    }),
  }),
  remove_task: cmd({ id }),
  add_task_comment: cmd({ taskId: id, authorName: text, content: text }),

  /* ---------- memória (title/body são ciphertext, mas ainda string) ---------- */
  add_memory: cmd({
    memory: z.object({
      titleCipher: text,
      bodyCipher: text,
      type: memoryType.optional(),
      scope: memoryScope.optional(),
      agentId: id.nullable().optional(),
      tags: z.array(text).optional(),
      pinned: flag.optional(),
      confidence: z.number().nullable().optional(),
    }),
  }),

  /* ---------- goals ---------- */
  add_goal: cmd({
    goal: z.object({
      title: text,
      description: text.optional(),
      parentGoalId: id.optional(),
    }),
  }),

  /* ---------- credenciais (valor vira segredo cifrado no DB) ---------- */
  add_credential: cmd({
    credential: z.object({
      name: text,
      value: text.optional(),
      note: text.optional(),
      expiresAt: text.nullable().optional(),
      agentAccess: flag.optional(),
    }),
  }),

  /* ---------- projetos ---------- */
  create_project: cmd({ project: z.object({ name: text }) }),
  update_project: cmd({
    project: z.object({
      id,
      name: text,
      baseRepoName: text.nullable().optional(),
      baseRepoUrl: text.nullable().optional(),
      baseRepoBranch: text.nullable().optional(),
      loopProtection: z.enum(["reactive", "preventive"]).optional(),
      loopLimit: z.number().optional(),
      loopPairLimit: z.number().optional(),
      loopPairWindowMs: z.number().optional(),
      fileLocking: flag.optional(),
      agentWorktrees: flag.optional(),
      collectThinking: flag.optional(),
    }),
  }),
  delete_project: cmd({ id }),
  select_project: cmd({ id }),

  /* ---------- agentes ---------- */
  start_agent: cmd({ id }),
  stop_agent: cmd({ id }),
  remove_agent: cmd({ id }),
  transfer_agent_owner: cmd({ id, newOwnerUserId: id }),
  assign_agent_repo: cmd({ id, repo: text }),

  /* ---------- config sensível do projeto ---------- */
  set_auto_approve: cmd({ value: flag }),
};

/**
 * Valida um comando já passado pelo envelope.
 * Devolve `{ ok: true }` (inclusive pra comando sem schema registrado) ou
 * `{ ok: false, error }` com o caminho do campo que quebrou.
 */
export function validateCommand(command) {
  const schema = Object.prototype.hasOwnProperty.call(commandSchemas, command.type)
    ? commandSchemas[command.type]
    : undefined;
  if (!schema) return { ok: true };
  const parsed = schema.safeParse(command);
  if (parsed.success) return { ok: true };
  const first = parsed.error.issues[0];
  const campo = first.path.filter((p) => p !== "type").join(".") || "(raiz)";
  return { ok: false, error: `campo inválido em ${command.type}: ${campo} — ${first.message}` };
}
