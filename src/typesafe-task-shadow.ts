/**
 * T-852 — sombra do Jev nas tasks (fase 1: só observa).
 *
 * Sai do relay, no mesmo ponto da sombra do delegate (`bridge-relay`), depois
 * da resposta 2xx de `tasks_add`/`tasks_update`: ali o `task` da resposta já
 * está decifrado. O request só decide `event` e skip — o `tasks_update` é patch
 * parcial e não serve de estado.
 *
 * Liga só com `TYPESAFE_TASK_SHADOW` em "1"/"true" (trim, ignora maiúsculas) E
 * a chave do provedor configurado não vazia E `jev_enabled` do projeto (mesma flag do
 * delegate). Sem isso: no-op, zero rede, motivo no log.
 *
 * Não muta o request, não é awaited e uma falha aqui nunca falha a task.
 * Endpoint e modelo ficam pinados; `safeFetch` com maxRedirects 0 e 2,5s;
 * log sem texto, chave ou corpo.
 *
 * A TypeSafe receives only sanitized task title/description and fixed,
 * bounded questions. Project/task/agent identifiers and rosters stay local.
 * HMAC is optional when the project key is unavailable; raw SHA is forbidden.
 */
import { decryptForProject, isE2eEncrypted } from "./daemon-crypto.js";
import { aadReadChain, E2EE_TABLE } from "@the-dudes/protocol/e2ee-fields";
import { isJevLigado, emitirSombra } from "./typesafe-delegate-shadow.js";
import type { TypesafeShadow } from "./protocol.js";
import {
  chamarSystemOne,
  hmacTexto,
  prepararTexto,
  TYPESAFE_MODEL,
  TYPESAFE_MAX_TEXTO_BYTES,
  typesafeLigado,
  type TypesafeFetch,
} from "./typesafe-client.js";

export { TYPESAFE_SYSTEMONE_URL } from "./typesafe-client.js";
const MODEL = TYPESAFE_MODEL;
const FLAG = "TYPESAFE_TASK_SHADOW";
const TETO_TEXTO_BYTES = TYPESAFE_MAX_TEXTO_BYTES;
const DEBOUNCE_MS = 400;
const MAX_EM_VOO = 3;
const PREFIXO_LOG = "[typesafe-task-shadow]";

export type EventoTask = "created" | "reassigned" | "edited";

interface Pedido {
  projectId: string;
  taskId: string;
  evento: EventoTask;
  title: string;
  description: string;
  textSha256?: string;
}

const PERGUNTAS_FIXAS = {
  complexity: {
    type: "choice",
    instructions:
      "What is the lowest complexity tier that can reliably carry out `task`? Prefer the smallest reliable tier. Reserve critical for a cross-system decision, a production effect, or an irreversible effect.",
    criteria: {
      simple: "Mechanical work, search, formatting, or a localized change whose path is obvious.",
      moderate: "Ordinary implementation or a contained fix that needs normal engineering judgment.",
      complex: "Architecture, a difficult diagnosis, or a design that spans several modules.",
      critical: "A cross-system decision, a production change, or an irreversible effect. Not merely hard or urgent.",
    },
  },
  destructive: {
    type: "noul",
    instructions:
      "Does `task` ask to deploy, restart production, change or reveal a credential, delete data, force-push, or mutate a cluster?",
    criteria: {
      true: "One of those effects is requested, including as a step of a larger task.",
      false: "None of those effects is requested.",
    },
  },
  security: {
    type: "noul",
    instructions:
      "Does `task` change or depend on authentication, sessions, cookies, encryption, credentials, secrets, or permissions?",
    criteria: {
      true: "At least one of those areas is changed or depended on.",
      false: "None of those areas is involved.",
    },
  },
  acceptance: {
    type: "noul",
    instructions:
      "Does `task.description` state how to verify the task is done: acceptance criteria, tests, or an observable result?",
    criteria: {
      true: "At least one observable check, test, or acceptance criterion is written down.",
      false: "Nothing says how to verify it.",
    },
  },
} as const;

