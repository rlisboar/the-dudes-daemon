/** Fire-and-forget SystemOne shadow for agent-to-agent messages. */
import type { TypesafeShadow } from "./protocol.js";
import {
  chamarSystemOne,
  hmacTexto,
  opaqueRefId,
  prepararTexto,
  TYPESAFE_MAX_TEXTO_BYTES,
  TYPESAFE_MODEL,
  typesafeLigado,
  type TypesafeFetch,
} from "./typesafe-client.js";
import { emitirSombra, isJevLigado } from "./typesafe-delegate-shadow.js";

export const FLAG = "TYPESAFE_AGENTMSG_SHADOW";
export const NOUL = "requires_response";

interface Pending {
  projectId: string;
  agentId: string;
  deliveryId: string;
  refId: string;
  textSha256?: string;
  startedAt: number;
  verdict: boolean;
  acted: boolean;
  tokens: number;
  durationMs?: number;
  settled: boolean;
}

const MODEL = TYPESAFE_MODEL;
const MAX_PENDING = 256;
const EXPIRES_MS = 30 * 60_000;
const pending = new Map<string, Pending>();
const inFlight = new Set<Promise<void>>();
let fetchInjetado: TypesafeFetch | null = null;

const QUESTION = {
  type: "noul",
  instructions: "Does this agent-to-agent message require a response, decision, or action? Judge only the message text, not its sender or recipient.",
  criteria: {
    true: "The message asks a question, requests work, gives information that needs acknowledgment, or requires a decision or action.",
    false: "The message is only an acknowledgment, thanks, or a notice that explicitly needs no reply or action.",
  },
} as const;

function key(agentId: string, deliveryId: string): string {
  return `${agentId}\0${deliveryId}`;
}

function readNoul(response: unknown): number | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const answers = (response as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const answer = (answers as Record<string, unknown>)[NOUL];
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const value = (answer as Record<string, unknown>).noul;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
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
    declaredTaskType: "communication",
    declaredComplexity: "simple",
    taskType: "communication",
    complexity: "simple",
    domain: "agent-msg",
    confidence: null,
    destructiveNoul: null,
    disagreeTaskType: false,
    disagreeComplexity: false,
    source: "agent-msg",
    event: "verdict",
    refId: p.refId,
    ...(p.textSha256 ? { textSha256: p.textSha256, hashKind: "hmac1" as const } : {}),
    requiresResponseNoul: probability,
  };
  try { emitirSombra(frame as unknown as TypesafeShadow); } catch { /* shadow must not affect delivery */ }
}

function emitOutcome(p: Pending): void {
  if (!p.verdict || !p.settled) return;
  const frame = {
    type: "typesafe:shadow",
    projectId: p.projectId,
    at: Date.now(),
    ok: true,
    error: null,
    model: MODEL,
    latencyMs: 0,
    declaredTaskType: "communication",
    declaredComplexity: "simple",
    taskType: "communication",
    complexity: "simple",
    domain: "agent-msg",
    confidence: null,
    destructiveNoul: null,
    disagreeTaskType: false,
    disagreeComplexity: false,
    source: "agent-msg",
    event: "outcome",
    refId: p.refId,
    outcome: {
      acted: p.acted,
      ...(p.tokens > 0 ? { tokens: p.tokens } : {}),
      ...(p.durationMs === undefined ? {} : { durationMs: p.durationMs }),
    },
  };
  try { emitirSombra(frame as unknown as TypesafeShadow); } catch { /* shadow must not affect delivery */ }
  pending.delete(key(p.agentId, p.deliveryId));
}

