/**
 * T-582: parque de suites de teste abandonadas.
 *
 * DEFEITO MEDIDO (2026-09-16, host do dono): 14 processos
 * `node --import tsx --test` vivos, 13 deles abandonados em worktrees de
 * cards já fechados, idades de 11h a 1d18h. Assinatura: a raiz `node --test`
 * vive sozinha (ou com workers parados há horas) com CPU acumulada irrisória
 * — 5 workers somando 10s de CPU em 12 horas. Dois deles ignoraram SIGTERM.
 * Efeito: parque e memória inflados, e "suite pendurada" fica
 * indistinguível de "suite a correr".
 *
 * CRITÉRIO DE CORTE (declarado, binário): uma raiz `node … --test` é
 * PENDURADA quando as TRÊS condições valem ao mesmo tempo:
 *   1. a raiz está viva há pelo menos `minAgeMs` (default 10 min);
 *   2. a CPU acumulada de TODA a árvore (raiz + workers + pipeline) cresceu
 *      menos de `maxCpuDeltaMs` (default 1s) numa janela de `flatWindowMs`
 *      (default 3 min no daemon, 60s no comando manual);
 *   3. (T-667) não há sinal de LIVENESS RUNNABLE no snapshot: NENHUM membro
 *      está RUNNABLE (stat R do ps), ou o RUNNABLE observado é um BLIP de 1
 *      proc que não se repete na outra ponta da janela.
 * Uma suite a trabalhar produz dezenas de segundos de CPU numa janela de
 * minutos; uma pendurada produz milissegundos E tem a árvore inteira dormindo.
 * O gate de idade protege a janela de boot/teardown do `node --test`.
 *
 * T-667 — POR QUE RUNNABLE (e por que não basta um olhar): sob starvation
 * extrema a CPU da árvore fica 0ms na janela mesmo com a árvore queimando (o
 * proc está na fila do scheduler, não recebeu CPU), então CPU plana lia a
 * fixture VIVA como pendurada e o reaper matava suite em voo (medido no CI,
 * run 35295629976 attempt 1). O estado `stat` do ps separa as duas classes,
 * mas um ÚNICO instante não separa: um proc dormindo que acorda (um
 * `setInterval`) também aparece R por um átimo. Medido nas duas fixtures
 * reais (sonda `evidence/T-667/probe-runnable2.mjs`, 13 amostras, load ~40):
 * a viva tem 3–4 procs RUNNABLE em 100% das amostras; a pendurada tem 0 (no
 * máximo 1 blip, nunca o mesmo pid em duas amostras). Daí o critério exigir
 * REPETIÇÃO: ≥ 2 procs RUNNABLE no snapshot, ou o MESMO pid RUNNABLE nas
 * duas pontas da janela (o que também cobre a suite de um único queimador).
 *
 * CONTROLE NEGATIVO (C2): enquanto a CPU da árvore crescer acima do teto a
 * suite é classificada `viva` e o reaper não a toca — inclusive se ela tiver
 * sido lançada em background e o turno do agente já tiver terminado.
 *
 * MORTE (C4): mata o GRUPO de processos (`kill(-pgid)`) e, como rede de
 * segurança, cada membro individualmente. O grupo cobre exatamente o que o
 * relatório do PM exigiu: raiz + workers + o `grep` do pipeline
 * `npm test | grep` — que não é descendente da raiz, é irmão de grupo.
 *
 * Não toca nos testes em si (escopo do card).
 */
import { spawnSync } from "node:child_process";

/** Defaults do mecanismo. Override por env para calibração no host. */
export const SUITE_PARK_DEFAULTS = {
  /** Intervalo entre amostras do loop do daemon. */
  sampleMs: 60_000,
  /** Janela em que a CPU da árvore tem de ficar plana para contar pendurada. */
  flatWindowMs: 180_000,
  /** Idade mínima da raiz antes de qualquer veredito (protege boot/teardown). */
  minAgeMs: 600_000,
  /** Crescimento de CPU tolerado dentro da janela (abaixo disto = plana). */
  maxCpuDeltaMs: 1_000,
  /** SIGTERM → espera → SIGKILL. */
  graceMs: 2_000,
  /** Teto de amostras guardadas no histórico do daemon. */
  historyMax: 30,
} as const;

