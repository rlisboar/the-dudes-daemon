import path from "node:path";
import { homedir } from "node:os";
import { statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ResolvedCliCommands } from "./cli-config.js";
import type { DropTarget } from "./privileges.js";
import type { CliRunner } from "./types.js";
import { startCliShim, type CliShim } from "./graph-llm-shim.js";

export interface BuildOpts {
  /** true = `graphify extract` (AST + semântico via LLM, indexa docs/.md/.yaml
   *  além de código). false/undefined = `graphify update` (code-only, local). */
  semantic?: boolean;
  /** backend LLM do graphify: claude-cli (usa o claude Code, sem key) |
   *  gemini | openai | anthropic | deepseek | ollama | kimi | "auto" |
   *  opencode-cli | codex-cli | gemini-cli (CLIs via shim OpenAI-compat).
   *  Não-claude-cli/HTTP leem a API key do ENV do daemon. Vazio = claude-cli. */
  backend?: string;
  /** path absoluto do `claude` CLI — necessário p/ backend claude-cli
   *  (graphify resolve `claude` via PATH, então injetamos o dir). */
  claudeCmd?: string;
  /** modelo dentro do backend (ex haiku/sonnet/opus, gpt-4.1-mini,
   *  gemini-3-flash-preview, qwen2.5-coder:7b). graphify lê via env por backend. */
  model?: string;
  /** API key (já decifrada) + env var do backend (ex GEMINI_API_KEY). Injetada
   *  no env do graphify pros backends que leem key do ambiente. */
  apiKeyEnv?: string;
  apiKey?: string;
  /** CLIs resolvidos do daemon — necessário pros backends *-cli (shim). */
  cliCommands?: ResolvedCliCommands;
  /** drop de privilégios pros CLIs do shim (igual aos agentes). */
  dropTo?: DropTarget | null;
  /** logger do daemon (status do shim). */
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  timeoutMs?: number;
}

/** Backends *-cli → runner do shim OpenAI-compat. claude tem backend nativo
 *  (claude-cli), então não passa pelo shim. */
const CLI_SHIM_RUNNER: Record<string, CliRunner> = {
  "opencode-cli": "opencode",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
};

// O graphify roda `claude -p` SEM CLAUDE_CONFIG_DIR → claude usa o default
// (~/.claude), que pode não estar autenticado (a auth pode estar em
// ~/.config/claude, ~/.claude-eonf, ou no env). Descobrimos qual dir autentica
// (probe rápido, cache por processo) e passamos pro graphify. Resolve o exit 1
// silencioso (401 que o claude joga no stdout JSON e o graphify descarta).
let _authedClaudeCfg: string | null | undefined; // undefined=não testado, null=nenhum, string=dir
function probeClaudeAuth(claudeCmd: string, cfgDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out = ""; let settled = false;
    const fin = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    let pr: ReturnType<typeof spawn>;
    try {
      pr = spawn(claudeCmd, ["-p", "--output-format", "json", "ok"], { env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir } });
    } catch { fin(false); return; }
    const t = setTimeout(() => { try { pr.kill("SIGKILL"); } catch { /* noop */ } fin(false); }, 30_000);
    pr.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    pr.on("error", () => { clearTimeout(t); fin(false); });
    pr.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return fin(false);
      try { fin(JSON.parse(out)?.is_error !== true); } catch { fin(false); }
    });
  });
}
async function resolveAuthedClaudeConfigDir(claudeCmd: string): Promise<string | undefined> {
  if (_authedClaudeCfg !== undefined) return _authedClaudeCfg ?? undefined;
  const home = homedir();
  const cands = [process.env.CLAUDE_CONFIG_DIR, path.join(home, ".claude-eonf"), path.join(home, ".config", "claude"), path.join(home, ".claude")]
    .filter((d): d is string => !!d && existsSync(d));
  const seen = new Set<string>();
  for (const dir of cands) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (await probeClaudeAuth(claudeCmd, dir)) { _authedClaudeCfg = dir; return dir; }
  }
  _authedClaudeCfg = null;
  return undefined;
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

