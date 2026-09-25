/** Fire-and-forget SystemOne shadow for the post-task reflection decision. */
import {
  chamarSystemOne,
  hmacTexto,
  opaqueRefId,
  prepararTexto,
  TYPESAFE_MAX_TEXTO_BYTES,
  TYPESAFE_MODEL,
  TYPESAFE_REFLECT_TITLE_BYTES,
  typesafeLigado,
  type TypesafeFetch,
} from "./typesafe-client.js";
import { emitirSombra, isJevLigado } from "./typesafe-delegate-shadow.js";

export const FLAG = "TYPESAFE_REFLECT_SHADOW";
export const NOUL = "has_reusable_lesson";

export interface EstadoReflexao {
  projectId: string;
  /** IDs are local correlation inputs only and never enter the SystemOne body. */
  agentId: string;
  taskId?: string;
  deliveryId?: string;
  titulo?: string;
  descricao?: string;
  resumo?: string;
  turnos?: number;
  erros?: number;
  retries?: number;
  reaberta?: boolean;
}

export interface MetricasReflexao {
  disparos: number;
  poupadas: Partial<Record<"p50" | "p70" | "p90", number>>;
  falsosNegativos: number;
  memoriaGerada: number;
  semLicao: number;
}

const MODEL = TYPESAFE_MODEL;
const MAX_SIGNAL = 1_000_000;
const MIN_SIGNAL_CHARS = 20;
const metricas: MetricasReflexao = { disparos: 0, poupadas: {}, falsosNegativos: 0, memoriaGerada: 0, semLicao: 0 };
const emVoo = new Set<Promise<boolean>>();
let fetchInjetado: TypesafeFetch | null = null;

const QUESTION = {
  type: "noul",
  instructions: "Does this completed task contain a reusable lesson about how it was solved in this project? Judge the task text and outcome signals only.",
  criteria: {
    true: "The task contains a concrete approach, pitfall, or decision that would help with a similar future task.",
    false: "The task was routine, fully automated, or provides no useful reusable lesson.",
  },
} as const;

export function metricasReflexao(): MetricasReflexao {
  return { ...metricas, poupadas: { ...metricas.poupadas } };
}

export function _resetMetricasReflexaoForTest(): void {
  metricas.disparos = 0;
  metricas.poupadas = {};
  metricas.falsosNegativos = 0;
  metricas.memoriaGerada = 0;
  metricas.semLicao = 0;
}

export function setReflectShadowFetchForTests(fetcher: TypesafeFetch | null): void {
  fetchInjetado = fetcher;
}

export function settleReflectShadowForTests(): Promise<void> {
  return Promise.all([...emVoo]).then(() => {});
}

function sanitizarCampo(value: unknown, cap: number, projectId: string): string | null | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return prepararTexto(value, cap, projectId);
}

/** Sanitized allowlist only; never includes project, agent, or task identifiers. */
export function estadoEnxuto(e: EstadoReflexao): Record<string, string | number | boolean> | null {
  try {
    const title = sanitizarCampo(e.titulo, TYPESAFE_REFLECT_TITLE_BYTES, e.projectId);
    const description = sanitizarCampo(e.descricao, TYPESAFE_MAX_TEXTO_BYTES, e.projectId);
    const summary = sanitizarCampo(e.resumo, TYPESAFE_MAX_TEXTO_BYTES, e.projectId);
    if (title === null || description === null || summary === null) return null;

    const out: Record<string, string | number | boolean> = {};
    if (title?.trim()) out.title = title;
    if (description?.trim()) out.description = description;
    if (summary?.trim()) out.summary = summary;
    if (typeof e.turnos === "number" && Number.isSafeInteger(e.turnos) && e.turnos >= 0 && e.turnos <= MAX_SIGNAL) out.turns = e.turnos;
    if (typeof e.erros === "number" && Number.isSafeInteger(e.erros) && e.erros >= 0 && e.erros <= MAX_SIGNAL) out.errors = e.erros;
    if (typeof e.retries === "number" && Number.isSafeInteger(e.retries) && e.retries >= 0 && e.retries <= MAX_SIGNAL) out.retries = e.retries;
    if (typeof e.reaberta === "boolean") out.reopened = e.reaberta;

    const textSize = [out.title, out.description, out.summary]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .trim();
    if ([...textSize].length < MIN_SIGNAL_CHARS) return null;
    return out;
  } catch {
    return null;
  }
}

function lerNoul(response: unknown): number | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const answers = (response as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const answer = (answers as Record<string, unknown>)[NOUL];
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const noul = (answer as Record<string, unknown>).noul;
  return typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : null;
}

interface PedidoReflexao {
  projectId: string;
  taskId?: string;
  refId?: string;
  textSha256?: string;
  state: Record<string, string | number | boolean>;
}

