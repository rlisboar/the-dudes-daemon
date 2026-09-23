/**
 * T-812: store de observabilidade do dashboard de debug local.
 *
 * Motivação: o dono via "runner com desempenho muito ruim" sem ter onde olhar
 * além do log de texto. O health-monitor (daemon:health) só leva contadores
 * agregados ao server e conta turnos apenas de grok/one-shot. Este módulo
 * guarda, EM MEMÓRIA e com teto fixo, tudo o que o dashboard precisa para
 * responder "onde está o tempo":
 *
 *  - logs (ring grande, já passados pelo scrub do main.log);
 *  - turnos de TODOS os runners (o registro estruturado do [turn-latency]);
 *  - processos filhos (todo spawnDropped: comando, duração, exit);
 *  - chamadas síncronas que bloqueiam o event loop (spawnSync/execFileSync/fs);
 *  - travamentos do event loop, GC, WS com o orchestrator, relay do bridge;
 *  - eventos de agente (estado, hang, exit, erro) e contadores de I/O dos CLIs.
 *
 * Regras: nenhum hook pode lançar nem mudar comportamento (tudo O(1) e em
 * try/catch no chamador quando houver risco); nada de conteúdo de mensagem —
 * só metadados, salvo a captura de I/O dos CLIs, que é opt-in, fica só em
 * memória e só sai pelo servidor loopback autenticado.
 */

import { performance } from "node:perf_hooks";

/* ───────────────────────────── ring buffer ───────────────────────────── */

export class Ring<T> {
  private buf: Array<T | undefined>;
  private head = 0;
  private n = 0;
  /** Quantos itens já entraram na vida do processo (inclui os descartados). */
  total = 0;

  constructor(readonly cap: number) {
    this.buf = new Array(Math.max(1, cap));
  }

  push(v: T): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
    this.total++;
  }

  get size(): number { return this.n; }

  /** Mais antigos primeiro. */
  toArray(): T[] {
    const out: T[] = [];
    const start = (this.head - this.n + this.buf.length) % this.buf.length;
    for (let i = 0; i < this.n; i++) out.push(this.buf[(start + i) % this.buf.length] as T);
    return out;
  }

  /** Últimos `k`, mais antigos primeiro. */
  last(k: number): T[] {
    const all = this.toArray();
    return k >= all.length ? all : all.slice(all.length - k);
  }

  clear(): void {
    this.buf = new Array(this.buf.length);
    this.head = 0;
    this.n = 0;
  }
}

/* ───────────────────────────── estatística ───────────────────────────── */

export interface Dist {
  n: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

export function dist(values: Array<number | null | undefined>): Dist {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, min: null, p50: null, p90: null, p95: null, p99: null, max: null, mean: null };
  const pick = (p: number) => {
    const i = Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1));
    return round(v[i]!);
  };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    min: round(v[0]!),
    p50: pick(0.5),
    p90: pick(0.9),
    p95: pick(0.95),
    p99: pick(0.99),
    max: round(v[v.length - 1]!),
    mean: round(sum / v.length),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ───────────────────────────── logs ───────────────────────────── */

export type DebugLevel = "info" | "warn" | "error";

export interface DebugLogLine {
  seq: number;
  ts: number;
  level: DebugLevel;
  /** Texto JÁ passado pelo scrub do main.log. */
  msg: string;
  /** Origem: log central do daemon, cliLog (verbose) ou console.* de terceiros. */
  src: "daemon" | "cli" | "console";
}

const LOG_CAP = 5000;
const ISSUE_CAP = 1500;
const LOG_MSG_MAX = 4000;

let logSeq = 0;
const logs = new Ring<DebugLogLine>(LOG_CAP);
/** Só warn/error — sobrevive mais tempo que o ring geral num daemon verboso. */
const issues = new Ring<DebugLogLine>(ISSUE_CAP);
const logCounts: Record<DebugLevel, number> = { info: 0, warn: 0, error: 0 };
type LogListener = (line: DebugLogLine) => void;
const logListeners = new Set<LogListener>();

export function recordDebugLog(level: DebugLevel, msg: string, src: DebugLogLine["src"] = "daemon"): void {
  const text = msg.length > LOG_MSG_MAX ? `${msg.slice(0, LOG_MSG_MAX)}… [+${msg.length - LOG_MSG_MAX} chars]` : msg;
  const line: DebugLogLine = { seq: ++logSeq, ts: Date.now(), level, msg: text, src };
  logs.push(line);
  logCounts[level]++;
  if (level !== "info") issues.push(line);
  for (const fn of logListeners) {
    try { fn(line); } catch { /* listener (SSE) nunca derruba o log */ }
  }
}

