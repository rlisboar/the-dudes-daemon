import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

export function processAlive(process: ChildProcess | null | undefined): process is ChildProcess {
  return !!process && process.exitCode === null && process.signalCode === null;
}

/**
 * T-055: mata o leader do Grok amarrado a um `--leader-socket`.
 *
 * O SIGKILL do cliente headless NÃO atinge o leader (processo separado no
 * socket). Leader zumbi = próximos turnos pendem sem CPU/log até restart.
 * Best-effort: lsof → kill; unlink do sock. Falha silenciosa se sem lsof.
 */
export function killGrokLeader(leaderSocketPath: string | undefined | null): number {
  if (!leaderSocketPath) return 0;
  let killed = 0;
  try {
    const r = spawnSync("lsof", ["-t", leaderSocketPath], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const pids = (r.stdout ?? "")
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 1);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
        killed += 1;
      } catch { /* ESRCH */ }
    }
  } catch { /* lsof ausente / timeout */ }
  try {
    if (existsSync(leaderSocketPath)) unlinkSync(leaderSocketPath);
  } catch { /* best-effort */ }
  return killed;
}

export function killProcess(child: ChildProcess | null | undefined, signal: NodeJS.Signals = "SIGKILL"): boolean {
  if (!processAlive(child)) return false;
  // Grupo primeiro: spawnDropped usa `detached: true`, então o filho é líder
  // de um process group próprio e `kill(-pid)` alcança wrapper E netos (o CLI
  // real atrás do setpriv/pty). Se o processo NÃO for líder (spawn direto fora
  // do spawnDropped), não existe grupo com esse pgid → ESRCH → cai no kill
  // individual de sempre. Nunca atinge o grupo do daemon: o pgid usado é o pid
  // do filho, não o nosso.
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch { /* ESRCH/EPERM → individual */ }
  }
  try { return child.kill(signal); } catch { return false; }
}

/**
 * T-593: mata por PID, sem depender do bookkeeping do ChildProcess.
 *
 * `killProcess` sai cedo em `!processAlive(child)`: um `close` já entregue
 * (exitCode/signalCode setados pelo Node) torna o kill um no-op mesmo quando o
 * process group do turno ainda está vivo. O pgid sobrevive ao líder enquanto
 * qualquer membro existir (netos herdam pipes e ficam no mesmo grupo), então
 * `kill(-pid)` continua alcançando a árvore — e o alvo aqui é o PID, não o
 * objeto. Fallback individual quando o pid não é líder de grupo (ESRCH).
 *
 * Best-effort: pid morto/inexistente devolve false, nunca lança.
 */
export function killPidTree(pid: number | null | undefined, signal: NodeJS.Signals = "SIGKILL"): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch { /* sem grupo com esse pgid → individual */ }
  try {
    process.kill(pid, signal);
    return true;
  } catch { return false; }
}

/** T-593: o pid ainda existe no SO? Sonda por sinal 0 — `processAlive` só sabe
 *  de ChildProcess do Node, e o alvo aqui é o pid. Zumbi ainda conta como vivo
 *  (o Node o recolhe logo depois do SIGKILL). */
export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function terminateWithEscalation(process: ChildProcess | null | undefined, graceMs = 1_500): () => void {
  if (!processAlive(process)) return () => {};
  let escalation: NodeJS.Timeout | undefined;
  const clear = () => { if (escalation) clearTimeout(escalation); };
  process.once("exit", clear);
  process.once("close", clear);
  killProcess(process, "SIGTERM");
  if (processAlive(process)) escalation = setTimeout(() => killProcess(process, "SIGKILL"), graceMs);
  return clear;
}

export function terminateAndWait(process: ChildProcess | null | undefined, input: {
  graceMs?: number;
  maxWaitMs?: number;
  beforeTerminate?: () => void;
} = {}): Promise<void> {
  if (!processAlive(process)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let maxWait: NodeJS.Timeout | undefined;
    const done = () => {
      if (settled) return;
      settled = true;
      if (maxWait) clearTimeout(maxWait);
      resolve();
    };
    process.once("exit", done);
    process.once("close", done);
    process.once("error", done);
    maxWait = setTimeout(done, input.maxWaitMs ?? 3_000);
    input.beforeTerminate?.();
    terminateWithEscalation(process, input.graceMs);
  });
}

