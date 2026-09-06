/**
 * T-051: limpa sessões Grok Build criadas pelo summarizer (cwd the-dudes-cli-*).
 *
 * O CLI persiste estado por cwd em `$GROK_HOME/sessions/<encodeURIComponent(cwd)>/`.
 * Cada one-shot de `runCliText` (summarizer) usa `mkdtemp(the-dudes-cli-*)` e deixa
 * um dir órfão no home do user (chegou a 2k+ dirs / ~4GB). Esta rotina remove
 * APENAS entradas sob HOME/.grok/sessions (ou GROK_HOME/sessions) cujo path
 * decodificado tem um componente `the-dudes-cli-*` e mtime além do TTL.
 * Sessões de projetos reais, alertai-ia-*, worktrees etc. ficam intactas.
 *
 * Superfície de escrita: exclusivamente `rmSync` sob os roots de sessions
 * resolvidos — zero escrita fora de `…/sessions/`.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grokHomePath } from "./runners/runtime-files.js";

/** Prefixo do mkdtemp no summarizer-runner (`the-dudes-cli-` + random). */
export const THE_DUDES_CLI_PREFIX = "the-dudes-cli-";

/** TTL default: 48h — cobre uso recente sem acumular lixo de semanas. */
export const DEFAULT_GROK_SESSION_TTL_MS = 48 * 60 * 60_000;

/** Intervalo do sweep periódico no daemon. */
export const DEFAULT_GROK_SESSION_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

export interface GrokSessionCleanupResult {
  scanned: number;
  /** Dirs elegíveis removidos (ou que seriam, em dry-run). */
  removed: number;
  /** Mantidos: não-alvo, dentro do TTL, ou não-dir. */
  kept: number;
  errors: number;
  /** Bytes liberados (ou a liberar em dry-run). */
  bytesFreed: number;
  /** Paths que seriam/foram removidos (lista do dry-run / apply). */
  candidates: string[];
  roots: string[];
  dryRun: boolean;
}

export interface GrokSessionCleanupFs {
  readdirSync: (dir: string) => string[];
  statSync: (p: string) => { isDirectory: () => boolean; mtimeMs: number; size: number };
  rmSync: (p: string, opts: { recursive: boolean; force: boolean }) => void;
}

const defaultFs: GrokSessionCleanupFs = {
  readdirSync: (dir) => readdirSync(dir),
  statSync: (p) => {
    const s = statSync(p);
    return { isDirectory: () => s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size };
  },
  rmSync: (p, opts) => rmSync(p, opts),
};

/**
 * Path decodificado tem um componente `the-dudes-cli-*` (prefixo + sufixo)?
 * Match por componente (não substring no meio de um nome tipo
 * `the-dudes-cli-notes`) — alinhado ao mkdtemp do summarizer.
 */
export function isTheDudesCliSessionDir(encodedName: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedName);
  } catch {
    return false;
  }
  if (!decoded || decoded.includes("\0")) return false;
  // Normaliza separadores e corta trailing slash
  const normalized = decoded.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.some(
    (part) => part.startsWith(THE_DUDES_CLI_PREFIX) && part.length > THE_DUDES_CLI_PREFIX.length,
  );
}

/** Path canônico de sessions sob um home (ou GROK_HOME explícito).
 *  `runner` escolhe o dir name (T-166/T-168: grok-custom → ~/.grok-custom). */
export function grokSessionsRoot(homeOrGrokHome: string, isGrokHome = false, runner?: string): string {
  const root = isGrokHome ? homeOrGrokHome : grokHomePath(homeOrGrokHome, runner);
  return path.join(root, "sessions");
}

/**
 * Homes a varrer: home efetivo do processo + dropTo (sudo) + GROK_HOME se set.
 * T-168: inclui ~/.grok-custom (wrapper grok-custom / helper T-166).
 * Deduplica por realpath lógico (string).
 */