function emitirVeredito(p: PedidoReflexao, ok: boolean, error: string | null, latencyMs: number, probability: number | null): void {
  const frame = {
    type: "typesafe:shadow",
    projectId: p.projectId,
    at: Date.now(),
    ok,
    error,
    model: MODEL,
    latencyMs,
    declaredTaskType: "reflect",
    declaredComplexity: "moderate",
    taskType: "reflect",
    complexity: "moderate",
    domain: "reflect",
    confidence: null,
    destructiveNoul: null,
    disagreeTaskType: false,
    disagreeComplexity: false,
    source: "reflect",
    event: "verdict",
    ...(p.taskId ? { taskId: p.taskId } : {}),
    ...(p.refId ? { refId: p.refId } : {}),
    ...(p.textSha256 ? { textSha256: p.textSha256, hashKind: "hmac1" as const } : {}),
    noul: NOUL,
    hasReusableLessonNoul: probability,
  };
  try { emitirSombra(frame as never); } catch { /* shadow must not affect reflection */ }
}

function emitirDesfecho(p: PedidoReflexao, generatedLesson: boolean): void {
  if (!p.refId) return;
  const frame = {
    type: "typesafe:shadow",
    projectId: p.projectId,
    at: Date.now(),
    ok: true,
    error: null,
    model: MODEL,
    latencyMs: 0,
    declaredTaskType: "reflect",
    declaredComplexity: "moderate",
    taskType: "reflect",
    complexity: "moderate",
    domain: "reflect",
    confidence: null,
    destructiveNoul: null,
    disagreeTaskType: false,
    disagreeComplexity: false,
    source: "reflect",
    event: "outcome",
    ...(p.taskId ? { taskId: p.taskId } : {}),
    refId: p.refId,
    outcome: { produced: generatedLesson },
  };
  try { emitirSombra(frame as never); } catch { /* shadow must not affect reflection */ }
}

async function executar(p: PedidoReflexao): Promise<boolean> {
  const started = Date.now();
  try {
    const payload = {
      model: MODEL,
      state: p.state,
      questions: { [NOUL]: QUESTION },
    };
    const response = await chamarSystemOne(payload, fetchInjetado ?? undefined);
    if (!response) return false;
    if (response.status < 200 || response.status >= 300) {
      try { await response.text(); } catch { /* never log response bodies */ }
      const error = response.status >= 400 && response.status <= 599 ? `http_${response.status}` : "fetch";
      emitirVeredito(p, false, error, Date.now() - started, null);
      return true;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await response.text()); } catch {
      emitirVeredito(p, false, "parse", Date.now() - started, null);
      return true;
    }
    const probability = lerNoul(parsed);
    if (probability === null) {
      emitirVeredito(p, false, "parse", Date.now() - started, null);
      return true;
    }
    recalcularPoupadas([probability]);
    emitirVeredito(p, true, null, Date.now() - started, probability);
    return true;
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    emitirVeredito(p, false, name === "AbortError" || name === "TimeoutError" ? "timeout" : "fetch", Date.now() - started, null);
    return true;
  }
}

/** Starts the real SystemOne call and returns a local-only outcome registrar. */
export function sombraDaReflexao(e: EstadoReflexao): (resumoReflexao?: string) => void {
  try {
    if (!typesafeLigado(FLAG) || !isJevLigado(e.projectId)) return () => {};
    const state = estadoEnxuto(e);
    if (!state) return () => {};

    const refId = e.deliveryId ? opaqueRefId(e.projectId, e.deliveryId) ?? undefined : undefined;
    const text = [state.title, state.description, state.summary].filter((x): x is string => typeof x === "string").join(" ");
    const textSha256 = hmacTexto(e.projectId, text) ?? undefined;
    const pedido: PedidoReflexao = {
      projectId: e.projectId,
      ...(e.taskId ? { taskId: e.taskId } : {}),
      ...(refId ? { refId } : {}),
      ...(textSha256 ? { textSha256 } : {}),
      state,
    };
    metricas.disparos++;
    const job = executar(pedido).catch(() => false);
    emVoo.add(job);
    void job.finally(() => { emVoo.delete(job); });

    let outcomeRecorded = false;
    return (resumoReflexao?: string) => {
      if (outcomeRecorded) return;
      outcomeRecorded = true;
      const generatedLesson = typeof resumoReflexao === "string" && resumoReflexao.trim().length > 0;
      if (generatedLesson) metricas.memoriaGerada++; else metricas.semLicao++;
      if (refId) void job.then((verdictSent) => { if (verdictSent) emitirDesfecho(pedido, generatedLesson); });
    };
  } catch {
    return () => {};
  }
}

/** Counts the calls that would be saved at three candidate thresholds. */
export function recalcularPoupadas(probabilidades: number[]): void {
  const limits: Array<"p50" | "p70" | "p90"> = ["p50", "p70", "p90"];
  limits.forEach((label, i) => {
    const threshold = [0.5, 0.7, 0.9][i]!;
    metricas.poupadas[label] = probabilidades.filter((probability) => probability < threshold).length;
  });
}
