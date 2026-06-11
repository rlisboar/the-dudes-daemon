import path from "node:path";
import { statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

export interface BuildOpts {
  /** true = `graphify extract` (AST + semântico via LLM, indexa docs/.md/.yaml
   *  além de código). false/undefined = `graphify update` (code-only, local). */
  semantic?: boolean;
  /** backend LLM do graphify: claude-cli (usa o claude Code, sem key) |
   *  gemini | openai | anthropic | deepseek | ollama | kimi | "auto".
   *  Não-claude-cli leem a API key do ENV do daemon. Vazio = claude-cli. */
  backend?: string;
  /** path absoluto do `claude` CLI — necessário p/ backend claude-cli
   *  (graphify resolve `claude` via PATH, então injetamos o dir). */
  claudeCmd?: string;
  /** modelo dentro do backend (ex haiku/sonnet/opus, gpt-4.1-mini,
   *  gemini-3-flash-preview, qwen2.5-coder:7b). graphify lê via env por backend. */
  model?: string;
  timeoutMs?: number;
}

/** env var de modelo por backend do graphify (ver llm.py model_env_key). */
const MODEL_ENV: Record<string, string> = {
  "claude-cli": "GRAPHIFY_CLAUDE_CLI_MODEL",
  gemini: "GRAPHIFY_GEMINI_MODEL",
  openai: "GRAPHIFY_OPENAI_MODEL",
  deepseek: "GRAPHIFY_DEEPSEEK_MODEL",
  azure: "GRAPHIFY_AZURE_MODEL",
  bedrock: "GRAPHIFY_BEDROCK_MODEL",
  ollama: "OLLAMA_MODEL",
};

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
  /** tokens gastos no modo semântico (parseados do output do graphify). */
  inputTokens?: number;
  outputTokens?: number;
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

/** graphify respeita .gitignore. Workspaces defensivos (the-dudes) usam um
 *  .gitignore `*` (ignora TUDO pra nunca vazar num push acidental) → graphify
 *  não veria NENHUM arquivo. graphify prefere .graphifyignore sobre .gitignore;
 *  então, SÓ no caso "ignora-tudo", escrevemos um .graphifyignore com defaults
 *  sãos (pula ruído, indexa código+docs). Em repos normais, não toca — respeita
 *  o .gitignore do projeto. */
function ensureGraphifyignore(workspaceRoot: string): void {
  try {
    const gi = path.join(workspaceRoot, ".graphifyignore");
    if (existsSync(gi)) return; // já existe → respeita
    let ignoreAll = false;
    try {
      const txt = readFileSync(path.join(workspaceRoot, ".gitignore"), "utf8");
      ignoreAll = txt.split(/\r?\n/).some((l) => l.trim() === "*");
    } catch { return; } // sem .gitignore → nada a fazer
    if (!ignoreAll) return; // .gitignore normal → respeita
    const defaults = [
      ".git/", "node_modules/", "graphify-out/", "dist/", "build/", "out/",
      ".venv/", "venv/", "__pycache__/", ".next/", "target/", "vendor/",
      ".cache/", "coverage/", "*.min.js", "*.min.css",
      "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "",
    ].join("\n");
    writeFileSync(gi, defaults, { mode: 0o600 });
  } catch { /* best-effort */ }
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
 * Indexa o workspace de forma ASSÍNCRONA (spawn, não trava o event loop).
 * - modo padrão (code-only): `graphify update` — local, sem LLM/egress.
 * - modo semântico: `graphify extract` — AST + LLM (indexa docs/.md/.yaml/.pdf)
 *   via backend claude-cli (usa o `claude` Code do user). Mais lento e faz
 *   egress (chamadas ao modelo). Single-flight por (root, modo).
 * Parseia "Rebuilt: N nodes, M edges" (fallback: conta do JSON).
 */
export function buildGraph(
  workspaceRoot: string,
  graphifyBin: string,
  opts: BuildOpts = {},
): Promise<GraphBuildResult> {
  if (!workspaceRoot) return Promise.resolve({ ok: false, error: "workspaceRoot vazio" });
  const key = path.resolve(workspaceRoot) + (opts.semantic ? ":sem" : ":code");
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = runBuild(workspaceRoot, graphifyBin, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function runBuild(
  workspaceRoot: string,
  graphifyBin: string,
  opts: BuildOpts,
): Promise<GraphBuildResult> {
  // semântico é mais lento (LLM sequencial via claude-cli) → timeout maior.
  const timeoutMs = opts.timeoutMs ?? (opts.semantic ? 900_000 : 180_000);
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (r: GraphBuildResult) => { if (!settled) { settled = true; resolve(r); } };
    ensureGraphifyignore(workspaceRoot); // .gitignore `*` esconderia tudo do graphify
    let proc: ReturnType<typeof spawn>;
    try {
      if (opts.semantic) {
        // `extract` faz AST + semântico via LLM. Backend via flag --backend.
        // claude-cli usa o claude Code local (sem key) — graphify resolve
        // `claude` via PATH, então injetamos o dir. Outros backends leem a API
        // key do env do daemon. Herda o resto do env (HOME etc).
        const backend = opts.backend || "claude-cli";
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (backend === "claude-cli" && opts.claudeCmd) {
          env.PATH = `${path.dirname(opts.claudeCmd)}:${process.env.PATH ?? ""}`;
        }
        if (opts.model && backend !== "auto") {
          const mEnv = MODEL_ENV[backend];
          if (mEnv) env[mEnv] = opts.model;
        }
        const args = ["extract", workspaceRoot];
        if (backend !== "auto") args.push("--backend", backend);
        proc = spawn(graphifyBin, args, { cwd: workspaceRoot, env });
      } else {
        // code-only: build local; herda PATH pro python resolver libs.
        proc = spawn(graphifyBin, ["update", workspaceRoot], { cwd: workspaceRoot });
      }
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
      // tokens (modo semântico): "[graphify extract] tokens: 1,234 in / 56 out, …"
      const tm = out.match(/tokens:\s*([\d,]+)\s*in\s*\/\s*([\d,]+)\s*out/i);
      const inputTokens = tm ? Number(tm[1].replace(/,/g, "")) : undefined;
      const outputTokens = tm ? Number(tm[2].replace(/,/g, "")) : undefined;
      // "Rebuilt: 17 nodes, 19 edges, 3 communities"
      const m = out.match(/Rebuilt:\s*(\d+)\s+nodes?,\s*(\d+)\s+edges?/i);
      if (m) {
        done({ ok: true, nodeCount: Number(m[1]), edgeCount: Number(m[2]), inputTokens, outputTokens });
      } else {
        // caminho incremental/no-op pode não imprimir "Rebuilt:" — conta do JSON
        const c = countFromJson(workspaceRoot);
        done({ ok: true, nodeCount: c.nodeCount, edgeCount: c.edgeCount, inputTokens, outputTokens });
      }
    });
  });
}