/** Fallback quando o daemon conhece menos de 2 agentes do projeto. */
const DOMINIO_FIXO = {
  instructions:
    "Which specialist should implement the work in `task`? Choose NONE when the task is an explanation or no specialist implements anything.",
  criteria: {
    DAEMON: "Local agent runners, watchdogs, the MCP bridge, daemon lifecycle, or self-update.",
    SERVER: "The orchestrator, its API, persistence, or migrations.",
    WEB: "The user interface, layout, styling, or client-side text.",
    DEVOPS: "CI, deploy pipelines, or ops configuration, outside the daemon process itself.",
    QA_A: "Independent review of the daemon or the server.",
    QA_B: "Independent review of the web app, ops, or CI/deploy.",
    SECURITY: "A security review or a security-only consultation.",
    THREEJS: "A 3D scene, rendering, or three.js behavior.",
    PM: "Scope, priority, or coordination, with no specialist implementation.",
    NONE: "An explanation or a question, or no specialist implements anything.",
  },
} as const;

const ULTIMO: Map<string, { textSha256: string }> = new Map();
const PENDENTE: Map<string, NodeJS.Timeout> = new Map();
const EM_VOO = new Set<Promise<void>>();
let aleatorio = Math.random;

/** Testes: relógio/aleatório e estado limpos. */
export function _resetTaskShadowForTest(): void {
  ULTIMO.clear();
  for (const t of PENDENTE.values()) clearTimeout(t);
  PENDENTE.clear();
}

export function _setTaskShadowAleatorio(fn: () => number): void {
  aleatorio = fn;
}

/** Compatibilidade com chamadores antigos: este classificador não envia elenco. */
export function definirElencoProjeto(_fn: ((projectId: string) => unknown[]) | null): void {}

export type TaskShadowFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  opts: { timeoutMs: number; maxRedirects: number },
) => Promise<{ status: number; text: () => Promise<string> }>;

let fetchInjetado: TypesafeFetch | null = null;

/** Só testes. `null` volta ao safeFetch de produção. */
export function setTaskShadowFetch(fn: TaskShadowFetch | null): void {
  fetchInjetado = fn as TypesafeFetch | null;
}

/** Só testes: espera os POSTs em voo assentarem. */
export function settleTaskShadowForTests(): Promise<void> {
  return Promise.all([...EM_VOO]).then(() => {});
}

/** Só testes: dispara já, sem esperar o debounce. */
export function flushTaskShadowDebounceForTests(): void {
  for (const [chave, t] of PENDENTE) {
    clearTimeout(t);
    PENDENTE.delete(chave);
    const pend = AGENDADO.get(chave);
    if (pend) { AGENDADO.delete(chave); disparar(pend); }
  }
}

const AGENDADO = new Map<string, Pedido>();

function sombraLigada(): boolean {
  return typesafeLigado(FLAG);
}

function logar(extra: Record<string, unknown>): void {
  try {
    console.error(`${PREFIXO_LOG} ${JSON.stringify(extra)}`);
  } catch {
    /* o log não derruba a task */
  }
}

/** Um skip com motivo é uma linha só — sem texto. */
function pular(motivo: "redaction" | "no-change" | "disabled" | "inflight", ctx: Record<string, unknown>): void {
  logar({ skip: motivo, ...ctx });
}

function jaCifrado(v: unknown): boolean {
  return typeof v === "string" && isE2eEncrypted(v);
}

/**
 * Campo cifrado: tenta abrir com a chave do projeto (o relay já decifrou a
 * resposta, mas o patch nunca passa por lá). Ainda cifrado → `null`.
 */
function textoPlano(v: unknown, projectId: string, field: "title" | "description"): string | null {
  if (typeof v !== "string") return null;
  if (!jaCifrado(v)) return v;
  // Mesma cadeia de AAD dos leitores do relay: v2 primeiro, depois legado.
  for (const aad of aadReadChain({ projectId, table: E2EE_TABLE.TASKS, field })) {
    const p = decryptForProject(v, projectId, aad);
    if (p != null) return p;
  }
  return decryptForProject(v, projectId) ?? null;
}

/** Campos do request que interessam: presença decide evento e skip. */
export interface PatchTask {
  title?: boolean;
  description?: boolean;
  assignee?: boolean;
}

