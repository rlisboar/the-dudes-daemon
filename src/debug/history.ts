/**
 * T-812: histórico dos logs do perfil para o dashboard identificar problemas.
 *
 * O store do dashboard vive em memória e zera a cada re-exec — medido: 13–17
 * re-execs POR DIA (54 de 85 deploys em 7d sem mudança no daemon). O que dá
 * para diagnosticar só com "desde o último boot" é pouco; o log do launcher
 * (<home do perfil>/daemon-prod.log + rotações) guarda o `[turn-latency]` de
 * todos os turnos, hangs, recovers, filas estouradas e trocas de release.
 *
 * Leitura por stream (readline) — o loop segue livre; filtro por prefixo de
 * timestamp descarta rápido o que é mais velho que 7 dias. Recalcula a cada
 * 10 min ou sob demanda. Só metadados que o próprio log já tem.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { dist, type Dist } from "./store.js";

export interface HistTurnAgg {
  key: string;
  count: number;
  completed: number;
  problems: number;
  okPct: number;
  endReasons: Record<string, number>;
  duration: Dist;
  firstEvent: Dist;
  queue: Dist;
  gateWait: Dist;
  retries: number;
  queueWait10m: number;
  /** Falhas reais (error/hard-recover/process-exit/spawn-error/retry) — stop/reset não contam. */
  failures: number;
  /** Última falha real (para dizer se o problema ainda acontece). */
  lastProblemTs: number | null;
  /** Últimas 3h da janela: o problema segue ou parou? (só completados + falhas) */
  recent3h: { count: number; completed: number };
}

/** Fim de turno que é defeito (o resto — stopped/cancelled/reset — é decisão ou restart). */
export const FAILURE_REASONS = new Set(["error", "hard-recover", "process-exit", "spawn-error", "retry"]);

export interface HistWindow {
  turns: number;
  byRunner: HistTurnAgg[];
  byAgent: HistTurnAgg[];
  hardRecovers: Array<{ agent: string; runner: string; reason: string; n: number }>;
  hardRecoversByAgent: Array<{ agent: string; n: number }>;
  softHangs: Array<{ agent: string; runner: string; n: number }>;
  queueFullDrops: Array<{ agent: string; n: number }>;
  stdinNotAccepted: number;
  queueWait10m: number;
  reexecs: number;
  releases: number;
  launcherExits: number;
  wsHandshakeFailures: number;
  heartbeatTimeouts: number;
  stateLost: number;
  /** Slots do turn-gate liberados à força pelo anti-deadlock (label → vezes). */
  gateForced: Array<{ label: string; n: number }>;
  /** Maior toolsInFlight visto por agente quando o teto de tools estourou. */
  toolsInflated: Array<{ agent: string; max: number; n: number }>;
  patterns: Array<{ id: string; n: number; last: number; sample: string }>;
  topIssues: Array<{ msg: string; level: string; n: number; last: number }>;
}

export interface HistorySummary {
  generatedAt: number;
  tookMs: number;
  files: Array<{ path: string; bytes: number; from: number | null; to: number | null }>;
  reexecsByDay: Record<string, number>;
  windows: { "24h": HistWindow; "7d": HistWindow };
  error: string | null;
}

/** Padrões conhecidos com significado operacional (id → regex). */
export const KNOWN_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "dsh-sem-chave", re: /no API key for provider route/ },
  { id: "opencode-teto-post", re: /opencode: turno falhou.*teto de 30min do POST/ },
  { id: "opencode-abortado", re: /MessageAbortedError/ },
  { id: "summarize-timeout", re: /summarize:result ok=false error=timeout/ },
  { id: "handshake-orchestrator", re: /handshake failed: HTTP|Opening handshake has timed out/ },
  { id: "send-sem-runner", re: /send_message para agent_\S+ sem runner ativo/ },
  { id: "e2ee-sem-chave", re: /project key not held|e2ee-required sem chave/ },
  { id: "grok-close-nao-veio", re: /close não veio após SIGKILL/ },
  { id: "codex-processo-morto", re: /process dead for \d+s while busy/ },
  { id: "tool-result-perdido", re: /tool_result perdido ou teto/ },
];

