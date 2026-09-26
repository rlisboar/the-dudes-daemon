/**
 * T-812: sondas de runtime do dashboard de debug.
 *
 *  - Sonda de chamadas SÍNCRONAS: embrulha spawnSync/execFileSync/execSync
 *    (sempre registradas, com stack curta — cada uma bloqueia o loop inteiro)
 *    e as funções *Sync mais usadas do fs (agregado sempre; ring só acima de
 *    SLOW_FS_MS). O bundle CJS resolve `child_process.spawnSync` no objeto do
 *    módulo a CADA chamada (`(0, import_x.spawnSync)(…)`), então trocar a
 *    propriedade no boot alcança todos os call sites sem tocar em nenhum.
 *  - Event loop: histograma (monitorEventLoopDelay), ELU e detector de
 *    travamento por deriva de timer — cada travamento guarda as chamadas
 *    síncronas e os logs que caíram na janela.
 *  - GC: PerformanceObserver('gc') por tipo.
 *
 * Tudo é transparente: mesmos argumentos, mesmo `this`, mesmo retorno, mesmo
 * throw. Opt-out: THE_DUDES_DEBUG_PROBES=0.
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
type LoopHistogram = ReturnType<typeof monitorEventLoopDelay>;
import { recordGc, recordStall, recordSyncOp } from "./store.js";

/** fs *Sync abaixo disto só entra no agregado (não no ring). */
const SLOW_FS_MS = 15;
/** Travamento = timer de 100ms que atrasou mais que isto. */
const STALL_MIN_MS = 150;
const STALL_TICK_MS = 100;

let installed = false;

/** Stack curta do CHAMADOR: descarta "Error", o próprio shortStack e o
 *  embrulho (sempre os 2 primeiros frames, no bundle e no tsx). */
function shortStack(): string {
  const raw = new Error().stack ?? "";
  const frames = raw.split("\n").slice(3)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") && !l.includes("node:internal"))
    .slice(0, 5)
    .map((l) => l.replace(/^at /, "").replace(/\(?(?:file:\/\/)?[^()]*\/([^/()]+:\d+):\d+\)?$/, "($1)"));
  return frames.join(" ← ");
}

function describeProcessCall(fn: string, args: unknown[]): string {
  if (fn === "execSync") return String(args[0] ?? "").slice(0, 200);
  const file = String(args[0] ?? "");
  const argv = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [];
  const shown = argv.map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(" ");
  return `${file.slice(file.lastIndexOf("/") + 1)} ${shown}`.slice(0, 240);
}

function describeFsTarget(args: unknown[]): string {
  const a = args[0];
  if (typeof a === "string") return a.length > 160 ? `…${a.slice(-160)}` : a;
  if (typeof a === "number") return `fd:${a}`;
  if (a instanceof URL) return a.pathname;
  if (Buffer.isBuffer(a)) return "<buffer>";
  return typeof a;
}

type AnyFn = (...args: any[]) => any;

function wrapProcessFn(mod: Record<string, unknown>, fn: string): void {
  const orig = mod[fn] as AnyFn | undefined;
  if (typeof orig !== "function" || (orig as { __tdProbe?: boolean }).__tdProbe) return;
  const wrapped = function (this: unknown, ...args: any[]) {
    const t0 = performance.now();
    let status: number | null = null;
    let timedOut = false;
    try {
      const r = orig.apply(this, args);
      if (fn === "spawnSync" && r && typeof r === "object") {
        status = (r as { status?: number | null }).status ?? null;
        timedOut = (r as { error?: { code?: string } }).error?.code === "ETIMEDOUT";
      } else {
        status = 0;
      }
      return r;
    } catch (e) {
      status = (e as { status?: number }).status ?? -1;
      timedOut = (e as { code?: string }).code === "ETIMEDOUT";
      throw e;
    } finally {
      const end = performance.now();
      try {
        recordSyncOp({
          ts: Date.now(),
          endPerf: end,
          fn: `child_process.${fn}`,
          target: describeProcessCall(fn, args),
          ms: end - t0,
          status,
          timedOut,
          stack: shortStack(),
        }, true);
      } catch { /* observação nunca muda a execução */ }
    }
  };
  (wrapped as { __tdProbe?: boolean }).__tdProbe = true;
  mod[fn] = wrapped;
}

const FS_FNS = [
  "readFileSync", "writeFileSync", "appendFileSync", "readdirSync", "statSync", "lstatSync",
  "existsSync", "openSync", "readSync", "writeSync", "mkdirSync", "rmSync", "renameSync",
  "copyFileSync", "unlinkSync", "mkdtempSync", "chmodSync", "chownSync", "accessSync",
] as const;

function wrapFsFn(mod: Record<string, unknown>, fn: string): void {
  const orig = mod[fn] as AnyFn | undefined;
  if (typeof orig !== "function" || (orig as { __tdProbe?: boolean }).__tdProbe) return;
  const wrapped = function (this: unknown, ...args: any[]) {
    const t0 = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      const end = performance.now();
      const ms = end - t0;
      try {
        const slow = ms >= SLOW_FS_MS;
        recordSyncOp({
          ts: Date.now(),
          endPerf: end,
          fn: `fs.${fn}`,
          target: slow ? describeFsTarget(args) : "",
          ms,
          status: null,
          timedOut: false,
          stack: slow ? shortStack() : "",
        }, slow);
      } catch { /* observação nunca muda a execução */ }
    }
  };
  // Preserva propriedades anexas (ex.: realpathSync.native — não embrulhado, mas por via das dúvidas).
  for (const k of Object.keys(orig)) (wrapped as unknown as Record<string, unknown>)[k] = (orig as unknown as Record<string, unknown>)[k];
  (wrapped as { __tdProbe?: boolean }).__tdProbe = true;
  mod[fn] = wrapped;
}