export function resolveGrokSessionRoots(opts: {
  home?: string;
  dropToHome?: string | null;
  /** `undefined` = ler process.env.GROK_HOME; `null`/"" = ignorar env (testes). */
  grokHomeEnv?: string | null;
} = {}): string[] {
  const homes = new Set<string>();
  const home = opts.home ?? process.env.HOME ?? os.homedir();
  homes.add(grokSessionsRoot(home));
  homes.add(grokSessionsRoot(home, false, "grok-custom"));
  if (opts.dropToHome && opts.dropToHome !== home) {
    homes.add(grokSessionsRoot(opts.dropToHome));
    homes.add(grokSessionsRoot(opts.dropToHome, false, "grok-custom"));
  }
  // nullish-coalesce quebraria `null` explícito (testes) → cairia no env do host.
  const gh = opts.grokHomeEnv !== undefined ? opts.grokHomeEnv : process.env.GROK_HOME;
  if (gh && gh.trim()) {
    homes.add(grokSessionsRoot(gh.trim(), true));
  }
  return [...homes];
}

/** Garante que o path a remover fica estritamente sob o root de sessions. */
export function isPathInsideSessionsRoot(full: string, root: string): boolean {
  const resolvedFull = path.resolve(full);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolvedFull);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Soma bytes de um dir (best-effort; erros → 0 nesse ramo). */
export function dirByteSize(dir: string, fsApi: GrokSessionCleanupFs, depth = 0): number {
  if (depth > 32) return 0;
  let total = 0;
  let entries: string[];
  try {
    entries = fsApi.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = fsApi.statSync(p);
      if (st.isDirectory()) total += dirByteSize(p, fsApi, depth + 1);
      else total += st.size || 0;
    } catch {
      /* skip */
    }
  }
  return total;
}

export function formatCleanupSummary(r: GrokSessionCleanupResult): string {
  const mode = r.dryRun ? "dry-run" : "apply";
  return (
    `grok session cleanup [${mode}]: removed=${r.removed} kept=${r.kept} ` +
    `bytesFreed=${r.bytesFreed} scanned=${r.scanned} errors=${r.errors}`
  );
}

/**
 * Sweep seletivo. Por default: dry-run logado (lista + totais) e depois apply.
 * `dryRun: true` só planeja; `dryRun: false` + `skipDryRunLog: true` aplica
 * sem o log prévio (raro — testes).
 */
export function cleanGrokTempSessions(opts: {
  roots?: string[];
  nowMs?: number;
  ttlMs?: number;
  fs?: GrokSessionCleanupFs;
  log?: (level: "info" | "warn", msg: string) => void;
  /** Só planeja (default false = aplica após dry-run log). */
  dryRun?: boolean;
  /** Se true, não emite o dry-run prévio quando for apply (testes). */
  skipDryRunLog?: boolean;
} = {}): GrokSessionCleanupResult {
  const ttlMs = opts.ttlMs ?? DEFAULT_GROK_SESSION_TTL_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - ttlMs;
  const fsApi = opts.fs ?? defaultFs;
  const log = opts.log;
  const dryRun = opts.dryRun === true;
  const roots = opts.roots ?? resolveGrokSessionRoots();

  // 1) Planejar candidatos (sempre, inclusive no apply)
  const plan = planRemovals({ roots, cutoff, fsApi, log });

  if (!opts.skipDryRunLog || dryRun) {
    log?.(
      "info",
      `grok session cleanup dry-run: candidates=${plan.candidates.length} ` +
        `bytes=${plan.bytesFreed} kept=${plan.kept} scanned=${plan.scanned}` +
        (plan.candidates.length
          ? ` sample=[${plan.candidates.slice(0, 5).map((c) => path.basename(c)).join(", ")}]`
          : ""),
    );
  }

  if (dryRun) {
    const result: GrokSessionCleanupResult = {
      ...plan,
      removed: plan.candidates.length,
      dryRun: true,
      roots: [...roots],
    };
    log?.("info", formatCleanupSummary(result));
    return result;
  }

  // 2) Apply — só rm sob roots de sessions; erro isolado não derruba o daemon
  let removed = 0;
  let bytesFreed = 0;
  let errors = plan.errors;
  const removedPaths: string[] = [];

  for (let i = 0; i < plan.candidates.length; i++) {
    const full = plan.candidates[i]!;
    const bytes = plan.candidateBytes[i] ?? 0;
    // Defense-in-depth: path precisa estar sob um root conhecido
    if (!roots.some((root) => isPathInsideSessionsRoot(full, root))) {
      errors += 1;
      log?.("warn", `grok session cleanup: recusou path fora de sessions: ${full}`);
      continue;
    }
    try {
      fsApi.rmSync(full, { recursive: true, force: true });
      removed += 1;
      bytesFreed += bytes;
      removedPaths.push(full);
    } catch (e) {
      errors += 1;
      log?.("warn", `grok session cleanup: falha em ${path.basename(full)}: ${(e as Error).message}`);
    }
  }

  const result: GrokSessionCleanupResult = {
    scanned: plan.scanned,
    removed,
    kept: plan.kept,
    errors,
    bytesFreed,
    candidates: removedPaths,
    roots: [...roots],
    dryRun: false,
  };
  log?.("info", formatCleanupSummary(result));
  return result;
}

