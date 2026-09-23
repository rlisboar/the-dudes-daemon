/**
 * T-812: dashboard de debug do daemon — orquestra store, sondas, amostradores
 * e o servidor HTTP loopback.
 *
 * Liga por padrão (o dono precisa dele justamente quando o daemon está mal);
 * opt-out THE_DUDES_DEBUG_HTTP=0. Porta: THE_DUDES_DEBUG_PORT, senão a última
 * usada pelo perfil (debug-dashboard.json), senão 7878 — e as próximas 20 se
 * ocupada (dois perfis na mesma máquina não brigam). A URL com token fica em
 * <home do perfil>/debug-dashboard.url (0600).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import inspector from "node:inspector";
import { performance } from "node:perf_hooks";
import { dashboardHtml } from "./dashboard-html.js";
import { profileHome } from "../profile-home.js";
import { lastHostMemory, ProcSampler, refreshHostMemory, type ProcSample } from "./proc-sampler.js";
import { readLoopStats, type LoopStats } from "./probes.js";
import { analyzeHistory, historyLogFiles, type HistorySummary } from "./history.js";
import { newDebugToken, sendJson, startDebugHttpServer, type Route } from "./server.js";
import {
  agentEventsSnapshot, aggregateTurns, cliCaptureEnabled, cliCaptureSnapshot, counterTotals, gcSnapshot,
  liveSpawnAgents, liveTurnsSnapshot, onDebugLog, pushTimePoint, queryLogs, recentTurns, relaySnapshot,
  setCliCapture, spawnsSnapshot, stallsSnapshot, syncOpsSnapshot, timeSeries, wsSnapshot,
  type DebugLevel, type TimePoint,
} from "./store.js";
import type { TurnGateDebug } from "../runners/turn-gate.js";

export interface DashboardDeps {
  log: (level: "info" | "warn" | "error", msg: string) => void;
  identity: () => Record<string, unknown>;
  agents: () => Array<Record<string, unknown>>;
  agentCount: () => number;
  hostState: () => Record<string, unknown>;
  gate: () => TurnGateDebug;
  wsLive: () => Record<string, unknown>;
  runners: () => Record<string, unknown>;
  health: () => Record<string, unknown>;
  relayLive: () => Record<string, unknown>;
  scrub: (s: string) => string;
}

export interface DashboardHandle {
  url: string;
  port: number;
  stop: () => void;
}

/* ───────────────────────────── perfil / config ───────────────────────────── */

export { profileHome } from "../profile-home.js";

interface DashboardConfig { token: string; port: number }

function loadConfig(home: string): DashboardConfig {
  const file = path.join(home, "debug-dashboard.json");
  let saved: Partial<DashboardConfig> = {};
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DashboardConfig>; } catch { /* primeiro boot */ }
  const envPort = Number(process.env.THE_DUDES_DEBUG_PORT);
  const token = process.env.THE_DUDES_DEBUG_TOKEN && process.env.THE_DUDES_DEBUG_TOKEN.length >= 16
    ? process.env.THE_DUDES_DEBUG_TOKEN
    : typeof saved.token === "string" && saved.token.length >= 24 ? saved.token : newDebugToken();
  const port = Number.isInteger(envPort) && envPort > 0 && envPort < 65536
    ? envPort
    : Number.isInteger(saved.port) && (saved.port as number) > 0 ? (saved.port as number) : 7878;
  return { token, port };
}

function saveConfig(home: string, cfg: DashboardConfig, url: string): void {
  try {
    fs.mkdirSync(home, { recursive: true });
    const write = (name: string, content: string) => {
      const file = path.join(home, name);
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, content, { mode: 0o600 });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch { /* */ }
    };
    write("debug-dashboard.json", JSON.stringify({ token: cfg.token, port: cfg.port }, null, 2));
    write("debug-dashboard.url", `${url}?token=${cfg.token}\n`);
  } catch { /* sem persistência: o token vale só para este processo */ }
}

/* ───────────────────────────── série temporal + estado corrente ───────────────────────────── */

let lastLoop: LoopStats | null = null;
let lastCpuPct = 0;

function processInfo(): Record<string, unknown> {
  const mem = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const ru = process.resourceUsage();
  const handles: Record<string, number> = {};
  try {
    const info = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ?? [];
    for (const t of info) handles[t] = (handles[t] ?? 0) + 1;
  } catch { /* node antigo */ }
  const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;
  return {
    pid: process.pid,
    ppid: process.ppid,
    uptimeS: Math.round(process.uptime()),
    cpuPct: lastCpuPct,
    memory: { rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed), heapTotalMb: mb(mem.heapTotal), externalMb: mb(mem.external), arrayBuffersMb: mb(mem.arrayBuffers) },
    heap: {
      limitMb: mb(heap.heap_size_limit),
      usedPct: Math.round((heap.used_heap_size / heap.heap_size_limit) * 1000) / 10,
      mallocedMb: mb(heap.malloced_memory),
      nativeContexts: heap.number_of_native_contexts,
      detachedContexts: heap.number_of_detached_contexts,
    },
    resourceUsage: {
      userCpuS: Math.round(ru.userCPUTime / 1e4) / 100,
      systemCpuS: Math.round(ru.systemCPUTime / 1e4) / 100,
      maxRssMb: Math.round(ru.maxRSS / 1024),
      fsRead: ru.fsRead,
      fsWrite: ru.fsWrite,
      voluntaryCtxSwitches: ru.voluntaryContextSwitches,
      involuntaryCtxSwitches: ru.involuntaryContextSwitches,
    },
    handles,
    node: process.version,
    v8: process.versions.v8,
    uv: process.versions.uv,
  };
}

function systemInfo(): Record<string, unknown> {
  const cpus = os.cpus();
  const load = os.loadavg();
  return {
    hostname: os.hostname(),
    platform: `${process.platform} ${os.release()} (${process.arch})`,
    cpus: cpus.length,
    cpuModel: cpus[0]?.model ?? "?",
    load: load.map((l) => Math.round(l * 100) / 100),
    loadPerCpu: cpus.length ? Math.round((load[0]! / cpus.length) * 100) / 100 : null,
    totalMemMb: Math.round(os.totalmem() / 1048576),
    freeMemMb: Math.round(os.freemem() / 1048576),
    uptimeS: Math.round(os.uptime()),
    hostMemory: lastHostMemory(),
  };
}