/** Módulo CJS real (mutável) — o namespace ESM é congelado. */
function cjsModule(name: "child_process" | "fs"): Record<string, unknown> {
  const fallback = name === "fs" ? (fs as unknown as Record<string, unknown>) : (childProcess as unknown as Record<string, unknown>);
  try {
    // No bundle CJS `require` existe; no ESM (tsx/testes) cria-se um.
    const req = typeof require === "function" ? require : createRequire(process.cwd() + "/");
    return req(`node:${name}`) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

export function installSyncProbes(): boolean {
  if (installed || process.env.THE_DUDES_DEBUG_PROBES === "0") return installed;
  installed = true;
  try {
    const cp = cjsModule("child_process");
    for (const fn of ["spawnSync", "execFileSync", "execSync"]) wrapProcessFn(cp, fn);
    const fsMod = cjsModule("fs");
    for (const fn of FS_FNS) wrapFsFn(fsMod, fn);
    // ESM que importou nomes antes do patch passa a ver os embrulhados.
    syncBuiltinESMExports();
  } catch { /* sem sonda: o resto do dashboard segue */ }
  return installed;
}

/* ───────────────────────────── event loop ───────────────────────────── */

export interface LoopStats {
  /** Janela desde a última leitura (ms). */
  window: { p50: number; p90: number; p99: number; max: number; mean: number };
  /** Desde o boot (ms). */
  total: { p50: number; p99: number; max: number; mean: number; count: number };
  eluPct: number;
}

let hWindow: LoopHistogram | null = null;
let hTotal: LoopHistogram | null = null;
let lastElu: ReturnType<typeof performance.eventLoopUtilization> | null = null;
let stallTimer: NodeJS.Timeout | null = null;
let gcObserver: PerformanceObserver | null = null;

const LOOP_RES_MS = 10;
/** O histograma mede o intervalo ENTRE disparos do timer de `LOOP_RES_MS`
 *  (idle ≈ 10–11ms). O atraso real é o que passa disso. */
const ns = (v: number) => Math.max(0, Math.round((v / 1e6 - LOOP_RES_MS) * 10) / 10);

export function startLoopMonitor(): void {
  if (hWindow) return;
  try {
    hWindow = monitorEventLoopDelay({ resolution: LOOP_RES_MS });
    hWindow.enable();
    hTotal = monitorEventLoopDelay({ resolution: LOOP_RES_MS });
    hTotal.enable();
  } catch { hWindow = null; hTotal = null; }
  lastElu = performance.eventLoopUtilization();
  let last = performance.now();
  stallTimer = setInterval(() => {
    const now = performance.now();
    const blocked = now - last - STALL_TICK_MS;
    if (blocked >= STALL_MIN_MS) {
      try { recordStall(blocked, last, now); } catch { /* */ }
    }
    last = now;
  }, STALL_TICK_MS);
  stallTimer.unref?.();
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const kind = gcKind((e as unknown as { detail?: { kind?: number } }).detail?.kind);
        recordGc(kind, e.duration);
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  } catch { gcObserver = null; }
}

function gcKind(k: number | undefined): string {
  switch (k) {
    case 1: return "minor";
    case 2: return "major";
    case 4: return "incremental";
    case 8: return "weakcb";
    case 15: return "all";
    default: return `kind-${k ?? "?"}`;
  }
}

/** Lê e ZERA a janela do histograma (chamar 1× por amostra da série). */
export function readLoopStats(): LoopStats {
  const w = hWindow;
  const t = hTotal;
  const elu = performance.eventLoopUtilization(lastElu ?? undefined);
  lastElu = performance.eventLoopUtilization();
  const safe = (h: LoopHistogram | null, f: (h: LoopHistogram) => number) => {
    try { return h && h.count > 0 ? ns(f(h)) : 0; } catch { return 0; }
  };
  const out: LoopStats = {
    window: {
      p50: safe(w, (h) => h.percentile(50)),
      p90: safe(w, (h) => h.percentile(90)),
      p99: safe(w, (h) => h.percentile(99)),
      max: safe(w, (h) => h.max),
      mean: safe(w, (h) => h.mean),
    },
    total: {
      p50: safe(t, (h) => h.percentile(50)),
      p99: safe(t, (h) => h.percentile(99)),
      max: safe(t, (h) => h.max),
      mean: safe(t, (h) => h.mean),
      count: t?.count ?? 0,
    },
    eluPct: Math.round(elu.utilization * 1000) / 10,
  };
  try { w?.reset(); } catch { /* */ }
  return out;
}

export function stopLoopMonitor(): void {
  try { hWindow?.disable(); hTotal?.disable(); } catch { /* */ }
  hWindow = null; hTotal = null;
  if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
  try { gcObserver?.disconnect(); } catch { /* */ }
  gcObserver = null;
}