export function onDebugLog(fn: LogListener): () => void {
  logListeners.add(fn);
  return () => { logListeners.delete(fn); };
}

export interface LogQuery {
  sinceSeq?: number;
  level?: DebugLevel | "issues";
  q?: string;
  src?: DebugLogLine["src"];
  limit?: number;
}

export function queryLogs(query: LogQuery = {}): { lines: DebugLogLine[]; lastSeq: number; counts: Record<DebugLevel, number>; total: number } {
  const limit = Math.max(1, Math.min(LOG_CAP, Math.floor(query.limit ?? 500)));
  const source = query.level === "issues" || query.level === "warn" || query.level === "error" ? issues : logs;
  const needle = query.q?.trim().toLowerCase() || "";
  const out: DebugLogLine[] = [];
  const all = source.toArray();
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const l = all[i]!;
    if (query.sinceSeq != null && l.seq <= query.sinceSeq) break;
    if (query.level === "warn" && l.level !== "warn") continue;
    if (query.level === "error" && l.level !== "error") continue;
    if (query.level === "info" && l.level !== "info") continue;
    if (query.src && l.src !== query.src) continue;
    if (needle && !l.msg.toLowerCase().includes(needle)) continue;
    out.push(l);
  }
  out.reverse();
  return { lines: out, lastSeq: logSeq, counts: { ...logCounts }, total: logs.total };
}

/** Logs com ts dentro da janela (para anexar contexto a um travamento). */
function logsBetween(fromTs: number, toTs: number, max: number): string[] {
  const out: string[] = [];
  const all = logs.last(200);
  for (const l of all) {
    if (l.ts >= fromTs && l.ts <= toTs) out.push(`[${l.level}] ${l.msg.slice(0, 240)}`);
  }
  return out.slice(-max);
}

/* ───────────────────────────── turnos ───────────────────────────── */

export interface TurnRecord {
  /** Fim do turno (wall clock). */
  ts: number;
  agentId: string;
  runner: string;
  turnId: string;
  attempt: number;
  queueMs: number | null;
  gateWaitMs: number | null;
  firstEventMs: number | null;
  durationMs: number | null;
  acceptMs: number | null;
  bootMs: number | null;
  firstEventKind: string | null;
  endReason: string;
  killedBy: string | null;
  recoverKind: string | null;
  lifetimeLimit: string | null;
  sessionMode: string | null;
}

const TURN_CAP = 3000;
const turns = new Ring<TurnRecord>(TURN_CAP);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Recebe o MESMO objeto que o [turn-latency] loga (allowlist do TurnTiming). */
export function recordTurnEnd(agentId: string, runner: string, fields: Record<string, unknown>): void {
  turns.push({
    ts: Date.now(),
    agentId,
    runner,
    turnId: String(fields.turnId ?? ""),
    attempt: num(fields.attempt) ?? 0,
    queueMs: num(fields.queueMs),
    gateWaitMs: num(fields.gateWaitMs),
    firstEventMs: num(fields.firstEventMs),
    durationMs: num(fields.durationMs),
    acceptMs: num(fields.acceptMs),
    bootMs: num(fields.bootMs),
    firstEventKind: str(fields.firstEventKind),
    endReason: str(fields.endReason) ?? "?",
    killedBy: str(fields.killedBy),
    recoverKind: str(fields.recoverKind),
    lifetimeLimit: str(fields.lifetimeLimit),
    sessionMode: str(fields.sessionMode),
  });
}

export function recentTurns(filter: { agentId?: string; runner?: string; limit?: number } = {}): TurnRecord[] {
  const limit = Math.max(1, Math.min(TURN_CAP, filter.limit ?? 300));
  const out: TurnRecord[] = [];
  const all = turns.toArray();
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const t = all[i]!;
    if (filter.agentId && t.agentId !== filter.agentId) continue;
    if (filter.runner && t.runner !== filter.runner) continue;
    out.push(t);
  }
  return out.reverse();
}

export interface TurnAggregate {
  key: string;
  count: number;
  /** Turnos que produziram resposta completa. */
  completed: number;
  /** Tudo que não é completed (error, hard-recover, process-exit, stopped, …). */
  problems: number;
  /** Só defeitos: error/hard-recover/process-exit/spawn-error/retry. */
  failures: number;
  endReasons: Record<string, number>;
  duration: Dist;
  firstEvent: Dist;
  gateWait: Dist;
  queue: Dist;
  boot: Dist;
  lastTs: number;
}