function startSeriesSampler(deps: DashboardDeps, sampler: ProcSampler): NodeJS.Timeout {
  let prevCpu = process.cpuUsage();
  let prevAt = performance.now();
  let prevTotals = counterTotals();
  const tick = () => {
    try {
      const loop = readLoopStats();
      lastLoop = loop;
      const now = performance.now();
      const cpu = process.cpuUsage(prevCpu);
      lastCpuPct = Math.round(((cpu.user + cpu.system) / 1000 / Math.max(1, now - prevAt)) * 1000) / 10;
      prevCpu = process.cpuUsage();
      prevAt = now;
      const mem = process.memoryUsage();
      const gate = deps.gate();
      const totals = counterTotals();
      const ps = sampler.latestSample();
      const fresh = ps && Date.now() - ps.ts < 90_000 ? ps : null;
      const point: TimePoint = {
        ts: Date.now(),
        cpuPct: lastCpuPct,
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        elP50: loop.window.p50,
        elP99: loop.window.p99,
        elMax: loop.window.max,
        eluPct: loop.eluPct,
        agents: deps.agentCount(),
        activeTurns: gate.pools.main.active + gate.pools.bg.active,
        gateActive: gate.pools.main.active,
        gateQueued: gate.pools.main.queued,
        bgActive: gate.pools.bg.active,
        bgQueued: gate.pools.bg.queued,
        children: fresh ? fresh.totals.count : null,
        childCpuPct: fresh ? fresh.totals.cpuPct : null,
        childRssMb: fresh ? fresh.totals.rssMb : null,
        load1: Math.round(os.loadavg()[0]! * 100) / 100,
        freeMemMb: Math.round(os.freemem() / 1048576),
        syncMs: Math.round(totals.syncMs - prevTotals.syncMs),
        stalls: totals.stalls - prevTotals.stalls,
        relayReqs: totals.relayReqs - prevTotals.relayReqs,
        wsOut: totals.wsOut - prevTotals.wsOut,
        wsIn: totals.wsIn - prevTotals.wsIn,
        logWarn: totals.logWarn - prevTotals.logWarn,
        logError: totals.logError - prevTotals.logError,
      };
      prevTotals = totals;
      pushTimePoint(point);
    } catch (e) {
      deps.log("warn", `[debug-http] amostra da série falhou: ${(e as Error).message}`);
    }
  };
  const timer = setInterval(tick, 5_000);
  timer.unref?.();
  return timer;
}

/* ───────────────────────────── diagnóstico automático ───────────────────────────── */

export interface Alert {
  level: "crit" | "warn" | "info";
  area: string;
  title: string;
  detail: string;
  /** O que fazer (quando há correção conhecida). */
  action?: string;
  /** "agora" (estado vivo) ou a janela do histórico do log ("24h"/"7d"). */
  when?: "agora" | "24h" | "7d";
}

const MIN = 60_000;