function planRemovals(input: {
  roots: string[];
  cutoff: number;
  fsApi: GrokSessionCleanupFs;
  log?: (level: "info" | "warn", msg: string) => void;
}): {
  scanned: number;
  kept: number;
  errors: number;
  bytesFreed: number;
  candidates: string[];
  candidateBytes: number[];
} {
  let scanned = 0;
  let kept = 0;
  let errors = 0;
  let bytesFreed = 0;
  const candidates: string[] = [];
  const candidateBytes: number[] = [];

  for (const root of input.roots) {
    let entries: string[];
    try {
      entries = input.fsApi.readdirSync(root);
    } catch {
      // root inexistente — normal em hosts sem grok ainda
      continue;
    }

    for (const name of entries) {
      scanned += 1;
      if (!isTheDudesCliSessionDir(name)) {
        kept += 1;
        continue;
      }
      const full = path.join(root, name);
      if (!isPathInsideSessionsRoot(full, root)) {
        kept += 1;
        continue;
      }
      try {
        const st = input.fsApi.statSync(full);
        if (!st.isDirectory()) {
          kept += 1;
          continue;
        }
        if (st.mtimeMs > input.cutoff) {
          kept += 1; // dentro do TTL
          continue;
        }
        const bytes = dirByteSize(full, input.fsApi);
        candidates.push(full);
        candidateBytes.push(bytes);
        bytesFreed += bytes;
      } catch (e) {
        errors += 1;
        input.log?.("warn", `grok session cleanup: stat falhou em ${name}: ${(e as Error).message}`);
      }
    }
  }

  return { scanned, kept, errors, bytesFreed, candidates, candidateBytes };
}

/**
 * Agenda sweep no boot (imediato) + periódico. `stop()` no shutdown.
 * Timers usam unref para não segurar o process se só restar o GC.
 */
export function scheduleGrokSessionCleanup(opts: {
  roots?: string[];
  ttlMs?: number;
  intervalMs?: number;
  log?: (level: "info" | "warn", msg: string) => void;
  run?: () => GrokSessionCleanupResult;
}): { stop: () => void; runNow: () => GrokSessionCleanupResult } {
  const intervalMs = opts.intervalMs ?? DEFAULT_GROK_SESSION_SWEEP_INTERVAL_MS;
  const run =
    opts.run ??
    (() =>
      cleanGrokTempSessions({
        roots: opts.roots,
        ttlMs: opts.ttlMs,
        log: opts.log,
      }));

  const runNow = () => {
    try {
      return run();
    } catch (e) {
      opts.log?.("warn", `grok session cleanup crash: ${(e as Error).message}`);
      return {
        scanned: 0,
        removed: 0,
        kept: 0,
        errors: 1,
        bytesFreed: 0,
        candidates: [],
        roots: opts.roots ?? [],
        dryRun: false,
      };
    }
  };

  // boot: síncrono e best-effort (não bloqueia start por I/O lento)
  runNow();

  const timer = setInterval(() => {
    runNow();
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
    },
    runNow,
  };
}
