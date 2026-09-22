/**
 * Sombra do portão TypeSafe no delegate (T-758).
 *
 * O plaintext do goal só existe no relay, dentro de `encryptOr409`, entre o
 * `JSON.parse` e `encryptBridgePayload`. É daqui que a sombra sai — não do
 * mcp-bridge: o env do bridge não herda o do daemon, e copiar
 * `TYPESAFE_API_KEY` para lá gravaria a chave nos configs dos runners.
 *
 * Liga só com `TYPESAFE_DELEGATE_SHADOW` em "1"/"true" (trim, ignora maiúsculas) E
 * `TYPESAFE_API_KEY` não vazia. Sem flag ou sem chave: no-op, zero rede.
 * Copia goal/context/taskType/complexity na hora e devolve. Não muta o json,
 * não é awaited e não acrescenta campo nenhum ao corpo que sobe. Uma falha
 * aqui não falha o delegate. A rota do Brain não lê este veredito.
 */
import { createHash } from "node:crypto";
import { isE2eEncrypted } from "./daemon-crypto.js";
import type { TypesafeShadow } from "./protocol.js";
import { safeFetch, type SafeFetchOpts } from "./ssrf-guard.js";

/** Endpoint pinado. Sem override por env. */
export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";

/** Versão pinada. O alias móvel não entra no corpo. */
const MODEL = "jev-1.13.0";

const TIMEOUT_MS = 2500;
const TETO_CHARS = 2000;
const TETO_DECLARADO = 64;
const PREFIXO_LOG = "[typesafe-delegate-shadow]";

export interface DelegateShadowRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type DelegateShadowFetch = (
  url: string,
  init: DelegateShadowRequestInit,
) => Promise<{ status: number; text: () => Promise<string> }>;

interface Pedido {
  /** Goal já com trim e teto. O hash usa o cru, que não fica retido. */
  goal: string;
  context: string;
  declaredTaskType: string;
  declaredComplexity: string;
  goalSha256: string;
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
  goalSha256: string;
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
      "What is the dominant kind of work requested in `goal`? Use `context` only as background. Judge the work itself. `declaredTaskType` is the caller's claim, not the answer, and must not be copied.",
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
      "What is the lowest complexity tier that can reliably carry out `goal`? Use `context` only as background. Do not copy `declaredComplexity`. Prefer the smallest reliable tier. Reserve critical for a cross-system decision, a production effect, or an irreversible effect.",
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
      "Does `goal` or `context` ask to deploy, restart production, change or reveal a credential, delete data, force-push, or mutate a cluster?",
    criteria: {
      true: "One of those effects is requested, including as a step of a larger task.",
      false: "None of those effects is requested.",
    },
  },
  domain: {
    type: "choice",
    instructions:
      "Which specialist should implement the work in `goal`? Use `context` only as background. Choose NONE when the request is an explanation or no specialist implements anything.",
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

/** Chamado no agent:spawn. Sem hot-update: o próximo spawn substitui. */
export function registrarJevDoProjeto(projectId: string, ligado: boolean): void {
  if (!projectId) return;
  if (ligado) jevPorProjeto.set(projectId, true);
  else jevPorProjeto.delete(projectId);
}

/** O daemon entrega o veredito no socket. A sombra não espera essa entrega. */
export function definirEmissorSombra(fn: ((msg: TypesafeShadow) => void) | null): void {
  emissorSombra = fn;
}

function jevLigado(projectId: string): boolean {
  return jevPorProjeto.get(projectId) === true;
}

/** Opts da chamada de produção. `maxRedirects: 0` é obrigatório. */
export interface DelegateShadowSafeFetchOpts {
  timeoutMs: number;
  maxRedirects: number;
}

export type DelegateShadowSafeFetch = (
  url: string,
  init: DelegateShadowRequestInit,
  opts: DelegateShadowSafeFetchOpts,
) => Promise<{ status: number; text: () => Promise<string> }>;

async function safeFetchProducao(
  url: string,
  init: DelegateShadowRequestInit,
  opts: DelegateShadowSafeFetchOpts,
): Promise<{ status: number; text: () => Promise<string> }> {
  // timeoutMs existe no safeFetch em runtime; o .d.ts ainda não o declara.
  const res = await safeFetch(url, init, opts as SafeFetchOpts);
  return { status: res.status, text: () => res.text() };
}

let safeFetchEmUso: DelegateShadowSafeFetch = safeFetchProducao;

/** Só testes. `null` volta ao safeFetch de produção. O atalho `setDelegateShadowFetch` não passa por aqui. */
export function setDelegateShadowSafeFetch(fn: DelegateShadowSafeFetch | null): void {
  safeFetchEmUso = fn ?? safeFetchProducao;
}

/** Só testes. `null` faz o post seguir pelo safeFetch (não pelo atalho). */
export function setDelegateShadowFetch(fn: DelegateShadowFetch | null): void {
  fetchInjetado = fn;
}

/** Só testes. Espera as sombras já disparadas, para o log assentar. */
export function settleDelegateShadowForTests(): Promise<void> {
  return Promise.all([...emVoo]).then(() => {});
}

function chaveApi(): string {
  return (process.env.TYPESAFE_API_KEY ?? "").trim();
}

function sombraLigada(): boolean {
  const flag = (process.env.TYPESAFE_DELEGATE_SHADOW ?? "").trim().toLowerCase();
  if (flag !== "1" && flag !== "true") return false;
  return chaveApi() !== "";
}

function jaCifrado(valor: string): boolean {
  return isE2eEncrypted(valor) || valor.startsWith("e2e:v2:");
}

function tokenCurto(v: unknown): string | null {
  if (typeof v !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(v)) return null;
  return v;
}

function declarado(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return t.length <= TETO_DECLARADO ? t : t.slice(0, TETO_DECLARADO);
}

/** Contexto cifrado não sai: o blob não ajuda o modelo e não pode ir pra fora. */
function contextoSeguro(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (!t || jaCifrado(t)) return "";
  return t.length <= TETO_CHARS ? t : t.slice(0, TETO_CHARS);
}

function hashGoal(goalCru: string): string {
  return createHash("sha256").update(goalCru, "utf8").digest("hex").slice(0, 12);
}

/**
 * Lê o pedido sem escrever no objeto. O hash é do goal cru (antes do trim
 * e do teto); o state leva só a versão curta.
 */
function copiarPedido(json: unknown): Pedido | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const rec = json as Record<string, unknown>;
  const cru = rec.goal;
  if (typeof cru !== "string") return null;
  const aparado = cru.trim();
  if (!aparado || jaCifrado(aparado)) return null;
  return {
    goal: aparado.length <= TETO_CHARS ? aparado : aparado.slice(0, TETO_CHARS),
    context: contextoSeguro(rec.context),
    declaredTaskType: declarado(rec.taskType),
    declaredComplexity: declarado(rec.complexity),
    goalSha256: hashGoal(cru),
    projectId: "",
  };
}