/**
 * T-667: mínimo de procs RUNNABLE no snapshot para o sinal de starvation
 * valer sem esperar a outra ponta da janela. Derivado da sonda das duas
 * fixtures reais: viva = 3–4 procs RUNNABLE em 100% das amostras; pendurada
 * = 0 (blip de no máximo 1). O 2 fica entre as duas classes com margem.
 */
export const RUNNABLE_MIN = 2;

export interface SuiteParkOpts {
  sampleMs: number;
  flatWindowMs: number;
  minAgeMs: number;
  maxCpuDeltaMs: number;
  graceMs: number;
  historyMax: number;
}

export function suiteParkOptsFromEnv(env: NodeJS.ProcessEnv = process.env): SuiteParkOpts {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    sampleMs: num("THE_DUDES_SUITE_PARK_SAMPLE_MS", SUITE_PARK_DEFAULTS.sampleMs),
    flatWindowMs: num("THE_DUDES_SUITE_PARK_FLAT_MS", SUITE_PARK_DEFAULTS.flatWindowMs),
    minAgeMs: num("THE_DUDES_SUITE_PARK_MIN_AGE_MS", SUITE_PARK_DEFAULTS.minAgeMs),
    maxCpuDeltaMs: num("THE_DUDES_SUITE_PARK_MAX_CPU_DELTA_MS", SUITE_PARK_DEFAULTS.maxCpuDeltaMs),
    graceMs: num("THE_DUDES_SUITE_PARK_GRACE_MS", SUITE_PARK_DEFAULTS.graceMs),
    historyMax: SUITE_PARK_DEFAULTS.historyMax,
  };
}

// ─────────────────────────── leitura de processos ───────────────────────────

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** Estado do processo (stat do ps); 1º char "R" = running/runnable. */
  stat: string;
  /** Idade do processo (etime). */
  elapsedMs: number;
  /** CPU acumulada (time). */
  cpuMs: number;
  command: string;
}

/** `[[dd-]hh:]mm:ss[.ss]` → ms. Vale para `etime` e para `time` do ps.
 *  No macOS `time` vem como `MM:SS.ss` com minutos não-normalizados
 *  (`109:00.03` = 109 min) — por isso 2 partes são MINUTOS:segundos, não
 *  horas:minutos. 3 partes é sempre h:m:s. */
export function parsePsDuration(raw: string): number {
  const s = raw.trim();
  if (!s || s === "-") return 0;
  let days = 0;
  let rest = s;
  const dash = s.indexOf("-");
  if (dash > 0) {
    days = Number(s.slice(0, dash));
    rest = s.slice(dash + 1);
    if (!Number.isFinite(days)) return 0;
  }
  const parts = rest.split(":");
  if (parts.length === 0 || parts.length > 3) return 0;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return 0;
  let h = 0;
  let m = 0;
  let sec = 0;
  if (nums.length === 3) [h, m, sec] = nums;
  else if (nums.length === 2) [m, sec] = nums;
  else [sec] = nums;
  return Math.round((((days * 24 + h) * 60 + m) * 60 + sec) * 1000);
}

/** `pid ppid pgid etime time command…` (uma linha por processo). */
export function parsePsOutput(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(t);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      stat: m[4],
      elapsedMs: parsePsDuration(m[5]),
      cpuMs: parsePsDuration(m[6]),
      command: m[7],
    });
  }
  return rows;
}

/** `--test` como TOKEN isolado. Workers do node --test carregam só flags
 *  `--test-*` (`--test-concurrency=0`, `--test-isolation=process`, …), então
 *  o token nu identifica a RAIZ e nada mais. */
const BARE_TEST_RE = /(^|\s)--test(\s|$)/;

