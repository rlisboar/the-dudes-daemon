/**
 * T-852 — sombra do Jev nas tasks (fase 1: só observa).
 *
 * Sai do relay, no mesmo ponto da sombra do delegate (`bridge-relay`), depois
 * da resposta 2xx de `tasks_add`/`tasks_update`: ali o `task` da resposta já
 * está decifrado. O request só decide `event` e skip — o `tasks_update` é patch
 * parcial e não serve de estado.
 *
 * Liga só com `TYPESAFE_TASK_SHADOW` em "1"/"true" (trim, ignora maiúsculas) E
 * `TYPESAFE_API_KEY` não vazia E `jev_enabled` do projeto (mesma flag do
 * delegate). Sem isso: no-op, zero rede, motivo no log.
 *
 * Não muta o request, não é awaited e uma falha aqui nunca falha a task.
 * Endpoint e modelo ficam pinados; `safeFetch` com maxRedirects 0 e 2,5s;
 * log sem texto, chave ou corpo.
 *
 * Itens do parecer do SECURITY (#855) que valem código:
 *  - rótulos seguros ao parser (`[A-Za-z0-9_.-]{1,64}`), colisão com sufixo,
 *    `NONE` reservado; `domain`/`declaredAssignee` viajam como agentId;
 *  - elenco por whitelist (`name`, `role`), nunca o AgentInfo (o systemPrompt
 *    decifrado ficaria fora); teto de 24, ordem determinística, o responsável
 *    declarado sempre presente;
 *  - hash HMAC local (HKDF do project key) para o server não virar oráculo de
 *    dicionário; projeto sem chave cai em sha256 etiquetado;
 *  - dedup/last-wins por taskId e teto de POSTs em voo.
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { decryptForProject, getProjectKey, isE2eEncrypted } from "./daemon-crypto.js";
import { aadReadChain, E2EE_TABLE } from "@the-dudes/protocol/e2ee-fields";
import { isJevLigado, emitirSombra, safeFetchSombra, type SombraFetchOpts } from "./typesafe-delegate-shadow.js";
import type { TypesafeShadow } from "./protocol.js";

export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const TIMEOUT_MS = 2500;
const TETO_TEXTO = 2000;
const TETO_ROLE = 160;
const TETO_ELENCO = 24;
const TETO_ROTULO = 64;
const DEBOUNCE_MS = 400;
const MAX_EM_VOO = 3;
const PREFIXO_LOG = "[typesafe-task-shadow]";
/** Vocabulário do CHECK do server (v22). */
const HASH_INFO = "jev-text-hash-v1";

export type EventoTask = "created" | "reassigned" | "edited";

export interface ElencoOd {
  agentId: string;
  name: string;
  role: string;
}

interface Rotulado {
  rotulo: string;
  agentId: string;
  texto: string;
}

interface Pedido {
  projectId: string;
  taskId: string;
  evento: EventoTask;
  declaredAssignee: string;
  title: string;
  description: string;
  textHash: string;
  hashKind: "hmac1" | "sha256";
  elenco: Rotulado[];
  /** Menos de 2 agentes conhecidos: o `domain` usa a lista fixa (não agentId). */
  usarFixo: boolean;
  rosterN: number;
  rosterHash: string;
  /** null = não comparável (fora do elenco deste daemon). */
  declaradoNoElenco: string | null;
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

const ULTIMO: Map<string, { hash: string; assignee: string }> = new Map();
const PENDENTE: Map<string, NodeJS.Timeout> = new Map();
const EM_VOO = new Set<Promise<void>>();
let elencoFn: ((projectId: string) => ElencoOd[]) | null = null;
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

/** Main liga o elenco (whitelist name/role do host). */
export function definirElencoProjeto(fn: ((projectId: string) => ElencoOd[]) | null): void {
  elencoFn = fn;
}

export type TaskShadowFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  opts: SombraFetchOpts,
) => Promise<{ status: number; text: () => Promise<string> }>;

let fetchInjetado: TaskShadowFetch | null = null;

/** Só testes. `null` volta ao safeFetch de produção. */
export function setTaskShadowFetch(fn: TaskShadowFetch | null): void {
  fetchInjetado = fn;
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
  const flag = (process.env.TYPESAFE_TASK_SHADOW ?? "").trim().toLowerCase();
  if (flag !== "1" && flag !== "true") return false;
  return (process.env.TYPESAFE_API_KEY ?? "").trim() !== "";
}

function logar(extra: Record<string, unknown>): void {
  try {
    console.error(`${PREFIXO_LOG} ${JSON.stringify(extra)}`);
  } catch {
    /* o log não derruba a task */
  }
}