export function classificarEvento(op: "tasks_add" | "tasks_update", patch: PatchTask): EventoTask | "no-change" {
  if (op === "tasks_add") return "created";
  if (patch.assignee) return "reassigned";
  if (patch.title || patch.description) return "edited";
  return "no-change";
}

function montarCorpo(p: Pedido): Record<string, unknown> {
  return {
    model: MODEL,
    state: {
      task: { title: p.title, description: p.description },
    },
    questions: { domain: { type: "choice", ...DOMINIO_FIXO }, ...PERGUNTAS_FIXAS },
  };
}

interface ChoiceLido {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

function lerMapa(v: unknown, allowed: ReadonlySet<string>): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (!allowed.has(k) || typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) return null;
    out[k] = n;
  }
  return out;
}

function lerChoice(v: unknown, allowed: ReadonlySet<string>): ChoiceLido | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (a.type !== "choice") return null;
  if (typeof a.choice !== "string" || !a.choice) return null;
  if (typeof a.choice !== "string" || !allowed.has(a.choice)) return null;
  const probabilities = lerMapa(a.probabilities, allowed);
  if (!probabilities) return null;
  if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) return null;
  return { choice: a.choice, probabilities, confidence: a.confidence };
}

function lerNoul(v: unknown): number | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (a.type !== "noul") return null;
    if (typeof a.noul !== "number" || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) return null;
  return a.noul;
}

function emitir(p: Pedido, evento: Record<string, unknown>): void {
  const msg = {
    type: "typesafe:shadow",
    projectId: p.projectId,
    at: Date.now(),
    ...evento,
    source: "task",
    taskId: p.taskId,
    event: p.evento,
    ...(p.textSha256 ? { textSha256: p.textSha256, hashKind: "hmac1" as const } : {}),
  };
  try { emitirSombra(msg as unknown as TypesafeShadow); } catch { /* emissão não falha a task */ }
}

async function executar(p: Pedido): Promise<void> {
  const inicio = Date.now();
  const falha = (error: string): void => {
    logar({ source: "task", taskId: p.taskId, event: p.evento, ok: false, error });
    emitir(p, {
      ok: false, error, model: MODEL, latencyMs: Date.now() - inicio,
      declaredTaskType: "", declaredComplexity: "", taskType: "", complexity: "", domain: "",
      confidence: null, destructiveNoul: null, disagreeTaskType: false, disagreeComplexity: false,
      securityNoul: null, acceptanceNoul: null, disagreeDomain: null, probabilities: null,
    });
  };
  try {
    const res = await chamarSystemOne(montarCorpo(p), fetchInjetado ?? undefined);
    if (!res) return;
    if (res.status !== 200 && res.status !== 201) {
      await drenar(res);
      falha(res.status === 429 ? "http_429" : res.status >= 400 && res.status <= 599 ? `http_${res.status}` : "fetch");
      return;
    }
    let dados: unknown;
    try {
      dados = JSON.parse(await res.text());
    } catch {
      falha("parse");
      return;
    }
    const answers = (dados as { answers?: Record<string, unknown> } | null)?.answers;
    if (!answers || typeof answers !== "object") { falha("parse"); return; }
    const domain = lerChoice(answers.domain, new Set(Object.keys(DOMINIO_FIXO.criteria)));
    const complexity = lerChoice(answers.complexity, new Set(["simple", "moderate", "complex", "critical"]));
    const destructive = lerNoul(answers.destructive);
    const security = lerNoul(answers.security);
    const acceptance = lerNoul(answers.acceptance);
    if (!domain || !complexity || destructive == null || security == null || acceptance == null) {
      falha("parse");
      return;
    }
    if (!(domain.choice in DOMINIO_FIXO.criteria)) { falha("rotulo"); return; }
    const domainAgent = domain.choice;
    const confianca = { task_type: 0, complexity: complexity.confidence, domain: domain.confidence };
    const evento = {
      ok: true,
      error: null,
      model: MODEL,
      latencyMs: Date.now() - inicio,
      declaredTaskType: "",
      declaredComplexity: "",
      taskType: "",
      complexity: complexity.choice,
      domain: domainAgent,
      confidence: confianca,
      destructiveNoul: destructive,
      disagreeTaskType: false,
      disagreeComplexity: false,
      securityNoul: security,
      acceptanceNoul: acceptance,
      // null quando o responsável declarado não está no elenco deste daemon.
      disagreeDomain: null,
      probabilities: { domain: domain.probabilities, complexity: complexity.probabilities },
    };
    logar({ source: "task", taskId: p.taskId, event: p.evento, ok: true, latencyMs: evento.latencyMs });
    emitir(p, evento);
  } catch (e) {
    const nome = (e as { name?: string })?.name;
    falha(nome === "TimeoutError" || nome === "AbortError" ? "timeout" : "fetch");
  }
}