const DAY = 86_400_000;
const LINE_RE = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[(info|warn|error)\] (.*)$/;

interface Turn { ts: number; agentId: string; runner: string; endReason: string; durationMs: number | null; firstEventMs: number | null; queueMs: number | null; gateWaitMs: number | null; attempt: number }

interface Acc {
  turns: Turn[];
  hard: Map<string, number>;
  soft: Map<string, number>;
  drops: Map<string, number>;
  stdin: number;
  reexecs: number;
  releases: number;
  launcherExits: number;
  handshake: number;
  heartbeat: number;
  stateLost: number;
  gateForced: Map<string, number>;
  tools: Map<string, { max: number; n: number }>;
  patterns: Map<string, { n: number; last: number; sample: string }>;
  issues: Map<string, { msg: string; level: string; n: number; last: number }>;
}

const newAcc = (): Acc => ({
  turns: [], hard: new Map(), soft: new Map(), drops: new Map(), stdin: 0, reexecs: 0, releases: 0,
  launcherExits: 0, handshake: 0, heartbeat: 0, stateLost: 0, gateForced: new Map(), tools: new Map(), patterns: new Map(), issues: new Map(),
});

const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Normaliza uma linha de warn/error para agrupar (ids, números, uuids). */
export function normalizeIssue(msg: string): string {
  return msg
    .replace(/agent_[0-9a-f]+/g, "agent_*")
    .replace(/ses_[A-Za-z0-9]+/g, "ses_*")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hash>")
    .replace(/\d+(\.\d+)?/g, "N")
    .slice(0, 140);
}

/** Uma linha do log → acumuladores (exportado para teste). */
export function ingestLogLine(line: string, acc: Acc, names: Map<string, string>): number | null {
  const m = LINE_RE.exec(line);
  if (!m) {
    // Linha do launcher (run-daemon.sh): outro formato de timestamp.
    const l = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\] \[launcher\] daemon saiu com código/.exec(line);
    if (!l) return null;
    acc.launcherExits++;
    return Date.parse(l[1]!);
  }
  const ts = Date.parse(m[1]!);
  const level = m[2]!;
  const msg = m[3]!;
  let x: RegExpExecArray | null;
  if ((x = /^spawn (.+?) \((agent_[0-9a-f]+)\) .*runner=(\S+)/.exec(msg))) names.set(x[2]!, x[1]!);
  if (msg.startsWith("[turn-latency] ")) {
    try {
      const j = JSON.parse(msg.slice(15)) as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      acc.turns.push({
        ts,
        agentId: String(j.agentId ?? "?"),
        runner: String(j.runner ?? "?"),
        endReason: String(j.endReason ?? "?"),
        durationMs: n(j.durationMs),
        firstEventMs: n(j.firstEventMs),
        queueMs: n(j.queueMs),
        gateWaitMs: n(j.gateWaitMs),
        attempt: n(j.attempt) ?? 0,
      });
    } catch { /* linha truncada */ }
    return ts;
  }
  if ((x = /^\[(?:hang|lifetime):(.+?)\] HARD recover(?: claude continuous| dsh)?: (.*?)(?: \(runner=(\S+?) idleMs=\d+\))?$/.exec(msg))) {
    inc(acc.hard, `${x[1]}\u0000${x[3] ?? "?"}\u0000${x[2]!.replace(/\d+/g, "N").slice(0, 80)}`);
  } else if ((x = /^\[hang\] sem atividade há \d+s \(runner=(\S+)\) — aguardando… agent=(.+)$/.exec(msg))) {
    inc(acc.soft, `${x[2]}\u0000${x[1]}`);
  }
  if ((x = /^\[cli:(agent_[0-9a-f]+):\S+\] (?:ocQueue cheia|pendingMessages cheia)/.exec(msg))) inc(acc.drops, x[1]!);
  if (/mensagem não foi aceita pelo CLI/.test(msg)) acc.stdin++;
  if (/saindo com código 42/.test(msg)) acc.reexecs++;
  if (/^\[self-update\] release [0-9a-f]+ ≠ rodando/.test(msg)) acc.releases++;
  if (/^heartbeat timeout/.test(msg)) acc.heartbeat++;
  if (/^handshake failed: HTTP/.test(msg)) acc.handshake++;
  // T-822: o log virou "descartado" (o crítico é "enfileirado" e não se perde).
  if (/^outbound descartado type=agent:(running|state|usage_delta|context) /.test(msg)) acc.stateLost++;
  if ((x = /^\[turn-gate:\w+\] slot de (.+?) preso há \d+min — liberando à força/.exec(msg))) inc(acc.gateForced, x[1]!);
  if ((x = /^\[hang:(.+?)\] toolsInFlight=(\d+) aberto há \d+s/.exec(msg))) {
    const e = acc.tools.get(x[1]!) ?? { max: 0, n: 0 };
    e.max = Math.max(e.max, Number(x[2]));
    e.n++;
    acc.tools.set(x[1]!, e);
  }
  for (const p of KNOWN_PATTERNS) {
    if (!p.re.test(msg)) continue;
    const e = acc.patterns.get(p.id) ?? { n: 0, last: 0, sample: "" };
    e.n++;
    e.last = ts;
    e.sample = msg.slice(0, 220);
    acc.patterns.set(p.id, e);
  }
  if (level !== "info") {
    const k = normalizeIssue(msg);
    const e = acc.issues.get(k) ?? { msg: k, level, n: 0, last: 0 };
    e.n++;
    e.last = ts;
    acc.issues.set(k, e);
  }
  return ts;
}

