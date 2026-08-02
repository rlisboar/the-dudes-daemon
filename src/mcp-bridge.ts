import http from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const AGENT_ID = process.env.THE_DUDES_AGENT_ID;
const AGENT_NAME = process.env.THE_DUDES_AGENT_NAME ?? AGENT_ID ?? "unknown";
const ORCH = process.env.THE_DUDES_ORCH_URL ?? "http://127.0.0.1:8787";
const BRIDGE_SOCKET = process.env.THE_DUDES_BRIDGE_SOCKET;

// Token preferencialmente via arquivo mode 0o600 escrito pelo daemon.
// Em vez de THE_DUDES_AGENT_TOKEN no env (visível em /proc/<pid>/environ
// pra outros processos do mesmo user), bridge lê 1x do disco no boot.
// Fallback pra env mantém back-compat com versões antigas do daemon.
function loadAgentToken(): string {
  const file = process.env.THE_DUDES_AGENT_TOKEN_FILE;
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch (err) {
      // catch sem binding derrubava o bridge inteiro (ReferenceError: e is not defined)
      // e o runner Grok ficava sem tools the-dudes (send_message etc. "Tool not found").
      console.error(
        `[mcp-bridge] failed to read THE_DUDES_AGENT_TOKEN_FILE=${file}: ${(err as Error).message}`,
      );
    }
  }
  return process.env.THE_DUDES_AGENT_TOKEN ?? "";
}
const AGENT_TOKEN = loadAgentToken();

if (!AGENT_ID) {
  console.error("[mcp-bridge] THE_DUDES_AGENT_ID not set");
  process.exit(1);
}

// Timeout 30s pra qualquer chamada bridge → daemon. Sem isso, se daemon
// trava (SIGSTOP, deadlock, socket morto não detectado), o agente CLI
// (claude/etc) fica com tool call pendurada forever sem feedback.
// O CLI não consegue cancelar — usuário precisa matar processo inteiro.
// 30s cobre operações lentas (summarize, large list) com folga; rejeita
// claramente em pathological hangs.
const BRIDGE_REQ_TIMEOUT_MS = 30_000;

function postViaSocket(route: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {});
    const req = http.request(
      {
        socketPath: BRIDGE_SOCKET,
        method: "POST",
        path: `/api/bridge/${AGENT_ID}/${route}`,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${AGENT_TOKEN}`,
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: BRIDGE_REQ_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`bridge ${route} ${res.statusCode}: ${text.slice(0, 200)}`));
          } else {
            try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`bridge ${route} timeout após ${BRIDGE_REQ_TIMEOUT_MS}ms`));
    });
    req.write(data);
    req.end();
  });
}

async function postViaHttp(route: string, body: unknown): Promise<any> {
  // AbortController + timeout — fetch nativo sem timeout interno pende
  // forever se orch trava ou rede congela. Mesmo motivo do socket path.
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(new Error(`bridge ${route} timeout após ${BRIDGE_REQ_TIMEOUT_MS}ms`)), BRIDGE_REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${ORCH}/api/bridge/${AGENT_ID}/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`bridge ${route} ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(tm);
  }
}

async function postJSON(route: string, body: unknown): Promise<any> {
  if (BRIDGE_SOCKET) return postViaSocket(route, body);
  return postViaHttp(route, body);
}

const server = new McpServer({ name: "the-dudes", version: "0.1.0" });

// --- Gating de contexto por projeto -------------------------------------
// O daemon escreve THE_DUDES_FEATURES (lista CSV dos grupos ligados) no env
// deste processo. Ausente = registra TUDO (compat com daemon antigo). Tools
// de grupo desligado não são registradas → não ocupam contexto no agente.
// Grupos não mapeados (goals, credential, webhooks, approve_action) são
// sempre registrados. Monkey-patch em server.tool: gateia por NOME, sem
// tocar nos 21 call sites abaixo.
const _featuresRaw = process.env.THE_DUDES_FEATURES;
const _enabledGroups = _featuresRaw === undefined
  ? null
  : new Set(_featuresRaw.split(",").map((s) => s.trim()).filter(Boolean));