/** A raiz do runner é um `node` (não o `sh -c`/`npm` que o envolve) cujo argv
 *  traz `--test` nu. O primeiro token é o executável — é o que separa
 *  `node --import tsx --test …` (raiz) de `sh -c node --import tsx --test …`
 *  (wrapper, cuja string contém `--test` mas cujo argv[0] é `sh`). */
export function isTestRoot(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.slice(first.lastIndexOf("/") + 1);
  if (!/^node(js)?(\.exe)?$/.test(base)) return false;
  return BARE_TEST_RE.test(command);
}

/**
 * Resultado cru de um `ps`. Amostra falhada (timeout, buffer estourado,
 * stdout vazio) NÃO é um host sem processos: tratá-la como lista vazia faz
 * toda raiz já viva cair em "sem amostra anterior" (T-761, C2 com outra
 * suíte `node --test` no ar).
 */
export interface PsSpawnResult {
  status: number | null;
  stdout?: string | null;
  error?: (Error & { code?: string }) | null;
}

const PS_TENTATIVAS = 3;
const PS_TIMEOUT_MS = 15_000;
const PS_MAX_BUFFER = 32 * 1024 * 1024;

export function describePsFailure(r: PsSpawnResult): string {
  const code = r.error?.code ?? "";
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "maxbuffer";
  if (r.error) return "erro";
  if (r.status !== 0 && r.status !== null) return `status_${r.status}`;
  if (!(r.stdout ?? "").trim()) return "stdout_vazio";
  return "sem_processo";
}

/** null = esta tentativa não serve (não parsear como host vazio). */
export function rowsFromPsAttempt(r: PsSpawnResult): ProcRow[] | null {
  if (r.error || r.status !== 0) return null;
  if (!(r.stdout ?? "").trim()) return null;
  const rows = parsePsOutput(r.stdout ?? "");
  return rows.length > 0 ? rows : null;
}

export function primeiraAmostraUtil(tentativas: PsSpawnResult[]): ProcRow[] {
  let last: PsSpawnResult = { status: null, stdout: "", error: null };
  for (const t of tentativas) {
    last = t;
    const rows = rowsFromPsAttempt(t);
    if (rows) return rows;
  }
  throw new Error(`ps indisponível (${describePsFailure(last)}) — amostra descartada`);
}

export function runPs(): ProcRow[] {
  const tentativas: PsSpawnResult[] = [];
  for (let i = 0; i < PS_TENTATIVAS; i++) {
    const r = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,etime=,time=,command="], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER,
    });
    tentativas.push({ status: r.status, stdout: r.stdout, error: r.error ?? null });
    const rows = rowsFromPsAttempt(tentativas[tentativas.length - 1]!);
    if (rows) return rows;
    if (i + 1 < PS_TENTATIVAS) sleepSync(200 * (i + 1));
  }
  return primeiraAmostraUtil(tentativas);
}

// ──────────────────────────── modelagem da árvore ───────────────────────────

export interface Suite {
  rootPid: number;
  pgid: number;
  command: string;
  /** raiz + descendentes (+ irmãos de grupo, quando o grupo é do próprio suite). */
  members: number[];
  /** CPU acumulada por membro NO snapshot em que a suite foi colhida. */
  cpuByPid: Map<number, number>;
  /** Membros RUNNABLE (stat R) no snapshot — T-667: liveness sob starvation. */
  runnablePids: number[];
  ageMs: number;
  cpuMs: number;
  /** true quando dá para matar por grupo sem atingir o daemon. */
  killGroup: boolean;
}

function ancestorsOf(pid: number, byPid: Map<number, ProcRow>): Set<number> {
  const out = new Set<number>();
  let cur = byPid.get(pid)?.ppid ?? 0;
  for (let i = 0; i < 64 && cur > 1 && !out.has(cur); i++) {
    out.add(cur);
    cur = byPid.get(cur)?.ppid ?? 0;
  }
  return out;
}

