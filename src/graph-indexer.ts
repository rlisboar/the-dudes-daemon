import path from "node:path";
import { statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

// Integração com graphify (knowledge graph). O build (`graphify update <path>`)
// é extração 100% LOCAL — sem LLM, sem egress, sem API key. Gera
// `<workspaceRoot>/graphify-out/graph.json`, servido depois por `graphify-mcp`
// via MCP stdio. A parte semântica (labeling de comunidades por LLM) é opcional
// e não é disparada aqui.

/** Diretório de saída do graphify dentro do workspace. */
export function graphDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, "graphify-out");
}

/** Caminho do graph.json gerado pelo graphify dentro do workspace. */
export function graphPath(workspaceRoot: string): string {
  return path.join(graphDir(workspaceRoot), "graph.json");
}

/** true se já existe um índice (graph.json) pro workspace. */
export function graphExists(workspaceRoot: string): boolean {
  try {
    return statSync(graphPath(workspaceRoot)).size > 0;
  } catch {
    return false;
  }
}

export interface GraphBuildResult {
  ok: boolean;
  nodeCount?: number;
  edgeCount?: number;
  error?: string;
}

// Single-flight por root resolvido: dois reindex simultâneos (ou reindex +
// auto-build no spawn) escreveriam no mesmo graphify-out/cache concorrentemente
// e poderiam corromper o índice. Builds pro mesmo root coalescem na mesma
// Promise. Compartilhado entre handleGraphBuild (main) e prepareGraphify (runner).
const inFlight = new Map<string, Promise<GraphBuildResult>>();

/** Conta nodes/edges lendo o graph.json — fallback quando o regex do stdout
 *  não casa (ex: caminho incremental sem mudanças não imprime "Rebuilt:"). */
function countFromJson(workspaceRoot: string): { nodeCount?: number; edgeCount?: number } {
  try {
    const j = JSON.parse(readFileSync(graphPath(workspaceRoot), "utf8")) as {
      nodes?: unknown[]; edges?: unknown[]; links?: unknown[];
    };
    const nodeCount = Array.isArray(j.nodes) ? j.nodes.length : undefined;
    const edges = Array.isArray(j.edges) ? j.edges : Array.isArray(j.links) ? j.links : undefined;
    return { nodeCount, edgeCount: edges?.length };
  } catch {
    return {};
  }
}

/** Mantém o índice fora do git: grava graphify-out/.gitignore com `*` (ignora
 *  todo o conteúdo do dir sem tocar o .gitignore do repo do user). O grafo é
 *  plaintext local e NÃO é E2EE — não deve vazar pro remoto via commit. */
function ensureGitignored(workspaceRoot: string): void {
  try {
    const dir = graphDir(workspaceRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".gitignore"), "*\n", { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/**
 * Roda `graphify update <workspaceRoot>` (extração local) de forma ASSÍNCRONA
 * (spawn, não spawnSync) — não trava o event loop do daemon enquanto indexa.
 * Idempotente, incremental (cache SHA256 em graphify-out/cache/) e single-flight
 * por root. Parseia "Rebuilt: N nodes, M edges" (fallback: conta do JSON).
 * Timeout defensivo mata o processo se passar do limite.
 */
export function buildGraph(
  workspaceRoot: string,
  graphifyBin: string,
  timeoutMs = 180_000,
): Promise<GraphBuildResult> {
  if (!workspaceRoot) return Promise.resolve({ ok: false, error: "workspaceRoot vazio" });
  const key = path.resolve(workspaceRoot);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = runBuild(workspaceRoot, graphifyBin, timeoutMs).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function runBuild(
  workspaceRoot: string,
  graphifyBin: string,
  timeoutMs: number,
): Promise<GraphBuildResult> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (r: GraphBuildResult) => { if (!settled) { settled = true; resolve(r); } };
    let proc: ReturnType<typeof spawn>;
    try {
      // sem env extra: build é local; herda PATH pro python resolver libs.
      proc = spawn(graphifyBin, ["update", workspaceRoot], { cwd: workspaceRoot });
    } catch (e) {
      done({ ok: false, error: `graphify spawn falhou: ${(e as Error).message}` });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      done({ ok: false, error: `graphify update timeout (${timeoutMs}ms)` });
    }, timeoutMs);
    proc.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    proc.stderr?.on("data", (c: Buffer) => { out += c.toString(); });
    proc.on("error", (e) => { clearTimeout(timer); done({ ok: false, error: `graphify spawn falhou: ${e.message}` }); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // Casos benignos: nada a indexar (workspace sem código) ou nenhuma
        // mudança no caminho incremental. graphify sai 1 mesmo assim.
        if (/no code files|nothing to (update|rebuild)/i.test(out)) {
          ensureGitignored(workspaceRoot);
          if (graphExists(workspaceRoot)) {
            const c = countFromJson(workspaceRoot);
            done({ ok: true, nodeCount: c.nodeCount, edgeCount: c.edgeCount });
          } else {
            done({ ok: false, error: "Nenhum arquivo de código encontrado no workspace — graphify indexa código (.py/.ts/.js/.go/…), não só docs/yaml." });
          }
          return;
        }
        const tail = out.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
        done({ ok: false, error: `graphify update exit ${code}: ${tail}` });
        return;
      }
      ensureGitignored(workspaceRoot);
      // "Rebuilt: 17 nodes, 19 edges, 3 communities"
      const m = out.match(/Rebuilt:\s*(\d+)\s+nodes?,\s*(\d+)\s+edges?/i);
      if (m) {
        done({ ok: true, nodeCount: Number(m[1]), edgeCount: Number(m[2]) });
      } else {
        // caminho incremental/no-op pode não imprimir "Rebuilt:" — conta do JSON
        const c = countFromJson(workspaceRoot);
        done({ ok: true, nodeCount: c.nodeCount, edgeCount: c.edgeCount });
      }
    });
  });
}