function aggTurns(turns: Turn[], key: (t: Turn) => string, now: number): HistTurnAgg[] {
  const g = new Map<string, Turn[]>();
  for (const t of turns) {
    if (t.endReason === "queue-cleared" || t.endReason === "drained") continue;
    const k = key(t);
    const a = g.get(k) ?? [];
    a.push(t);
    g.set(k, a);
  }
  return [...g.entries()].map(([k, a]) => {
    const endReasons: Record<string, number> = {};
    for (const t of a) endReasons[t.endReason] = (endReasons[t.endReason] ?? 0) + 1;
    const completed = endReasons.completed ?? 0;
    const falhas = a.filter((t) => FAILURE_REASONS.has(t.endReason));
    const decididos = completed + falhas.length;
    const recent = a.filter((t) => now - t.ts <= 3 * 3_600_000 && (t.endReason === "completed" || FAILURE_REASONS.has(t.endReason)));
    return {
      key: k,
      count: a.length,
      completed,
      problems: a.length - completed,
      okPct: decididos ? Math.round((completed / decididos) * 1000) / 10 : 100,
      endReasons,
      duration: dist(a.map((t) => t.durationMs)),
      firstEvent: dist(a.map((t) => t.firstEventMs)),
      queue: dist(a.map((t) => t.queueMs)),
      gateWait: dist(a.map((t) => t.gateWaitMs)),
      retries: a.filter((t) => t.attempt > 0).length,
      queueWait10m: a.filter((t) => (t.queueMs ?? 0) >= 10 * 60_000).length,
      failures: falhas.length,
      lastProblemTs: falhas.length ? Math.max(...falhas.map((t) => t.ts)) : null,
      recent3h: { count: recent.length, completed: recent.filter((t) => t.endReason === "completed").length },
    };
  }).sort((x, y) => y.count - x.count);
}