function descendantsOf(root: number, children: Map<number, number[]>): number[] {
  const out: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop() as number;
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * Suites presentes no snapshot. Uma "suite" é a raiz `node … --test` mais
 * tudo que ela controla. `ownPid` é o processo que faz a varredura (o daemon,
 * ou o próprio comando) — serve para não matar o grupo errado: se a raiz
 * partilha o grupo do observador, o grupo contém o observador e a morte tem
 * de ser membro-a-membro.
 */
export function collectSuites(rows: ProcRow[], ownPid: number = process.pid): Suite[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const ownRow = byPid.get(ownPid);
  const ownPgid = ownRow?.pgid ?? -1;
  const ownAncestors = ancestorsOf(ownPid, byPid);
  const roots = rows.filter((r) => isTestRoot(r.command));

  const suites: Suite[] = [];
  for (const root of roots) {
    // Raiz aninhada (um teste que dispara outro `node --test`) é suite
    // própria, não duplicata: a assinatura `--test` nu já exclui os workers,
    // então quem casa aqui é sempre uma invocação independente do runner.
    const members = new Set<number>([root.pid, ...descendantsOf(root.pid, children)]);
    const killGroup = root.pgid > 1 && root.pgid !== ownPgid;
    if (killGroup) {
      for (const r of rows) if (r.pgid === root.pgid) members.add(r.pid);
    } else {
      // Mesmo grupo do observador: o pipeline (`| grep`) é irmão de grupo,
      // não descendente. Inclui quem partilha o grupo sem ser o observador
      // nem um ancestral dele.
      for (const r of rows) {
        if (r.pgid !== root.pgid || r.pid === ownPid || ownAncestors.has(r.pid)) continue;
        members.add(r.pid);
      }
    }
    const cpuByPid = new Map<number, number>();
    const runnablePids: number[] = [];
    let cpuMs = 0;
    for (const pid of members) {
      const row = byPid.get(pid);
      const cpu = row?.cpuMs ?? 0;
      cpuByPid.set(pid, cpu);
      cpuMs += cpu;
      // T-667: 1º char "R" = running/runnable — na fila do scheduler.
      if (row?.stat.startsWith("R")) runnablePids.push(pid);
    }
    suites.push({
      rootPid: root.pid,
      pgid: root.pgid,
      command: root.command,
      members: [...members].sort((a, b) => a - b),
      cpuByPid,
      runnablePids,
      ageMs: root.elapsedMs,
      cpuMs,
      killGroup,
    });
  }
  return suites;
}

// ────────────────────────────── classificação ───────────────────────────────

export type SuiteState = "viva" | "pendurada" | "indeterminada";

export interface Assessment {
  suite: Suite;
  state: SuiteState;
  motivo: string;
  /** CPU acumulada pela árvore DENTRO da janela (null sem amostra anterior). */
  cpuDeltaMs: number | null;
  windowMs: number;
}

export interface AssessOpts {
  minAgeMs: number;
  maxCpuDeltaMs: number;
  windowMs: number;
}

/**
 * Classifica cada suite contra uma amostra ANTERIOR (CPU por pid + conjunto
 * RUNNABLE). `baseline` null = primeira amostra: nada pode ser declarado
 * pendurado ainda (o critério exige delta de CPU, e delta exige duas amostras).
 */
export function assessSuites(
  suites: Suite[],
  baseline: Sample | null,
  opts: AssessOpts,
): Assessment[] {
  return suites.map((suite) => {
    const base = { suite, windowMs: opts.windowMs };
    if (suite.ageMs < opts.minAgeMs) {
      return {
        ...base,
        state: "viva" as const,
        motivo: `idade ${fmtDuration(suite.ageMs)} < ${fmtDuration(opts.minAgeMs)}`,
        cpuDeltaMs: null,
      };
    }
    if (!baseline || !baseline.cpu.has(suite.rootPid)) {
      return {
        ...base,
        state: "indeterminada" as const,
        motivo: "sem amostra anterior da raiz",
        cpuDeltaMs: null,
      };
    }
    let delta = 0;
    for (const pid of suite.members) {
      const before = baseline.cpu.get(pid);
      if (before === undefined) continue;
      delta += (suite.cpuByPid.get(pid) ?? 0) - before;
    }
    if (delta < opts.maxCpuDeltaMs) {
      // T-667: CPU plana não basta sob starvation extrema. Processo RUNNABLE
      // está vivo e na fila do scheduler — só não recebeu CPU na janela. O
      // sinal, porém, tem de ser REPETIDO (um proc que acorda também aparece
      // R por um átimo): vale com ≥ RUNNABLE_MIN procs, ou com o MESMO pid
      // RUNNABLE nas duas pontas da janela.
      const persistentes = suite.runnablePids.filter((pid) => baseline.runnable.has(pid));
      if (suite.runnablePids.length >= RUNNABLE_MIN || persistentes.length > 0) {
        const como = suite.runnablePids.length >= RUNNABLE_MIN
          ? `${suite.runnablePids.length} procs RUNNABLE`
          : `pid ${persistentes.join(",")} RUNNABLE nas DUAS pontas da janela`;
        return {
          ...base,
          state: "viva" as const,
          motivo: `CPU da árvore cresceu ${delta}ms < ${opts.maxCpuDeltaMs}ms em ${fmtDuration(opts.windowMs)}, mas ${como} (starvation) — viva`,
          cpuDeltaMs: delta,
        };
      }
      return {
        ...base,
        state: "pendurada" as const,
        motivo: `CPU da árvore cresceu ${delta}ms < ${opts.maxCpuDeltaMs}ms em ${fmtDuration(opts.windowMs)} e nenhum sinal RUNNABLE repetido (árvore dormindo; RUNNABLE no snapshot: ${suite.runnablePids.length})`,
        cpuDeltaMs: delta,
      };
    }
    return {
      ...base,
      state: "viva" as const,
      motivo: `CPU da árvore cresceu ${delta}ms >= ${opts.maxCpuDeltaMs}ms`,
      cpuDeltaMs: delta,
    };
  });
}

/** Amostra contra a qual o próximo tick compara: CPU por pid + pids RUNNABLE. */
export interface Sample {
  cpu: Map<number, number>;
  runnable: Set<number>;
}

export function sampleOf(rows: ProcRow[]): Sample {
  const cpu = new Map<number, number>();
  const runnable = new Set<number>();
  for (const r of rows) {
    cpu.set(r.pid, r.cpuMs);
    if (r.stat.startsWith("R")) runnable.add(r.pid);
  }
  return { cpu, runnable };
}

// ──────────────────────────────── morte ─────────────────────────────────────

export interface ReapResult {
  rootPid: number;
  pgid: number;
  viaGrupo: boolean;
  sinais: string[];
  sobreviventes: number[];
}

export interface ReapDeps {
  kill: (pid: number, signal: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
  sleep: (ms: number) => void;
}

export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Vivo E não-zumbi. `kill(pid, 0)` responde true para zumbi (o parent ainda
 *  não colheu) — e o reaper roda com `sleepSync`, que bloqueia o event loop e
 *  portanto atrasa a colheita dos PRÓPRIOS filhos. Sem esta distinção, uma
 *  árvore corretamente morta é reportada como sobrevivente. */
export function aliveNotZombie(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  const stat = (r.stdout ?? "").trim();
  return stat !== "" && !stat.startsWith("Z");
}

export const defaultReapDeps: ReapDeps = {
  kill: (pid, signal) => { process.kill(pid, signal); },
  alive: aliveNotZombie,
  sleep: sleepSync,
};

function killTree(suite: Suite, signal: NodeJS.Signals, deps: ReapDeps, sinais: string[]): void {
  let hit = false;
  if (suite.killGroup) {
    try { deps.kill(-suite.pgid, signal); hit = true; sinais.push(`-${suite.pgid}:${signal}`); } catch { /* ESRCH */ }
  }
  if (!hit) {
    for (const pid of suite.members) {
      try { deps.kill(pid, signal); sinais.push(`${pid}:${signal}`); } catch { /* ESRCH */ }
    }
  }
}

/**
 * Mata a ÁRVORE inteira (raiz + workers + pipeline). SIGTERM primeiro,
 * SIGKILL depois — dois dos processos medidos pelo PM ignoraram SIGTERM.
 */
export function reapSuites(
  suites: Suite[],
  opts: { graceMs: number },
  deps: ReapDeps = defaultReapDeps,
): ReapResult[] {
  const results: ReapResult[] = suites.map((s) => ({
    rootPid: s.rootPid,
    pgid: s.pgid,
    viaGrupo: s.killGroup,
    sinais: [],
    sobreviventes: [],
  }));
  suites.forEach((s, i) => killTree(s, "SIGTERM", deps, results[i].sinais));
  if (opts.graceMs > 0) deps.sleep(opts.graceMs);
  suites.forEach((s, i) => {
    const vivos = s.members.filter((pid) => deps.alive(pid));
    if (!vivos.length) return;
    // Grupo primeiro de novo; depois membro a membro nos que resistiram.
    killTree(s, "SIGKILL", deps, results[i].sinais);
    for (const pid of vivos) {
      if (!deps.alive(pid)) continue;
      try { deps.kill(pid, "SIGKILL"); results[i].sinais.push(`${pid}:SIGKILL`); } catch { /* ESRCH */ }
    }
  });
  if (opts.graceMs > 0) deps.sleep(Math.min(opts.graceMs, 1_000));
  results.forEach((r, i) => {
    r.sobreviventes = suites[i].members.filter((pid) => deps.alive(pid));
  });
  return results;
}

// ──────────────────────────── formatação / relatório ────────────────────────

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d) return `${d}d${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}m`;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** cwd best-effort por pid (o `ps` não traz). Degrada em silêncio sem lsof. */
export function cwdOf(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  const r = spawnSync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn", "-Fp"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (!r.stdout) return out;
  let cur = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("p")) cur = Number(line.slice(1));
    else if (line.startsWith("n") && cur) out.set(cur, line.slice(1));
  }
  return out;
}

