/** Fire-and-forget Jev decision for TTS summaries and reply suggestions. */
import type { TypesafeShadow } from "./protocol.js";
import {
  chamarSystemOne,
  hmacTexto,
  prepararTexto,
  TYPESAFE_MAX_TEXTO_BYTES,
  TYPESAFE_MODEL,
  typesafeLigado,
  type TypesafeFetch,
} from "./typesafe-client.js";
import { emitirSombra, isJevLigado } from "./typesafe-delegate-shadow.js";
import { similaridadeLocal } from "./typesafe-shadow-summarize.js";

export const FLAG = "TYPESAFE_VOICE_SHADOW";
const MODEL = TYPESAFE_MODEL;
const ALMOST_IDENTICAL = 0.9;
const flight = new Set<Promise<void>>();
let fetchInjected: TypesafeFetch | null = null;

type Kind = "tts" | "reply";
type Source = "tts-summary" | "reply-suggest";

/** No implicit kind: legacy summarize requests are deliberately not shadowed. */
export function summarizeKindFromRequest(value: unknown): Kind | undefined {
  return value === "tts" || value === "reply" ? value : undefined;
}

interface Pending {
  projectId: string;
  source: Source;
  refId: string;
  textSha256?: string;
  verdictSent: boolean;
  settled: boolean;
  /** Only TTS has an observed outcome; reply-suggest use is not visible here. */
  acted?: boolean;
}

const QUESTIONS = {
  tts: {
    id: "speak_as_is",
    question: {
      type: "noul",
      instructions: "Can this text be read aloud as-is without losing important meaning or clarity? Judge only the text.",
      criteria: {
        true: "The text is already concise, clear, and natural to hear; a summary is unnecessary.",
        false: "The text is long, dense, technical, or unclear enough that a spoken summary would help.",
      },
    },
  },
  reply: {
    id: "asks_human",
    question: {
      type: "noul",
      instructions: "Does this text require a decision, response, or action from a human? Judge only the text.",
      criteria: {
        true: "It asks a question, requests a decision or work, or needs a human response or action.",
        false: "It is informational, self-contained, or explicitly needs no human response.",
      },
    },
  },
} as const;

function readProbability(response: unknown, questionId: string): number | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const answers = (response as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const answer = (answers as Record<string, unknown>)[questionId];
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const probability = (answer as Record<string, unknown>).noul;
  return typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? probability
    : null;
}

function emitVerdict(p: Pending, ok: boolean, error: string | null, latencyMs: number, probability: number | null): void {
  const frame = {
    type: "typesafe:shadow",
    projectId: p.projectId,
    at: Date.now(),
    ok,
    error,
    model: MODEL,
    latencyMs,
    declaredTaskType: "summarize",
    declaredComplexity: "moderate",
    taskType: "summarize",
    complexity: "moderate",
    domain: p.source,
    confidence: null,
    destructiveNoul: null,
    disagreeTaskType: false,
    disagreeComplexity: false,
    source: p.source,
    event: "verdict",
    refId: p.refId,
    ...(p.textSha256 ? { textSha256: p.textSha256, hashKind: "hmac1" as const } : {}),
    ...(p.source === "tts-summary" ? { speakAsIsNoul: probability } : { asksHumanNoul: probability }),
  };
  try { emitirSombra(frame as unknown as TypesafeShadow); } catch { /* telemetry cannot affect one-shot */ }
}

function emitOutcome(p: Pending): void {
  if (!p.verdictSent || !p.settled || p.acted === undefined) return;
  const frame = {
    type: "typesafe:shadow",
    projectId: p.projectId,
    at: Date.now(),
    ok: true,
    error: null,
    model: MODEL,
    latencyMs: 0,
    declaredTaskType: "summarize",
    declaredComplexity: "moderate",
    taskType: "summarize",
    complexity: "moderate",
    domain: p.source,
    confidence: null,
    destructiveNoul: null,
    disagreeTaskType: false,
    disagreeComplexity: false,
    source: p.source,
    event: "outcome",
    refId: p.refId,
    outcome: { acted: p.acted },
  };
  try { emitirSombra(frame as unknown as TypesafeShadow); } catch { /* telemetry cannot affect one-shot */ }
}

async function evaluate(p: Pending, kind: Kind, text: string): Promise<void> {
  const started = Date.now();
  const query = QUESTIONS[kind];
  try {
    const response = await chamarSystemOne({
      model: MODEL,
      state: { text },
      questions: { [query.id]: query.question },
    }, fetchInjected ?? undefined);
    if (!response) return;
    if (response.status < 200 || response.status >= 300) {
      try { await response.text(); } catch { /* response bodies are never retained or logged */ }
      emitVerdict(p, false, response.status >= 400 && response.status <= 599 ? `http_${response.status}` : "fetch", Date.now() - started, null);
      p.verdictSent = true;
      emitOutcome(p);
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await response.text()); } catch {
      emitVerdict(p, false, "parse", Date.now() - started, null);
      p.verdictSent = true;
      emitOutcome(p);
      return;
    }
    const probability = readProbability(parsed, query.id);
    if (probability === null) {
      emitVerdict(p, false, "parse", Date.now() - started, null);
      p.verdictSent = true;
      emitOutcome(p);
      return;
    }
    emitVerdict(p, true, null, Date.now() - started, probability);
    p.verdictSent = true;
    emitOutcome(p);
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    emitVerdict(p, false, name === "AbortError" || name === "TimeoutError" ? "timeout" : "fetch", Date.now() - started, null);
    p.verdictSent = true;
    emitOutcome(p);
  }
}

/** Starts a real, redacted SystemOne request and returns a local outcome hook. */
export function scheduleSummarizerShadow(input: {
  kind: Kind;
  projectId: string;
  correlationId?: string;
  text: string;
}): ((summary?: string) => void) | null {
  try {
    if (!input.correlationId || !typesafeLigado(FLAG) || !isJevLigado(input.projectId)) return null;
    const safeText = prepararTexto(input.text, TYPESAFE_MAX_TEXTO_BYTES, input.projectId);
    if (!safeText?.trim()) return null;
    // PM decision: correlationId is random/ephemeral and must match the WEB
    // outcome's refId exactly. It is never included in the SystemOne request.
    const refId = input.correlationId;
    const source: Source = input.kind === "tts" ? "tts-summary" : "reply-suggest";
    const textSha256 = hmacTexto(input.projectId, safeText) ?? undefined;
    const pending: Pending = {
      projectId: input.projectId,
      source,
      refId,
      ...(textSha256 ? { textSha256 } : {}),
      verdictSent: false,
      settled: false,
    };
    const job = evaluate(pending, input.kind, safeText).catch(() => {});
    flight.add(job);
    void job.finally(() => flight.delete(job));

    let called = false;
    return (summary?: string) => {
      if (called) return;
      called = true;
      pending.settled = true;
      if (input.kind === "tts") {
        const similarity = typeof summary === "string" ? similaridadeLocal(input.text, summary) : null;
        // A summary materially changed the text when token Jaccard is below 0.9.
        pending.acted = similarity !== null && similarity < ALMOST_IDENTICAL;
      }
      emitOutcome(pending);
    };
  } catch {
    return null;
  }
}

export function setSummarizerShadowFetchForTests(fetcher: TypesafeFetch | null): void { fetchInjected = fetcher; }
export function settleSummarizerShadowForTests(): Promise<void> { return Promise.all([...flight]).then(() => {}); }
export function _resetSummarizerShadowForTest(): void { flight.clear(); fetchInjected = null; }