export function armHardTimeout(
  process: ChildProcess,
  timeoutMs: number,
  onTimeout?: () => void,
  shouldKill?: () => boolean,
  /** T-705: se shouldKill() recusar, volta a armar com este intervalo.
   *  Sem isto o skip no teto absoluto (720s grok) abandonava o backstop. */
  rearmOnSkipMs?: number,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let cleared = false;
  const clear = () => {
    cleared = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (ms: number) => {
    timer = setTimeout(() => {
      if (cleared || !processAlive(process)) return;
      if (shouldKill && !shouldKill()) {
        if (rearmOnSkipMs && rearmOnSkipMs > 0) schedule(rearmOnSkipMs);
        return;
      }
      onTimeout?.();
      killProcess(process, "SIGKILL");
    }, ms);
  };
  schedule(timeoutMs);
  process.once("exit", clear);
  process.once("close", clear);
  process.once("error", clear);
  return clear;
}

export interface CollectedProcessOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Teto por acumulador de stdout/stderr do turno. Uma linha sem \\n não
 *  pode crescer até o limite de string do V8. */
export const RUNNER_OUTPUT_CAP_BYTES = 8 * 1024 * 1024;
export const RUNNER_OUTPUT_TRUNC_MARK = "\n[the-dudes: output truncated]\n";

export function appendCapped(
  buf: string,
  chunk: string,
  cap = RUNNER_OUTPUT_CAP_BYTES,
): { text: string; truncated: boolean; justHit: boolean } {
  const cur = Buffer.byteLength(buf, "utf8");
  if (cur >= cap) return { text: buf, truncated: true, justHit: false };
  const add = Buffer.byteLength(chunk, "utf8");
  if (cur + add <= cap) return { text: buf + chunk, truncated: false, justHit: false };
  const remain = cap - cur;
  const head = remain > 0 ? Buffer.from(chunk, "utf8").subarray(0, remain).toString("utf8") : "";
  return { text: buf + head + RUNNER_OUTPUT_TRUNC_MARK, truncated: true, justHit: true };
}

function takeCapped(
  buf: string,
  chunk: string,
  onTruncated?: () => void,
  onData?: (chunk: string) => void,
): string {
  const next = appendCapped(buf, chunk);
  if (next.justHit) {
    onTruncated?.();
    onData?.(RUNNER_OUTPUT_TRUNC_MARK);
  } else if (!next.truncated) {
    onData?.(chunk);
  }
  return next.text;
}

/** Resolve no timeout sem depender de `close`: processos netos podem herdar
 * pipes e impedir que o evento seja emitido mesmo depois do SIGKILL. */
export function collectProcessOutput(process: ChildProcess, input: {
  timeoutMs: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onTruncated?: (stream: "stdout" | "stderr") => void;
}): Promise<CollectedProcessOutput> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: CollectedProcessOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    process.stdout?.setEncoding("utf8");
    process.stderr?.setEncoding("utf8");
    process.stdout?.on("data", (chunk: string) => {
      stdout = takeCapped(stdout, chunk, () => input.onTruncated?.("stdout"), input.onStdout);
    });
    process.stderr?.on("data", (chunk: string) => {
      stderr = takeCapped(stderr, chunk, () => input.onTruncated?.("stderr"), input.onStderr);
    });
    const timer = setTimeout(() => {
      killProcess(process, "SIGKILL");
      settle({ stdout, stderr, code: process.exitCode, timedOut: true });
    }, input.timeoutMs);
    process.once("close", (code) => settle({ stdout, stderr, code, timedOut: false }));
    process.once("error", () => settle({ stdout, stderr, code: process.exitCode, timedOut: false }));
  });
}