export function formatReport(assessments: Assessment[], opts: AssessOpts): string {
  const lines: string[] = [];
  const pend = assessments.filter((a) => a.state === "pendurada");
  lines.push(`criterio: raiz \`node … --test\` viva ha >= ${fmtDuration(opts.minAgeMs)} E CPU da arvore`);
  lines.push(`          (raiz + workers + pipeline) crescendo < ${opts.maxCpuDeltaMs}ms em ${fmtDuration(opts.windowMs)}`);
  lines.push(`          E nenhum sinal RUNNABLE repetido — T-667: sob starvation CPU plana nao basta;`);
  lines.push(`          conta com >= ${RUNNABLE_MIN} procs RUNNABLE (state R) ou o MESMO pid R nas duas pontas`);
  lines.push(`suites encontradas: ${assessments.length} · penduradas: ${pend.length}`);
  lines.push("");
  lines.push("ESTADO        PID     PGID    IDADE      CPU      dCPU    ARV  CMD / CWD");
  const cwds = cwdOf(assessments.map((a) => a.suite.rootPid));
  for (const a of assessments) {
    const cwd = cwds.get(a.suite.rootPid) ?? "?";
    const cmd = a.suite.command.length > 90 ? `${a.suite.command.slice(0, 87)}...` : a.suite.command;
    lines.push(
      [
        a.state.toUpperCase().padEnd(13),
        String(a.suite.rootPid).padEnd(7),
        String(a.suite.pgid).padEnd(7),
        fmtDuration(a.suite.ageMs).padEnd(10),
        `${(a.suite.cpuMs / 1000).toFixed(2)}s`.padEnd(8),
        (a.cpuDeltaMs === null ? "-" : `${a.cpuDeltaMs}ms`).padEnd(7),
        String(a.suite.members.length).padEnd(4),
        `${cwd}  ${cmd}`,
      ].join(" "),
    );
  }
  if (!assessments.length) lines.push("(nenhuma suite `node … --test` viva)");
  lines.push("");
  for (const a of assessments) {
    lines.push(`  ${a.state} pid=${a.suite.rootPid}: ${a.motivo}`);
  }
  return `${lines.join("\n")}\n`;
}