async function runBuild(
  workspaceRoot: string,
  graphifyBin: string,
  opts: BuildOpts,
): Promise<GraphBuildResult> {
  // semântico é mais lento (LLM sequencial via claude-cli) → timeout maior.
  const timeoutMs = opts.timeoutMs ?? (opts.semantic ? 900_000 : 180_000);
  // Descobre o CLAUDE_CONFIG_DIR autenticado (probe + cache) p/ o claude-cli do
  // graphify não cair no default ~/.claude desautenticado (401 → exit 1).
  let claudeCfgDir: string | undefined;
  if (opts.semantic && (opts.backend || "claude-cli") === "claude-cli" && opts.claudeCmd) {
    claudeCfgDir = await resolveAuthedClaudeConfigDir(opts.claudeCmd);
  }
  // Backend *-cli: sobe o shim OpenAI-compat ANTES do graphify (precisa do
  // baseUrl/token). O graphify roda como `--backend openai` apontando pro shim.
  const reqBackend = opts.backend || "claude-cli";
  const shimRunner: CliRunner | undefined = opts.semantic ? CLI_SHIM_RUNNER[reqBackend] : undefined;
  let shim: CliShim | undefined;
  if (shimRunner) {
    if (!opts.cliCommands?.[shimRunner]?.available) {
      return { ok: false, error: `backend ${reqBackend} exige o CLI '${shimRunner}' instalado no daemon` };
    }
    try {
      shim = await startCliShim({
        runner: shimRunner,
        model: opts.model,
        cliCommands: opts.cliCommands,
        dropTo: opts.dropTo,
        claudeConfigDir: claudeCfgDir,
        log: opts.log,
      });
    } catch (e) {
      return { ok: false, error: `falha ao subir o shim ${shimRunner}: ${(e as Error).message}` };
    }
  }
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (r: GraphBuildResult) => {
      if (!settled) { settled = true; try { shim?.stop(); } catch { /* noop */ } resolve(r); }
    };
    ensureGraphifyignore(workspaceRoot); // .gitignore `*` esconderia tudo do graphify
    let proc: ReturnType<typeof spawn>;
    try {
      if (opts.semantic) {
        // `extract` faz AST + semântico via LLM. Backend via flag --backend.
        // claude-cli usa o claude Code local (sem key) — graphify resolve
        // `claude` via PATH, então injetamos o dir. Outros backends leem a API
        // key do env do daemon. Herda o resto do env (HOME etc).
        let backend = reqBackend;
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (shim) {
          // Backend *-cli: graphify fala OpenAI-compat com o shim local.
          backend = "openai";
          env.OPENAI_BASE_URL = shim.baseUrl;
          env.OPENAI_API_KEY = shim.token;
          // label (o modelo real é forçado pelo CLI); seta as duas env vars que
          // versões diferentes do graphify leem.
          env.OPENAI_MODEL = shim.model;
          env.GRAPHIFY_OPENAI_MODEL = shim.model;
        } else {
          if (backend === "claude-cli" && opts.claudeCmd) {
            env.PATH = `${path.dirname(opts.claudeCmd)}:${process.env.PATH ?? ""}`;
            if (claudeCfgDir) env.CLAUDE_CONFIG_DIR = claudeCfgDir; // dir autenticado
          }
          if (opts.model && backend !== "auto") {
            const mEnv = MODEL_ENV[backend];
            if (mEnv) env[mEnv] = opts.model;
          }
          // API key do backend (do vault, já decifrada) → env var do backend.
          if (opts.apiKeyEnv && opts.apiKey) env[opts.apiKeyEnv] = opts.apiKey;
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
        // Prioriza linhas que parecem o ERRO real (claude-cli/python) em vez do
        // tail de progresso — senão a msg mostra "...semantic extraction..." e
        // esconde a causa. Cap maior pra a causa caber.
        const lines = out.trim().split("\n").filter(Boolean);
        const errRe = /error|exception|traceback|failed|rate.?limit|unauthorized|forbidden|not found|timeout|denied|invalid|quota|\b4\d\d\b|\b5\d\d\b/i;
        const errLines = lines.filter((l) => errRe.test(l) && !/\[graphify extract\]\s+(AST|semantic) extraction/i.test(l));
        const picked = (errLines.length ? errLines : lines).slice(-4).join(" | ").slice(0, 800);
        const cmd = opts.semantic ? "extract" : "update";
        // Hint p/ o caso comum: todos os chunks do claude-cli falham (exit 1,
        // stderr vazio) = o claude retornou erro no stdout JSON (que o graphify
        // descarta) — quase sempre rate/usage limit do Claude no lote de N
        // arquivos. Single call funciona; o lote (chunks ~paralelos) estoura.
        let hint = "";
        if (/semantic chunk.*failed|all semantic chunks failed|claude -p exited/i.test(out)) {
          if (shimRunner) {
            hint = ` — o CLI '${shimRunner}' falhou via shim (login/modelo do '${shimRunner}'?). Veja o log do daemon ([graph-shim]) ou tente outro backend.`;
          } else if (opts.semantic && reqBackend === "claude-cli") {
            const cfgNote = _authedClaudeCfg
              ? `config dir testado: ${_authedClaudeCfg}`
              : "nenhum CLAUDE_CONFIG_DIR autenticado encontrado — rode 'claude' e faça login";
            hint =
              ` — claude-cli falhou (${cfgNote}). Pode ser auth (401, erro vai no stdout JSON que o graphify descarta)` +
              " ou rate-limit. Tente outro backend (Gemini/DeepSeek/Ollama) ou reduza o escopo (.graphifyignore).";
          } else {
            hint = " — verifique a API key do backend (credencial no vault) e o escopo (.graphifyignore).";
          }
        }
        done({ ok: false, error: `graphify ${cmd} exit ${code}: ${picked}${hint}` });
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
