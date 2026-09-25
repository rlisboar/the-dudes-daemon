/**
 * Sombra do portão TypeSafe no delegate (T-758).
 *
 * O plaintext do goal só existe no relay, dentro de `encryptOr409`, entre o
 * `JSON.parse` e `encryptBridgePayload`. É daqui que a sombra sai — não do
 * mcp-bridge: o env do bridge não herda o do daemon, e copiar
 * credenciais TypeSafe/OpenRouter para lá gravaria a chave nos configs dos runners.
 *
 * Liga só com `TYPESAFE_DELEGATE_SHADOW` em "1"/"true" (trim, ignora maiúsculas) E
 * a chave do provedor configurado não vazia. Sem flag ou sem chave: no-op, zero rede.
 * Copia apenas goal/taskType/complexity na hora e devolve. Não muta o json,
 * não é awaited e não acrescenta campo nenhum ao corpo que sobe. Uma falha
 * aqui não falha o delegate. A rota do Brain não lê este veredito.
 */
import type { TypesafeShadow } from "./protocol.js";
import {
  chamarSystemOne,
  hmacTexto,
  prepararTexto,
  TYPESAFE_MODEL,
  typesafeLigado,
  type TypesafeFetch,
  type TypesafeFetchOpts,
  type TypesafeRequestInit,
} from "./typesafe-client.js";

/** Endpoint pinado. Sem override por env. */
export { TYPESAFE_SYSTEMONE_URL } from "./typesafe-client.js";

/** Versão pinada. O alias móvel não entra no corpo. */
const MODEL = TYPESAFE_MODEL;

const TETO_BYTES = 2 * 1024;
const TETO_DECLARADO = 64;
const PREFIXO_LOG = "[typesafe-delegate-shadow]";

export type DelegateShadowRequestInit = TypesafeRequestInit;

export type DelegateShadowFetch = (
  url: string,
  init: DelegateShadowRequestInit,
) => Promise<{ status: number; text: () => Promise<string> }>;

export type DelegateShadowSafeFetch = TypesafeFetch;

interface Pedido {
  /** Goal redigido e truncado; nunca guarda o texto cru. */
  goal: string;
  declaredTaskType: string;
  declaredComplexity: string;
  textSha256?: string;
  projectId: string;
}