/** Um skip com motivo é uma linha só — sem texto. */
function pular(motivo: "e2e" | "no-change" | "no-roster" | "disabled" | "inflight", ctx: Record<string, unknown>): void {
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

function higienizarRotulo(bruto: string): string {
  const limpo = bruto.trim().replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[_.-]+/, "").slice(0, TETO_ROTULO);
  return limpo || "AGENTE";
}

function higienizarRole(bruto: string): string {
  const t = bruto.replace(/\s+/g, " ").trim();
  return t.length <= TETO_ROLE ? t : `${t.slice(0, TETO_ROLE - 1)}…`;
}

/** Rótulos únicos, ordem determinística, `NONE` por último. */
function rotular(elenco: ElencoOd[], declaredAssignee: string): Rotulado[] {
  const ordenado = [...elenco].sort((a, b) => (a.name || a.agentId).localeCompare(b.name || b.agentId, "en"));
  // O responsável declarado entra sempre, mesmo fora do topo do teto.
  const declarado = declaredAssignee ? ordenado.find((a) => a.agentId === declaredAssignee) : undefined;
  const selecionados = ordenado.slice(0, TETO_ELENCO);
  if (declarado && !selecionados.includes(declarado)) {
    if (selecionados.length >= TETO_ELENCO) selecionados.pop();
    selecionados.push(declarado);
  }
  const usados = new Set<string>(["NONE"]);
  const out: Rotulado[] = [];
  for (const a of selecionados) {
    let rotulo = higienizarRotulo(a.name || a.agentId);
    if (usados.has(rotulo)) {
      let n = 2;
      while (usados.has(`${rotulo}-${n}`)) n++;
      rotulo = `${rotulo}-${n}`.slice(0, TETO_ROTULO);
    }
    usados.add(rotulo);
    const nome = (a.name || a.agentId).replace(/\s+/g, " ").trim().slice(0, 64);
    out.push({ rotulo, agentId: a.agentId, texto: `${nome} — ${higienizarRole(a.role)}` });
  }
  return out;
}

function hashElenco(rotulados: Rotulado[]): string {
  const base = rotulados.map((r) => `${r.rotulo}:${r.agentId}`).join("|");
  return createHash("sha256").update(base, "utf8").digest("hex").slice(0, 12);
}

/**
 * Hash do texto CRU. HMAC com chave derivada do project key (HKDF) para o
 * server não poder testar candidatos; projeto sem chave cai em sha256 e NUNCA
 * se mistura com hmac1 no histórico da mesma task.
 */
function hashTexto(projectId: string, title: string, description: string): { hash: string; kind: "hmac1" | "sha256" } {
  const base = `${projectId}\n${title}\n${description}`;
  const chave = getProjectKey(projectId);
  if (!chave) return { hash: createHash("sha256").update(base, "utf8").digest("hex").slice(0, 12), kind: "sha256" };
  try {
    const derivada = Buffer.from(hkdfSync("sha256", chave, Buffer.alloc(0), HASH_INFO, 32));
    return { hash: createHmac("sha256", derivada).update(base, "utf8").digest("hex").slice(0, 12), kind: "hmac1" };
  } catch {
    return { hash: createHash("sha256").update(base, "utf8").digest("hex").slice(0, 12), kind: "sha256" };
  }
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

function montarCorpo(p: Pedido): string {
  let domain: { type: "choice"; instructions: string; criteria: Record<string, string> };
  if (p.usarFixo) {
    domain = { type: "choice", ...DOMINIO_FIXO };
  } else {
    const criterios: Record<string, string> = {};
    for (const r of p.elenco) criterios[r.rotulo] = r.texto;
    criterios.NONE = "An explanation or a question, or no specialist implements anything.";
    domain = {
      type: "choice",
      instructions:
        "Which specialist should implement the work in `task`? Choose NONE when the task is an explanation or no specialist implements anything. `declaredAssignee` is who the board says is responsible, not the answer.",
      criteria: criterios,
    };
  }
  return JSON.stringify({
    model: MODEL,
    state: {
      task: { title: p.title, description: p.description },
      declaredAssignee: p.declaredAssignee,
    },
    questions: { domain, ...PERGUNTAS_FIXAS },
  });
}

interface ChoiceLido {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

function lerMapa(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    out[k] = n;
  }
  return out;
}

function lerChoice(v: unknown): ChoiceLido | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (a.type !== "choice") return null;
  if (typeof a.choice !== "string" || !a.choice) return null;
  const probabilities = lerMapa(a.probabilities);
  if (!probabilities) return null;
  if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence)) return null;
  return { choice: a.choice, probabilities, confidence: a.confidence };
}

