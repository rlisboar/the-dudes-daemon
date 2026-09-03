import http from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { normalizeBoardUpsertArgs } from "./board-upsert-args.js";
import { withBridgeRetry } from "./bridge-retry.js";
import {
  memoryManualDupDecision,
  memoryPinBudgetWarning,
  memoryQueryMatch,
} from "./memory-utils.js";
import { POLICY_GATED_RUNNERS } from "./runner-policy.js";

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

async function postJSONOnce(route: string, body: unknown): Promise<any> {
  if (BRIDGE_SOCKET) return postViaSocket(route, body);
  return postViaHttp(route, body);
}

/**
 * T-037: retry em falhas transitórias (502, ECONNREFUSED, timeout) — restart
 * do server / troca do bridge.sock no self-update. Rotas críticas (send)
 * usam isto; o helper postJSON genérico também, pra list/tasks não sumirem
 * no mesmo buraco.
 */
async function postJSON(route: string, body: unknown): Promise<any> {
  return withBridgeRetry(() => postJSONOnce(route, body), { attempts: 4, baseDelayMs: 200 });
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
/** Linguagem de diagrama do projeto (daemon escreve no env junto das
 *  features). Entra na descrição da tool pra o agente não escrever mermaid
 *  num projeto que só renderiza d2 — o bloco chegaria sem renderer. */
const DIAGRAM_LANG: "mermaid" | "d2" = process.env.THE_DUDES_DIAGRAM_LANG === "d2" ? "d2" : "mermaid";
/** Modo do quadro. `html` = a página inteira é o quadro; `blocks` = markdown
 *  + diagrama. Exclusivos: o enum abaixo oferece só o que o modo permite, e o
 *  server recusa o que escapar. */
const BOARD_MODE: "blocks" | "html" = process.env.THE_DUDES_BOARD_MODE === "html" ? "html" : "blocks";
/** Requinte da página no modo html — muda o que a tool autoriza (script,
 *  three.js) e o quanto o agente deve investir. */
const HTML_LEVEL: "basic" | "normal" | "quality" =
  process.env.THE_DUDES_BOARD_HTML_LEVEL === "basic" ? "basic"
  : process.env.THE_DUDES_BOARD_HTML_LEVEL === "quality" ? "quality"
  : "normal";
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
  // Explanation Board — opt-in por projeto (THE_DUDES_FEATURES=board)
  board_get: "board", board_clear: "board", board_set: "board",
  board_upsert_block: "board", board_remove_block: "board",
  board_focus: "board", board_set_step: "board", board_play: "board", board_pause: "board",
  board_say: "board", board_draw: "board", board_remove_annotation: "board",
  board_clear_drawings: "board",
  board_list: "board", board_create: "board", board_switch: "board", board_delete: "board",
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
    preferred_runner: z.enum(POLICY_GATED_RUNNERS).optional().describe("Optional override; used only if installed."),
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
  "Save a durable note to YOUR agent memory (default scope=agent). Default is NOT pinned (catalog/recall only). Set pinned=true only if it must re-inject into YOUR system prompt every restart (hot-set quota ~15, budget 8000 chars). Use scope 'project' only for shared catalog facts others may recall (never auto-injected into all agents). Keep entries short and atomic. Use supersedes to replace an older mem_ id of the same fact. Near-dup guard: an existing entry with a similar title and essentially the same body is SKIPPED; with a new body, the new entry supersedes the old one automatically.",
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
      // Near-dup manual: título parecido (Jaccard ≥0.72) contra memórias
      // existentes → skip (corpo igual) ou supersede (corpo novo).
      let existing: Array<{ id: string; title?: string; body?: string }> = [];
      try {
        const lr = await postJSON("memory_list", { limit: 80, touch: false });
        existing = (lr.memories ?? []).map((m: any) => ({
          id: typeof m?.id === "string" ? m.id : "",
          title: typeof m?.title === "string" ? m.title : "",
          body: typeof m?.body === "string" ? m.body : "",
        }));
      } catch {
        // lista indisponível → segue como create (não bloqueia o save)
      }
      const dup = memoryManualDupDecision(existing, title, body);
      if (dup.action === "skip") {
        console.error(
          `[mcp-bridge] ${AGENT_NAME} remember skip near-dup: "${title}" ≈ ${dup.nearId} ("${dup.nearTitle}") — corpo essencialmente igual`,
        );
        return {
          content: [{
            type: "text",
            text: `skipped — near-dup of ${dup.nearId} ("${dup.nearTitle}") with essentially the same body (nothing saved)`,
          }],
        };
      }
      if (dup.action === "supersede") {
        console.error(
          `[mcp-bridge] ${AGENT_NAME} remember near-dup: "${title}" ≈ ${dup.nearId} ("${dup.nearTitle}") — corpo novo, nova entrada supersedes a antiga`,
        );
      }
      const supList = dup.action === "supersede" && !sup.includes(dup.nearId)
        ? [dup.nearId, ...sup].slice(0, 5)
        : sup;
      const r = await postJSON("memory_add", {
        title, body, type,
        scope: scope ?? "agent",
        pinned: pinned === true,
        tags: tags?.slice(0, 12),
        supersedesId: supList[0],
      });
      const newId = r.memory?.id as string | undefined;
      let merged = 0;
      if (newId && supList.length > 0) {
        for (const oldId of supList) {
          if (oldId === newId) continue;
          try {
            await postJSON("memory_remove", { id: oldId });
            merged++;
          } catch { /* ownership */ }
        }
      }
      const pin = r.memory?.pinned ? " pinned" : "";
      const pinWarn = memoryPinBudgetWarning(pinned, body);
      const mrg = merged > 0 ? ` superseded ${merged}` : "";
      return { content: [{ type: "text", text: `remembered ${newId ?? ""} [${r.memory?.type ?? type ?? "fact"}/${r.memory?.scope ?? scope ?? "agent"}]${pin}${mrg}${pinWarn}` }] };
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
        entries = entries.filter((e) =>
          memoryQueryMatch(`${e.title ?? ""}\n${e.body ?? ""}\n${(e.tags ?? []).join(" ")}`, query, matchMode),
        );
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

// --- Explanation Board ---------------------------------------------------
// Quadro visual em tempo real. Ensine passo a passo: upsert → focus → set_step / play.

server.tool(
  "board_get",
  "Read the ACTIVE Explanation Board (title, blocks, focus, playhead, annotations) + list of all boards. Call before editing.",
  {},
  async () => {
    try {
      const r = await postJSON("board_get", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            activeBoardId: r.activeBoardId,
            boards: r.boards,
            board: r.board ?? r,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_list",
  "List all explanation boards in the project (id, title, blockCount) and which is active.",
  {},
  async () => {
    try {
      const r = await postJSON("board_list", {});
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_create",
  `DEFAULT for any NEW explanation / new topic / "explica X" when another board already has content.
Creates a NEW empty board, switches to it, KEEPS previous boards. Do NOT use board_clear to start a new topic.`,
  { title: z.string().optional().describe("Short topic title for the new board") },
  async ({ title }) => {
    try {
      const r = await postJSON("board_create", { title });
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      return {
        content: [{
          type: "text",
          text: `created board id=${r.board?.id ?? "?"} title=${r.board?.title ?? title ?? ""} (active) — previous boards kept`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_switch",
  "Switch the active board (UI + further board_* ops apply to it).",
  { id: z.string().describe("Board id from board_list / board_get") },
  async ({ id }) => {
    try {
      const r = await postJSON("board_switch", { id });
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      return { content: [{ type: "text", text: `active board → ${id} (${r.board?.title ?? ""})` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_delete",
  "Delete a board by id. If it is the last board, it is cleared instead. Switches to another board if you delete the active one.",
  { id: z.string() },
  async ({ id }) => {
    try {
      const r = await postJSON("board_delete", { id });
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      return { content: [{ type: "text", text: `deleted ${id}; active=${r.activeBoardId ?? r.board?.id}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_clear",
  `Wipe the ACTIVE board's blocks/drawings. DO NOT use this to start a new explanation — use board_create instead.
Only when the human explicitly asks to empty the current board. If the active board has content, the server may open a new board to preserve history.`,
  {},
  async () => {
    try {
      const r = await postJSON("board_clear", {});
      const op = r.board?.lastOp === "create"
        ? `opened NEW board (previous preserved) id=${r.board?.id ?? "?"} title=${r.board?.title ?? ""}`
        : `board cleared (rev ${r.board?.revision ?? "?"}) id=${r.board?.id ?? "?"}`;
      return { content: [{ type: "text", text: op }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_set",
  "Set the ACTIVE board title (live on the Quadro tab).",
  { title: z.string().describe("Short title") },
  async ({ title }) => {
    try {
      const r = await postJSON("board_set", { title });
      return { content: [{ type: "text", text: `board title → ${r.board?.title ?? title}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_upsert_block",
  (BOARD_MODE === "html"
    // Modo html: a lista de kinds tem UM item. Descrever markdown/chart/steps
    // aqui contradiria o enum (que só aceita "html") — e o agente acredita no
    // texto antes de bater no erro de validação.
    ? `Replace THE page of the Quadro. This project's board is a single HTML document that you write end to end.
- kind: "html" (the only one here)
- body: a full HTML document. ${HTML_LEVEL === "basic"
    ? "Level BASIC: HTML + CSS only, no <script>. Layout, tables, CSS-only diagrams."
    : HTML_LEVEL === "quality"
    ? "Level QUALITY: HTML + CSS + JS + three.js (import * as THREE from \"three\" — import map injected). Rich, animated, modern — still a lesson, not a demo."
    : "Level NORMAL: HTML + CSS + JS. Light animation and charts you draw (SVG/canvas)."}
- Style with the host palette: var(--bg) var(--panel) var(--elevated) var(--border) var(--text) var(--muted) var(--accent) var(--ok) var(--warn) var(--err). Do not invent a colour scheme.
- Every call REPLACES the page: rewrite the whole document, keep the same id. Do not split across blocks.
- It is displayed WHOLE: the frame grows to your content's height and the human scrolls the board. No inner scrollbar, no fullscreen.
- Use the FULL WIDTH you are given (the board may be set to the whole screen). No narrow centred column; lay cards/comparisons/diagrams side by side with grid auto-fit so it reflows on smaller widths.
- Sandboxed iframe: no access to the app, its session or storage.
- Give anything you may want to point at a stable id (e.g. id="step-2") so marks can target it precisely.
Optional say: spoken aloud via TTS if the agent has voice enabled.`
    : `Add/replace a block. The human sees updates LIVE on the Quadro tab.
Kinds:
- markdown: body = markdown
- ${DIAGRAM_LANG}: body = ${DIAGRAM_LANG} source — THIS project's diagram language${DIAGRAM_LANG === "d2" ? " (d2lang.com)" : ""}, raw (no \`\`\` fences)
- callout: body + tone info|warn|ok|err
- chart: chart = { type, labels, series }
- steps | flow: steps = [{ label, detail? }] — animated teaching flow (use with board_set_step / board_play)
Reuse the same id to update a block in place while you explain. focus defaults true (scrolls UI to it).
Optional say: spoken aloud via TTS if the agent has voice enabled.`),
  {
    id: z.string().optional().describe("Stable id to update in place, e.g. flow-main"),
    // O enum oferece SÓ a linguagem de diagrama do projeto. Deixar as duas
    // disponíveis não resolvia: o modelo lê "mermaid" na lista e vai de
    // mermaid por hábito, por mais que a descrição e o system prompt peçam
    // d2. Aqui a escolha errada nem existe — e se ele tentar, o zod recusa
    // com o nome do kind válido, que é feedback direto pro agente.
    kind: BOARD_MODE === "html"
      // Modo HTML: o quadro É a página. Deixar markdown no enum reabriria a
      // mistura que o modo existe pra evitar.
      ? z.enum(["html"])
      : (DIAGRAM_LANG === "d2"
          ? z.enum(["markdown", "d2", "chart", "callout", "steps", "flow"])
          : z.enum(["markdown", "mermaid", "chart", "callout", "steps", "flow"])),
    title: z.string().optional(),
    body: z.string().optional().describe("Block body (HTML/markdown/diagram source). Prefer this name."),
    // T-024: alias de body — LLMs reusam o nome de send_message (`content`)
    // e o Zod descartava o campo → server 400 "html exige body".
    content: z.string().optional().describe("Alias of body (same meaning). Prefer body."),
    tone: z.enum(["info", "warn", "ok", "err"]).optional(),
    order: z.number().optional(),
    focus: z.boolean().optional().describe("Scroll UI to this block (default true)"),
    say: z.string().optional().describe("Short spoken line (TTS) while showing this block"),
    steps: z
      .array(z.object({
        id: z.string().optional(),
        label: z.string(),
        detail: z.string().optional(),
      }))
      .optional()
      .describe("For kind steps|flow"),
    chart: z
      .object({
        type: z.enum(["bar", "line", "pie"]),
        labels: z.array(z.string()),
        series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })),
      })
      .optional(),
  },
  async (args) => {
    try {
      // content→body antes do post (e do E2EE do relay, que cifra `body`).
      const payload = normalizeBoardUpsertArgs(args as Record<string, unknown>);
      const r = await postJSON("board_upsert_block", payload);
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      const n = r.board?.blocks?.length ?? 0;
      const id = args.id ?? r.board?.focusBlockId ?? "?";
      return {
        content: [{
          type: "text",
          text: `upserted ${args.kind} id=${id} rev=${r.board?.revision ?? "?"} blocks=${n}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_remove_block",
  "Remove a block by id.",
  { id: z.string() },
  async ({ id }) => {
    try {
      const r = await postJSON("board_remove_block", { id });
      return { content: [{ type: "text", text: `removed ${id} (rev ${r.board?.revision ?? "?"})` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_focus",
  "Highlight + scroll the UI to a block while you talk about it (real-time teaching). Optional say → TTS.",
  {
    blockId: z.string().describe("Block id"),
    say: z.string().optional().describe("Short spoken line (TTS) about this block"),
  },
  async ({ blockId, say }) => {
    try {
      const r = await postJSON("board_focus", { blockId, say });
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      return { content: [{ type: "text", text: `focus → ${blockId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_set_step",
  "Point the playhead at a step in a steps/flow block (sync animation with your explanation). Auto-narrates label+detail via TTS unless you pass say (or empty to skip is not supported — pass say to override).",
  {
    blockId: z.string(),
    stepIndex: z.number().describe("0-based step index"),
    playing: z.boolean().optional().describe("Keep autoplay on/off"),
    say: z.string().optional().describe("Override spoken text for this step (default: label + detail)"),
  },
  async ({ blockId, stepIndex, playing, say }) => {
    try {
      const r = await postJSON("board_set_step", { blockId, stepIndex, playing, say });
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      return { content: [{ type: "text", text: `step ${stepIndex} on ${blockId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_play",
  "Auto-animate a steps/flow block (cycles steps for the human). Prefer board_set_step when explaining verbally in sync.",
  {
    blockId: z.string(),
    intervalMs: z.number().optional().describe("ms per step, default 1800"),
    from: z.number().optional().describe("start step index"),
  },
  async ({ blockId, intervalMs, from }) => {
    try {
      const r = await postJSON("board_play", { blockId, intervalMs, from });
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      return { content: [{ type: "text", text: `playing ${blockId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_pause",
  "Pause steps/flow autoplay on the board.",
  {},
  async () => {
    try {
      await postJSON("board_pause", {});
      return { content: [{ type: "text", text: "board paused" }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_say",
  "Speak a short line via the human's TTS (agent voice must be ON). Use while pointing at the board — does not change blocks. Prefer short spoken sentences (1–3).",
  { text: z.string().describe("Spoken text (plain, short)") },
  async ({ text }) => {
    try {
      const r = await postJSON("board_say", { text });
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      return { content: [{ type: "text", text: `said (rev ${r.board?.revision ?? "?"})` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_draw",
  `Draw on the shared Quadro (bidirectional: you=orange, human=blue).

${BOARD_MODE === "html"
  ? "**PREFERRED in this project (html board):** selector = the id of the element you want to ring (e.g. #step-2). Blind pixel coords age badly — the page reflows and the ring drifts."
  : "**PREFERRED (no blind coords):** aroundBlock=true + blockId — UI hugs that block."}
Kinds: ellipse | rect | arrow | pen | pin | text

Free geometry (only if you know layout): points NORMALIZED 0–1 on board surface
- ellipse|rect: [topLeft, bottomRight]
- arrow: [from, to] · pen: path · pin|text: [anchor] + label

Human marks arrive as [board mark] messages and in board_get.annotations (author=human).
${BOARD_MODE === "html" ? "When replying to a human mark, reuse the selector the message gives you (TARGET ELEMENT) — same element, not the whole page." : "When replying to a human mark, prefer aroundBlock on the same blockId."}`,
  {
    kind: z.enum(["rect", "ellipse", "arrow", "pen", "pin", "text"]),
    points: z.array(z.object({ x: z.number(), y: z.number() })).optional()
      .describe("Board-normalized 0–1; omit when aroundBlock=true"),
    blockId: z.string().optional().describe("Block id (required if aroundBlock)"),
    selector: z.string().optional()
      .describe(BOARD_MODE === "html"
        ? "CSS selector of the element INSIDE your html (e.g. #step-2). Preferred here: the UI resolves it to the live rect, so the ring lands exactly on the element even after reflow."
        : "CSS selector (html board mode only)"),
    aroundBlock: z.boolean().optional()
      .describe("true = UI anchors mark on the block DOM (recommended)"),
    label: z.string().optional().describe("Caption / note on the mark"),
    strokeWidth: z.number().optional(),
    id: z.string().optional().describe("Stable id to replace a previous mark"),
  },
  async (args) => {
    try {
      const r = await postJSON("board_draw", args);
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      const a = r.annotation;
      return {
        content: [{
          type: "text",
          text: `drew ${args.kind} id=${a?.id ?? args.id ?? "?"} author=agent color=orange`
            + ` anchor=${a?.anchor ?? "board"} blockId=${a?.blockId ?? args.blockId ?? "—"}`
            + ` rev=${r.board?.revision ?? "?"}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_remove_annotation",
  "Remove one drawing/mark by id.",
  { id: z.string() },
  async ({ id }) => {
    try {
      const r = await postJSON("board_remove_annotation", { id });
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      return { content: [{ type: "text", text: `removed annotation ${id}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "board_clear_drawings",
  "Clear all drawings/marks on the board (keeps blocks).",
  {},
  async () => {
    try {
      const r = await postJSON("board_clear_drawings", {});
      return { content: [{ type: "text", text: `drawings cleared rev=${r.board?.revision ?? "?"}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `bridge error: ${(e as Error).message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch((e: unknown) => {
  console.error("[mcp-bridge] failed to connect:", e);
  process.exit(1);
});