interface ChoiceLido {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

interface LogSombra {
  model: string;
  declaredTaskType: string;
  declaredComplexity: string;
  choices: { task_type: string; complexity: string; domain: string } | null;
  probabilities: {
    task_type: Record<string, number>;
    complexity: Record<string, number>;
    domain: Record<string, number>;
  } | null;
  confidence: { task_type: number; complexity: number; domain: number } | null;
  destructiveNoul: number | null;
  disagreeTaskType: boolean;
  disagreeComplexity: boolean;
  textSha256?: string;
  hashKind?: "hmac1";
  latencyMs: number;
  ok: boolean;
  error: string | null;
}

/**
 * Complexity é Choice, não Score: o declarado já é enum, e o jev-1.13
 * interpola Score entre níveis — o veredito não bateria com o enum.
 * As quatro perguntas são independentes e saem no mesmo POST.
 */
const PERGUNTAS = {
  task_type: {
    type: "choice",
    instructions:
      "What is the dominant kind of work requested in `goal`? Judge the work itself. `declaredTaskType` is the caller's claim, not the answer, and must not be copied.",
    criteria: {
      coding: "Writing, modifying, or debugging source code is the main work.",
      research: "Gathering facts, documentation, or prior art, without implementing a change.",
      analysis: "Interpreting existing evidence, data, or behavior in order to reach a conclusion.",
      review: "Evaluating a change, diff, or artifact for correctness, quality, or risk.",
      testing: "Adding, running, or designing tests, or checking behavior against an expectation.",
      documentation: "Writing or editing an explanation, document, or comment is the deliverable.",
      general: "No other kind dominates, or the request mixes several kinds without a clear primary.",
    },
  },
  complexity: {
    type: "choice",
    instructions:
      "What is the lowest complexity tier that can reliably carry out `goal`? Do not copy `declaredComplexity`. Prefer the smallest reliable tier. Reserve critical for a cross-system decision, a production effect, or an irreversible effect.",
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
      "Does `goal` ask to deploy, restart production, change or reveal a credential, delete data, force-push, or mutate a cluster?",
    criteria: {
      true: "One of those effects is requested, including as a step of a larger task.",
      false: "None of those effects is requested.",
    },
  },
  domain: {
    type: "choice",
    instructions:
      "Which specialist should implement the work in `goal`? Choose NONE when the request is an explanation or no specialist implements anything.",
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
  },
} as const;

let fetchInjetado: DelegateShadowFetch | null = null;
const emVoo = new Set<Promise<void>>();
/** Projetos cujo spawn veio com ContextFeatures.jev === true. Ausente = desligado. */
const jevPorProjeto = new Map<string, true>();
let emissorSombra: ((msg: TypesafeShadow) => void) | null = null;

let logJev: ((nivel: "info", msg: string) => void) | null = null;

/** T-868: o daemon liga aqui o log() central — a flag não muda em silêncio. */
export function definirLogJev(fn: ((nivel: "info", msg: string) => void) | null): void {
  logJev = fn;
}

/**
 * Chamado no agent:spawn e no `project:features` (T-868) — o toggle do admin
 * vale NA HORA, sem esperar o próximo spawn. Projeto sem mensagem = desligado
 * (nenhum default ligado). Uma linha em info na primeira vez que liga e quando
 * desliga, para o dono seguir a fase 1 sem abrir banco.
 */
export function registrarJevDoProjeto(projectId: string, ligado: boolean): void {
  if (!projectId) return;
  const antes = jevPorProjeto.get(projectId) === true;
  if (ligado === antes) return;
  if (ligado) {
    jevPorProjeto.set(projectId, true);
    logJev?.("info", `[jev] projeto ${projectId}: feature LIGADA — sombra do delegate e das tasks ativa`);
  } else {
    jevPorProjeto.delete(projectId);
    logJev?.("info", `[jev] projeto ${projectId}: feature DESLIGADA — sombra para na hora`);
  }
}

/** Testes: zera o mapa de projetos (o default é sempre desligado). */
export function _resetJevProjetosForTest(): void {
  jevPorProjeto.clear();
}

/** O daemon entrega o veredito no socket. A sombra não espera essa entrega. */
export function definirEmissorSombra(fn: ((msg: TypesafeShadow) => void) | null): void {
  emissorSombra = fn;
}

function jevLigado(projectId: string): boolean {
  return jevPorProjeto.get(projectId) === true;
}

// T-852: a sombra das tasks usa o MESMO interruptor de projeto e o mesmo
// caminho de emissão/rede — só a flag de kill-switch e as perguntas mudam.

/** `jev_enabled` do projeto (alimentado pelo spawn e pelo project:features). */
export function isJevLigado(projectId: string): boolean {
  return jevLigado(projectId);
}

/** Emissão compartilhada do veredito (socket do daemon). */
export function emitirSombra(msg: TypesafeShadow): void {
  emissorSombra?.(msg);
}

export type SombraFetchOpts = TypesafeFetchOpts;
let safeFetchInjetado: DelegateShadowSafeFetch | null = null;

/** Só testes. `null` volta ao safeFetch de produção. O atalho `setDelegateShadowFetch` não passa por aqui. */
export function setDelegateShadowSafeFetch(fn: DelegateShadowSafeFetch | null): void {
  safeFetchInjetado = fn;
}

/** Só testes. `null` faz o post seguir pelo safeFetch (não pelo atalho). */
export function setDelegateShadowFetch(fn: DelegateShadowFetch | null): void {
  fetchInjetado = fn;
}

/** Só testes. Espera as sombras já disparadas, para o log assentar. */
export function settleDelegateShadowForTests(): Promise<void> {
  return Promise.all([...emVoo]).then(() => {});
}

function sombraLigada(): boolean {
  return typesafeLigado("TYPESAFE_DELEGATE_SHADOW");
}

function jaCifrado(valor: string): boolean {
  return valor.startsWith("e2e:");
}

function declarado(v: unknown, permitidos: ReadonlySet<string>): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return t.length <= TETO_DECLARADO && permitidos.has(t) ? t : "";
}