function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function diagnose(input: {
  agents: Array<Record<string, unknown>>;
  gate: TurnGateDebug;
  loop: LoopStats | null;
  proc: ProcSample | null;
  ws: Record<string, unknown>;
  process: Record<string, unknown>;
  system: Record<string, unknown>;
  now?: number;
  platform?: NodeJS.Platform;
  history?: HistorySummary | null;
  /** T-839: estado do host (dreno + quem segura). O dashboard manda o record cru. */
  host?: Record<string, unknown>;
}): Alert[] {
  const now = input.now ?? Date.now();
  const platform = input.platform ?? process.platform;
  const out: Alert[] = [];
  const add = (level: Alert["level"], area: string, title: string, detail = "", action?: string, when: Alert["when"] = "agora") =>
    out.push({ level, area, title, detail, ...(action ? { action } : {}), when });

  // Event loop: o daemon inteiro (todos os runners) anda no mesmo thread.
  const loop = input.loop;
  if (loop) {
    if (loop.window.p99 >= 200 || loop.window.max >= 1000) {
      add("crit", "event loop", `Event loop travando: p99 ${fmtMs(loop.window.p99)}, máx ${fmtMs(loop.window.max)} na última janela`,
        "Enquanto o loop está bloqueado NENHUM runner é atendido (stdout parado, WS atrasado, watchdog atrasado). Veja Event loop → travamentos e chamadas síncronas.");
    } else if (loop.window.p99 >= 50) {
      add("warn", "event loop", `Event loop lento: p99 ${fmtMs(loop.window.p99)}`, "Latência de timers acima de 50ms — todo o daemon sente.");
    }
    if (loop.eluPct >= 85) add("warn", "event loop", `Event loop ${loop.eluPct}% ocupado`, "Pouca folga de CPU no thread principal do daemon.");
  }
  const stalls = stallsSnapshot(400).recent.filter((s) => now - s.ts < 5 * MIN);
  if (stalls.length > 0) {
    const worst = stalls.reduce((a, b) => (b.blockedMs > a.blockedMs ? b : a));
    const causes = new Map<string, number>();
    for (const s of stalls) for (const op of s.syncOps) {
      const k = op.replace(/\s\d+ms$/, "").split(" ").slice(0, 2).join(" ");
      causes.set(k, (causes.get(k) ?? 0) + 1);
    }
    const top = [...causes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n}×)`).join(", ");
    add(stalls.length >= 5 || worst.blockedMs >= 1000 ? "crit" : "warn", "event loop",
      `${stalls.length} travamento(s) ≥150ms nos últimos 5 min (pior ${fmtMs(worst.blockedMs)})`,
      top ? `Chamadas síncronas dentro das janelas: ${top}.` : "Nenhuma chamada síncrona registrada na janela — CPU de JS (parse/cripto/GC). Rode um CPU profile.");
  }
  const sync = syncOpsSnapshot(800).recent.filter((r) => now - r.ts < 5 * MIN && r.fn.startsWith("child_process."));
  if (sync.length > 0) {
    const total = sync.reduce((a, r) => a + r.ms, 0);
    if (total >= 1000) {
      const byTarget = new Map<string, { n: number; ms: number }>();
      for (const r of sync) {
        const k = r.target.split(" ")[0] ?? r.target;
        const v = byTarget.get(k) ?? { n: 0, ms: 0 };
        v.n++; v.ms += r.ms;
        byTarget.set(k, v);
      }
      const top = [...byTarget.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 4).map(([k, v]) => `${k} ${v.n}× = ${fmtMs(v.ms)}`).join(", ");
      add(total >= 5000 ? "crit" : "warn", "sync", `${fmtMs(total)} bloqueados em spawnSync/execFileSync nos últimos 5 min`, `Maiores: ${top}. Cada chamada congela o daemon inteiro pelo tempo dela.`);
    }
  }

  // Turn-gate.
  for (const w of input.gate.waiters) {
    if (w.waitingMs >= 30_000) {
      const p = input.gate.pools[w.pool];
      add("warn", "gate", `Turno esperando slot há ${fmtMs(w.waitingMs)}: ${w.label}`,
        `Pool ${w.pool}: ${p.active}/${p.max} ativos, ${p.queued} na fila. Quem segura: ${input.gate.holders.filter((h) => h.pool === w.pool).map((h) => `${h.label} (${fmtMs(h.heldMs)})`).join(", ") || "ninguém?!"}. Ajuste THE_DUDES_MAX_CLI_TURNS / THE_DUDES_MAX_BG_CLI_TURNS se for capacidade.`);
      break;
    }
  }
  for (const [name, p] of Object.entries(input.gate.pools)) {
    if (p.forced > 0) add("warn", "gate", `Pool ${name}: ${p.forced} slot(s) liberado(s) à força pelo anti-deadlock`, "Slot vazado — algum turno não chamou release.");
  }

  // Agentes.
  const cpuByAgent = new Map((input.proc?.byAgent ?? []).map((a) => [a.agentId, a]));
  for (const a of input.agents) {
    const r = (a.runner ?? null) as Record<string, any> | null;
    const name = `${a.name} (${a.cliRunner})`;
    if (!r) {
      if (a.hasRunner === false) add("info", "agente", `${name} sem runner ativo`, `Mensagens retidas no buffer: ${a.inboundBuffered ?? 0}.`);
      continue;
    }
    if (r.error) { add("warn", "agente", `${name}: snapshot falhou`, String(r.error)); continue; }
    if (typeof r.claudeUnacceptedMs === "number" && r.claudeUnacceptedMs >= 30_000) {
      add("crit", "agente", `${name}: mensagem não aceita pelo stdin do claude há ${fmtMs(r.claudeUnacceptedMs)}`, "T-758: o CLI não leu a mensagem; o watchdog reinicia aos 90s.");
    }
    if (r.state === "stalled") add("warn", "agente", `${name} está STALLED (sem atividade semântica há ${fmtMs(r.idleMs)})`, `Fase do turno: ${r.currentTurn?.phase ?? "?"}; tools em voo: ${r.toolsInFlight}.`);
    else if (r.inTurn && typeof r.idleMs === "number" && r.idleMs >= 3 * MIN && !(r.toolsInFlight > 0)) {
      add("warn", "agente", `${name} em turno sem atividade há ${fmtMs(r.idleMs)}`, `Soft do runner: ${fmtMs(r.thresholds?.softMs)}, hard: ${fmtMs(r.thresholds?.hardMs)}.`);
    }
    if (r.toolsInFlight > 0 && typeof r.toolsInFlightMs === "number" && r.toolsInFlightMs >= 5 * MIN) {
      // T-826: tool em voo SEM atividade nenhuma além do soft é o formato da
      // `question` do opencode (espera resposta no TUI) ou de tool travada —
      // o watchdog, com tool em voo, só age no teto absoluto.
      const semAtividade = typeof r.idleMs === "number" && r.idleMs >= (r.thresholds?.softMs ?? 3 * MIN);
      if (semAtividade) {
        add("warn", "agente", `${name}: ${r.toolsInFlight} tool(s) em voo há ${fmtMs(r.toolsInFlightMs)} sem nenhuma atividade`, `Sem evento há ${fmtMs(r.idleMs)}; o watchdog só age no teto absoluto (${fmtMs(r.thresholds?.toolsHardMs)}).`,
          "Ver a tool pendente no CLI (opencode: GET /question e /permission do serve do agente); tool que espera resposta humana trava o turno.");
      } else {
        add("info", "agente", `${name}: ${r.toolsInFlight} tool(s) em voo há ${fmtMs(r.toolsInFlightMs)}`, `Teto absoluto: ${fmtMs(r.thresholds?.toolsHardMs)}.`);
      }
    }
    if (r.queued > 0 && !r.busy && !r.waitingTurnGate) add("warn", "agente", `${name}: fila com ${r.queued} msg(s) sem turno rodando`, "Fila órfã — o watchdog tenta drenar a cada 30s.");
    if (r.queued >= 5) add("warn", "agente", `${name}: ${r.queued} mensagens enfileiradas`, "O agente está recebendo mais do que consegue processar.");
    if (r.hardRecoversLastHour >= 2) add("warn", "agente", `${name}: ${r.hardRecoversLastHour} hard recovers na última hora`, "Veja Turnos → motivos de fim.");
    if (r.compacting && typeof r.compactingMs === "number" && r.compactingMs >= 5 * MIN) add("warn", "agente", `${name}: compact rodando há ${fmtMs(r.compactingMs)}`, "A fila fica parada durante o compact.");
    if (typeof r.contextUsed === "number" && typeof r.contextLimit === "number" && r.contextLimit > 0 && r.contextUsed / r.contextLimit >= 0.9) {
      add("info", "agente", `${name}: contexto em ${Math.round((r.contextUsed / r.contextLimit) * 100)}%`, "Turnos ficam mais lentos com contexto cheio; compact em breve.");
    }
    const procs = cpuByAgent.get(String(a.agentId));
    if (r.inTurn && procs && procs.cpuPct != null && procs.cpuPct < 1 && typeof r.idleMs === "number" && r.idleMs >= 2 * MIN) {
      add("warn", "agente", `${name}: turno ativo com ${procs.procs} processo(s) a ${procs.cpuPct}% de CPU`, "CLI parado esperando algo (rede do provedor, lock, stdin).");
    }
    if (r.alive === false && a.hasRunner) add("warn", "agente", `${name}: runner marcado mas processo morto`, "");
    // T-839: turno aberto de verdade (claude espera `result`). Sem o dreno
    // ligado isto só explica o rótulo; com o dreno, o alerta de baixo nomeia
    // quem segura o re-exec.
    if (r.longTurn && input.host?.draining !== true) {
      add("info", "agente", `turno longo: ${a.agentId} há ${fmtMs(r.turnElapsedMs)}`,
        `Motivo: ${r.turnHoldReason ?? r.state}. O claude contínuo só fecha o turno no evento result; monitor ou tool em segundo plano mantém o stream aberto. É turno de verdade — a idade é deste turno, não um flag preso desde o boot.`);
    }
  }

  if (input.host?.draining === true) {
    const bruto = input.host.drainHolders;
    const holders = Array.isArray(bruto)
      ? bruto as Array<{ agentId: string; turnAgeMs: number; runner?: string; state?: string; reason?: string }>
      : [];
    if (holders.length === 0) {
      add("warn", "dreno", "dreno do self-update ligado sem agente nomeado",
        "O re-exec espera o teto. Nenhum snapshot de turno chegou — veja o turn-gate.");
    }
    for (const h of holders) {
      const longo = h.turnAgeMs >= 10 * MIN;
      add("warn", "dreno", `${longo ? "turno longo" : "turno"} segura o dreno: ${h.agentId} há ${fmtMs(h.turnAgeMs)}`,
        `runner=${h.runner ?? "?"} state=${h.state ?? "?"} motivo=${h.reason ?? "?"}. O claude contínuo permanece em turno até o evento result; um monitor em segundo plano não emite result. No teto o re-exec sai com keepRunning e o turno volta pelo spool e --resume.`);
    }
  }

  // Turnos por runner (última hora).
  for (const agg of aggregateTurns("runner", now - 60 * MIN)) {
    const decididos = agg.completed + agg.failures;
    if (decididos >= 3 && agg.failures / decididos >= 0.3) {
      const reasons = Object.entries(agg.endReasons).filter(([k]) => k !== "completed").map(([k, v]) => `${k} ${v}`).join(", ");
      add("warn", "turnos", `Runner ${agg.key}: ${agg.failures}/${decididos} turnos da última hora falharam`, reasons);
    }
    if (agg.firstEvent.p50 != null && agg.firstEvent.p50 >= 60_000) {
      add("info", "turnos", `Runner ${agg.key}: 1º evento demora ${fmtMs(agg.firstEvent.p50)} (p50)`, "Latência de arranque/provedor antes de qualquer saída.");
    }
    if (agg.gateWait.p95 != null && agg.gateWait.p95 >= 30_000) {
      add("warn", "turnos", `Runner ${agg.key}: espera no turn-gate p95 ${fmtMs(agg.gateWait.p95)}`, "Turnos parados na fila do gate antes de começar.");
    }
  }

  // Prioridade de escalonamento (macOS): LaunchAgent com ProcessType=Background
  // prende o daemon E todos os filhos (CLIs, MCPs, tools, builds) no teto de
  // prioridade de background — CPU e I/O estrangulados, fome sob carga.
  const selfRow = input.proc?.self;
  if (platform === "darwin" && selfRow && selfRow.pri <= 4) {
    const throttled = Object.entries(input.proc?.priCounts ?? {}).filter(([p]) => Number(p) <= 4).reduce((a, [, n]) => a + n, 0);
    const sysLoad = input.system as { load?: number[]; cpus?: number };
    add("crit", "prioridade", `Daemon em prioridade de BACKGROUND do macOS (pri ${selfRow.pri}) — ${throttled} processo(s) de runner herdaram`,
      `O LaunchAgent usa ProcessType=Background: o launchd aplica o clamp de QoS de background, herdado por TODO filho (claude/codex/grok, MCPs, bash das tools, builds e testes). CPU e I/O ficam estrangulados; com load ${sysLoad.load?.[0] ?? "?"} em ${sysLoad.cpus ?? "?"} CPUs eles esperam o escalonador. Referência nesta máquina: apps/terminal pri 31, LaunchAgents Standard pri 20.`,
      "Trocar ProcessType para Interactive (ou Standard) no plist do LaunchAgent (daemon/scripts/com.the-dudes.daemon.plist.template) e recarregar o agente do perfil.");
  } else if (platform === "darwin" && selfRow && selfRow.pri < 31) {
    add("info", "prioridade", `Daemon com prioridade de escalonamento ${selfRow.pri} (apps/terminal: 31)`, "LaunchAgent Standard aplica limites leves de CPU/I/O.");
  }

  // Host e processo.
  const sys = input.system as { loadPerCpu?: number | null; cpus?: number; load?: number[]; hostMemory?: Record<string, number | null> | null };
  if (sys.loadPerCpu != null && sys.loadPerCpu >= 1.2) {
    add(sys.loadPerCpu >= 2 ? "crit" : "warn", "host", `Host saturado: load ${sys.load?.[0]} em ${sys.cpus} CPUs (${sys.loadPerCpu}/CPU)`, "Os CLIs competem por CPU com o resto da máquina — veja Processos → top do host.");
  }
  const hm = sys.hostMemory;
  if (hm && hm.swapTotalMb && hm.swapUsedMb != null && hm.swapUsedMb / hm.swapTotalMb >= 0.8) {
    add("warn", "host", `Swap em ${Math.round((hm.swapUsedMb / hm.swapTotalMb) * 100)}% (${hm.swapUsedMb}/${hm.swapTotalMb} MB)`, "Paginação congela processos (medido antes: turnos travados a 0% CPU).");
  }
  if (hm && hm.freePct != null && hm.freePct < 10) add("crit", "host", `Memória livre do host em ${hm.freePct}%`, "");
  const pr = input.process as { cpuPct?: number; memory?: { rssMb?: number }; heap?: { usedPct?: number; detachedContexts?: number } };
  if ((pr.cpuPct ?? 0) >= 80) add("warn", "daemon", `Processo do daemon a ${pr.cpuPct}% de CPU`, "O thread principal está ocupado — rode um CPU profile.");
  if ((pr.memory?.rssMb ?? 0) >= 1500) add("warn", "daemon", `RSS do daemon em ${pr.memory?.rssMb} MB`, "");
  if ((pr.heap?.usedPct ?? 0) >= 80) add("crit", "daemon", `Heap V8 em ${pr.heap?.usedPct}% do limite`, "GC vai dominar; risco de OOM.");
  const gc = gcSnapshot();
  const major = gc.byKind.find((k) => k.kind === "major");
  if (major && major.maxMs >= 300) add("warn", "daemon", `GC major chegou a ${fmtMs(major.maxMs)}`, "");

  // WS.
  const ws = input.ws as { readyState?: number | null; bufferedAmount?: number; outboundQueued?: number; lastPongAgoMs?: number | null };
  if (ws.readyState !== 1) add("crit", "ws", "WebSocket com o orchestrator NÃO está aberto", "Mensagens de/para agentes ficam retidas até reconectar.");
  if ((ws.bufferedAmount ?? 0) >= 1_000_000) add("warn", "ws", `WS com ${Math.round((ws.bufferedAmount ?? 0) / 1024)} KB presos no buffer de saída`, "Rede lenta ou server não consumindo.");
  if ((ws.outboundQueued ?? 0) > 0) add("warn", "ws", `${ws.outboundQueued} mensagem(ns) críticas na fila de reenvio`, "");
  const wss = wsSnapshot() as { rtt?: { p95?: number | null }; events?: Array<{ ts: number; kind: string }> };
  if ((wss.rtt?.p95 ?? 0) >= 1000) add("warn", "ws", `RTT do WS p95 ${fmtMs(wss.rtt?.p95)}`, "");
  const closes = (wss.events ?? []).filter((e) => e.kind === "close" && now - e.ts < 15 * MIN).length;
  if (closes >= 3) add("warn", "ws", `${closes} quedas do WS nos últimos 15 min`, "");

  // Relay do bridge (tools MCP dos agentes).
  const relay = relaySnapshot(0) as { byOp?: Array<{ op: string; count: number; errors: number; total: { p95: number | null }; peer: { mean: number | null; max: number | null } }> };
  for (const op of relay.byOp ?? []) {
    if (op.count >= 3 && op.total.p95 != null && op.total.p95 >= 5000) add("warn", "relay", `Tool MCP "${op.op}" lenta: p95 ${fmtMs(op.total.p95)} (${op.count} chamadas)`, "Latência do orchestrator/rede vista pelo agente.");
    if (op.count >= 5 && op.errors / op.count >= 0.1) add("warn", "relay", `Tool MCP "${op.op}": ${op.errors}/${op.count} com erro`, "");
    if ((op.peer.max ?? 0) >= 500) add("warn", "relay", `Resolução de peer-pid chegou a ${fmtMs(op.peer.max)} em "${op.op}" (média ${fmtMs(op.peer.mean)})`, "perl + ps por hop (assíncrono desde o T-815): não para o loop, mas atrasa a tool MCP a cada conexão nova do bridge.");
  }

  // Processos.
  if (input.proc && input.proc.hotOrphans.length > 0) {
    const hot = input.proc.hotOrphans;
    const cpu = hot.reduce((a, o) => a + (o.cpuPct ?? o.psCpu), 0);
    const groups = new Map<string, number>();
    for (const o of hot) {
      const k = o.command.split(/\s+/).slice(0, 2).join(" ").slice(0, 60);
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${n}× ${k}`).join(" · ");
    add(cpu >= 100 ? "crit" : "warn", "processos", `${hot.length} processo(s) órfão(s) fora do daemon queimando ${Math.round(cpu)}% de CPU há mais de 1h`,
      `${top}. Somam ${hot.filter((o) => o.stat.startsWith("R")).length} ao load average (estado R). Veja Processos → órfãos quentes.`,
      `Conferir na tabela e encerrar: ${input.proc.hotKill.slice(0, 6).join("; ")} (kill de grupo só quando o grupo inteiro é órfão).`);
  }
  if (input.proc) {
    if (input.proc.orphans.length > 0) {
      const cpu = input.proc.orphans.reduce((a, o) => a + (o.cpuPct ?? 0), 0);
      add(cpu >= 20 ? "warn" : "info", "processos", `${input.proc.orphans.length} processo(s) de runner/bridge órfão(s) no host`, `CPU somada ${Math.round(cpu)}%. Veja Processos → órfãos.`);
    }
    if (input.proc.error) add("info", "processos", "Amostra do ps falhou", input.proc.error);
  }
  const sp = spawnsSnapshot(200);
  const spawnErrs = sp.recent.filter((r) => r.error && now - r.startedAt < 15 * MIN);
  if (spawnErrs.length > 0) add("warn", "processos", `${spawnErrs.length} spawn(s) falharam nos últimos 15 min`, spawnErrs.slice(-3).map((r) => `${r.cmd}: ${r.error}`).join(" · "));

  const errs = queryLogs({ level: "error", limit: 200 }).lines.filter((l) => now - l.ts < 5 * MIN);
  if (errs.length > 0) add("info", "logs", `${errs.length} erro(s) no log nos últimos 5 min`, errs.at(-1)?.msg.slice(0, 200) ?? "");

  // ── Histórico do log do perfil (sobrevive aos re-execs) ──
  const h = input.history;
  if (h) {
    const d1 = h.windows["24h"];
    const d7 = h.windows["7d"];
    const fmtList = (xs: Array<{ agent: string; n: number }>, k = 4) => xs.slice(0, k).map((x) => `${x.agent} ${x.n}`).join(", ");
    const drops7 = d7.queueFullDrops.reduce((a, x) => a + x.n, 0);
    if (drops7 > 0) {
      add("crit", "fila", `${drops7} mensagem(ns) DESCARTADA(S) por fila cheia do agente em 7 dias`, `Por agente: ${fmtList(d7.queueFullDrops)}. A fila por agente tem teto de 20 (MAX_BUFFERED_MESSAGES). Desde o T-818 o excedente é agrupado na última da fila; só descarta acima de 64 KiB agrupados (flood), com aviso no chat. Descartes anteriores ao T-818 foram silenciosos.`,
        "Se continuar aparecendo depois do T-818, é flood: ver quem manda tanto para o agente (loop agent↔agent, notificações em massa).", "7d");
    }
    const days = Math.max(1, Object.keys(h.reexecsByDay).length);
    if (d7.reexecs >= 14) {
      add("warn", "reinícios", `${d7.reexecs} re-execs por self-update em 7 dias (~${Math.round(d7.reexecs / days)}/dia)`, `Cada re-exec derruba todos os CLIs do perfil: boot do claude ~50s com MCPs, backlog do spool drenado em série, sessões grok retomadas. ${d7.releases} troca(s) de release vistas.`,
        "O deploy publica um daemon novo mesmo sem mudança no daemon (DAEMON_BUILD_TS muda o sha a cada build). Publicar o daemon/dist só quando daemon/ ou packages/ mudarem.", "7d");
    }
    if (d1.launcherExits > 0) add("info", "reinícios", `${d1.launcherExits} parada(s) do daemon por SIGTERM/kill nas últimas 24h`, "O launcher saiu com código ≠ 42 (restart manual/reinstalação): agentes anunciados como parados e religados pelo server.", undefined, "24h");
    const ha = (ts: number | null | undefined) => (ts ? `há ${fmtMs(now - ts)}` : "–");
    for (const r of d1.byRunner) {
      if (r.count >= 5 && r.okPct < 70) {
        const motivos = Object.entries(r.endReasons).filter(([k]) => k !== "completed").map(([k, n]) => `${k} ${n}`).join(", ");
        const rc = r.recent3h;
        const parou = rc.count >= 3 && rc.completed / rc.count >= 0.9;
        add(parou ? "info" : r.okPct < 40 ? "crit" : "warn", "runner",
          `Runner ${r.key}: só ${r.okPct}% dos ${r.count} turnos completaram nas últimas 24h${parou ? ` — PAROU: últimas 3h ${rc.completed}/${rc.count} ok` : ""}`,
          `Motivos: ${motivos}. Duração p50 ${fmtMs(r.duration.p50)}. Última falha ${ha(r.lastProblemTs)}; últimas 3h: ${rc.completed}/${rc.count} ok.`, undefined, "24h");
      }
      if (r.count >= 5 && r.firstEvent.p50 != null && r.firstEvent.p50 >= 20_000) {
        add("info", "runner", `Runner ${r.key}: 1º evento p50 ${fmtMs(r.firstEvent.p50)} (p95 ${fmtMs(r.firstEvent.p95)}) nas últimas 24h`, "Tempo até a primeira saída semântica (arranque do CLI + provedor/modelo).", undefined, "24h");
      }
    }
    const pat = new Map(d1.patterns.map((p) => [p.id, p]));
    const p = (id: string) => pat.get(id);
    if (p("dsh-sem-chave")) add("warn", "config", `dsh sem chave de API: ${p("dsh-sem-chave")!.n} turno(s) falharam em 24h (última ${ha(p("dsh-sem-chave")!.last)})`, p("dsh-sem-chave")!.sample, "Configurar a chave da rota deepseek (DEEPSEEK_API_KEY) para o dsh do perfil, ou trocar o runner desses agentes.", "24h");
    if (p("opencode-teto-post")) add("info", "runner", `opencode: ${p("opencode-teto-post")!.n} tentativa(s) de turno falharam com "teto de 30min do POST" em 24h (última ${ha(p("opencode-teto-post")!.last)})`, "Com duração ~5s é o socket do serve caindo (T-796, corrigido na 685c22c0), não o teto real; com ~30min é turno longo abortado.", undefined, "24h");
    if ((p("summarize-timeout")?.n ?? 0) >= 5) add("warn", "summarizer", `${p("summarize-timeout")!.n} resumos (summarize) estouraram o timeout em 24h`, "Ocupam o pool bg do turn-gate até o timeout.", undefined, "24h");
    if ((p("codex-processo-morto")?.n ?? 0) + (p("grok-close-nao-veio")?.n ?? 0) >= 3) add("warn", "runner", `${(p("codex-processo-morto")?.n ?? 0) + (p("grok-close-nao-veio")?.n ?? 0)} turno(s) com processo do CLI morto/zumbi em 24h`, "codex: processo morreu com busy; grok: close não veio após SIGKILL.", undefined, "24h");
    for (const a of d1.hardRecoversByAgent.filter((x) => x.n >= 5).slice(0, 4)) {
      const motivos = d1.hardRecovers.filter((x) => x.agent === a.agent).slice(0, 2).map((x) => `${x.reason} (${x.n})`).join("; ");
      add("warn", "hang", `${a.agent}: ${a.n} hard recovers nas últimas 24h`, motivos, undefined, "24h");
    }
    if (d1.turns >= 20 && d1.queueWait10m >= 5) {
      const top = d1.byAgent.filter((x) => x.queueWait10m > 0).sort((x, y) => y.queueWait10m - x.queueWait10m).slice(0, 4).map((x) => `${x.key} ${x.queueWait10m} (fila p95 ${fmtMs(x.queue.p95)})`).join(", ");
      add("warn", "fila", `${d1.queueWait10m} de ${d1.turns} turnos esperaram ≥10min na fila do próprio agente (24h)`, `O agente processa uma mensagem por vez; turnos longos represam as seguintes. Mais afetados: ${top}.`,
        "Olhar a duração dos turnos desses agentes (Histórico → por agente) e o volume de mensagens que recebem.", "24h");
    }
    const forced = d1.gateForced.reduce((a, g) => a + g.n, 0);
    if (forced > 0) add("warn", "gate", `${forced} slot(s) do turn-gate liberado(s) à força pelo anti-deadlock em 24h`, `Por turno: ${d1.gateForced.slice(0, 4).map((g) => `${g.label} ${g.n}`).join(", ")}. O anti-deadlock solta o slot aos 70min (TURN_GATE_MAX_HOLD_MS), mas o turno do opencode pode durar até 120min (T-776): o gate passa a admitir mais turnos simultâneos que o máximo configurado.`,
      "Alinhar os tetos: TURN_GATE_MAX_HOLD_MS acima de OPENCODE_POST_CAP_MS (ou o opencode renovar o slot enquanto houver progresso).", "24h");
    const inflados = d1.toolsInflated.filter((t) => t.max >= 20);
    if (inflados.length) add("warn", "hang", `Contador de tools em voo inflado em ${inflados.length} agente(s) (até ${inflados[0]!.max}) nas últimas 24h`, `${inflados.slice(0, 5).map((t) => `${t.agent} ${t.max}`).join(", ")}. Com tool "em voo" o watchdog de hang fica suprimido até o teto absoluto (~10min): turno travado demora a ser detectado.`,
      "O contador soma tool_call e não desconta o resultado em alguns runners (mesma classe do T-795 no OpenCode); zerar por turno e descontar no tool_result.", "24h");
    if (d7.stdinNotAccepted >= 3) add("info", "claude", `${d7.stdinNotAccepted} mensagem(ns) não aceitas pelo stdin do claude em 7 dias`, "O watchdog (T-758) reinicia o claude aos 90s; costuma acontecer logo após restart, com o CLI ainda subindo os MCPs.", undefined, "7d");
    if (d7.stateLost >= 20) add("info", "ws", `${d7.stateLost} mensagem(ns) de estado (running/state/usage/context) perdidas com o WS fora em 7 dias`, "Não entram na fila de reenvio: a UI pode mostrar estado velho até o próximo evento do agente.", undefined, "7d");
    if ((p("handshake-orchestrator")?.n ?? 0) >= 10) add("info", "ws", `${p("handshake-orchestrator")!.n} falhas de handshake com o orchestrator em 24h`, "Server fora (deploy/restart) ou rede; os agentes ficam sem canal enquanto isso.", undefined, "24h");
  }

  const order = { crit: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/* ───────────────────────────── diagnóstico sob demanda ───────────────────────────── */

let profiling = false;

function diagDir(home: string): string {
  const dir = path.join(home, "diag");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

interface CpuProfile {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }>;
  samples?: number[];
  timeDeltas?: number[];
  startTime: number;
  endTime: number;
}

/** Top funções por self-time — dá a resposta sem abrir o DevTools. */
export function summarizeCpuProfile(profile: CpuProfile, top = 40): Array<{ fn: string; where: string; selfMs: number; pct: number }> {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const d = deltas[i + 1] ?? deltas[i] ?? 0;
    self.set(samples[i]!, (self.get(samples[i]!) ?? 0) + d);
  }
  const agg = new Map<string, { fn: string; where: string; us: number }>();
  let total = 0;
  for (const [id, us] of self) {
    const n = byId.get(id);
    if (!n) continue;
    total += us;
    const fn = n.callFrame.functionName || "(anônima)";
    const file = n.callFrame.url ? n.callFrame.url.slice(n.callFrame.url.lastIndexOf("/") + 1) : "";
    const where = file ? `${file}:${n.callFrame.lineNumber + 1}` : "";
    const k = `${fn}@${where}`;
    const v = agg.get(k) ?? { fn, where, us: 0 };
    v.us += us;
    agg.set(k, v);
  }
  return [...agg.values()]
    .sort((a, b) => b.us - a.us)
    .slice(0, top)
    .map((v) => ({ fn: v.fn, where: v.where, selfMs: Math.round(v.us / 100) / 10, pct: total ? Math.round((v.us / total) * 1000) / 10 : 0 }));
}

