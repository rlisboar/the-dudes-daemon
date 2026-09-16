/**
 * R8 (T-463): ponto ÚNICO de invocação do git no daemon.
 *
 * Contrato (espelha o T-424 e generaliza):
 *  - spawnDropped (drop de privilégio quando root) + detached;
 *  - env enxuto (`gitMinimalEnv`: hooks/config maliciosos não veem secrets);
 *  - TIMEOUT com kill de GRUPO (escalation SIGTERM→SIGKILL) — antes um git
 *    pendurado (network fs, lock) segurava handlers pra sempre;
 *  - output capado; `--` antes de refs/paths é responsabilidade do caller
 *    (helpers validateGitRef deste módulo);
 *  - nunca rejeita: devolve { ok, status, stdout, stderr, timedOut }.
 */
import path from "node:path";
import { appendCapped, killProcess, terminateWithEscalation, RUNNER_OUTPUT_CAP_BYTES } from "./process-lifecycle.js";
import { spawnDropped } from "../privileges.js";
import { gitMinimalEnv } from "../workspace.js";
import type { DropTarget } from "../privileges.js";

export interface RunGitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export const RUN_GIT_DEFAULT_TIMEOUT_MS = 60_000;
/** Clone pode baixar repo grande; teto próprio. */
export const RUN_GIT_CLONE_TIMEOUT_MS = 10 * 60_000;

// T-554: fonte ÚNICA — a allowlist endurecida do T-424 (workspace.ts), não
// uma cópia paralela mais frouxa. Re-exportada aqui pra quem importa o helper
// pelo módulo de git.
export { validateGitRef } from "../workspace.js";

export async function runGit(
  repo: string,
  args: string[],
  opts: { drop?: DropTarget | null; timeoutMs?: number; maxBytes?: number } = {},
): Promise<RunGitResult> {
  const drop = opts.drop ?? null;
  const timeoutMs = opts.timeoutMs ?? RUN_GIT_DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? RUNNER_OUTPUT_CAP_BYTES;
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnDropped("git", args, {
        cwd: repo,
        env: gitMinimalEnv(drop),
        stdio: ["ignore", "pipe", "pipe"],
      }, drop);
    } catch (e) {
      resolve({ ok: false, status: 1, stdout: "", stderr: (e as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateWithEscalation(proc);
    }, timeoutMs);
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: status === 0 && !timedOut, status, stdout: stdout.trim(), stderr: stderr.trim(), ...(timedOut ? { timedOut: true } : {}) });
    };
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (c: string) => { stdout = appendCapped(stdout, c, maxBytes).text; });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (c: string) => { stderr = appendCapped(stderr, c, maxBytes).text; });
    proc.on("close", (code) => finish(code));
    proc.on("error", (e) => { stderr = stderr || e.message; finish(1); });
  });
}

/** Nome do repo a partir de um path (conveniência usada no clone). */
export function repoNameOf(target: string): string {
  return path.basename(target);
}

export { killProcess };