function windowOf(acc: Acc, names: Map<string, string>, now = Date.now()): HistWindow {
  const nm = (id: string) => names.get(id) ?? id;
  const split = (m: Map<string, number>) => [...m.entries()].map(([k, n]) => ({ parts: k.split("\u0000"), n })).sort((a, b) => b.n - a.n);
  const hard = split(acc.hard).map(({ parts, n }) => ({ agent: parts[0]!, runner: parts[1]!, reason: parts[2]!, n }));
  const hardByAgent = new Map<string, number>();
  for (const h of hard) hardByAgent.set(h.agent, (hardByAgent.get(h.agent) ?? 0) + h.n);
  return {
    turns: acc.turns.length,
    byRunner: aggTurns(acc.turns, (t) => t.runner, now),
    byAgent: aggTurns(acc.turns, (t) => `${nm(t.agentId)} (${t.runner})`, now),
    hardRecovers: hard.slice(0, 30),
    hardRecoversByAgent: [...hardByAgent.entries()].map(([agent, n]) => ({ agent, n })).sort((a, b) => b.n - a.n),
    softHangs: split(acc.soft).map(({ parts, n }) => ({ agent: parts[0]!, runner: parts[1]!, n })).slice(0, 30),
    queueFullDrops: [...acc.drops.entries()].map(([id, n]) => ({ agent: nm(id), n })).sort((a, b) => b.n - a.n),
    stdinNotAccepted: acc.stdin,
    queueWait10m: acc.turns.filter((t) => (t.queueMs ?? 0) >= 10 * 60_000).length,
    reexecs: acc.reexecs,
    releases: acc.releases,
    launcherExits: acc.launcherExits,
    wsHandshakeFailures: acc.handshake,
    heartbeatTimeouts: acc.heartbeat,
    stateLost: acc.stateLost,
    gateForced: [...acc.gateForced.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n),
    toolsInflated: [...acc.tools.entries()].map(([agent, e]) => ({ agent, ...e })).sort((a, b) => b.max - a.max),
    patterns: [...acc.patterns.entries()].map(([id, e]) => ({ id, ...e })).sort((a, b) => b.n - a.n),
    topIssues: [...acc.issues.values()].sort((a, b) => b.n - a.n).slice(0, 40),
  };
}

/** Logs do perfil: override por env, senão daemon-prod.log (+ rotações) do home. */
export function historyLogFiles(home: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string[] {
  if (env.THE_DUDES_DEBUG_LOG_FILES) return env.THE_DUDES_DEBUG_LOG_FILES.split(",").map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const base of ["daemon-prod.log", "daemon.log"]) {
    for (const suf of [".2", ".1", ""]) {
      const p = path.join(home, base + suf);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs < 8 * DAY) out.push(p);
      } catch { /* não existe */ }
    }
  }
  return out;
}

/** Lê os arquivos (mais antigo primeiro) e resume 24h / 7d. */
export async function analyzeHistory(files: string[], now = Date.now()): Promise<HistorySummary> {
  const t0 = Date.now();
  const cut7 = new Date(now - 7 * DAY).toISOString();
  const cut24 = now - DAY;
  const acc7 = newAcc();
  const acc24 = newAcc();
  const names = new Map<string, string>();
  const reexecsByDay: Record<string, number> = {};
  const meta: HistorySummary["files"] = [];
  let error: string | null = null;
  for (const file of files) {
    let bytes = 0;
    let from: number | null = null;
    let to: number | null = null;
    try {
      bytes = fs.statSync(file).size;
      const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of rl) {
        // Nomes de agente valem a vida toda do log (o spawn pode ser antigo).
        if (line.length > 30 && line.charCodeAt(0) === 91 /* [ */ && line.slice(1, 25) < cut7) {
          if (line.includes("] spawn ")) ingestLogLine(line, newAcc(), names);
          continue;
        }
        const ts = ingestLogLine(line, acc7, names);
        if (ts != null) {
          if (from == null) from = ts;
          to = ts;
          if (ts >= cut24) ingestLogLine(line, acc24, names);
          if (/saindo com código 42/.test(line)) {
            const d = new Date(ts).toISOString().slice(0, 10);
            reexecsByDay[d] = (reexecsByDay[d] ?? 0) + 1;
          }
        }
      }
    } catch (e) {
      error = `${path.basename(file)}: ${(e as Error).message}`;
    }
    meta.push({ path: file, bytes, from, to });
  }
  return {
    generatedAt: Date.now(),
    tookMs: Date.now() - t0,
    files: meta,
    reexecsByDay,
    windows: { "24h": windowOf(acc24, names, now), "7d": windowOf(acc7, names, now) },
    error,
  };
}

/** Só para teste. */
export const _histForTest = { newAcc, windowOf };
