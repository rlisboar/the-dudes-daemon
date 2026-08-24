import { z } from "zod";

/**
 * Validação de FORMA por comando WS.
 *
 * DECISÃO — o que estes schemas checam e o que NÃO checam:
 *  - checam TIPO e PRESENÇA. Não checam comprimento (server já trunca).
 *  - NÃO usam `.strict()` — campo extra é ignorado (deploy escalonado).
 *
 * T-067: 100% dos comandos que escrevem em DB têm schema. O teste estrutural
 * em server/src/__tests__/ws-command-schemas.test.ts falha o build se um
 * `case` novo do dispatch não tiver schema nem estiver no allowlist de
 * leitura. Comando sem schema ainda PASSA em runtime (allowlist progressivo
 * pras rotas só-leitura).
 */

const id = z.string();
const text = z.string();
const flag = z.boolean();
const num = z.number();

const role = z.enum(["admin", "member"]);
const taskStatus = z.enum(["todo", "doing", "done", "blocked"]);
const memoryScope = z.enum(["project", "agent"]);
const memoryType = z.enum(["fact", "decision", "reference", "preference", "task_state"]);
const goalStatus = z.enum(["active", "achieved", "archived"]);
const scheduleType = z.enum(["interval", "daily", "cron"]);
const planValidator = z.object({
  mode: z.enum(["human", "creator", "agent"]),
  agentId: id.optional(),
  agentRole: text.optional(),
});
const agentRepo = z.object({ name: text, gitUrl: text, branch: text.optional() });
const imageAtt = z.object({ mimeType: text, base64: text, name: text.optional() });
const agentSpec = z.object({
  id: id.optional(),
  name: text,
  role: text,
  systemPrompt: text.optional(),
  hierarchyLevel: num.optional(),
  managerAgentId: id.nullable().optional(),
  team: text.optional(),
  color: text.optional(),
  model: text.optional(),
  effort: text.optional(),
  cliRunner: text.optional(),
  planMode: flag.optional(),
  claudeConfigDir: text.nullable().optional(),
  collectThinking: flag.nullable().optional(),
  ttsEnabled: flag.nullable().optional(),
  skillAllowlist: z.array(text).nullable().optional(),
  mcpAllowlist: z.array(text).nullable().optional(),
  fallbackChain: z.array(text).nullable().optional(),
  ephemeral: flag.optional(),
  ownerUserId: id.optional(),
  repo: agentRepo.nullable().optional(),
  cwdOverride: text.nullable().optional(),
});
const missionStepIn = z.object({
  title: text,
  prompt: text,
  agentId: id.optional(),
  agentRole: text.optional(),
  requiresHuman: flag.optional(),
  maxAttempts: num.optional(),
  timeoutMs: num.optional(),
  completionMode: text.optional(),
  reviewerAgentId: id.optional(),
});
const planTaskIn = z.object({
  taskId: id.optional(),
  title: text.optional(),
  prompt: text.optional(),
  executorAgentId: id.optional(),
  executorRole: text.optional(),
  validator: planValidator.optional(),
  acceptance: text.optional(),
  maxAttempts: num.optional(),
  timeoutMs: num.optional(),
});

/** Objeto do comando — `type` já veio do envelope. */
const cmd = (shape) => z.object({ type: z.string(), ...shape });

