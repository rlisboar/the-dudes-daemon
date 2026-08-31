/**
 * T-051: limpa sessões Grok Build criadas pelo summarizer (cwd the-dudes-cli-*).
 *
 * O CLI persiste estado por cwd em `$GROK_HOME/sessions/<encodeURIComponent(cwd)>/`.
 * Cada one-shot de `runCliText` (summarizer) usa `mkdtemp(the-dudes-cli-*)` e deixa
 * um dir órfão no home do user (chegou a 2k+ dirs / ~4GB). Esta rotina remove
 * APENAS entradas cujo path decodificado tem basename `the-dudes-cli-*` e mtime
 * além do TTL. Sessões de projetos reais, alertai-ia-*, worktrees etc. ficam
 * intactas.
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
  removed: number;
  skipped: number;
  errors: number;
  roots: string[];
}

export interface GrokSessionCleanupFs {
  readdirSync: (dir: string) => string[];
  statSync: (p: string) => { isDirectory: () => boolean; mtimeMs: number };
  rmSync: (p: string, opts: { recursive: boolean; force: boolean }) => void;
}

const defaultFs: GrokSessionCleanupFs = {
  readdirSync: (dir) => readdirSync(dir),
  statSync: (p) => {
    const s = statSync(p);
    return { isDirectory: () => s.isDirectory(), mtimeMs: s.mtimeMs };
  },
  rmSync: (p, opts) => rmSync(p, opts),
};

/**
 * Basename decodificado do entry de sessão é `the-dudes-cli-*`?
 * Só o basename — evita falso positivo em paths tipo
 * `/Users/x/docs/the-dudes-cli-notes/repo`.
 */
export function isTheDudesCliSessionDir(encodedName: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedName);
  } catch {
    return false;
  }
  if (!decoded || decoded.includes("\0")) return false;
  const base = path.basename(decoded.replace(/\/+$/, ""));
  return base.startsWith(THE_DUDES_CLI_PREFIX) && base.length > THE_DUDES_CLI_PREFIX.length;
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

export function cleanGrokTempSessions(opts: {
  roots?: string[];
  nowMs?: number;
  ttlMs?: number;
  fs?: GrokSessionCleanupFs;
  log?: (level: "info" | "warn", msg: string) => void;
} = {}): GrokSessionCleanupResult {
  const ttlMs = opts.ttlMs ?? DEFAULT_GROK_SESSION_TTL_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - ttlMs;
  const fsApi = opts.fs ?? defaultFs;
  const log = opts.log;
  const roots = opts.roots ?? resolveGrokSessionRoots();

  const result: GrokSessionCleanupResult = {
    scanned: 0,
    removed: 0,
    skipped: 0,
    errors: 0,
    roots: [...roots],
  };

  for (const root of roots) {
    let entries: string[];
    try {
      entries = fsApi.readdirSync(root);
    } catch {
      // root inexistente — normal em hosts sem grok ainda
      continue;
    }

    for (const name of entries) {
      result.scanned += 1;
      if (!isTheDudesCliSessionDir(name)) {
        result.skipped += 1;
        continue;
      }
      const full = path.join(root, name);
      try {
        const st = fsApi.statSync(full);
        if (!st.isDirectory()) {
          result.skipped += 1;
          continue;
        }
        if (st.mtimeMs > cutoff) {
          result.skipped += 1; // ainda dentro do TTL
          continue;
        }
        fsApi.rmSync(full, { recursive: true, force: true });
        result.removed += 1;
      } catch (e) {
        result.errors += 1;
        log?.("warn", `grok session cleanup: falha em ${name}: ${(e as Error).message}`);
      }
    }
  }

  if (result.removed > 0 || result.errors > 0) {
    log?.(
      "info",
      `grok session cleanup: removed=${result.removed} skipped=${result.skipped} scanned=${result.scanned} errors=${result.errors} ttlMs=${ttlMs}`,
    );
  }

  return result;
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
      return { scanned: 0, removed: 0, skipped: 0, errors: 1, roots: opts.roots ?? [] };
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
