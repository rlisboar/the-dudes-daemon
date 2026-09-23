/**
 * T-812: amostrador ASSÍNCRONO de processos para o dashboard.
 *
 * `ps -axo` neste host custa ~300ms (855 processos, load ~25 em 18 cpus) —
 * o suite-park faz o mesmo com spawnSync e bloqueia o loop. Aqui é execFile
 * (loop livre), uma amostra em voo por vez, e o ritmo cai quando ninguém está
 * olhando o dashboard.
 *
 * Da tabela inteira sai:
 *  - a árvore de descendentes do daemon (CLIs, MCPs, tools, bash dos agentes)
 *    com CPU% por DELTA de tempo de CPU entre amostras (o %cpu do ps no macOS
 *    é média decadente), RSS, estado, idade e o agente dono do galho;
 *  - órfãos suspeitos: processos de runner/bridge adotados pelo launchd (ppid 1);
 *  - top de CPU do host inteiro (a máquina saturada também é resposta).
 */

import { execFile } from "node:child_process";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { parsePsDuration } from "../suite-park.js";

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** nice (ni). */
  nice: number;
  /** Prioridade de escalonamento do ps (macOS: 31 = app/terminal, 20 =
   *  LaunchAgent Standard, 4 = BACKGROUND/throttled — MAXPRI_THROTTLE). */
  pri: number;
  stat: string;
  elapsedMs: number;
  cpuMs: number;
  /** %cpu reportado pelo ps (média decadente no macOS). */
  psCpu: number;
  rssKb: number;
  command: string;
}

export interface ProcNode extends PsRow {
  depth: number;
  /** CPU% por delta entre esta amostra e a anterior (null na 1ª). */
  cpuPct: number | null;
  agentId: string | null;
  /** Comando do filho direto do daemon que originou o galho. */
  branch: string;
}

export interface ProcSample {
  ts: number;
  tookMs: number;
  error: string | null;
  hostProcs: number;
  /** Linha do próprio daemon (prioridade/nice/CPU do processo principal). */
  self: (PsRow & { cpuPct: number | null }) | null;
  tree: ProcNode[];
  totals: { count: number; cpuPct: number | null; rssMb: number };
  /** Processos da árvore do daemon por prioridade do ps (pri → quantos). */
  priCounts: Record<string, number>;
  orphans: Array<PsRow & { cpuPct: number | null; why: string }>;
  /** Órfãos (ppid 1) FORA do daemon queimando CPU há ≥1h — geradores de carga
   *  e probes de teste esquecidos (medido: 18 `dd` a ~21% cada por 6 dias). */
  hotOrphans: Array<PsRow & { cpuPct: number | null }>;
  /** Comandos seguros para encerrar os órfãos quentes: kill de GRUPO só quando
   *  todos os membros do grupo são órfãos quentes; senão, kill por pid. */
  hotKill: string[];
  hostTop: Array<PsRow & { cpuPct: number | null; mine: boolean }>;
  byAgent: Array<{ agentId: string; procs: number; cpuPct: number | null; rssMb: number }>;
}

const PS_ARGS = ["-axo", "pid=,ppid=,pgid=,ni=,pri=,stat=,etime=,time=,%cpu=,rss=,command="];
const LINE_RE = /^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\d.,]+)\s+(\d+)\s+(.*)$/;

export function parsePsTable(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = LINE_RE.exec(t);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      nice: Number(m[4]),
      pri: Number(m[5]),
      stat: m[6]!,
      elapsedMs: parsePsDuration(m[7]!),
      cpuMs: parsePsDuration(m[8]!),
      psCpu: Number(m[9]!.replace(",", ".")) || 0,
      rssKb: Number(m[10]) || 0,
      command: m[11]!.length > 400 ? `${m[11]!.slice(0, 400)}…` : m[11]!,
    });
  }
  return rows;
}