export const commandSchemas = {
  /* ---------- membros ---------- */
  add_member: cmd({ email: text, role }),
  update_member: cmd({ userId: id, role }),
  remove_member: cmd({ userId: id }),
  leave_project: cmd({}),

  /* ---------- admin global ---------- */
  "admin:set_super_admin": cmd({ userId: id, value: flag }),
  "admin:set_disabled": cmd({ userId: id, value: flag }),
  "admin:set_can_create_projects": cmd({ userId: id, value: flag }),
  "admin:set_project_role": cmd({ userId: id, projectId: id, role }),
  "admin:add_user_to_project": cmd({ userId: id, projectId: id, role }),
  "admin:remove_user_from_project": cmd({ userId: id, projectId: id }),
  "admin:list_users": cmd({}),
  "admin:get_system_stats": cmd({}),
  "admin:list_audit": cmd({
    actorUserId: id.optional(),
    action: text.optional(),
    limit: num.optional(),
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
  lock_task: cmd({ id }),
  unlock_task: cmd({ id }),
  add_task_comment: cmd({ taskId: id, authorName: text, content: text }),

  /* ---------- memória ---------- */
  add_memory: cmd({
    memory: z.object({
      titleCipher: text,
      bodyCipher: text,
      type: memoryType.optional(),
      scope: memoryScope.optional(),
      agentId: id.nullable().optional(),
      tags: z.array(text).optional(),
      pinned: flag.optional(),
      confidence: num.nullable().optional(),
      contentHash: text.optional(),
      supersedesId: id.nullable().optional(),
      goalId: id.nullable().optional(),
      taskId: id.nullable().optional(),
      planId: id.nullable().optional(),
      expiresAt: text.nullable().optional(),
    }),
  }),
  update_memory: cmd({
    id,
    patch: z.object({
      titleCipher: text.optional(),
      bodyCipher: text.optional(),
      type: memoryType.optional(),
      scope: memoryScope.optional(),
      agentId: id.nullable().optional(),
      tags: z.array(text).optional(),
      pinned: flag.optional(),
      confidence: num.nullable().optional(),
      supersedesId: id.nullable().optional(),
      goalId: id.nullable().optional(),
      taskId: id.nullable().optional(),
      planId: id.nullable().optional(),
      archivedAt: text.nullable().optional(),
      expiresAt: text.nullable().optional(),
    }),
  }),
  remove_memory: cmd({ id }),
  clear_memories: cmd({}),
  bulk_memories: cmd({
    ids: z.array(id),
    action: z.enum(["pin", "unpin", "archive", "unarchive", "delete", "set_scope_project", "set_scope_agent"]),
    agentId: id.nullable().optional(),
  }),
  memory_hygiene: cmd({ mode: z.enum(["unpin_non_sticky", "enforce_quota"]).optional() }),
  set_memory_enabled: cmd({ value: flag }),
  set_memory_max_pinned: cmd({ value: num }),
  set_e2ee_required: cmd({ value: flag }),

  /* ---------- goals ---------- */
  add_goal: cmd({
    goal: z.object({
      title: text,
      description: text.optional(),
      parentGoalId: id.optional(),
    }),
  }),
  update_goal: cmd({
    id,
    patch: z.object({
      title: text.optional(),
      description: text.optional(),
      status: goalStatus.optional(),
      parentGoalId: id.nullable().optional(),
    }),
  }),
  remove_goal: cmd({ id }),
  update_goal_auto_complete: cmd({ id, value: flag }),

  /* ---------- credenciais ---------- */
  add_credential: cmd({
    credential: z.object({
      name: text,
      value: text.optional(),
      note: text.optional(),
      expiresAt: text.nullable().optional(),
      agentAccess: flag.optional(),
    }),
  }),
  remove_credential: cmd({ id }),
  grant_credential: cmd({ credentialId: id, userId: id }),
  revoke_credential: cmd({ credentialId: id, userId: id }),

  /* ---------- projetos ---------- */
  create_project: cmd({ project: z.object({ name: text }) }),
  create_project_with_key: cmd({ project: z.object({ name: text }), wrappedProjectKey: text }),
  duplicate_project: cmd({ id, name: text.optional(), wrappedProjectKey: text.optional() }),
  update_project: cmd({
    project: z.object({
      id,
      name: text,
      baseRepoName: text.nullable().optional(),
      baseRepoUrl: text.nullable().optional(),
      baseRepoBranch: text.nullable().optional(),
      loopProtection: z.enum(["reactive", "preventive"]).optional(),
      loopLimit: num.optional(),
      loopPairLimit: num.optional(),
      loopPairWindowMs: num.optional(),
      fileLocking: flag.optional(),
      agentWorktrees: flag.optional(),
      collectThinking: flag.optional(),
      diagramLanguage: z.enum(["mermaid", "d2"]).optional(),
      boardMode: z.enum(["blocks", "html"]).optional(),
      boardHtmlLevel: z.enum(["basic", "normal", "quality"]).optional(),
      boardWidth: z.enum(["small", "medium", "large"]).optional(),
    }),
  }),
  delete_project: cmd({ id }),
  select_project: cmd({ id }),
  set_workspace: cmd({ basePath: text }),
  set_auto_approve: cmd({ value: flag }),
  set_loop_protection: cmd({
    value: z.enum(["reactive", "preventive"]),
    limitEnabled: flag.optional(),
    limit: num.optional(),
    pairLimit: num.optional(),
    pairWindowMs: num.optional(),
  }),
  set_auto_retry: cmd({ enabled: flag, seconds: num }),
  set_context_feature: cmd({
    feature: z.enum(["tasks", "teammates", "goals", "credentials", "webhooks", "graph", "board"]),
    value: flag,
  }),
  set_project_planner: cmd({ agentId: id.nullable() }),
  set_project_plan_defaults: cmd({
    plannerAgentId: id.nullable().optional(),
    defaultValidator: planValidator.nullable().optional(),
  }),

  /* ---------- agentes / mensagens persistidas ---------- */
  start_agent: cmd({ id }),
  stop_agent: cmd({ id }),
  remove_agent: cmd({ id }),
  transfer_agent_owner: cmd({ id, newOwnerUserId: id }),
  assign_agent_repo: cmd({ id, repo: z.union([agentRepo, text, z.null()]) }),
  save_agent: cmd({ spec: agentSpec }),
  spawn: cmd({ spec: agentSpec }),
  user_to_agent: cmd({ id, content: text, images: z.array(imageAtt).optional() }),
  broadcast: cmd({ content: text, images: z.array(imageAtt).optional() }),
  clear_messages: cmd({}),

  /* ---------- templates ---------- */
  save_template: cmd({
    template: z.object({
      name: text,
      role: text,
      systemPrompt: text,
      hierarchyLevel: num.optional(),
      team: text.optional(),
      color: text.optional(),
      model: text.optional(),
      effort: text.optional(),
      cliRunner: text.optional(),
      planMode: flag.optional(),
      cwdOverride: text.optional(),
      claudeConfigDir: text.optional(),
      skillAllowlist: z.array(text).nullable().optional(),
      mcpAllowlist: z.array(text).nullable().optional(),
      enabled: flag.optional(),
    }),
  }),
  update_template: cmd({
    id,
    patch: z.object({
      name: text.optional(),
      role: text.optional(),
      systemPrompt: text.optional(),
      hierarchyLevel: num.optional(),
      team: text.optional(),
      color: text.optional(),
      model: text.optional(),
      effort: text.optional(),
      cliRunner: text.optional(),
      planMode: flag.optional(),
      cwdOverride: text.optional(),
      claudeConfigDir: text.optional(),
      skillAllowlist: z.array(text).nullable().optional(),
      mcpAllowlist: z.array(text).nullable().optional(),
      enabled: flag.optional(),
    }),
  }),
  delete_template: cmd({ id }),

  /* ---------- schedules ---------- */
  add_schedule: cmd({
    schedule: z.object({
      title: text,
      prompt: text,
      targetAgentId: id.optional(),
      scheduleType,
      intervalMs: num.optional(),
      dailyTime: text.optional(),
      cronExpr: text.optional(),
      timezone: text.optional(),
      wakeAgent: flag.optional(),
    }),
  }),
  update_schedule: cmd({
    id,
    patch: z.object({
      title: text.optional(),
      prompt: text.optional(),
      targetAgentId: id.nullable().optional(),
      enabled: flag.optional(),
      intervalMs: num.optional(),
      dailyTime: text.optional(),
      cronExpr: text.optional(),
      timezone: text.optional(),
      wakeAgent: flag.optional(),
      scheduleType: scheduleType.optional(),
    }),
  }),
  remove_schedule: cmd({ id }),
  fire_schedule: cmd({ id }),

  /* ---------- board (persistido) ---------- */
  board_clear: cmd({}),
  board_set_title: cmd({ title: text }),
  board_create: cmd({ title: text.optional() }),
  board_switch: cmd({ id }),
  board_delete: cmd({ id }),
  board_restore: cmd({ id }),
  board_remove_block: cmd({ id }),
  board_focus: cmd({ blockId: id }),
  board_set_step: cmd({ blockId: id, stepIndex: num, playing: flag.optional() }),
  board_play: cmd({ blockId: id, intervalMs: num.optional(), from: num.optional() }),
  board_pause: cmd({}),
  board_draw: cmd({
    annotation: z.object({
      id: id.optional(),
      kind: z.enum(["rect", "ellipse", "arrow", "pen", "pin", "text"]),
      blockId: id.optional(),
      selector: text.optional(),
      points: z.array(z.object({ x: num, y: num })),
      aroundBlock: flag.optional(),
      color: text.optional(),
      label: text.optional(),
      strokeWidth: num.optional(),
    }),
    askAgentId: id.optional(),
    askPrompt: text.optional(),
  }),
  board_remove_annotation: cmd({ id }),
  board_clear_drawings: cmd({}),

  /* ---------- missions / plans ---------- */
  create_mission: cmd({
    mission: z.object({
      title: text,
      description: text.optional(),
      goalId: id.optional(),
      steps: z.array(missionStepIn).optional(),
    }),
  }),
  update_mission: cmd({
    id,
    patch: z.object({
      title: text.optional(),
      description: text.optional(),
      goalId: id.nullable().optional(),
    }),
  }),
  start_mission: cmd({ id }),
  cancel_mission: cmd({ id }),
  reset_mission: cmd({ id }),
  duplicate_mission: cmd({ id }),
  remove_mission: cmd({ id }),
  approve_step: cmd({ stepId: id, approve: flag, comment: text.optional() }),
  force_complete_step: cmd({ stepId: id, output: text }),
  report_step_sentinel: cmd({
    stepId: id,
    kind: z.enum(["complete", "failed", "review_approve", "review_reject"]),
    output: text.optional(),
    reason: text.optional(),
  }),
  generate_plan: cmd({ missionId: id }),
  apply_plan_steps: cmd({
    missionId: id,
    mode: z.enum(["append", "replace"]),
    steps: z.array(missionStepIn),
  }),
  add_mission_step: cmd({ missionId: id, step: missionStepIn }),
  update_mission_step: cmd({
    stepId: id,
    patch: z.object({
      title: text.optional(),
      prompt: text.optional(),
      agentId: id.nullable().optional(),
      agentRole: text.nullable().optional(),
      requiresHuman: flag.optional(),
      maxAttempts: num.optional(),
      timeoutMs: num.nullable().optional(),
    }),
  }),
  remove_mission_step: cmd({ stepId: id }),
  reorder_mission_steps: cmd({ missionId: id, stepIds: z.array(id) }),
  create_plan: cmd({
    plan: z.object({
      title: text,
      description: text.optional(),
      goalId: id.optional(),
      plannerAgentId: id.optional(),
      defaultValidator: planValidator.optional(),
      taskIds: z.array(id).optional(),
      tasks: z.array(planTaskIn).optional(),
    }),
  }),
  update_plan: cmd({
    id,
    patch: z.object({
      title: text.optional(),
      description: text.optional(),
      goalId: id.nullable().optional(),
      plannerAgentId: id.nullable().optional(),
      defaultValidator: planValidator.optional(),
    }),
  }),
  remove_plan: cmd({ id, deleteBoardTasks: flag.optional(), deleteLinkedMission: flag.optional() }),
  add_plan_task: cmd({ planId: id, task: planTaskIn }),
  update_plan_task: cmd({
    taskId: id,
    patch: z.object({
      title: text.optional(),
      prompt: text.optional(),
      executorAgentId: id.nullable().optional(),
      executorRole: text.nullable().optional(),
      validator: planValidator.nullable().optional(),
      acceptance: text.nullable().optional(),
      maxAttempts: num.optional(),
      timeoutMs: num.nullable().optional(),
    }),
  }),
  remove_plan_task: cmd({ taskId: id }),
  reorder_plan_tasks: cmd({ planId: id, taskIds: z.array(id) }),
  apply_plan_tasks: cmd({
    planId: id,
    mode: z.enum(["append", "replace"]),
    tasks: z.array(planTaskIn),
  }),
  start_plan: cmd({ id }),
  pause_plan: cmd({ id }),
  cancel_plan: cmd({ id }),
  reset_plan: cmd({ id }),
  validate_plan_task: cmd({ taskId: id, approve: flag, note: text.optional() }),
  report_plan_task_sentinel: cmd({
    taskId: id,
    kind: z.enum(["complete", "failed", "validate_approve", "validate_reject"]),
    output: text.optional(),
    reason: text.optional(),
  }),

  /* ---------- gitlab (grava config / cria tasks) ---------- */
  gitlab_save_config: cmd({
    config: z.object({
      baseUrl: text,
      projectRef: text,
      token: text.optional(),
      defaultBranch: text.optional(),
      webhookSecret: text.optional(),
    }),
  }),
  gitlab_import_issues: cmd({
    state: z.enum(["opened", "closed", "all"]).optional(),
    labels: text.optional(),
  }),
  gitlab_export_task: cmd({ taskId: id, labels: text.optional() }),
  gitlab_export_all_tasks: cmd({ labels: text.optional(), deleteMissing: flag.optional() }),
  gitlab_create_webhook: cmd({ publicUrl: text }),
  gitlab_create_branch: cmd({ branch: text, ref: text.optional() }),
  gitlab_create_mr: cmd({
    title: text,
    sourceBranch: text,
    targetBranch: text.optional(),
    description: text.optional(),
    taskId: id.optional(),
  }),
  gitlab_comment_issue: cmd({ issueIid: num, body: text }),
  gitlab_comment_mr: cmd({ mergeRequestIid: num, body: text }),

  /* ---------- tts / runs ---------- */
  save_tts_summary: cmd({
    entry: z.object({
      id,
      agentId: id.optional(),
      agentName: text.optional(),
      agentColor: text.optional(),
      original: text,
      summary: text.optional(),
      state: z.enum(["ok", "err", "fallback"]),
      error: text.optional(),
    }),
  }),
  clear_tts_summaries: cmd({}),
  clear_runs: cmd({}),

  /* ---------- crypto / totp / project keys (DB) ---------- */
  "crypto:init": cmd({
    publicKey: text,
    wrappedPrivateKey: text,
    wrappedPrivateKeyRecovery: text,
    kekSalt: text,
    recoveryCodeHash: text,
  }),
  "crypto:rotate_passphrase": cmd({ wrappedPrivateKey: text, kekSalt: text }),
  "crypto:reset_with_recovery": cmd({
    wrappedPrivateKey: text,
    wrappedPrivateKeyRecovery: text,
    kekSalt: text,
    recoveryCodeHash: text,
    oldRecoveryCodeHash: text.optional(),
  }),
  "crypto:dev_reset": cmd({}),
  "totp:setup_init": cmd({}),
  "totp:setup_confirm": cmd({ code: text }),
  "totp:disable": cmd({ code: text }),
  "project_keys:rotate": cmd({
    projectId: id,
    wraps: z.array(z.object({ userId: id, wrappedProjectKey: text })),
    ringEntry: text.optional(),
  }),
  "project_keys:set_for_member": cmd({ projectId: id, userId: id, wrappedProjectKey: text }),
  "project_keys:enable_e2ee": cmd({ projectId: id, wrappedProjectKey: text }),

  /* ---------- file locks (tabela file_locks) ---------- */
  lock_file: cmd({ path: text }),
  unlock_file: cmd({ path: text }),

  /* ---------- T-098 task workspaces ---------- */
  workspace_create: cmd({ taskId: id, agentId: id }),
  workspace_remove: cmd({ taskId: id, force: flag.optional() }),
  workspace_list: cmd({}),
};

/**
 * Comandos cujo handler persiste no Postgres. Fonte da verdade pro teste
 * estrutural: todo nome daqui TEM que ter schema. Case novo de escrita
 * entra aqui de propósito, não por esquecimento.
 */
export const DB_WRITE_COMMANDS = Object.freeze([
  "add_member", "update_member", "remove_member", "leave_project",
  "admin:set_super_admin", "admin:set_disabled", "admin:set_can_create_projects",
  "admin:set_project_role", "admin:add_user_to_project", "admin:remove_user_from_project",
  "add_task", "update_task", "remove_task", "lock_task", "unlock_task", "add_task_comment",
  "add_memory", "update_memory", "remove_memory", "clear_memories", "bulk_memories",
  "memory_hygiene", "set_memory_enabled", "set_memory_max_pinned", "set_e2ee_required",
  "add_goal", "update_goal", "remove_goal", "update_goal_auto_complete",
  "add_credential", "remove_credential", "grant_credential", "revoke_credential",
  "create_project", "create_project_with_key", "duplicate_project", "update_project",
  "delete_project", "set_workspace", "set_auto_approve", "set_loop_protection",
  "set_auto_retry", "set_context_feature", "set_project_planner", "set_project_plan_defaults",
  "start_agent", "stop_agent", "remove_agent", "transfer_agent_owner", "assign_agent_repo",
  "save_agent", "spawn", "user_to_agent", "broadcast", "clear_messages",
  "save_template", "update_template", "delete_template",
  "add_schedule", "update_schedule", "remove_schedule", "fire_schedule",
  "board_clear", "board_set_title", "board_create", "board_switch", "board_delete",
  "board_restore", "board_remove_block", "board_focus", "board_set_step", "board_play",
  "board_pause", "board_draw", "board_remove_annotation", "board_clear_drawings",
  "create_mission", "update_mission", "start_mission", "cancel_mission", "reset_mission",
  "duplicate_mission", "remove_mission", "approve_step", "force_complete_step",
  "report_step_sentinel", "generate_plan", "apply_plan_steps",
  "add_mission_step", "update_mission_step", "remove_mission_step", "reorder_mission_steps",
  "create_plan", "update_plan", "remove_plan", "add_plan_task", "update_plan_task",
  "remove_plan_task", "reorder_plan_tasks", "apply_plan_tasks",
  "start_plan", "pause_plan", "cancel_plan", "reset_plan",
  "validate_plan_task", "report_plan_task_sentinel",
  "gitlab_save_config", "gitlab_import_issues", "gitlab_export_task",
  "gitlab_export_all_tasks", "gitlab_create_webhook", "gitlab_create_branch",
  "gitlab_create_mr", "gitlab_comment_issue", "gitlab_comment_mr",
  "save_tts_summary", "clear_tts_summaries", "clear_runs",
  "crypto:init", "crypto:rotate_passphrase", "crypto:reset_with_recovery", "crypto:dev_reset",
  "totp:setup_init", "totp:setup_confirm", "totp:disable",
  "project_keys:rotate", "project_keys:set_for_member", "project_keys:enable_e2ee",
  "lock_file", "unlock_file",
  "workspace_create", "workspace_remove",
]);

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