const TIPOS = new Set(["coding", "research", "analysis", "review", "testing", "documentation", "general"]);
const COMPLEXIDADES = new Set(["simple", "moderate", "complex", "critical"]);
const DOMINIOS = new Set(["DAEMON", "SERVER", "WEB", "DEVOPS", "QA_A", "QA_B", "SECURITY", "THREEJS", "PM", "NONE"]);

/**
 * Lê apenas o campo permitido. Redação e teto em bytes são aplicados antes de
 * qualquer retenção; o HMAC cobre somente o texto já higienizado.
 */
function copiarPedido(json: unknown, projectId: string): Pedido | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const rec = json as Record<string, unknown>;
  const cru = rec.goal;
  if (typeof cru !== "string") return null;
  if (!cru.trim() || jaCifrado(cru.trim())) return null;
  const goal = prepararTexto(cru, TETO_BYTES, projectId);
  if (!goal?.trim()) return null;
  return {
    goal,
    declaredTaskType: declarado(rec.taskType, TIPOS),
    declaredComplexity: declarado(rec.complexity, COMPLEXIDADES),
    textSha256: hmacTexto(projectId, goal) ?? undefined,
    projectId,
  };
}

function montarCorpo(snap: Pedido): Record<string, unknown> {
  return {
    model: MODEL,
    state: {
      goal: snap.goal,
      declaredTaskType: snap.declaredTaskType,
      declaredComplexity: snap.declaredComplexity,
    },
    questions: PERGUNTAS,
  };
}

function emitirVeredito(evento: LogSombra, projectId: string): void {
  const fn = emissorSombra;
  if (!fn || !projectId) return;
  const conf = evento.confidence;
  const msg: TypesafeShadow = {
    type: "typesafe:shadow",
    projectId,
    at: Date.now(),
    ok: evento.ok,
    error: evento.error,
    model: evento.model,
    latencyMs: evento.latencyMs,
    declaredTaskType: evento.declaredTaskType,
    declaredComplexity: evento.declaredComplexity,
    taskType: evento.choices?.task_type ?? "",
    complexity: evento.choices?.complexity ?? "",
    domain: evento.choices?.domain ?? "",
    confidence: conf,
    destructiveNoul: evento.destructiveNoul,
    disagreeTaskType: evento.disagreeTaskType,
    disagreeComplexity: evento.disagreeComplexity,
    ...(evento.textSha256 ? { textSha256: evento.textSha256, hashKind: "hmac1" as const } : {}),
  };
  try { fn(msg as TypesafeShadow); } catch { /* a emissão não falha o delegate */ }
}

function logar(evento: LogSombra, projectId: string): void {
  try {
    // Uma linha. Sem goal, context, chave ou corpo cru — só o veredito.
    console.error(`${PREFIXO_LOG} ${JSON.stringify(evento)}`);
  } catch {
    /* o log não pode derrubar o delegate */
  }
  emitirVeredito(evento, projectId);
}

function ehTimeout(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const nome = (e as { name?: unknown }).name;
  if (nome === "TimeoutError" || nome === "AbortError") return true;
  const code = (e as { code?: unknown }).code;
  return code === "ABORT_ERR" || code === "UND_ERR_ABORTED" || code === 20;
}

/** Códigos curtos. A mensagem do throw e o body HTTP ficam de fora. */
function erroCurto(e: unknown): string {
  if (ehTimeout(e)) return "timeout";
  return "fetch";
}

function lerMapa(v: unknown, allowed: ReadonlySet<string>): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (!allowed.has(k)) return null;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) return null;
    out[k] = n;
  }
  return out;
}

function lerChoice(v: unknown, allowed: ReadonlySet<string>): ChoiceLido | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (a.type !== "choice") return null;
  const choice = typeof a.choice === "string" && allowed.has(a.choice) ? a.choice : null;
  const probabilities = lerMapa(a.probabilities, allowed);
  if (!choice || !probabilities) return null;
  if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) return null;
  return { choice, probabilities, confidence: a.confidence };
}

function lerNoul(v: unknown): number | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (a.type !== "noul") return null;
  if (typeof a.noul !== "number" || !Number.isFinite(a.noul)) return null;
  return a.noul;
}

