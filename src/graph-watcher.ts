/**
 * Watch debounced do workspace → `graphify update` (code-only, local).
 * Mantém o índice fresco sem reindex manual entre spawns de agentes.
 *
 * Um watcher por root resolvido. Ignora dirs ruidosos (node_modules, dist,
 * graphify-out, .git…). Single-flight via buildGraph.
 */
import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { buildGraph, graphExists, graphMtime, type GraphBuildResult } from "./graph-indexer.js";

const IGNORE_DIR = new Set([
  "node_modules", "graphify-out", ".git", "dist", "build", "out", ".next",
  "coverage", ".cache", "venv", ".venv", "__pycache__", "target", "vendor",
  ".turbo", ".nx", "Pods",
]);

function shouldIgnore(relOrName: string): boolean {
  const parts = relOrName.split(/[/\\]/).filter(Boolean);
  return parts.some((p) => IGNORE_DIR.has(p) || p.startsWith("."));
}

export interface GraphWatchHandlers {
  onStatus: (status: "building" | "ready" | "error", info?: {
    nodeCount?: number;
    edgeCount?: number;
    error?: string;
    indexMtime?: number;
    stale?: boolean;
    phase?: string;
    progress?: number;
  }) => void;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  /** Debounce padrão 3s — agrupa saves em rajada. */
  debounceMs?: number;
}

interface WatchEntry {
  root: string;
  graphifyBin: string;
  projectId?: string;
  handlers: GraphWatchHandlers;
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const watches = new Map<string, WatchEntry>();

function keyOf(root: string): string {
  return path.resolve(root);
}

async function runUpdate(entry: WatchEntry): Promise<void> {
  if (entry.closed) return;
  entry.handlers.onStatus("building", { phase: "watch", progress: 5, stale: true });
  entry.handlers.log?.("info", `[graph-watch] reindex ${entry.root}`);
  let r: GraphBuildResult;
  try {
    r = await buildGraph(entry.root, entry.graphifyBin, {
      onProgress: (p) => entry.handlers.onStatus("building", {
        phase: p.phase ?? "watch",
        progress: p.progress,
        stale: true,
      }),
    });
  } catch (e) {
    entry.handlers.onStatus("error", { error: (e as Error).message, phase: "watch" });
    return;
  }
  if (entry.closed) return;
  if (r.ok) {
    entry.handlers.onStatus("ready", {
      nodeCount: r.nodeCount,
      edgeCount: r.edgeCount,
      indexMtime: graphMtime(entry.root),
      stale: false,
      phase: "watch",
      progress: 100,
    });
  } else {
    // falha no watch: marca stale, mantém índice antigo se existir
    entry.handlers.onStatus(graphExists(entry.root) ? "ready" : "error", {
      error: r.error,
      nodeCount: r.nodeCount,
      edgeCount: r.edgeCount,
      indexMtime: graphMtime(entry.root),
      stale: true,
      phase: "watch",
    });
    entry.handlers.log?.("warn", `[graph-watch] falhou: ${r.error}`);
  }
}

function schedule(entry: WatchEntry): void {
  if (entry.closed) return;
  const ms = entry.handlers.debounceMs ?? 3000;
  if (entry.timer) clearTimeout(entry.timer);
  // avisa UI que está stale enquanto espera o debounce
  entry.handlers.onStatus("ready", {
    indexMtime: graphMtime(entry.root),
    stale: true,
    phase: "watch-pending",
  });
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void runUpdate(entry);
  }, ms);
}

/**
 * Garante um watcher pro root. Reusa se já existe; atualiza handlers/bin.
 * No-op se o root não tem índice ainda (chame de novo após o 1º build).
 */
export function ensureGraphWatch(
  workspaceRoot: string,
  graphifyBin: string,
  handlers: GraphWatchHandlers,
  projectId?: string,
): void {
  if (!workspaceRoot || !graphifyBin) return;
  const key = keyOf(workspaceRoot);
  const existing = watches.get(key);
  if (existing && !existing.closed) {
    existing.graphifyBin = graphifyBin;
    existing.handlers = handlers;
    existing.projectId = projectId ?? existing.projectId;
    return;
  }

  const entry: WatchEntry = {
    root: key,
    graphifyBin,
    projectId,
    handlers,
    watcher: null,
    timer: null,
    closed: false,
  };

  try {
    // recursive: true (macOS/Windows/Linux moderno). Em falha, segue sem watch.
    entry.watcher = watch(key, { recursive: true }, (_event, filename) => {
      if (entry.closed) return;
      const name = filename ? String(filename) : "";
      if (name && shouldIgnore(name)) return;
      // também ignora o próprio graphify-out se o evento vier sem path relativo
      if (name.includes("graphify-out")) return;
      schedule(entry);
    });
    entry.watcher.on("error", (e) => {
      entry.handlers.log?.("warn", `[graph-watch] watcher error: ${(e as Error).message}`);
    });
    watches.set(key, entry);
    handlers.log?.("info", `[graph-watch] ativo em ${key}`);
  } catch (e) {
    handlers.log?.("warn", `[graph-watch] não iniciou: ${(e as Error).message}`);
  }
}

export function stopGraphWatch(workspaceRoot: string): void {
  const key = keyOf(workspaceRoot);
  const entry = watches.get(key);
  if (!entry) return;
  entry.closed = true;
  if (entry.timer) clearTimeout(entry.timer);
  try { entry.watcher?.close(); } catch { /* noop */ }
  watches.delete(key);
}

export function stopAllGraphWatches(): void {
  for (const key of [...watches.keys()]) stopGraphWatch(key);
}