const TOOL_GROUP: Record<string, string> = {
  send_message: "teammates", list_agents: "teammates", delegate: "teammates",
  list_tasks: "tasks", add_task: "tasks", update_task: "tasks",
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
  // approve_action permanece SEMPRE registrado (permission-prompt do claude).
};
const _origTool = server.tool.bind(server);
(server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...args: unknown[]) => {
  const name = args[0] as string;
  const g = TOOL_GROUP[name];
  if (g && _enabledGroups !== null && !_enabledGroups.has(g)) {
    return undefined; // grupo desligado pra este projeto — não registra
  }
  return (_origTool as (...a: unknown[]) => unknown)(...args);
};

server.tool(
  "send_message",
  "Send a message to a teammate by name. Use list_agents to discover them.",
  { to: z.string().describe("Teammate name"), content: z.string() },
  async ({ to, content }) => {
    try {
      const r = await postJSON("send", { to, content });
      if (r.ok) {
        return { content: [{ type: "text", text: `delivered to ${to}` }] };
      }
      return {
        content: [{ type: "text", text: `unknown teammate: ${to}` }],
        isError: true,
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "delegate",
  "Brain delegation: spawn an EPHEMERAL specialist for ONE focused sub-task. YOU classify task_type and complexity; the platform selects the least expensive adequate model among installed runners. Use simple for mechanical/search/formatting work, moderate for ordinary implementation, complex for architecture or difficult debugging, and critical only for high-risk cross-system decisions. The specialist reports back and self-terminates.",
  {
    goal: z.string().describe("The focused task for the sub-agent (self-contained — it has no prior context)."),
    context: z.string().optional().describe("Optional background/inputs the sub-agent needs (paths, constraints, prior findings)."),
    task_type: z.enum(["coding", "research", "analysis", "review", "testing", "documentation", "general"]).describe("Dominant kind of work; drives runner selection."),
    complexity: z.enum(["simple", "moderate", "complex", "critical"]).describe("Minimum capability required. Prefer the lowest reliable tier."),
    preferred_runner: z.enum(["claude", "codex", "opencode", "gemini", "crush", "grok"]).optional().describe("Optional override; used only if installed."),
    preferred_model: z.string().optional().describe("Optional exact model override for advanced cases."),
  },
  async ({ goal, context, task_type, complexity, preferred_runner, preferred_model }) => {
    try {
      const r = await postJSON("delegate", { goal, context: context ?? "", taskType: task_type, complexity, preferredRunner: preferred_runner, preferredModel: preferred_model });
      if (r.error) return { content: [{ type: "text", text: `delegate falhou: ${r.error}` }], isError: true };
      return { content: [{ type: "text", text: `subagente "${r.subagentName}" criado com ${r.route} (task ${r.taskId}). Ele te manda o resultado por mensagem quando terminar.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "list_agents",
  "List teammates (other agents) currently active. Returns name, role, hierarchy level, team, manager, and skills.",
  {},
  async () => {
    try {
      const r = await postJSON("list", {});
      const others = (r.agents ?? []).filter((a: any) => a.id !== AGENT_ID);
      const text = others.length
        ? others.map((a: any) => {
            const parts = [
              `role: ${a.role}`,
              a.hierarchyLevel == null ? undefined : `level: ${a.hierarchyLevel}`,
              a.team ? `team: ${a.team}` : undefined,
              a.manager ? `manager: ${a.manager}` : undefined,
              a.skills?.length ? `skills: ${a.skills.map((s: any) => `${s.name}${s.level ? ` (L${s.level})` : ""}`).join(", ")}` : undefined,
            ].filter(Boolean).join("; ");
            return `- ${a.name}: ${parts}`;
          }).join("\n")
        : "(no teammates online)";
      return { content: [{ type: "text", text: `You are ${AGENT_NAME}.\nTeammates:\n${text}` }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "list_tasks",
  "List all tasks of the current project. Returns id, title, status, assignee, description, lock, blocker, and goal.",
  {},
  async () => {
    try {
      const r = await postJSON("tasks_list", {});
      const tasks = r.tasks ?? [];
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "(no tasks yet)" }] };
      }
      const text = tasks
        .map((t: any) => {
          const assignee = t.assigneeAgentId ? ` @${t.assigneeAgentId}` : "";
          const locked = t.lockedByAgentId ? ` 🔒` : "";
          const blocked = t.blockedByTaskId ? ` ⛔#${t.blockedByTaskNumber ?? t.blockedByTaskId}` : "";
          const goal = t.goalId ? ` 🎯${t.goalId}` : "";
          const desc = t.description ? `\n    ${t.description}` : "";
          return `- [${t.status}] ${t.id}${locked}${blocked}${goal} · ${t.title}${assignee}${desc}`;
        })
        .join("\n");
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "add_task",
  "Add a new task to the project board. Status defaults to 'todo'. Optional assignee is a teammate name. Use goal_id to link this task to a project goal.",
  {
    title: z.string().describe("Short title for the task"),
    description: z.string().optional().describe("Optional details"),
    status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
    assignee: z.string().optional().describe("Teammate name to assign"),
    blockedByTaskId: z.string().optional().describe("Task id this one depends on"),
    goal_id: z.string().optional().describe("Goal id this task contributes to (from list_goals)"),
  },
  async ({ title, description, status, assignee, blockedByTaskId, goal_id }) => {
    try {
      const r = await postJSON("tasks_add", { title, description, status, assignee, blockedByTaskId, goal_id });
      return {
        content: [
          { type: "text", text: `created task ${r.task.id}: "${r.task.title}" [${r.task.status}]` },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "update_task",
  "Update an existing task. Pass id and any fields to change. Use status to move between todo/doing/done/blocked.",
  {
    id: z.string().describe("Task id (e.g. task_xxxx)"),
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
    assignee: z.string().nullable().optional().describe("Teammate name; pass null to unassign"),
  },
  async (args) => {
    try {
      const r = await postJSON("tasks_update", args);
      if (!r.task) return { content: [{ type: "text", text: `task ${args.id} not found` }], isError: true };
      return {
        content: [
          { type: "text", text: `updated task ${r.task.id}: "${r.task.title}" [${r.task.status}]` },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "lock_task",
  "Atomically lock a task so only you can work on it. This prevents double-work. Fails if task is already locked by another agent or blocked by an incomplete dependency. Always lock a task before starting work on it.",
  {
    id: z.string().describe("Task id (e.g. task_xxxx)"),
  },
  async ({ id }) => {
    try {
      const r = await postJSON("tasks_lock", { id });
      if (!r.task) {
        return { content: [{ type: "text", text: `cannot lock task ${id} — it may be locked by someone else or blocked by an unfinished dependency. Check list_tasks for status.` }], isError: true };
      }
      return { content: [{ type: "text", text: `locked task ${r.task.id}: "${r.task.title}"` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "unlock_task",
  "Release the lock on a task so other agents can work on it.",
  {
    id: z.string().describe("Task id (e.g. task_xxxx)"),
  },
  async ({ id }) => {
    try {
      const r = await postJSON("tasks_unlock", { id });
      if (!r.task) return { content: [{ type: "text", text: `cannot unlock task ${id}` }], isError: true };
      return { content: [{ type: "text", text: `unlocked task ${r.task.id}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "lock_file",
  "Lock a file so only you can edit it. Always lock a file before editing it. The lock expires after 5 minutes — renew it if you need more time. Returns the lock info or an error if the file is already locked by another agent.",
  { path: z.string().describe("file path relative to workspace root") },
  async ({ path: lockPath }) => {
    try {
      const j = await postJSON("tasks_lock_file", { path: lockPath });
      if (j.error) return { content: [{ type: "text", text: j.error || `cannot lock "${lockPath}"` }], isError: true };
      return { content: [{ type: "text", text: `locked "${lockPath}" until ${j.lock?.expiresAt ?? "?"}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "unlock_file",
  "Release your lock on a file so other agents can edit it.",
  { path: z.string().describe("file path relative to workspace root") },
  async ({ path: lockPath }) => {
    try {
      const j = await postJSON("tasks_unlock_file", { path: lockPath });
      return { content: [{ type: "text", text: j.released ? `unlocked "${lockPath}"` : `could not unlock "${lockPath}"` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "list_file_locks",
  "List all currently active file locks in this project. Use this before editing files to see which files are locked by other agents.",
  {},
  async () => {
    try {
      const j = await postJSON("tasks_files_locks", {});
      if (!j.locks?.length) return { content: [{ type: "text", text: "no active file locks" }] };
      const list = j.locks.map((l: any) => `- ${l.path} (locked by ${l.agentId.slice(0, 8)} until ${l.expiresAt})`).join("\n");
      return { content: [{ type: "text", text: list }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "list_goals",
  "List all project goals. Returns id, title, description, parent goal, and status. Goals provide context for why tasks exist — always check them to understand the bigger picture.",
  {},
  async () => {
    try {
      const r = await postJSON("goals_list", {});
      const goals = r.goals ?? [];
      if (goals.length === 0) {
        return { content: [{ type: "text", text: "(no goals defined yet)" }] };
      }
      const map = new Map<string, any>();
      for (const g of goals) map.set(g.id, g);
      const roots = goals.filter((g: any) => !g.parentGoalId);
      const buildTree = (g: any, depth: number): string => {
        const indent = "  ".repeat(depth);
        const children = goals.filter((c: any) => c.parentGoalId === g.id);
        let out = `${indent}- [${g.status}] ${g.id} · ${g.title}${g.description ? `\n${indent}  ${g.description}` : ""}`;
        for (const c of children) out += "\n" + buildTree(c, depth + 1);
        return out;
      };
      const text = roots.map((r: any) => buildTree(r, 0)).join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }
);

/* ---------- Planners: ordered group of board tasks; Start → Mission ---------- */

const VALIDATOR_MODE = z.enum(["human", "creator", "agent"]);

server.tool(
  "list_plans",
  "List project plans. A plan is an ordered group of BOARD tasks (not a separate work item). Returns plan id, status, progress, goal, default validator, and membership items (board task ids).",
  {},
  async () => {
    try {
      const r = await postJSON("plans_list", {});
      const plans = r.plans ?? [];
      if (plans.length === 0) {
        return { content: [{ type: "text", text: "(no plans yet — use create_plan)" }] };
      }
      const text = plans
        .map((p: any) => {
          const items = (p.tasks ?? [])
            .map(
              (t: any) =>
                `    ${t.idx + 1}. [${t.status}] board=${t.taskId ?? "?"}${t.taskNumber != null ? ` #${t.taskNumber}` : ""} · ${t.title}` +
                (t.validator?.mode ? ` ✓${t.validator.mode}` : "") +
                (t.executorAgentId ? ` @${t.executorAgentId}` : ""),
            )
            .join("\n");
          return (
            `- [${p.status}] ${p.id} · ${p.title} (${p.progressPct ?? 0}%, ${p.taskCount ?? 0} items)` +
            (p.goalId ? `\n    goal: ${p.goalId}` : "") +
            (p.defaultValidator?.mode ? `\n    default validator: ${p.defaultValidator.mode}` : "") +
            (p.linkedMissionId ? `\n    run: ${p.linkedMissionId}` : "") +
            (items ? `\n${items}` : "")
          );
        })
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "get_plan",
  "Get full detail of one plan by id (including membership prompts/outputs).",
  { id: z.string().describe("Plan id (e.g. pln_xxxx)") },
  async ({ id }) => {
    try {
      const r = await postJSON("plans_get", { id });
      if (!r.plan) {
        return { content: [{ type: "text", text: r.error ?? `plan ${id} not found` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(r.plan, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "create_plan",
  "Create a plan (ordered group of board tasks). Optionally pass existing task_ids and/or draft tasks (title/prompt) that become real board tasks. YOU become plannerAgentId (creator validator). default_validator: human | creator | agent.",
  {
    title: z.string().describe("Plan title"),
    description: z.string().optional().describe("Objective / context"),
    goal_id: z.string().optional().describe("Link to a goal from list_goals"),
    default_validator_mode: VALIDATOR_MODE.optional().describe("Default who validates each item (default human)"),
    default_validator_agent: z.string().optional().describe("If mode=agent: teammate name or id for reviewer"),
    task_ids: z.array(z.string()).optional().describe("Existing board task ids to include (ordered)"),
    tasks: z
      .array(
        z.object({
          title: z.string().optional(),
          prompt: z.string().optional().describe("Executor instructions (becomes board task description)"),
          task_id: z.string().optional().describe("Or link an existing board task"),
          assignee: z.string().optional().describe("Executor teammate name/id"),
          validator_mode: VALIDATOR_MODE.optional(),
          validator_agent: z.string().optional(),
          acceptance: z.string().optional(),
        }),
      )
      .optional()
      .describe("Draft items: creates board tasks + membership"),
  },
  async (args) => {
    try {
      const defaultValidator = args.default_validator_mode
        ? {
            mode: args.default_validator_mode,
            ...(args.default_validator_mode === "agent" && args.default_validator_agent
              ? { agent: args.default_validator_agent }
              : {}),
          }
        : undefined;
      const tasks = args.tasks?.map((t) => ({
        title: t.title,
        prompt: t.prompt,
        taskId: t.task_id,
        assignee: t.assignee,
        validator: t.validator_mode
          ? {
              mode: t.validator_mode,
              ...(t.validator_mode === "agent" && t.validator_agent ? { agent: t.validator_agent } : {}),
            }
          : undefined,
        acceptance: t.acceptance,
      }));
      const r = await postJSON("plans_create", {
        title: args.title,
        description: args.description,
        goal_id: args.goal_id,
        defaultValidator,
        taskIds: args.task_ids,
        tasks,
      });
      if (r.error) return { content: [{ type: "text", text: `error: ${r.error}` }], isError: true };
      const p = r.plan;
      return {
        content: [
          {
            type: "text",
            text: `created plan ${p.id}: "${p.title}" [${p.status}] with ${p.tasks?.length ?? 0} items. Use start_plan when ready to run.`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "add_plan_task",
  "Add one item to a draft/paused plan: either link an existing board task_id OR create a new board task with title/prompt.",
  {
    plan_id: z.string().describe("Plan id"),
    task_id: z.string().optional().describe("Existing board task to link"),
    title: z.string().optional().describe("New board task title (if not linking)"),
    prompt: z.string().optional().describe("Executor instructions / board description"),
    assignee: z.string().optional().describe("Executor teammate"),
    validator_mode: VALIDATOR_MODE.optional(),
    validator_agent: z.string().optional(),
    acceptance: z.string().optional(),
  },
  async (args) => {
    try {
      const r = await postJSON("plans_add_task", {
        planId: args.plan_id,
        taskId: args.task_id,
        title: args.title,
        prompt: args.prompt,
        assignee: args.assignee,
        validator: args.validator_mode
          ? {
              mode: args.validator_mode,
              ...(args.validator_mode === "agent" && args.validator_agent
                ? { agent: args.validator_agent }
                : {}),
            }
          : undefined,
        acceptance: args.acceptance,
      });
      if (r.error || !r.plan) {
        return { content: [{ type: "text", text: r.error ?? "failed" }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: `plan ${r.plan.id} now has ${r.plan.tasks?.length ?? 0} items`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "apply_plan_tasks",
  "Bulk add items to a draft/paused plan (append or replace). Each item without task_id creates a new board task. Use after you design a multi-step decomposition.",
  {
    plan_id: z.string(),
    mode: z.enum(["append", "replace"]).optional().describe("append (default) or replace existing membership"),
    tasks: z.array(
      z.object({
        title: z.string().optional(),
        prompt: z.string().optional(),
        task_id: z.string().optional(),
        assignee: z.string().optional(),
        validator_mode: VALIDATOR_MODE.optional(),
        validator_agent: z.string().optional(),
        acceptance: z.string().optional(),
      }),
    ).describe("1–200 items"),
  },
  async (args) => {
    try {
      const r = await postJSON("plans_apply_tasks", {
        planId: args.plan_id,
        mode: args.mode ?? "append",
        tasks: args.tasks.map((t) => ({
          title: t.title,
          prompt: t.prompt,
          taskId: t.task_id,
          assignee: t.assignee,
          validator: t.validator_mode
            ? {
                mode: t.validator_mode,
                ...(t.validator_mode === "agent" && t.validator_agent
                  ? { agent: t.validator_agent }
                  : {}),
              }
            : undefined,
          acceptance: t.acceptance,
        })),
      });
      if (r.error || !r.plan) {
        return { content: [{ type: "text", text: r.error ?? "failed" }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: `applied ${args.tasks.length} item(s) to plan ${r.plan.id} (${args.mode ?? "append"}) — now ${r.plan.tasks?.length ?? 0} total`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "start_plan",
  "Start a draft/paused plan: materializes a Mission (1 step per board task) and runs it with MissionEngine. Validators map to requiresHuman / reviewer. Board tasks move todo→doing→done as steps complete.",
  { id: z.string().describe("Plan id") },
  async ({ id }) => {
    try {
      const r = await postJSON("plans_start", { id });
      if (r.error || !r.plan) {
        return { content: [{ type: "text", text: r.error ?? `cannot start plan ${id}` }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: `started plan ${r.plan.id} [${r.plan.status}]` +
              (r.plan.linkedMissionId ? ` → mission ${r.plan.linkedMissionId}` : ""),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "pause_plan",
  "Pause a running plan (and its linked mission).",
  { id: z.string().describe("Plan id") },
  async ({ id }) => {
    try {
      const r = await postJSON("plans_pause", { id });
      if (r.error || !r.plan) {
        return { content: [{ type: "text", text: r.error ?? `cannot pause plan ${id}` }], isError: true };
      }
      return { content: [{ type: "text", text: `paused plan ${r.plan.id}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "validate_plan_task",
  "Approve or reject a plan membership item awaiting human validation (plan membership id from list_plans / get_plan, not board task id). Use after human/agent review of executor output.",
  {
    task_id: z.string().describe("Plan membership id (plt_xxxx), NOT board task id"),
    approve: z.boolean().describe("true = approve and continue; false = reject (retry/fail)"),
    note: z.string().optional().describe("Optional comment"),
  },
  async ({ task_id, approve, note }) => {
    try {
      const r = await postJSON("plans_validate_task", { taskId: task_id, approve, note });
      if (r.error || !r.plan) {
        return { content: [{ type: "text", text: r.error ?? "validate failed" }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: `${approve ? "approved" : "rejected"} membership ${task_id}; plan ${r.plan.id} is [${r.plan.status}] ${r.plan.progressPct ?? 0}%`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "add_task_comment",
  "Add a comment to a task. Use to document decisions, ask questions, or leave notes for teammates or the user.",
  {
    taskId: z.string().describe("Task id (e.g. task_xxxx)"),
    content: z.string().describe("Comment text"),
  },
  async ({ taskId, content }) => {
    try {
      const r = await postJSON("tasks_comment_add", { taskId, content });
      if (!r.comment) return { content: [{ type: "text", text: `task ${taskId} not found` }], isError: true };
      return { content: [{ type: "text", text: `added comment to task ${taskId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "list_task_comments",
  "List all comments on a task in chronological order. Use to read notes, decisions and questions logged by teammates or the user.",
  {
    taskId: z.string().describe("Task id (e.g. task_xxxx)"),
  },
  async ({ taskId }) => {
    try {
      const r = await postJSON("tasks_comment_list", { taskId });
      const comments = Array.isArray(r.comments) ? r.comments : [];
      if (comments.length === 0) {
        return { content: [{ type: "text", text: `no comments on task ${taskId}` }] };
      }
      const lines = comments.map((c: any) => {
        const stamp = c.createdAt ? new Date(c.createdAt).toISOString() : "?";
        const author = c.authorName ?? c.authorId ?? "?";
        return `[${stamp}] ${author}: ${c.content ?? ""}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "get_credential",
  "Retrieve a stored credential value by name (e.g. API key, token, password).",
  { name: z.string().describe("Credential name as registered in the project") },
  async ({ name }) => {
    try {
      const r = await postJSON("get_credential", { name });
      return { content: [{ type: "text", text: r.value }] };
    } catch {
      return {
        content: [{ type: "text", text: `credential '${name}' not found` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "list_webhooks",
  "List webhook subscriptions configured in this project. Returns name, direction (outbound/inbound), enabled state, events. URLs and secrets are NOT exposed. Use the names in send_webhook.",
  {},
  async () => {
    try {
      const r = await postJSON("list_webhooks", {});
      const subs = Array.isArray(r.webhooks) ? r.webhooks : [];
      if (subs.length === 0) return { content: [{ type: "text", text: "(no webhooks configured)" }] };
      const text = subs.map((w: any) => {
        const dir = w.direction;
        const flag = w.enabled ? "" : " (disabled)";
        const events = Array.isArray(w.events) && w.events.length ? w.events.join(", ") : "*";
        return `- [${dir}] ${w.name ?? "(sem nome)"}${flag} — events: ${events}`;
      }).join("\n");
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "send_webhook",
  "Send a custom message through a named outbound webhook configured in the project. Returns ok/error. The webhook owner picks the destination (Discord/Slack/etc) and the agent only supplies the message text.",
  {
    webhookName: z.string().describe("Exact name of the outbound webhook subscription"),
    message: z.string().describe("Plaintext message to deliver"),
  },
  async ({ webhookName, message }) => {
    try {
      const r = await postJSON("send_webhook", { webhookName, message });
      if (r.error) return { content: [{ type: "text", text: `error: ${r.error}` }], isError: true };
      return { content: [{ type: "text", text: `delivered to ${webhookName} (status ${r.status ?? "?"})` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "approve_action",
  "Permission prompt called by Claude Code before executing tools when auto-approve is off.",
  {
    tool_name: z.string(),
    input: z.unknown(),
    tool_use_id: z.string().optional(),
  },
  async ({ tool_name, input }) => {
    try {
      const r = await postJSON("permission", { tool: tool_name, input });
      if (r.allow) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ behavior: "allow", updatedInput: input }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              behavior: "deny",
              message: "User denied this action",
            }),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              behavior: "deny",
              message: `bridge error: ${(e as Error).message}`,
            }),
          },
        ],
      };
    }
  }
);

const MEMORY_TYPES = ["fact", "decision", "reference", "preference", "task_state"] as const;

server.tool(
  "remember",
  "Save a durable note to YOUR agent memory (default scope=agent). Default is NOT pinned (catalog/recall only). Set pinned=true only if it must re-inject into YOUR system prompt every restart (hot-set quota ~15). Use scope 'project' only for shared catalog facts others may recall (never auto-injected into all agents). Keep entries short and atomic. Use supersedes to replace an older mem_ id of the same fact.",
  {
    title: z.string().describe("Short one-line title"),
    body: z.string().describe("The fact/decision/reference to remember"),
    type: z.enum(MEMORY_TYPES).optional().describe("fact (default) | decision | reference | preference | task_state"),
    scope: z.enum(["project", "agent"]).optional().describe("agent = yours only (default); project = shared catalog (recall only)"),
    pinned: z.boolean().optional().describe("true = hot-set injection (opt-in). Default false."),
    tags: z.array(z.string()).optional().describe("Optional short tags for filtering"),
    supersedes: z.array(z.string()).optional().describe("mem_ ids this entry replaces (same fact updated)"),
  },
  async ({ title, body, type, scope, pinned, tags, supersedes }) => {
    try {
      const sup = (supersedes ?? []).filter((id) => /^mem_[a-z0-9]+$/i.test(id)).slice(0, 5);
      const r = await postJSON("memory_add", {
        title, body, type,
        scope: scope ?? "agent",
        pinned: pinned === true,
        tags: tags?.slice(0, 12),
        supersedesId: sup[0],
      });
      const newId = r.memory?.id as string | undefined;
      let merged = 0;
      if (newId && sup.length > 0) {
        for (const oldId of sup) {
          if (oldId === newId) continue;
          try {
            await postJSON("memory_remove", { id: oldId });
            merged++;
          } catch { /* ownership */ }
        }
      }
      const pin = r.memory?.pinned ? " pinned" : "";
      const mrg = merged > 0 ? ` superseded ${merged}` : "";
      return { content: [{ type: "text", text: `remembered ${newId ?? ""} [${r.memory?.type ?? type ?? "fact"}/${r.memory?.scope ?? scope ?? "agent"}]${pin}${mrg}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "recall",
  "Search memory visible to you: your private agent entries + project catalog (not archived). Hot-set (pinned) is already in the system prompt. Query multi-word: mode 'and' (default, all terms) or 'or' (any term). Ranked pin > sticky types > recent access.",
  {
    query: z.string().optional().describe("Search terms in title/body/tags"),
    type: z.enum(MEMORY_TYPES).optional(),
    limit: z.number().int().min(1).max(100).optional().describe("Max results (default 40)"),
    mode: z.enum(["and", "or"]).optional().describe("Multi-term match mode (default and)"),
  },
  async ({ query, type, limit, mode }) => {
    try {
      // touch:false no list — só touch dos IDs que passaram no filtro (ranking honesto)
      const r = await postJSON("memory_list", { type, limit: limit ?? 80, touch: false });
      let entries = (r.memories ?? []) as Array<{
        id: string; type: string; scope: string; agentId?: string | null;
        pinned?: boolean; title?: string; body?: string; tags?: string[];
      }>;
      const matchMode = mode === "or" ? "or" : "and";
      if (query?.trim()) {
        const terms = query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
        if (terms.length > 0) {
          entries = entries.filter((e) => {
            const hay = `${e.title ?? ""}\n${e.body ?? ""}\n${(e.tags ?? []).join(" ")}`.toLowerCase();
            return matchMode === "or" ? terms.some((t) => hay.includes(t)) : terms.every((t) => hay.includes(t));
          });
        }
      }
      // Boost sticky types after pin sort (server already ranks; re-boost filtered set)
      entries.sort((a, b) => {
        const pa = a.pinned ? 0 : 1;
        const pb = b.pinned ? 0 : 1;
        if (pa !== pb) return pa - pb;
        const sa = a.type === "decision" || a.type === "preference" ? 0 : 1;
        const sb = b.type === "decision" || b.type === "preference" ? 0 : 1;
        return sa - sb;
      });
      entries = entries.slice(0, limit ?? 40);
      if (entries.length > 0 && (query?.trim() || entries.length <= 15)) {
        void postJSON("memory_touch", { ids: entries.map((e) => e.id) }).catch(() => {});
      }
      if (entries.length === 0) return { content: [{ type: "text", text: "(no matching memory)" }] };
      const text = entries
        .map((e) => {
          const tagStr = e.tags?.length ? ` tags:${e.tags.join(",")}` : "";
          const hot = e.pinned && e.scope === "agent" ? " 📌hot" : "";
          return `- ${e.id} [${e.type}/${e.scope}]${hot}${tagStr} ${e.title ?? "🔒"}\n    ${(e.body ?? "").replace(/\n/g, "\n    ")}`;
        })
        .join("\n");
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "forget",
  "Delete a memory entry. You can only forget entries you created (or your own private ones) — user-curated and other agents' entries are protected.",
  { id: z.string().describe("Memory id (mem_xxxx)") },
  async ({ id }) => {
    try {
      const r = await postJSON("memory_remove", { id });
      if (r.ok) return { content: [{ type: "text", text: `forgot ${id}` }] };
      return { content: [{ type: "text", text: r.error ?? `could not forget ${id}` }], isError: true };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "pin",
  "Pin or unpin a memory entry. Pinned agent-scoped entries enter YOUR hot-set (injected on restart + live-push). Server enforces ~15 pinned per agent (oldest auto-unpin).",
  { id: z.string().describe("Memory id (mem_xxxx)"), pinned: z.boolean().optional().describe("true to pin (default), false to unpin") },
  async ({ id, pinned }) => {
    try {
      const r = await postJSON("memory_pin", { id, pinned: pinned !== false });
      if (r.memory) return { content: [{ type: "text", text: `${r.memory.pinned ? "pinned" : "unpinned"} ${id}` }] };
      return { content: [{ type: "text", text: r.error ?? `memory ${id} not found` }], isError: true };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
server.connect(transport).catch((e: unknown) => {
  console.error("[mcp-bridge] failed to connect:", e);
  process.exit(1);
});