function interpretar(dados: unknown): {
  model: string;
  choices: NonNullable<LogSombra["choices"]>;
  probabilities: NonNullable<LogSombra["probabilities"]>;
  confidence: NonNullable<LogSombra["confidence"]>;
  destructiveNoul: number;
} | null {
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) return null;
  const answers = (dados as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const a = answers as Record<string, unknown>;
  const task = lerChoice(a.task_type, TIPOS);
  const complexity = lerChoice(a.complexity, COMPLEXIDADES);
  const domain = lerChoice(a.domain, DOMINIOS);
  const destructiveNoul = lerNoul(a.destructive);
  if (!task || !complexity || !domain || destructiveNoul == null) return null;
  return {
    model: MODEL,
    choices: { task_type: task.choice, complexity: complexity.choice, domain: domain.choice },
    probabilities: {
      task_type: task.probabilities,
      complexity: complexity.probabilities,
      domain: domain.probabilities,
    },
    confidence: {
      task_type: task.confidence,
      complexity: complexity.confidence,
      domain: domain.confidence,
    },
    destructiveNoul,
  };
}

async function drenar(res: { text: () => Promise<string> }): Promise<void> {
  try { await res.text(); } catch { /* corpo não entra no log */ }
}

async function executar(snap: Pedido): Promise<void> {
  const inicio = Date.now();
  const falha = (error: string): void => {
    logar({
      model: MODEL,
      declaredTaskType: snap.declaredTaskType,
      declaredComplexity: snap.declaredComplexity,
      choices: null,
      probabilities: null,
      confidence: null,
      destructiveNoul: null,
      disagreeTaskType: false,
      disagreeComplexity: false,
      ...(snap.textSha256 ? { textSha256: snap.textSha256, hashKind: "hmac1" as const } : {}),
      latencyMs: Date.now() - inicio,
      ok: false,
      error,
    }, snap.projectId);
  };
  try {
    const fetcher: TypesafeFetch | undefined = fetchInjetado
      ? (url, init) => fetchInjetado!(url, init)
      : safeFetchInjetado ?? undefined;
    const res = await chamarSystemOne(montarCorpo(snap), fetcher);
    if (!res) return;
    if (res.status === 429) {
      await drenar(res);
      falha("http_429");
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      await drenar(res);
      falha(res.status >= 400 && res.status <= 599 ? `http_${res.status}` : "fetch");
      return;
    }
    let bruto: string;
    try {
      bruto = await res.text();
    } catch (e) {
      falha(erroCurto(e));
      return;
    }
    let dados: unknown;
    try {
      dados = JSON.parse(bruto);
    } catch {
      falha("parse");
      return;
    }
    const interp = interpretar(dados);
    if (!interp) {
      falha("parse");
      return;
    }
    logar({
      model: interp.model,
      declaredTaskType: snap.declaredTaskType,
      declaredComplexity: snap.declaredComplexity,
      choices: interp.choices,
      probabilities: interp.probabilities,
      confidence: interp.confidence,
      destructiveNoul: interp.destructiveNoul,
      disagreeTaskType: interp.choices.task_type !== snap.declaredTaskType,
      disagreeComplexity: interp.choices.complexity !== snap.declaredComplexity,
      ...(snap.textSha256 ? { textSha256: snap.textSha256, hashKind: "hmac1" as const } : {}),
      latencyMs: Date.now() - inicio,
      ok: true,
      error: null,
    }, snap.projectId);
  } catch (e) {
    falha(erroCurto(e));
  }
}

/**
 * Copia o pedido e devolve já. A rede corre depois, sem o caller esperar.
 * Não escreve em `json`. Goal vazio ou já cifrado (`e2e:` / `e2e:v2:`) não sai.
 */
export function scheduleDelegateShadow(json: unknown, projectId?: string): void {
  try {
    if (!sombraLigada()) return;
    // Feature do projeto vem só do agent:spawn. Ausente ou false: zero rede.
    if (!projectId || !jevLigado(projectId)) return;
    const snap = copiarPedido(json, projectId);
    if (!snap) return;
    const job = executar(snap).catch(() => {});
    emVoo.add(job);
    void job.finally(() => { emVoo.delete(job); });
  } catch {
    /* a sombra nunca falha o delegate */
  }
}
