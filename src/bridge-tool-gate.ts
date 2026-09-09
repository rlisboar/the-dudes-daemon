/**
 * T-391 — decisão única de registo do mcp-bridge, extraída do monkey-patch de
 * `server.tool` para ser testável sem importar o bridge (o módulo liga stdio no
 * import e morreria o TAP do test runner).
 *
 * Duas linhas independentes de gating:
 *  - FEATURE (herdada de `mcp-bridge.ts`): `TOOL_GROUP` × `THE_DUDES_FEATURES`,
 *    escrita pelo daemon a partir das features do projeto. Um grupo desligado
 *    não registra → não ocupa contexto.
 *  - PAPEL (T-391): `ROLE_GATED_TOOLS` × `THE_DUDES_AGENT_ROLE`, escrita pelo
 *    RUNNER a partir de `this.info.role`. O bridge não conhece papéis — obedece.
 *    É o único ramo que prova A3/A5: um BACKEND num projeto com `teammates`
 *    ligado não recebe `save_agent`/`stop_agent` na lista, porque a visibilidade
 *    não é uma feature do projeto — é o papel do agente. Um TOOL_GROUP novo
 *    ("control") falharia este critério por construção: filtraria por projeto.
 *
 * Regra de ouro (ruling do PM): o omissor é o runner; o bridge pode registrar.
 */

export const CONTROLLER_ROLE = "controller";

/** Ferramentas gated por papel do agente, não por feature do projeto. */
export const ROLE_GATED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  save_agent: CONTROLLER_ROLE,
  stop_agent: CONTROLLER_ROLE,
  // T-397: liga/remove são as mesmas mãos do dono — papel, não feature.
  start_agent: CONTROLLER_ROLE,
  remove_agent: CONTROLLER_ROLE,
});

/** Feature do projeto que cada tool exige (ausente = sempre registrada). */
export const TOOL_GROUP: Record<string, string> = {
  send_message: "teammates", list_agents: "teammates", delegate: "teammates",
  list_tasks: "tasks", get_task: "tasks", add_task: "tasks", update_task: "tasks",
  lock_task: "tasks", unlock_task: "tasks",
  add_task_comment: "tasks", list_task_comments: "tasks",
  lock_file: "filelock", unlock_file: "filelock", list_file_locks: "filelock",
  // Plans = grupo ordenado de board tasks; gate junto com tasks.
  list_plans: "tasks", get_plan: "tasks", create_plan: "tasks",
  add_plan_task: "tasks", apply_plan_tasks: "tasks",
  start_plan: "tasks", pause_plan: "tasks", validate_plan_task: "tasks",
  remember: "memory", recall: "memory", forget: "memory", pin: "memory",
  list_goals: "goals",
  get_credential: "credentials",
  list_webhooks: "webhooks", send_webhook: "webhooks",
  // Explanation Board — opt-in por projeto (THE_DUDES_FEATURES=board)
  board_get: "board", board_clear: "board", board_set: "board",
  board_upsert_block: "board", board_remove_block: "board",
  board_focus: "board", board_set_step: "board", board_play: "board", board_pause: "board",
  board_say: "board", board_draw: "board", board_remove_annotation: "board",
  board_clear_drawings: "board",
  board_list: "board", board_create: "board", board_switch: "board", board_delete: "board",
  // approve_action permanece SEMPRE registrado (permission-prompt do claude).
};

/**
 * `enabledGroups === null` = daemon antigo sem THE_DUDES_FEATURES → registra
 * tudo o que não for gated por papel. Um tool com papel exigido NUNCA depende
 * do null: sem papel, não registra, com features ou sem elas.
 */
export function bridgeToolAllowed(
  name: string,
  enabledGroups: Set<string> | null,
  agentRole: string,
): boolean {
  const requiredRole = ROLE_GATED_TOOLS[name];
  if (requiredRole) return agentRole === requiredRole;
  const g = TOOL_GROUP[name];
  if (!g) return true;
  return enabledGroups === null || enabledGroups.has(g);
}