// ───────────────────────────── comando manual ───────────────────────────────

export interface SuiteParkCliOpts {
  reap: boolean;
  windowMs: number;
  minAgeMs: number;
  graceMs: number;
  maxCpuDeltaMs: number;
}

/**
 * Raiz mais velha que a janela e ausente da 1ª amostra: o `ps` anterior não
 * viu um processo que já existia (timeout, buffer, linha cortada). Não é
 * suite nova — a medição não serve.
 */
function baselineIncompleta(suites: Suite[], baseline: Sample, windowMs: number): boolean {
  const minimo = windowMs + 1_000;
  return suites.some((s) => s.ageMs > minimo && !baseline.cpu.has(s.rootPid));
}

/** Duas amostras separadas pela janela + classificação + (opcional) morte.
 *  Tudo síncrono de propósito: roda antes do bootstrap do daemon e sai.
 *  `sleep` é injetável para o teste não esperar a janela real. */
export function runSuiteParkCli(
  opts: SuiteParkCliOpts,
  io: { out: (s: string) => void; ps: () => ProcRow[]; deps?: ReapDeps; sleep?: (ms: number) => void } = {
    out: (s) => { process.stdout.write(s); },
    ps: runPs,
  },
): number {
  const assessOpts: AssessOpts = {
    minAgeMs: opts.minAgeMs,
    maxCpuDeltaMs: opts.maxCpuDeltaMs,
    windowMs: opts.windowMs,
  };
  const dormir = io.sleep ?? sleepSync;
  let baselineRows = io.ps();
  let assessments: Assessment[] = [];
  // No máximo uma repetição: a 2ª amostra boa vira a baseline da medição
  // seguinte. Duas furadas seguidas reportam indeterminada em vez de laçar.
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const baseline = sampleOf(baselineRows);
    io.out(`amostra 1/2 colhida — aguardando ${fmtDuration(opts.windowMs)} para medir a CPU da janela...\n`);
    dormir(opts.windowMs);
    const rows = io.ps();
    const suites = collectSuites(rows);
    assessments = assessSuites(suites, baseline, assessOpts);
    const furada = baselineIncompleta(suites, baseline, opts.windowMs);
    if (!furada || tentativa === 1) break;
    io.out("amostra 1 incompleta (raiz mais velha que a janela sem baseline) — repetindo a medição\n");
    baselineRows = rows;
  }
  io.out(formatReport(assessments, assessOpts));

  const penduradas = assessments.filter((a) => a.state === "pendurada");
  if (!opts.reap) {
    io.out(`\nmodo lista (zero mutacao). Use --reap-suites para matar as ${penduradas.length} penduradas.\n`);
    return 0;
  }
  if (!penduradas.length) {
    io.out("\nmodo reap: nada pendurado, zero processos mortos.\n");
    return 0;
  }
  const results = reapSuites(penduradas.map((a) => a.suite), { graceMs: opts.graceMs }, io.deps ?? defaultReapDeps);
  io.out("\n");
  for (const r of results) {
    io.out(
      `morto raiz=${r.rootPid} grupo=${r.viaGrupo ? `-${r.pgid}` : "membro-a-membro"} ` +
      `sinais=[${r.sinais.join(",")}] sobreviventes=[${r.sobreviventes.join(",")}]\n`,
    );
  }
  const depois = collectSuites(io.ps());
  const restos = depois.filter((s) => results.some((r) => r.rootPid === s.rootPid));
  io.out(`confirmacao: ${restos.length === 0 ? "nenhum orfao da arvore morta" : `${restos.length} suite(s) ainda visivel(is)`}\n`);
  return 0;
}