/** Runners, bridge e ferramentas que o daemon lança — base do filtro de órfãos. */
const RUNNER_RE = /(^|\/|\s)(claude|codex|opencode|gemini|qwen|crush|grok|grok-custom|dsh|graphify|graphify-mcp)(\s|$)|mcp-bridge\.cjs|\/tmp\/t\d+-/;
/** Daemon e launcher de perfil vivem legitimamente sob o launchd/init. */
const NOT_ORPHAN_RE = /run-daemon\.sh|daemon\.cjs/;
/** Apps (bundles .app), serviços do sistema e do Homebrew têm ppid 1 por natureza. */
const LEGIT_SERVICE_RE = /\.app\/Contents\/|^\/(System|usr\/libexec|usr\/sbin|usr\/bin\/(?!perl|python)|sbin|Library)\/|\/Cellar\/[^/]+\/[^/]+\/(?:libexec|sbin)\//;
/** Ferramentas que testes/scripts de agente deixam órfãs (geradores de carga, probes, servidores de evidência). */
const TOOL_RE = /^(?:\S*\/)?(?:dd|node|nodejs|python[\d.]*|bash|sh|zsh|dash|perl|ruby|tsx|npm|npx|bun|deno|yes|stress(?:-ng)?|openssl|java|make)(?:\s|$)/;

/** Candidato a "órfão quente": ferramenta de dev/teste ou CLI de runner — nunca app ou serviço do sistema. */
export function isToolOrphanCandidate(command: string): boolean {
  if (NOT_ORPHAN_RE.test(command) || LEGIT_SERVICE_RE.test(command)) return false;
  return TOOL_RE.test(command.trim()) || RUNNER_RE.test(command);
}

interface Prev { cpuMs: number; elapsedMs: number; at: number }

export interface SamplerDeps {
  /** pid → dono (spawns vivos registrados pelo store). */
  spawnOwners: () => Map<number, { agentId: string | null; cmd: string }>;
  selfPid?: number;
  run?: () => Promise<string>;
}

export class ProcSampler {
  private prev = new Map<number, Prev>();
  private inflight: Promise<ProcSample> | null = null;
  private latest: ProcSample | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastWantedAt = 0;
  private stopped = false;

  constructor(private readonly deps: SamplerDeps) {}

  /** Chamado a cada request do dashboard: acelera o ritmo por 60s. */
  wanted(): void {
    this.lastWantedAt = Date.now();
  }