/** Agrega os turnos que caem na janela (default: tudo que está no ring). */
export function aggregateTurns(by: "runner" | "agentId", sinceTs = 0): TurnAggregate[] {
  const groups = new Map<string, TurnRecord[]>();
  for (const t of turns.toArray()) {
    if (t.ts < sinceTs) continue;
    // Descartes de fila não são turnos executados — não poluem as latências.
    if (t.endReason === "queue-cleared" || t.endReason === "drained") continue;
    const k = t[by];
    const list = groups.get(k) ?? [];
    list.push(t);
    groups.set(k, list);
  }
  const out: TurnAggregate[] = [];
  for (const [key, list] of groups) {
    const endReasons: Record<string, number> = {};
    for (const t of list) endReasons[t.endReason] = (endReasons[t.endReason] ?? 0) + 1;
    const completed = endReasons.completed ?? 0;
    out.push({
      key,
      count: list.length,
      completed,
      problems: list.length - completed,
      failures: list.filter((t) => ["error", "hard-recover", "process-exit", "spawn-error", "retry"].includes(t.endReason)).length,
      endReasons,
      duration: dist(list.map((t) => t.durationMs)),
      firstEvent: dist(list.map((t) => t.firstEventMs)),
      gateWait: dist(list.map((t) => t.gateWaitMs)),
      queue: dist(list.map((t) => t.queueMs)),
      boot: dist(list.map((t) => t.bootMs)),
      lastTs: Math.max(...list.map((t) => t.ts)),
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/* Turnos em voo: o TurnLatency registra cada TurnTiming criado; o fim
 * (emit "end") remove. Teto + poda por idade: mensagem que nunca é ativada
 * nem descartada não pode segurar memória para sempre. */

export interface LiveTurnSource {
  agentId: string;
  runner: string;
  createdAt: number;
  state: () => Record<string, unknown>;
}

const LIVE_TURN_CAP = 1000;
const LIVE_TURN_MAX_AGE_MS = 6 * 60 * 60_000;
const liveTurns = new Map<object, LiveTurnSource>();

export function trackLiveTurn(timing: object, src: LiveTurnSource): void {
  if (liveTurns.size >= LIVE_TURN_CAP) {
    const now = Date.now();
    for (const [k, v] of liveTurns) {
      if (now - v.createdAt > LIVE_TURN_MAX_AGE_MS || liveTurns.size >= LIVE_TURN_CAP) liveTurns.delete(k);
      if (liveTurns.size < LIVE_TURN_CAP) break;
    }
  }
  liveTurns.set(timing, src);
}

export function untrackLiveTurn(timing: object): void {
  liveTurns.delete(timing);
}

export function liveTurnsSnapshot(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const now = Date.now();
  for (const [k, v] of liveTurns) {
    if (now - v.createdAt > LIVE_TURN_MAX_AGE_MS) { liveTurns.delete(k); continue; }
    let st: Record<string, unknown> = {};
    try { st = v.state(); } catch { /* estado ilegível não derruba o snapshot */ }
    out.push({ agentId: v.agentId, runner: v.runner, createdAt: v.createdAt, ...st });
  }
  return out;
}

/* ───────────────────────────── processos filhos ───────────────────────────── */

export interface SpawnRecord {
  id: number;
  pid: number | null;
  /** Basename do executável real (setpriv desembrulhado). */
  cmd: string;
  /** argv resumido e truncado (prompts longos não entram inteiros). */
  args: string;
  agentId: string | null;
  cwd: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

const SPAWN_CAP = 1500;
const spawns = new Ring<SpawnRecord>(SPAWN_CAP);
const liveSpawns = new Map<number, SpawnRecord>();
let spawnSeq = 0;

interface SpawnAgg { spawns: number; live: number; errors: number; nonZeroExit: number; signaled: number; totalMs: number; maxMs: number; durations: Ring<number> }
const spawnAgg = new Map<string, SpawnAgg>();

function aggFor(cmd: string): SpawnAgg {
  let a = spawnAgg.get(cmd);
  if (!a) {
    a = { spawns: 0, live: 0, errors: 0, nonZeroExit: 0, signaled: 0, totalMs: 0, maxMs: 0, durations: new Ring<number>(200) };
    spawnAgg.set(cmd, a);
  }
  return a;
}

const ARG_MAX = 160;
const ARGS_TOTAL_MAX = 600;

export function summarizeArgs(args: readonly string[]): string {
  const parts: string[] = [];
  let total = 0;
  for (const raw of args) {
    let a = String(raw).replace(/\s+/g, " ");
    if (a.length > ARG_MAX) a = `${a.slice(0, ARG_MAX)}…(${a.length}c)`;
    if (total + a.length > ARGS_TOTAL_MAX) { parts.push(`…(+${args.length - parts.length} args)`); break; }
    parts.push(a);
    total += a.length + 1;
  }
  return parts.join(" ");
}

const basename = (p: string) => {
  const s = String(p || "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
};

/** Desembrulha `setpriv … -- cmd args` e `python -c pty.spawn cmd` para o comando real. */
export function unwrapCommand(file: string, argv: readonly string[]): { cmd: string; args: string[] } {
  let args = argv.slice(1);
  let cmd = file;
  if (basename(cmd) === "setpriv") {
    const sep = args.indexOf("--");
    if (sep >= 0 && sep + 1 < args.length) { cmd = args[sep + 1]!; args = args.slice(sep + 2); }
  }
  return { cmd: basename(cmd), args };
}

interface SpawnLike {
  pid?: number;
  spawnfile?: string;
  spawnargs?: string[];
  once(event: string, fn: (...a: any[]) => void): unknown;
}

/** Chamado por privileges.trackSpawnedAgent para TODO spawnDropped. */
export function recordSpawn(child: SpawnLike, opts: { cwd?: unknown; env?: NodeJS.ProcessEnv }): void {
  const { cmd, args } = unwrapCommand(child.spawnfile ?? "?", child.spawnargs ?? []);
  const env = opts.env ?? {};
  const rec: SpawnRecord = {
    id: ++spawnSeq,
    pid: typeof child.pid === "number" ? child.pid : null,
    cmd,
    args: summarizeArgs(args),
    agentId: typeof env.THE_DUDES_AGENT_ID === "string" && env.THE_DUDES_AGENT_ID ? env.THE_DUDES_AGENT_ID : null,
    cwd: typeof opts.cwd === "string" ? opts.cwd : null,
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    exitCode: null,
    signal: null,
    error: null,
  };
  spawns.push(rec);
  const a = aggFor(cmd);
  a.spawns++;
  if (rec.pid != null) { liveSpawns.set(rec.id, rec); a.live++; }
  let done = false;
  const finish = (code: number | null, signal: string | null, err?: Error) => {
    if (done) return;
    done = true;
    rec.endedAt = Date.now();
    rec.durationMs = rec.endedAt - rec.startedAt;
    rec.exitCode = code;
    rec.signal = signal;
    if (err) rec.error = String(err.message ?? err).slice(0, 300);
    if (liveSpawns.delete(rec.id)) a.live = Math.max(0, a.live - 1);
    if (err) a.errors++;
    else if (signal) a.signaled++;
    else if (code !== 0) a.nonZeroExit++;
    a.totalMs += rec.durationMs;
    if (rec.durationMs > a.maxMs) a.maxMs = rec.durationMs;
    a.durations.push(rec.durationMs);
  };
  // Só observa: NÃO escuta "error" — um listener ali engoliria o erro de
  // spawn (ENOENT) que hoje sobe para quem chamou. Spawn que falha não emite
  // "exit", mas emite "close" com o errno negativo como código.
  child.once("exit", (code: number | null, signal: string | null) => finish(code, signal));
  child.once("close", (code: number | null, signal: string | null) => {
    if (typeof code === "number" && code < 0) finish(null, null, new Error(`spawn falhou (errno ${code})`));
    else finish(code, signal);
  });
}

export function spawnsSnapshot(limit = 300): {
  live: SpawnRecord[];
  recent: SpawnRecord[];
  total: number;
  byCommand: Array<{ cmd: string; spawns: number; live: number; errors: number; nonZeroExit: number; signaled: number; avgMs: number | null; maxMs: number; duration: Dist }>;
} {
  const byCommand = [...spawnAgg.entries()].map(([cmd, a]) => {
    const ended = a.spawns - a.live;
    return {
      cmd,
      spawns: a.spawns,
      live: a.live,
      errors: a.errors,
      nonZeroExit: a.nonZeroExit,
      signaled: a.signaled,
      avgMs: ended > 0 ? Math.round(a.totalMs / ended) : null,
      maxMs: a.maxMs,
      duration: dist(a.durations.toArray()),
    };
  }).sort((x, y) => y.spawns - x.spawns);
  return { live: [...liveSpawns.values()], recent: spawns.last(limit), total: spawns.total, byCommand };
}

/** pid → agentId dos filhos vivos (atribuição da árvore de processos). */
export function liveSpawnAgents(): Map<number, { agentId: string | null; cmd: string }> {
  const m = new Map<number, { agentId: string | null; cmd: string }>();
  for (const r of liveSpawns.values()) if (r.pid != null) m.set(r.pid, { agentId: r.agentId, cmd: r.cmd });
  return m;
}

/* ───────────────────────── chamadas síncronas (bloqueiam o loop) ───────────────────────── */

export interface SyncOpRecord {
  ts: number;
  /** performance.now() do FIM — casa com a janela de um travamento. */
  endPerf: number;
  fn: string;
  target: string;
  ms: number;
  status: number | null;
  timedOut: boolean;
  stack: string;
}

const SYNC_CAP = 800;
const syncOps = new Ring<SyncOpRecord>(SYNC_CAP);
interface SyncAgg { count: number; totalMs: number; maxMs: number; slow: number }
const syncAgg = new Map<string, SyncAgg>();

/** Toda chamada entra no agregado; só as lentas (ou de processo) entram no ring. */
export function recordSyncOp(rec: SyncOpRecord, keep: boolean): void {
  let a = syncAgg.get(rec.fn);
  if (!a) { a = { count: 0, totalMs: 0, maxMs: 0, slow: 0 }; syncAgg.set(rec.fn, a); }
  a.count++;
  a.totalMs += rec.ms;
  if (rec.ms > a.maxMs) a.maxMs = rec.ms;
  if (keep) { a.slow++; syncOps.push(rec); }
}

export function syncOpsSnapshot(limit = 300): { recent: SyncOpRecord[]; byFn: Array<{ fn: string } & SyncAgg & { avgMs: number }>; total: number } {
  const byFn = [...syncAgg.entries()]
    .map(([fn, a]) => ({ fn, ...a, totalMs: Math.round(a.totalMs), maxMs: Math.round(a.maxMs * 10) / 10, avgMs: a.count ? Math.round((a.totalMs / a.count) * 100) / 100 : 0 }))
    .sort((x, y) => y.totalMs - x.totalMs);
  return { recent: syncOps.last(limit), byFn, total: syncOps.total };
}

function syncOpsBetween(fromPerf: number, toPerf: number): string[] {
  const out: string[] = [];
  for (const r of syncOps.last(100)) {
    // Termina dentro da janela (ou atravessa o início dela).
    if (r.endPerf >= fromPerf - 5 && r.endPerf - r.ms <= toPerf + 5) {
      out.push(`${r.fn} ${r.target} ${Math.round(r.ms)}ms`);
    }
  }
  return out.slice(-8);
}

/* ───────────────────────────── event loop ───────────────────────────── */

export interface StallRecord {
  ts: number;
  /** Tempo aproximado em que o loop ficou sem rodar timers. */
  blockedMs: number;
  syncOps: string[];
  logs: string[];
  /** Mensagem do orchestrator em processamento quando o travamento terminou. */
  inbound: string | null;
}

const stalls = new Ring<StallRecord>(400);
let currentInbound: string | null = null;

export function setCurrentInbound(type: string | null): void {
  currentInbound = type;
}

export function recordStall(blockedMs: number, fromPerf: number, toPerf: number): void {
  const now = Date.now();
  stalls.push({
    ts: now,
    blockedMs: Math.round(blockedMs),
    syncOps: syncOpsBetween(fromPerf, toPerf),
    logs: logsBetween(now - blockedMs - 200, now, 5),
    inbound: currentInbound,
  });
}

export function stallsSnapshot(limit = 200): { recent: StallRecord[]; total: number; dist: Dist } {
  const recent = stalls.last(limit);
  return { recent, total: stalls.total, dist: dist(stalls.toArray().map((s) => s.blockedMs)) };
}

/* ───────────────────────────── GC ───────────────────────────── */

interface GcAgg { count: number; totalMs: number; maxMs: number }
const gcAgg = new Map<string, GcAgg>();
const longGcs = new Ring<{ ts: number; kind: string; ms: number }>(200);

export function recordGc(kind: string, ms: number): void {
  let a = gcAgg.get(kind);
  if (!a) { a = { count: 0, totalMs: 0, maxMs: 0 }; gcAgg.set(kind, a); }
  a.count++;
  a.totalMs += ms;
  if (ms > a.maxMs) a.maxMs = ms;
  if (ms >= 50) longGcs.push({ ts: Date.now(), kind, ms: Math.round(ms) });
}

export function gcSnapshot(): { byKind: Array<{ kind: string } & GcAgg>; long: Array<{ ts: number; kind: string; ms: number }> } {
  return {
    byKind: [...gcAgg.entries()].map(([kind, a]) => ({ kind, count: a.count, totalMs: Math.round(a.totalMs), maxMs: Math.round(a.maxMs * 10) / 10 })),
    long: longGcs.last(100),
  };
}

/* ───────────────────────────── WS com o orchestrator ───────────────────────────── */

interface MsgAgg { count: number; bytes: number; lastAt: number; handlerTotalMs: number; handlerMaxMs: number; syncMaxMs: number; drops: number }
const wsIn = new Map<string, MsgAgg>();
const wsOut = new Map<string, MsgAgg>();
const wsEvents = new Ring<{ ts: number; kind: string; detail: string }>(300);
const rtts = new Ring<{ ts: number; ms: number }>(720);
const wsState = {
  connects: 0,
  disconnects: 0,
  byCode: {} as Record<string, number>,
  lastOpenAt: null as number | null,
  lastCloseAt: null as number | null,
  lastClose: null as null | { code: number; reason: string },
  errors: 0,
};

function msgAgg(map: Map<string, MsgAgg>, type: string): MsgAgg {
  let a = map.get(type);
  if (!a) { a = { count: 0, bytes: 0, lastAt: 0, handlerTotalMs: 0, handlerMaxMs: 0, syncMaxMs: 0, drops: 0 }; map.set(type, a); }
  return a;
}

export function recordWsIn(type: string, bytes: number): void {
  const a = msgAgg(wsIn, type);
  a.count++;
  a.bytes += bytes;
  a.lastAt = Date.now();
}

/** `syncMs` = parte síncrona do handler (bloqueia o loop); `totalMs` = até a promise assentar. */
export function recordWsHandler(type: string, syncMs: number, totalMs: number): void {
  const a = msgAgg(wsIn, type);
  a.handlerTotalMs += totalMs;
  if (totalMs > a.handlerMaxMs) a.handlerMaxMs = totalMs;
  if (syncMs > a.syncMaxMs) a.syncMaxMs = syncMs;
}

export function recordWsOut(type: string, bytes: number, ok: boolean): void {
  const a = msgAgg(wsOut, type);
  a.count++;
  a.bytes += bytes;
  a.lastAt = Date.now();
  if (!ok) a.drops++;
}

export function recordWsEvent(kind: "open" | "close" | "error" | "handshake", detail: string, code?: number): void {
  wsEvents.push({ ts: Date.now(), kind, detail: detail.slice(0, 300) });
  if (kind === "open") { wsState.connects++; wsState.lastOpenAt = Date.now(); }
  if (kind === "close") {
    wsState.disconnects++;
    wsState.lastCloseAt = Date.now();
    const k = String(code ?? "?");
    wsState.byCode[k] = (wsState.byCode[k] ?? 0) + 1;
    wsState.lastClose = { code: code ?? -1, reason: detail.slice(0, 200) };
  }
  if (kind === "error" || kind === "handshake") wsState.errors++;
}

export function recordRtt(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) rtts.push({ ts: Date.now(), ms: Math.round(ms) });
}

export function wsSnapshot(): Record<string, unknown> {
  const table = (m: Map<string, MsgAgg>) => [...m.entries()]
    .map(([type, a]) => ({
      type,
      count: a.count,
      bytes: a.bytes,
      lastAt: a.lastAt,
      drops: a.drops,
      handlerAvgMs: a.count ? Math.round((a.handlerTotalMs / a.count) * 10) / 10 : 0,
      handlerMaxMs: Math.round(a.handlerMaxMs),
      syncMaxMs: Math.round(a.syncMaxMs * 10) / 10,
    }))
    .sort((x, y) => y.count - x.count);
  return {
    ...wsState,
    rtt: dist(rtts.toArray().map((r) => r.ms)),
    rttSeries: rtts.last(240),
    events: wsEvents.last(150),
    inbound: table(wsIn),
    outbound: table(wsOut),
  };
}

/* ───────────────────────────── relay do bridge (MCP → orchestrator) ───────────────────────────── */

export interface RelayRecord {
  ts: number;
  agentId: string | null;
  op: string;
  method: string;
  status: number;
  totalMs: number;
  /** Tempo resolvendo o peer-pid (perl + ps por hop; assíncrono desde o T-815). */
  peerMs: number;
  upstreamMs: number | null;
  bytesIn: number;
  bytesOut: number;
  error: string | null;
}

const relayReqs = new Ring<RelayRecord>(2000);
interface RelayAgg { count: number; errors: number; statuses: Record<string, number>; totals: Ring<number>; peers: Ring<number>; upstreams: Ring<number>; peerTotalMs: number; peerMaxMs: number }
const relayAgg = new Map<string, RelayAgg>();
let relayConnections = 0;

export function recordRelayConnection(): void {
  relayConnections++;
}

export function recordRelayRequest(r: RelayRecord): void {
  relayReqs.push(r);
  let a = relayAgg.get(r.op);
  if (!a) {
    a = { count: 0, errors: 0, statuses: {}, totals: new Ring<number>(300), peers: new Ring<number>(300), upstreams: new Ring<number>(300), peerTotalMs: 0, peerMaxMs: 0 };
    relayAgg.set(r.op, a);
  }
  a.count++;
  if (r.status >= 400 || r.error) a.errors++;
  a.statuses[String(r.status)] = (a.statuses[String(r.status)] ?? 0) + 1;
  a.totals.push(r.totalMs);
  a.peers.push(r.peerMs);
  if (r.upstreamMs != null) a.upstreams.push(r.upstreamMs);
  a.peerTotalMs += r.peerMs;
  if (r.peerMs > a.peerMaxMs) a.peerMaxMs = r.peerMs;
}

export function relaySnapshot(limit = 300): Record<string, unknown> {
  const byOp = [...relayAgg.entries()].map(([op, a]) => ({
    op,
    count: a.count,
    errors: a.errors,
    statuses: a.statuses,
    total: dist(a.totals.toArray()),
    upstream: dist(a.upstreams.toArray()),
    peer: dist(a.peers.toArray()),
    peerTotalMs: Math.round(a.peerTotalMs),
    peerMaxMs: Math.round(a.peerMaxMs),
  })).sort((x, y) => y.count - x.count);
  return { connections: relayConnections, requests: relayReqs.total, byOp, recent: relayReqs.last(limit) };
}

/* ───────────────────────────── eventos de agente ───────────────────────────── */

export interface AgentEvent {
  ts: number;
  agentId: string;
  kind: "state" | "hung-soft" | "hung-hard" | "park" | "exit" | "error" | "spawn" | "stop";
  detail: string;
}

const agentEvents = new Ring<AgentEvent>(3000);
const lastState = new Map<string, { state: string; since: number }>();
const stateTime = new Map<string, Record<string, number>>();

export function recordAgentEvent(agentId: string, kind: AgentEvent["kind"], detail: string): void {
  agentEvents.push({ ts: Date.now(), agentId, kind, detail: detail.length > 500 ? `${detail.slice(0, 500)}…` : detail });
}

/** Estado novo do runner: guarda transição e acumula tempo por estado. */
export function recordAgentState(agentId: string, state: string): void {
  const now = Date.now();
  const prev = lastState.get(agentId);
  if (prev?.state === state) return;
  if (prev) {
    const acc = stateTime.get(agentId) ?? {};
    acc[prev.state] = (acc[prev.state] ?? 0) + (now - prev.since);
    stateTime.set(agentId, acc);
  }
  lastState.set(agentId, { state, since: now });
  recordAgentEvent(agentId, "state", `${prev?.state ?? "∅"} → ${state}`);
}

export function agentStateInfo(agentId: string): { state: string | null; since: number | null; timeByState: Record<string, number> } {
  const cur = lastState.get(agentId);
  const acc = { ...(stateTime.get(agentId) ?? {}) };
  if (cur) acc[cur.state] = (acc[cur.state] ?? 0) + (Date.now() - cur.since);
  return { state: cur?.state ?? null, since: cur?.since ?? null, timeByState: acc };
}

export function agentEventsSnapshot(filter: { agentId?: string; kinds?: string[]; limit?: number } = {}): AgentEvent[] {
  const limit = Math.max(1, Math.min(3000, filter.limit ?? 400));
  const out: AgentEvent[] = [];
  const all = agentEvents.toArray();
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const e = all[i]!;
    if (filter.agentId && e.agentId !== filter.agentId) continue;
    if (filter.kinds && !filter.kinds.includes(e.kind)) continue;
    out.push(e);
  }
  return out.reverse();
}

/* ───────────────────────────── I/O dos CLIs ───────────────────────────── */

export interface CliIoCounters {
  stdoutBytes: number;
  stdoutChunks: number;
  lastStdoutAt: number | null;
  stderrBytes: number;
  stderrChunks: number;
  lastStderrAt: number | null;
  stdinBytes: number;
  stdinWrites: number;
  lastStdinAt: number | null;
  argvCount: number;
}

const cliIo = new Map<string, CliIoCounters>();
const cliCapture = new Ring<{ ts: number; agentId: string; runner: string; dir: string; text: string }>(1500);
let cliCaptureOn = process.env.THE_DUDES_DEBUG_CLI_CAPTURE === "1";
const CLI_CAPTURE_MAX = 4000;
type Scrubber = (s: string) => string;
let scrubber: Scrubber = (s) => s;

export function setDebugScrubber(fn: Scrubber): void {
  scrubber = fn;
}

export function setCliCapture(on: boolean): void {
  cliCaptureOn = on;
}

export function cliCaptureEnabled(): boolean {
  return cliCaptureOn;
}

export function recordCliIo(agentId: string, runner: string, dir: string, text: string): void {
  let c = cliIo.get(agentId);
  if (!c) {
    c = { stdoutBytes: 0, stdoutChunks: 0, lastStdoutAt: null, stderrBytes: 0, stderrChunks: 0, lastStderrAt: null, stdinBytes: 0, stdinWrites: 0, lastStdinAt: null, argvCount: 0 };
    cliIo.set(agentId, c);
  }
  const now = Date.now();
  const len = text?.length ?? 0;
  if (dir === "stdout") { c.stdoutBytes += len; c.stdoutChunks++; c.lastStdoutAt = now; }
  else if (dir === "stderr") { c.stderrBytes += len; c.stderrChunks++; c.lastStderrAt = now; }
  else if (dir === "stdin") { c.stdinBytes += len; c.stdinWrites++; c.lastStdinAt = now; }
  else if (dir === "argv") { c.argvCount++; c.stdinBytes += len; c.lastStdinAt = now; }
  if (!cliCaptureOn) return;
  const clipped = len > CLI_CAPTURE_MAX ? `${text.slice(0, CLI_CAPTURE_MAX)}… [+${len - CLI_CAPTURE_MAX} chars]` : text;
  cliCapture.push({ ts: now, agentId, runner, dir, text: scrubber(clipped) });
}

export function cliIoCounters(agentId: string): CliIoCounters | null {
  return cliIo.get(agentId) ?? null;
}

export function cliCaptureSnapshot(filter: { agentId?: string; limit?: number } = {}): Array<{ ts: number; agentId: string; runner: string; dir: string; text: string }> {
  const limit = Math.max(1, Math.min(1500, filter.limit ?? 300));
  const all = cliCapture.toArray().filter((e) => !filter.agentId || e.agentId === filter.agentId);
  return all.slice(-limit);
}

/* ───────────────────────────── série temporal ───────────────────────────── */

export interface TimePoint {
  ts: number;
  cpuPct: number;
  rssMb: number;
  heapUsedMb: number;
  elP50: number;
  elP99: number;
  elMax: number;
  eluPct: number;
  agents: number;
  activeTurns: number;
  gateActive: number;
  gateQueued: number;
  bgActive: number;
  bgQueued: number;
  children: number | null;
  childCpuPct: number | null;
  childRssMb: number | null;
  load1: number;
  freeMemMb: number;
  syncMs: number;
  stalls: number;
  relayReqs: number;
  wsOut: number;
  wsIn: number;
  logWarn: number;
  logError: number;
}

const series = new Ring<TimePoint>(1440);

export function pushTimePoint(p: TimePoint): void {
  series.push(p);
}

export function timeSeries(limit = 1440): TimePoint[] {
  return series.last(limit);
}

/** Totais correntes que a série temporal transforma em taxa (delta por amostra). */
export function counterTotals(): { syncMs: number; stalls: number; relayReqs: number; wsOut: number; wsIn: number; logWarn: number; logError: number } {
  let syncMs = 0;
  for (const a of syncAgg.values()) syncMs += a.totalMs;
  let wsOutN = 0;
  for (const a of wsOut.values()) wsOutN += a.count;
  let wsInN = 0;
  for (const a of wsIn.values()) wsInN += a.count;
  return { syncMs, stalls: stalls.total, relayReqs: relayReqs.total, wsOut: wsOutN, wsIn: wsInN, logWarn: logCounts.warn, logError: logCounts.error };
}

/* ───────────────────────────── utilidades ───────────────────────────── */

export const perfNow = (): number => performance.now();

/** Só para teste: zera o estado global do módulo. */
export function _resetDebugStoreForTest(): void {
  logSeq = 0;
  logs.clear(); issues.clear();
  logCounts.info = 0; logCounts.warn = 0; logCounts.error = 0;
  turns.clear(); liveTurns.clear();
  spawns.clear(); liveSpawns.clear(); spawnAgg.clear(); spawnSeq = 0;
  syncOps.clear(); syncAgg.clear();
  stalls.clear(); currentInbound = null;
  gcAgg.clear(); longGcs.clear();
  wsIn.clear(); wsOut.clear(); wsEvents.clear(); rtts.clear();
  Object.assign(wsState, { connects: 0, disconnects: 0, byCode: {}, lastOpenAt: null, lastCloseAt: null, lastClose: null, errors: 0 });
  relayReqs.clear(); relayAgg.clear(); relayConnections = 0;
  agentEvents.clear(); lastState.clear(); stateTime.clear();
  cliIo.clear(); cliCapture.clear(); cliCaptureOn = false;
  series.clear();
}