function montarCorpo(snap: Pedido): string {
  return JSON.stringify({
    model: MODEL,
    state: {
      goal: snap.goal,
      context: snap.context,
      declaredTaskType: snap.declaredTaskType,
      declaredComplexity: snap.declaredComplexity,
    },
    questions: PERGUNTAS,
  });
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
  };
  try { fn(msg); } catch { /* a emissão não falha o delegate */ }
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

function lerMapa(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) return null;
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    out[k] = n;
  }
  return out;
}

function lerChoice(v: unknown): ChoiceLido | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (a.type !== "choice") return null;
  const choice = tokenCurto(a.choice);
  const probabilities = lerMapa(a.probabilities);
  if (!choice || !probabilities) return null;
  if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence)) return null;
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
  const task = lerChoice(a.task_type);
  const complexity = lerChoice(a.complexity);
  const domain = lerChoice(a.domain);
  const destructiveNoul = lerNoul(a.destructive);
  if (!task || !complexity || !domain || destructiveNoul == null) return null;
  const model = tokenCurto((dados as Record<string, unknown>).model) ?? MODEL;
  return {
    model,
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

async function postar(body: string, signal: AbortSignal): Promise<{ status: number; text: () => Promise<string> }> {
  const init: DelegateShadowRequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${chaveApi()}`,
    },
    body,
    signal,
  };
  if (fetchInjetado) return fetchInjetado(TYPESAFE_SYSTEMONE_URL, init);
  // maxRedirects 0: o safeFetch reenvia Authorization e o body em cada 3xx.
  // Com 0 o loop estoura antes do hop seguinte e lança. O signal do init
  // vale no lugar do timeoutMs quando os dois estão presentes.
  return safeFetchEmUso(TYPESAFE_SYSTEMONE_URL, init, {
    timeoutMs: TIMEOUT_MS,
    maxRedirects: 0,
  });
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
      goalSha256: snap.goalSha256,
      latencyMs: Date.now() - inicio,
      ok: false,
      error,
    }, snap.projectId);
  };
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const res = await postar(montarCorpo(snap), signal);
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
      goalSha256: snap.goalSha256,
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
    const snap = copiarPedido(json);
    if (!snap) return;
    snap.projectId = projectId;
    const job = executar(snap).catch(() => {});
    emVoo.add(job);
    void job.finally(() => { emVoo.delete(job); });
  } catch {
    /* a sombra nunca falha o delegate */
  }
}
