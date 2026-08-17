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
): () => void {
  const timer = setTimeout(() => {
    if (!processAlive(process) || (shouldKill && !shouldKill())) return;
    onTimeout?.();
    killProcess(process, "SIGKILL");
  }, timeoutMs);
  const clear = () => clearTimeout(timer);
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

/** Resolve no timeout sem depender de `close`: processos netos podem herdar
 * pipes e impedir que o evento seja emitido mesmo depois do SIGKILL. */
export function collectProcessOutput(process: ChildProcess, input: {
  timeoutMs: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
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
    process.stdout?.on("data", (chunk: string) => { stdout += chunk; input.onStdout?.(chunk); });
    process.stderr?.on("data", (chunk: string) => { stderr += chunk; input.onStderr?.(chunk); });
    const timer = setTimeout(() => {
      killProcess(process, "SIGKILL");
      settle({ stdout, stderr, code: process.exitCode, timedOut: true });
    }, input.timeoutMs);
    process.once("close", (code) => settle({ stdout, stderr, code, timedOut: false }));
    process.once("error", () => settle({ stdout, stderr, code: process.exitCode, timedOut: false }));
  });
}