/**
 * Reconhece o modo diagnóstico no argv cru. Chamado ANTES do `parseCli`
 * (que exige --orch/--token) — `--list-suites`/`--reap-suites` não devem
 * precisar de credencial nem abrir WS.
 */
export function suiteParkCliArgs(argv: string[]): SuiteParkCliOpts | null {
  const reap = argv.includes("--reap-suites");
  const list = argv.includes("--list-suites");
  if (!reap && !list) return null;
  const num = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i < 0) return fallback;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    reap,
    windowMs: num("--suite-window-ms", 60_000),
    minAgeMs: num("--suite-min-age-ms", SUITE_PARK_DEFAULTS.minAgeMs),
    graceMs: num("--suite-grace-ms", SUITE_PARK_DEFAULTS.graceMs),
    maxCpuDeltaMs: num("--suite-max-cpu-delta-ms", SUITE_PARK_DEFAULTS.maxCpuDeltaMs),
  };
}

// ─────────────────────────── loop periódico do daemon ───────────────────────

export interface SuiteParkHandle {
  stop: () => void;
  tick: () => Assessment[];
}

export interface StartSuiteParkInput {
  log: (level: "info" | "warn" | "error", msg: string) => void;
  opts?: SuiteParkOpts;
  /** Injetável em teste. */
  ps?: () => ProcRow[];
  deps?: ReapDeps;
  ownPid?: number;
}