async function evaluate(p: Pending, text: string): Promise<void> {
  const started = Date.now();
  const payload = { model: MODEL, state: { message: text }, questions: { [NOUL]: QUESTION } };
  try {
    const response = await chamarSystemOne(payload, fetchInjetado ?? undefined);
    if (!response) return;
    if (response.status < 200 || response.status >= 300) {
      try { await response.text(); } catch { /* response bodies are never retained or logged */ }
      emitVerdict(p, false, response.status >= 400 && response.status <= 599 ? `http_${response.status}` : "fetch", Date.now() - started, null);
      p.verdict = true;
      emitOutcome(p);
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await response.text()); } catch {
      emitVerdict(p, false, "parse", Date.now() - started, null);
      p.verdict = true;
      emitOutcome(p);
      return;
    }
    const probability = readNoul(parsed);
    if (probability === null) {
      emitVerdict(p, false, "parse", Date.now() - started, null);
      p.verdict = true;
      emitOutcome(p);
      return;
    }
    emitVerdict(p, true, null, Date.now() - started, probability);
    p.verdict = true;
    emitOutcome(p);
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    emitVerdict(p, false, name === "AbortError" || name === "TimeoutError" ? "timeout" : "fetch", Date.now() - started, null);
    p.verdict = true;
    emitOutcome(p);
  }
}

/** Starts classification without awaiting it. Text is scrubbed before retention or networking. */
export function scheduleAgentMessageShadow(input: {
  projectId: string;
  agentId: string;
  deliveryId?: string;
  text: string;
}): boolean {
  try {
    if (!input.deliveryId || !typesafeLigado(FLAG) || !isJevLigado(input.projectId)) return false;
    const safeText = prepararTexto(input.text, TYPESAFE_MAX_TEXTO_BYTES, input.projectId);
    if (!safeText?.trim()) return false;
    const refId = opaqueRefId(input.projectId, input.deliveryId);
    if (!refId) return false;
    const textSha256 = hmacTexto(input.projectId, safeText) ?? undefined;
    const id = key(input.agentId, input.deliveryId);
    for (const [storedKey, value] of pending) if (Date.now() - value.startedAt > EXPIRES_MS) pending.delete(storedKey);
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
    const item: Pending = {
      projectId: input.projectId,
      agentId: input.agentId,
      deliveryId: input.deliveryId,
      refId,
      ...(textSha256 ? { textSha256 } : {}),
      startedAt: Date.now(),
      verdict: false,
      acted: false,
      tokens: 0,
      settled: false,
    };
    pending.set(id, item);
    const job = evaluate(item, safeText).catch(() => {});
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
    return true;
  } catch {
    return false;
  }
}

/** Records successful task/message tools observed by the bridge, never tool input. */
export function markAgentMessageActed(agentId: string, deliveryId?: string): void {
  if (!deliveryId) return;
  const item = pending.get(key(agentId, deliveryId));
  if (item) item.acted = true;
}

/** Adds per-turn usage deltas, associated with the runner's current delivery. */
export function addAgentMessageTokens(agentId: string, deliveryId: string | undefined, delta: { input?: number; output?: number }): void {
  if (!deliveryId) return;
  const item = pending.get(key(agentId, deliveryId));
  if (!item) return;
  const amount = (Number.isFinite(delta.input) ? delta.input! : 0) + (Number.isFinite(delta.output) ? delta.output! : 0);
  if (amount > 0) item.tokens = Math.min(Number.MAX_SAFE_INTEGER, item.tokens + amount);
}

/** Pairs an observed turn end with its verdict using the same opaque refId. */
export function settleAgentMessageShadow(agentId: string, deliveryId: string | undefined, durationMs: number): void {
  if (!deliveryId) return;
  const item = pending.get(key(agentId, deliveryId));
  if (!item) return;
  item.durationMs = Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : undefined;
  item.settled = true;
  emitOutcome(item);
}

export function setAgentMessageShadowFetchForTests(fetcher: TypesafeFetch | null): void { fetchInjetado = fetcher; }
export function settleAgentMessageShadowForTests(): Promise<void> { return Promise.all([...inFlight]).then(() => {}); }
export function _resetAgentMessageShadowForTest(): void { pending.clear(); inFlight.clear(); fetchInjetado = null; }