  latestSample(): ProcSample | null {
    return this.latest;
  }

  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      try { await this.sample(); } catch { /* sample já registra o erro */ }
      if (this.stopped) return;
      // Olhando o dashboard: 5s. Sem ninguém: 60s (só para a série/histórico).
      const active = Date.now() - this.lastWantedAt < 60_000;
      this.timer = setTimeout(loop, active ? 5_000 : 60_000);
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Amostra agora (ou devolve a que já está em voo). */
  sample(): Promise<ProcSample> {
    if (this.inflight) return this.inflight;
    const t0 = Date.now();
    const run = this.deps.run ?? runPsAsync;
    this.inflight = run()
      .then((text) => this.build(parsePsTable(text), t0, null))
      .catch((e) => this.build([], t0, (e as Error).message ?? String(e)))
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private build(rows: PsRow[], t0: number, error: string | null): ProcSample {
    const now = Date.now();
    const selfPid = this.deps.selfPid ?? process.pid;
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const children = new Map<number, number[]>();
    for (const r of rows) {
      const list = children.get(r.ppid) ?? [];
      list.push(r.pid);
      children.set(r.ppid, list);
    }
    const cpuPctOf = (r: PsRow): number | null => {
      const p = this.prev.get(r.pid);
      if (!p || r.elapsedMs < p.elapsedMs) return null; // 1ª amostra ou pid reciclado
      const wall = now - p.at;
      if (wall <= 0) return null;
      return Math.max(0, Math.round(((r.cpuMs - p.cpuMs) / wall) * 1000) / 10);
    };
    const owners = this.deps.spawnOwners();

    // Árvore do daemon (DFS preservando ordem de pais → filhos).
    const tree: ProcNode[] = [];
    const walk = (pid: number, depth: number, agentId: string | null, branch: string) => {
      for (const c of children.get(pid) ?? []) {
        const r = byPid.get(c);
        if (!r) continue;
        const own = owners.get(c);
        const nextAgent = own?.agentId ?? agentId;
        const nextBranch = depth === 0 ? (own?.cmd ?? cmdName(r.command)) : branch;
        tree.push({ ...r, depth, cpuPct: cpuPctOf(r), agentId: nextAgent, branch: nextBranch });
        if (depth < 12) walk(c, depth + 1, nextAgent, nextBranch);
      }
    };
    walk(selfPid, 0, null, "");

    const inTree = new Set(tree.map((n) => n.pid));
    const orphans: ProcSample["orphans"] = [];
    for (const r of rows) {
      if (r.pid === selfPid || inTree.has(r.pid)) continue;
      if (r.ppid !== 1) continue;
      if (!RUNNER_RE.test(r.command) || NOT_ORPHAN_RE.test(r.command)) continue;
      orphans.push({ ...r, cpuPct: cpuPctOf(r), why: "ppid=1 (adotado pelo init) com comando de runner/bridge" });
    }

    const hotOrphans = rows
      .filter((r) => r.ppid === 1 && r.pid !== selfPid && !inTree.has(r.pid) && r.elapsedMs >= 3_600_000 && isToolOrphanCandidate(r.command))
      .map((r) => ({ ...r, cpuPct: cpuPctOf(r) }))
      .filter((r) => (r.cpuPct ?? r.psCpu) >= 5)
      .sort((a, b) => (b.cpuPct ?? b.psCpu) - (a.cpuPct ?? a.psCpu));
    const hotPids = new Set(hotOrphans.map((o) => o.pid));
    const hotKill: string[] = [];
    for (const pgid of [...new Set(hotOrphans.map((o) => o.pgid))]) {
      const membros = rows.filter((r) => r.pgid === pgid);
      if (pgid > 1 && membros.length > 0 && membros.every((r) => hotPids.has(r.pid))) hotKill.push(`kill -- -${pgid}`);
      else hotKill.push(`kill ${hotOrphans.filter((o) => o.pgid === pgid).map((o) => o.pid).join(" ")}`);
    }

    const hostTop = rows
      .map((r) => ({ ...r, cpuPct: cpuPctOf(r), mine: r.pid === selfPid || inTree.has(r.pid) }))
      .sort((a, b) => (b.cpuPct ?? b.psCpu) - (a.cpuPct ?? a.psCpu))
      .slice(0, 25);

    const priCounts: Record<string, number> = {};
    for (const n of tree) priCounts[String(n.pri)] = (priCounts[String(n.pri)] ?? 0) + 1;
    const selfRow = byPid.get(selfPid);

    const agg = new Map<string, { procs: number; cpu: number; cpuKnown: boolean; rssKb: number }>();
    let totalCpu = 0;
    let cpuKnown = false;
    let totalRss = 0;
    for (const n of tree) {
      totalRss += n.rssKb;
      if (n.cpuPct != null) { totalCpu += n.cpuPct; cpuKnown = true; }
      const k = n.agentId ?? "(daemon)";
      const a = agg.get(k) ?? { procs: 0, cpu: 0, cpuKnown: false, rssKb: 0 };
      a.procs++;
      a.rssKb += n.rssKb;
      if (n.cpuPct != null) { a.cpu += n.cpuPct; a.cpuKnown = true; }
      agg.set(k, a);
    }

    // Memória das amostras: só pids vistos agora.
    const nextPrev = new Map<number, Prev>();
    for (const r of rows) nextPrev.set(r.pid, { cpuMs: r.cpuMs, elapsedMs: r.elapsedMs, at: now });
    if (rows.length > 0) this.prev = nextPrev;

    const sample: ProcSample = {
      ts: now,
      tookMs: now - t0,
      error,
      hostProcs: rows.length,
      self: selfRow ? { ...selfRow, cpuPct: cpuPctOf(selfRow) } : null,
      tree,
      priCounts,
      totals: { count: tree.length, cpuPct: cpuKnown ? Math.round(totalCpu * 10) / 10 : null, rssMb: Math.round(totalRss / 1024) },
      orphans,
      hotOrphans,
      hotKill,
      hostTop,
      byAgent: [...agg.entries()].map(([agentId, a]) => ({
        agentId,
        procs: a.procs,
        cpuPct: a.cpuKnown ? Math.round(a.cpu * 10) / 10 : null,
        rssMb: Math.round(a.rssKb / 1024),
      })).sort((x, y) => (y.cpuPct ?? 0) - (x.cpuPct ?? 0)),
    };
    if (!error || !this.latest) this.latest = sample;
    return sample;
  }
}

function cmdName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}