async function cpuProfile(home: string, seconds: number): Promise<Record<string, unknown>> {
  if (profiling) throw new Error("já existe um CPU profile em andamento");
  profiling = true;
  const session = new inspector.Session();
  session.connect();
  const post = <T = unknown>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => session.post(method, params, (err, res) => (err ? reject(err) : resolve(res as T))));
  try {
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 500 });
    await post("Profiler.start");
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const { profile } = await post<{ profile: CpuProfile }>("Profiler.stop");
    await post("Profiler.disable");
    const name = `cpu-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`;
    const file = path.join(diagDir(home), name);
    await fs.promises.writeFile(file, JSON.stringify(profile), { mode: 0o600 });
    return { file, name, seconds, samples: profile.samples?.length ?? 0, top: summarizeCpuProfile(profile) };
  } finally {
    try { session.disconnect(); } catch { /* */ }
    profiling = false;
  }
}

function sanitizedReport(): Record<string, unknown> {
  const rep = (process.report?.getReport?.() ?? {}) as Record<string, unknown>;
  const clone = JSON.parse(JSON.stringify(rep)) as Record<string, any>;
  // Ambiente leva THE_DUDES_DAEMON_TOKEN, chaves de API etc. — fora, sempre.
  delete clone.environmentVariables;
  delete clone.sharedObjects;
  if (clone.header) {
    delete clone.header.commandLine;
    delete clone.header.networkInterfaces;
  }
  return clone;
}