function lerNoul(v: unknown): number | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (a.type !== "noul") return null;
  if (typeof a.noul !== "number" || !Number.isFinite(a.noul)) return null;
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
    declaredAssignee: p.declaredAssignee,
    textSha256: p.textHash,
    hashKind: p.hashKind,
  };
  // T-878 ainda não está na main: os campos novos do veredito vão por cast.
  try { emitirSombra(msg as unknown as TypesafeShadow); } catch { /* emissão não falha a task */ }
}

async function executar(p: Pedido): Promise<void> {
  const inicio = Date.now();
  const falha = (error: string): void => {
    logar({ source: "task", taskId: p.taskId, event: p.evento, ok: false, error, rosterN: p.rosterN, rosterHash: p.rosterHash, hashKind: p.hashKind });
    emitir(p, {
      ok: false, error, model: MODEL, latencyMs: Date.now() - inicio,
      declaredTaskType: "", declaredComplexity: "", taskType: "", complexity: "", domain: "",
      confidence: null, destructiveNoul: null, disagreeTaskType: false, disagreeComplexity: false,
      securityNoul: null, acceptanceNoul: null, disagreeDomain: null, probabilities: null,
    });
  };
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${(process.env.TYPESAFE_API_KEY ?? "").trim()}` },
      body: montarCorpo(p),
      signal,
    };
    const res = fetchInjetado
      ? await fetchInjetado(TYPESAFE_SYSTEMONE_URL, init, { timeoutMs: TIMEOUT_MS, maxRedirects: 0 })
      : await safeFetchSombra(TYPESAFE_SYSTEMONE_URL, init, { timeoutMs: TIMEOUT_MS, maxRedirects: 0 });
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
    const domain = lerChoice(answers.domain);
    const complexity = lerChoice(answers.complexity);
    const destructive = lerNoul(answers.destructive);
    const security = lerNoul(answers.security);
    const acceptance = lerNoul(answers.acceptance);
    if (!domain || !complexity || destructive == null || security == null || acceptance == null) {
      falha("parse");
      return;
    }
    const rotuloDe = new Map(p.elenco.map((r) => [r.rotulo, r.agentId]));
    let domainAgent = "";
    if (domain.choice !== "NONE") {
      // Lista fixa (sem elenco): o veredito é o papel, não um agentId.
      const resolvido = p.usarFixo ? (domain.choice in DOMINIO_FIXO.criteria ? domain.choice : "") : rotuloDe.get(domain.choice) ?? "";
      if (!resolvido) { falha("rotulo"); return; }
      domainAgent = resolvido;
    }
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
      disagreeDomain: p.declaradoNoElenco == null ? null : domainAgent !== p.declaradoNoElenco,
      probabilities: { domain: domain.probabilities, complexity: complexity.probabilities },
    };
    logar({ source: "task", taskId: p.taskId, event: p.evento, ok: true, latencyMs: evento.latencyMs, rosterN: p.rosterN, rosterHash: p.rosterHash, hashKind: p.hashKind });
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
    if (titleCru == null || descCru == null) {
      pular("e2e", { source: "task", taskId, event: evento, title: titleCru != null, description: descCru != null });
      return;
    }
    const title = titleCru.trim();
    const description = descCru.trim();
    if (!title) return;

    const elencoBruto = elencoFn?.(projectId) ?? [];
    const declaredAssignee = typeof task.assigneeAgentId === "string" ? task.assigneeAgentId : "";
    const elenco = rotular(elencoBruto, declaredAssignee);
    const rosterN = elenco.length;
    if (rosterN < 2) pular("no-roster", { source: "task", taskId, event: evento, rosterN });

    const { hash, kind } = hashTexto(projectId, titleCru, descCru);
    const anterior = ULTIMO.get(taskId);
    if (anterior && anterior.hash === hash && anterior.assignee === declaredAssignee) {
      pular("no-change", { source: "task", taskId, event: evento });
      return;
    }

    const pedido: Pedido = {
      projectId,
      taskId,
      evento,
      declaredAssignee,
      title: title.length <= TETO_TEXTO ? title : title.slice(0, TETO_TEXTO),
      description: description.length <= TETO_TEXTO ? description : description.slice(0, TETO_TEXTO),
      textHash: hash,
      hashKind: kind,
      elenco,
      usarFixo: elenco.length < 2,
      rosterN,
      rosterHash: hashElenco(elenco),
      declaradoNoElenco: declaredAssignee && elenco.some((r) => r.agentId === declaredAssignee) ? declaredAssignee : null,
    };
    ULTIMO.set(taskId, { hash, assignee: declaredAssignee });

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