function runPsAsync(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", PS_ARGS, { timeout: 15_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(stdout);
    });
  });
}

/* ───────────────────────────── memória do host ───────────────────────────── */

export interface HostMemory {
  ts: number;
  totalMb: number;
  freeMb: number;
  swapTotalMb: number | null;
  swapUsedMb: number | null;
  /** macOS: memory_pressure "System-wide memory free percentage". */
  freePct: number | null;
  pageouts: number | null;
}

let hostMem: HostMemory | null = null;
let hostMemInflight = false;

function execText(cmd: string, args: string[], timeout = 5_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (_err, stdout) => resolve(stdout ?? ""));
  });
}

/** Atualiza a leitura de memória/swap (assíncrono; no máx. uma em voo). */
export async function refreshHostMemory(): Promise<HostMemory | null> {
  if (hostMemInflight) return hostMem;
  hostMemInflight = true;
  try {
    const base: HostMemory = {
      ts: Date.now(),
      totalMb: Math.round(os.totalmem() / 1048576),
      freeMb: Math.round(os.freemem() / 1048576),
      swapTotalMb: null,
      swapUsedMb: null,
      freePct: null,
      pageouts: null,
    };
    if (process.platform === "darwin") {
      const sw = await execText("sysctl", ["-n", "vm.swapusage"]);
      const t = /total = ([\d.]+)M/.exec(sw);
      const u = /used = ([\d.]+)M/.exec(sw);
      if (t) base.swapTotalMb = Math.round(Number(t[1]));
      if (u) base.swapUsedMb = Math.round(Number(u[1]));
      const vm = await execText("vm_stat", []);
      const po = /Pageouts:\s+(\d+)/.exec(vm);
      if (po) base.pageouts = Number(po[1]);
      const mp = await execText("memory_pressure", ["-Q"], 8_000);
      const fp = /free percentage:\s*(\d+)%/.exec(mp);
      if (fp) base.freePct = Number(fp[1]);
    } else if (process.platform === "linux") {
      try {
        const mi = await readFile("/proc/meminfo", "utf8");
        const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(mi)?.[1] ?? NaN);
        const st = kb("SwapTotal");
        const sf = kb("SwapFree");
        const av = kb("MemAvailable");
        if (Number.isFinite(st)) base.swapTotalMb = Math.round(st / 1024);
        if (Number.isFinite(st) && Number.isFinite(sf)) base.swapUsedMb = Math.round((st - sf) / 1024);
        if (Number.isFinite(av)) base.freePct = Math.round((av * 1024 * 100) / os.totalmem());
      } catch { /* sem /proc */ }
    }
    hostMem = base;
    return hostMem;
  } finally {
    hostMemInflight = false;
  }
}

export function lastHostMemory(): HostMemory | null {
  return hostMem;
}