async function drenar(res: { text: () => Promise<string> }): Promise<void> {
  try { await res.text(); } catch { /* corpo não entra no log */ }
}

function disparar(p: Pedido): void {
  if (EM_VOO.size >= MAX_EM_VOO) {
    pular("inflight", { source: "task", taskId: p.taskId, emVoo: EM_VOO.size });
    return;
  }
  const job = executar(p).catch(() => {});
  EM_VOO.add(job);
  void job.finally(() => { EM_VOO.delete(job); });
}

export interface EntradaTaskShadow {
  op: "tasks_add" | "tasks_update";
  projectId: string;
  /** `task` da RESPOSTA 2xx (fonte do estado). */
  task: Record<string, unknown>;
  /** Campos tocados pelo request: decide `event`, nada mais. */
  patch: PatchTask;
}

/**
 * Copia o estado e devolve já. O POST corre depois, com debounce curto por
 * taskId (last-wins): um burst de updates manda só o último estado.
 */
export function scheduleTaskShadow(input: EntradaTaskShadow): void {
  try {
    const { op, projectId, task, patch } = input;
    const taskId = typeof task.id === "string" ? task.id : "";
    if (!projectId || !taskId) return;
    if (!sombraLigada()) { pular("disabled", { source: "task", taskId, motivo: "flag" }); return; }
    if (!isJevLigado(projectId)) { pular("disabled", { source: "task", taskId, motivo: "jev-off" }); return; }

    const evento = classificarEvento(op, patch);
    if (evento === "no-change") { pular("no-change", { source: "task", taskId, event: "status-only" }); return; }

    const titleCru = textoPlano(task.title, projectId, "title");
    const descCru = textoPlano(task.description, projectId, "description");
    if (titleCru == null || (task.description != null && descCru == null)) {
      pular("redaction", { source: "task", taskId, event: evento });
      return;
    }
    const title = prepararTexto(titleCru, TETO_TEXTO_BYTES, projectId);
    const description = descCru == null || !descCru.trim() ? "" : prepararTexto(descCru, TETO_TEXTO_BYTES, projectId);
    if (title == null || description == null) {
      pular("redaction", { source: "task", taskId, event: evento });
      return;
    }
    if (!title) return;

    const textSha256 = hmacTexto(projectId, JSON.stringify([title, description])) ?? undefined;
    const anterior = ULTIMO.get(taskId);
    if (textSha256 && anterior?.textSha256 === textSha256) {
      pular("no-change", { source: "task", taskId, event: evento });
      return;
    }

    const pedido: Pedido = {
      projectId,
      taskId,
      evento,
      title,
      description,
      ...(textSha256 ? { textSha256 } : {}),
    };
    if (textSha256) ULTIMO.set(taskId, { textSha256 });

    // Debounce last-wins: um burst manda só o último estado da task.
    AGENDADO.set(taskId, pedido);
    const anteriorTimer = PENDENTE.get(taskId);
    if (anteriorTimer) clearTimeout(anteriorTimer);
    const timer = setTimeout(() => {
      PENDENTE.delete(taskId);
      const pend = AGENDADO.get(taskId);
      AGENDADO.delete(taskId);
      if (pend) disparar(pend);
    }, DEBOUNCE_MS + Math.floor(aleatorio() * 50));
    timer.unref?.();
    PENDENTE.set(taskId, timer);
  } catch {
    /* a sombra nunca falha a task */
  }
}