/* ───────────────────────────── env (redatado) ───────────────────────────── */

const SECRET_KEY_RE = /TOKEN|KEY|SECRET|PASS|DSN|AUTH|COOKIE|CREDENTIAL|PRIVATE/i;
const ENV_PREFIX_RE = /^(THE_DUDES_|DUDES_|QWEN_|GROK_|TYPESAFE_|SENTRY_|OPENCODE_|CLAUDE_|CODEX_|GEMINI_|NODE_|UV_THREADPOOL)/;

export function redactedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (!ENV_PREFIX_RE.test(k) && !["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TZ"].includes(k)) continue;
    out[k] = SECRET_KEY_RE.test(k) ? `[REDACTED · ${v.length} chars]` : v;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/* ───────────────────────────── start ───────────────────────────── */

export async function startDebugDashboard(deps: DashboardDeps): Promise<DashboardHandle | null> {
  if (process.env.THE_DUDES_DEBUG_HTTP === "0") return null;
  const home = profileHome();
  const cfg = loadConfig(home);
  const sampler = new ProcSampler({ spawnOwners: liveSpawnAgents });
  sampler.start();
  void refreshHostMemory();
  const memTimer = setInterval(() => { void refreshHostMemory(); }, 30_000);
  memTimer.unref?.();
  const seriesTimer = startSeriesSampler(deps, sampler);
  const sseClients = new Set<() => void>();
  let history: HistorySummary | null = null;
  let historyRunning: Promise<HistorySummary | null> | null = null;
  const refreshHistory = (): Promise<HistorySummary | null> => {
    if (historyRunning) return historyRunning;
    historyRunning = analyzeHistory(historyLogFiles(home))
      .then((hs) => { history = hs; return hs; })
      .catch((e) => { deps.log("warn", `[debug-http] histórico do log falhou: ${(e as Error).message}`); return history; })
      .finally(() => { historyRunning = null; });
    return historyRunning;
  };
  // Depois do boot (não disputa com o arranque dos agentes) e a cada 10 min.
  const historyFirst = setTimeout(() => { void refreshHistory(); }, 20_000);
  historyFirst.unref?.();
  const historyTimer = setInterval(() => { void refreshHistory(); }, 10 * 60_000);
  historyTimer.unref?.();

  const overview = () => {
    const agents = deps.agents();
    const gate = deps.gate();
    const host = deps.hostState();
    const ws = { ...deps.wsLive(), ...(wsSnapshot() as Record<string, unknown>), rttSeries: undefined, events: undefined, inbound: undefined, outbound: undefined };
    const proc = sampler.latestSample();
    const pinfo = processInfo();
    const sys = systemInfo();
    const turnAgg = aggregateTurns("agentId", Date.now() - 60 * MIN);
    const turnByAgent = new Map(turnAgg.map((t) => [t.key, t]));
    const cpuByAgent = new Map((proc?.byAgent ?? []).map((a) => [a.agentId, a]));
    return {
      now: Date.now(),
      identity: deps.identity(),
      health: deps.health(),
      process: pinfo,
      system: sys,
      loop: lastLoop,
      gate,
      agents: agents.map((a) => ({ ...a, turns1h: turnByAgent.get(String(a.agentId)) ?? null, procs: cpuByAgent.get(String(a.agentId)) ?? null })),
      liveTurns: liveTurnsSnapshot(),
      host,
      ws,
      relay: { ...deps.relayLive(), ...(relaySnapshot(0) as Record<string, unknown>), recent: undefined },
      procs: proc ? { ts: proc.ts, tookMs: proc.tookMs, error: proc.error, hostProcs: proc.hostProcs, totals: proc.totals, byAgent: proc.byAgent, orphans: proc.orphans.length, hotOrphans: proc.hotOrphans.length, self: proc.self, priCounts: proc.priCounts } : null,
      logs: queryLogs({ limit: 1 }).counts,
      stalls5m: stallsSnapshot(400).recent.filter((s) => Date.now() - s.ts < 5 * MIN).length,
      cliCapture: cliCaptureEnabled(),
      alerts: diagnose({ agents, gate, loop: lastLoop, proc, ws, process: pinfo, system: sys, history, host }),
      historyAt: history?.generatedAt ?? null,
      point: timeSeries(1)[0] ?? null,
    };
  };

  const intParam = (url: URL, name: string, def: number, min: number, max: number) => {
    const n = Number(url.searchParams.get(name));
    return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : def;
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/overview", handler: () => overview() },
    { method: "GET", path: "/api/series", handler: ({ url }) => ({ points: timeSeries(intParam(url, "limit", 720, 1, 1440)) }) },
    {
      method: "GET", path: "/api/turns", handler: ({ url }) => {
        const agentId = url.searchParams.get("agent") || undefined;
        const runner = url.searchParams.get("runner") || undefined;
        const windowMin = intParam(url, "windowMin", 60, 1, 24 * 60);
        const since = Date.now() - windowMin * MIN;
        return {
          windowMin,
          byRunner: aggregateTurns("runner", since),
          byAgent: aggregateTurns("agentId", since),
          recent: recentTurns({ agentId, runner, limit: intParam(url, "limit", 400, 1, 3000) }),
          live: liveTurnsSnapshot(),
        };
      },
    },
    {
      method: "GET", path: "/api/procs", handler: async ({ url }) => {
        if (url.searchParams.get("fresh") === "1") return await sampler.sample();
        return sampler.latestSample() ?? await sampler.sample();
      },
    },
    { method: "GET", path: "/api/spawns", handler: ({ url }) => spawnsSnapshot(intParam(url, "limit", 300, 1, 1500)) },
    { method: "GET", path: "/api/loop", handler: () => ({ loop: lastLoop, stalls: stallsSnapshot(300), sync: syncOpsSnapshot(400), gc: gcSnapshot() }) },
    { method: "GET", path: "/api/relay", handler: ({ url }) => ({ ...deps.relayLive(), ...relaySnapshot(intParam(url, "limit", 400, 1, 2000)) }) },
    { method: "GET", path: "/api/ws", handler: () => ({ ...deps.wsLive(), ...wsSnapshot() }) },
    {
      method: "GET", path: "/api/events", handler: ({ url }) => agentEventsSnapshot({
        agentId: url.searchParams.get("agent") || undefined,
        kinds: url.searchParams.get("kinds")?.split(",").filter(Boolean),
        limit: intParam(url, "limit", 500, 1, 3000),
      }),
    },
    {
      method: "GET", path: "/api/logs", handler: ({ url }) => queryLogs({
        sinceSeq: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
        level: (url.searchParams.get("level") || undefined) as DebugLevel | "issues" | undefined,
        q: url.searchParams.get("q") || undefined,
        limit: intParam(url, "limit", 800, 1, 5000),
      }),
    },
    {
      method: "GET", path: "/api/logs/stream", handler: ({ req, res, url }) => {
        if (sseClients.size >= 8) { sendJson(res, 429, { error: "muitos streams abertos" }); return undefined; }
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
        const since = Number(url.searchParams.get("since") ?? NaN);
        if (Number.isFinite(since)) {
          for (const l of queryLogs({ sinceSeq: since, limit: 2000 }).lines) res.write(`id: ${l.seq}\ndata: ${JSON.stringify(l)}\n\n`);
        }
        const off = onDebugLog((l) => { res.write(`id: ${l.seq}\ndata: ${JSON.stringify(l)}\n\n`); });
        const ka = setInterval(() => { res.write(": ka\n\n"); }, 15_000);
        ka.unref?.();
        const close = () => { off(); clearInterval(ka); sseClients.delete(close); try { res.end(); } catch { /* */ } };
        sseClients.add(close);
        req.on("close", close);
        return undefined;
      },
    },
    { method: "GET", path: "/api/config", handler: () => ({ identity: deps.identity(), runners: deps.runners(), env: redactedEnv(), health: deps.health() }) },
    { method: "GET", path: "/api/history", handler: () => ({ history, running: !!historyRunning }) },
    { method: "POST", path: "/api/history/refresh", handler: async () => ({ history: await refreshHistory() }) },
    { method: "GET", path: "/api/cli-capture", handler: ({ url }) => ({ on: cliCaptureEnabled(), lines: cliCaptureSnapshot({ agentId: url.searchParams.get("agent") || undefined, limit: intParam(url, "limit", 400, 1, 1500) }) }) },
    {
      method: "POST", path: "/api/cli-capture", handler: async ({ body }) => {
        const b = await body();
        setCliCapture(b.on === true);
        deps.log("warn", `[debug-http] captura de I/O dos CLIs ${b.on === true ? "LIGADA (plaintext só em memória, loopback)" : "desligada"}`);
        return { on: cliCaptureEnabled() };
      },
    },
    {
      method: "POST", path: "/api/diag/cpu-profile", handler: async ({ url }) => {
        const seconds = intParam(url, "seconds", 10, 1, 120);
        deps.log("info", `[debug-http] CPU profile de ${seconds}s iniciado`);
        return await cpuProfile(home, seconds);
      },
    },
    {
      method: "POST", path: "/api/diag/heap-snapshot", handler: () => {
        const name = `heap-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`;
        const file = path.join(diagDir(home), name);
        const t0 = performance.now();
        deps.log("warn", "[debug-http] heap snapshot iniciado (bloqueia o daemon enquanto escreve)");
        v8.writeHeapSnapshot(file);
        try { fs.chmodSync(file, 0o600); } catch { /* */ }
        const ms = Math.round(performance.now() - t0);
        return { file, name, ms, bytes: fs.statSync(file).size };
      },
    },
    { method: "GET", path: "/api/diag/report", handler: () => sanitizedReport() },
    {
      method: "GET", path: "/api/diag/file", handler: ({ url, res }) => {
        const name = url.searchParams.get("name") ?? "";
        if (!/^(cpu|heap)-[\w.-]+\.(cpuprofile|heapsnapshot)$/.test(name)) { sendJson(res, 400, { error: "nome inválido" }); return undefined; }
        const file = path.join(diagDir(home), name);
        if (!fs.existsSync(file)) { sendJson(res, 404, { error: "arquivo não existe" }); return undefined; }
        res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
        fs.createReadStream(file).pipe(res);
        return undefined;
      },
    },
    {
      method: "GET", path: "/api/export", handler: ({ res }) => {
        const dump = {
          exportedAt: new Date().toISOString(),
          overview: overview(),
          series: timeSeries(1440),
          turns: { byRunner: aggregateTurns("runner"), byAgent: aggregateTurns("agentId"), recent: recentTurns({ limit: 3000 }), live: liveTurnsSnapshot() },
          procs: sampler.latestSample(),
          spawns: spawnsSnapshot(1500),
          loop: { stalls: stallsSnapshot(400), sync: syncOpsSnapshot(800), gc: gcSnapshot() },
          relay: relaySnapshot(2000),
          ws: wsSnapshot(),
          events: agentEventsSnapshot({ limit: 3000 }),
          history,
          logs: queryLogs({ limit: 5000 }),
          config: { runners: deps.runners(), env: redactedEnv() },
        };
        const body = JSON.stringify(dump);
        const name = `daemon-debug-${String(deps.identity().name ?? "daemon").replace(/[^\w.-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "Content-Length": String(Buffer.byteLength(body)) });
        res.end(body);
        return undefined;
      },
    },
  ];

  try {
    const handle = await startDebugHttpServer({
      port: cfg.port,
      portScan: 20,
      token: cfg.token,
      routes,
      html: (nonce) => dashboardHtml(nonce),
      log: deps.log,
      onRequest: () => sampler.wanted(),
    });
    saveConfig(home, { token: cfg.token, port: handle.port }, handle.url);
    deps.log("info", `[debug-http] dashboard de debug em ${handle.url} — URL com token em ${path.join(home, "debug-dashboard.url")}`);
    return {
      url: handle.url,
      port: handle.port,
      stop: () => {
        for (const close of [...sseClients]) close();
        handle.stop();
        sampler.stop();
        clearInterval(seriesTimer);
        clearInterval(memTimer);
        clearTimeout(historyFirst);
        clearInterval(historyTimer);
      },
    };
  } catch (e) {
    sampler.stop();
    clearInterval(seriesTimer);
    clearInterval(memTimer);
    clearTimeout(historyFirst);
    clearInterval(historyTimer);
    deps.log("warn", `[debug-http] dashboard não subiu: ${(e as Error).message}`);
    return null;
  }
}