/**
 * Loop do daemon: amostra, classifica contra a amostra de `flatWindowMs`
 * atrás e mata as penduradas. Sem reaper o parque só cresce — o critério de
 * aceite C3 é justamente que ele não cresça entre turnos.
 */
export function startSuitePark(input: StartSuiteParkInput): SuiteParkHandle {
  const opts = input.opts ?? suiteParkOptsFromEnv();
  const ps = input.ps ?? runPs;
  const deps = input.deps ?? defaultReapDeps;
  const ownPid = input.ownPid ?? process.pid;
  const history: Array<{ at: number; sample: Sample }> = [];
  let timer: NodeJS.Timeout | null = null;

  const tick = (): Assessment[] => {
    const rows = ps();
    const suites = collectSuites(rows, ownPid);
    const now = Date.now();
    // Baseline = amostra mais recente que já dista >= flatWindowMs.
    let baseline: Sample | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (now - history[i].at >= opts.flatWindowMs) { baseline = history[i].sample; break; }
    }
    const assessments = assessSuites(suites, baseline, {
      minAgeMs: opts.minAgeMs,
      maxCpuDeltaMs: opts.maxCpuDeltaMs,
      windowMs: opts.flatWindowMs,
    });
    history.push({ at: now, sample: sampleOf(rows) });
    while (history.length > opts.historyMax) history.shift();

    const penduradas = assessments.filter((a) => a.state === "pendurada");
    if (!penduradas.length) return assessments;
    input.log("warn", `[suite-park] ${penduradas.length} suite(s) pendurada(s): ` +
      penduradas.map((a) => `pid=${a.suite.rootPid} idade=${fmtDuration(a.suite.ageMs)} cpu=${a.suite.cpuMs}ms`).join(", "));
    const results = reapSuites(penduradas.map((a) => a.suite), { graceMs: opts.graceMs }, deps);
    for (const r of results) {
      input.log(
        r.sobreviventes.length ? "warn" : "info",
        `[suite-park] morto pid=${r.rootPid} grupo=${r.viaGrupo ? `-${r.pgid}` : "membro-a-membro"} ` +
        `sinais=[${r.sinais.join(",")}] sobreviventes=[${r.sobreviventes.join(",")}]`,
      );
    }
    return assessments;
  };

  // Primeira amostra imediata (barata) para o histórico já ter base.
  try { tick(); } catch (e) { input.log("warn", `[suite-park] amostra inicial falhou: ${(e as Error).message}`); }
  timer = setInterval(() => {
    try { tick(); } catch (e) { input.log("warn", `[suite-park] tick falhou: ${(e as Error).message}`); }
  }, opts.sampleMs);
  timer.unref?.();

  return {
    stop: () => { if (timer) { clearInterval(timer); timer = null; } },
    tick,
  };
}