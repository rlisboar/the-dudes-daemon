import path from "node:path";
import { homedir } from "node:os";
import { statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ResolvedCliCommands } from "./cli-config.js";
import type { DropTarget } from "./privileges.js";
import type { CliRunner } from "./types.js";
import { startCliShim, type CliShim } from "./graph-llm-shim.js";

export interface GraphProgress {
  phase?: string;
  progress?: number;
  message?: string;
}

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
  /** Progresso parseado do stdout (extract/update). */
  onProgress?: (p: GraphProgress) => void;
}

/** Backends *-cli → runner do shim OpenAI-compat. claude tem backend nativo
 *  (claude-cli), então não passa pelo shim.
 *
 *  Importante (graphify ≥0.8): o backend `openai` **ignora** OPENAI_BASE_URL
 *  (base_url fixo em api.openai.com). O backend `ollama` lê OLLAMA_BASE_URL
 *  do env no import — por isso o shim se apresenta como ollama apontando pro
 *  loopback. */
const CLI_SHIM_RUNNER: Record<string, CliRunner> = {
  "opencode-cli": "opencode",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  "qwen-cli": "qwen",
  "crush-cli": "crush",
  "grok-cli": "grok",
};

/** Backends nativos do graphify que usam API key (não CLI). */
export const GRAPHIFY_API_BACKENDS = new Set([
  "claude", "gemini", "openai", "deepseek", "kimi", "ollama", "azure", "anthropic",
]);

/** Normaliza aliases da UI → nome que o graphify entende. */
export function normalizeGraphifyBackend(backend?: string): string {
  const b = (backend || "claude-cli").trim();
  if (b === "anthropic") return "claude"; // graphify chama ANTHROPIC de "claude"
  return b;
}

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
  claude: "ANTHROPIC_MODEL", // fallback; graphify default model se ausente
  gemini: "GRAPHIFY_GEMINI_MODEL",
  openai: "GRAPHIFY_OPENAI_MODEL",
  deepseek: "GRAPHIFY_DEEPSEEK_MODEL",
  azure: "GRAPHIFY_AZURE_MODEL",
  bedrock: "GRAPHIFY_BEDROCK_MODEL",
  ollama: "OLLAMA_MODEL",
  kimi: "GRAPHIFY_KIMI_MODEL",
};

/** Env var de API key que o graphify lê por backend (llm.py env_key/env_keys). */
export const GRAPHIFY_BACKEND_KEY_ENV: Record<string, string[]> = {
  claude: ["ANTHROPIC_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  kimi: ["MOONSHOT_API_KEY"],
  ollama: ["OLLAMA_API_KEY"], // opcional em loopback
  azure: ["AZURE_OPENAI_API_KEY"],
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

/** mtime do graph.json em ms epoch, ou undefined se ausente. */
export function graphMtime(workspaceRoot: string): number | undefined {
  try {
    return statSync(graphPath(workspaceRoot)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Flag do graphify: docs/imagens mudaram e pedem re-extract semântico (+ docs). */
export function needsSemanticUpdate(workspaceRoot: string): boolean {
  try {
    return existsSync(path.join(graphDir(workspaceRoot), "needs_update"));
  } catch {
    return false;
  }
}

/** Marker escrito pelo `extract` quando houve camada semântica (docs). */
export function hasSemanticMarker(workspaceRoot: string): boolean {
  try {
    return existsSync(path.join(graphDir(workspaceRoot), ".graphify_semantic_marker"));
  } catch {
    return false;
  }
}

/**
 * Lê graph.json e, se grande demais ou com nós demais, devolve amostra dos
 * top-N por grau (mesmo critério do renderer web). Usado no graph:fetch.
 */
export function loadGraphJsonForUi(workspaceRoot: string, opts?: { maxBytes?: number; maxNodes?: number }): {
  json?: string;
  error?: string;
  truncated?: boolean;
  totalNodes?: number;
} {
  const maxBytes = opts?.maxBytes ?? 48 * 1024 * 1024;
  const maxNodes = opts?.maxNodes ?? 1200;
  const gp = graphPath(workspaceRoot);
  let st: { size: number };
  try {
    st = statSync(gp);
  } catch {
    return { error: "índice ainda não gerado — reindexe" };
  }
  if (st.size <= 0) return { error: "índice vazio — reindexe" };
  if (st.size > maxBytes) {
    return { error: `grafo muito grande (> ${Math.round(maxBytes / (1024 * 1024))}MB) pra renderizar — reduza o escopo (.graphifyignore) ou use as tools MCP do agente` };
  }
  let raw: string;
  try {
    raw = readFileSync(gp, "utf8");
  } catch (e) {
    return { error: (e as Error).message };
  }
  // Abaixo de ~4MB e poucos nós: manda cru (renderer web também capia).
  if (st.size < 4 * 1024 * 1024) {
    try {
      const j = JSON.parse(raw) as { nodes?: unknown[] };
      const n = Array.isArray(j.nodes) ? j.nodes.length : 0;
      if (n <= maxNodes) return { json: raw, truncated: false, totalNodes: n };
    } catch {
      return { error: "graph.json inválido" };
    }
  }
  // Sample top-N por grau
  try {
    const j = JSON.parse(raw) as {
      nodes?: Array<{ id?: string; label?: string; community?: number; [k: string]: unknown }>;
      edges?: Array<{ source?: string; target?: string; [k: string]: unknown }>;
      links?: Array<{ source?: string; target?: string; [k: string]: unknown }>;
      [k: string]: unknown;
    };
    const nodes = Array.isArray(j.nodes) ? j.nodes : [];
    const links = Array.isArray(j.links) ? j.links : Array.isArray(j.edges) ? j.edges : [];
    const totalNodes = nodes.length;
    if (totalNodes <= maxNodes) return { json: raw, truncated: false, totalNodes };
    const deg = new Map<string, number>();
    for (const l of links) {
      if (l.source != null) deg.set(String(l.source), (deg.get(String(l.source)) ?? 0) + 1);
      if (l.target != null) deg.set(String(l.target), (deg.get(String(l.target)) ?? 0) + 1);
    }
    const picked = [...nodes]
      .sort((a, b) => (deg.get(String(b.id)) ?? 0) - (deg.get(String(a.id)) ?? 0))
      .slice(0, maxNodes);
    const idSet = new Set(picked.map((n) => String(n.id)));
    const keptLinks = links.filter((l) => idSet.has(String(l.source)) && idSet.has(String(l.target)));
    const out = {
      ...j,
      nodes: picked,
      links: keptLinks,
      edges: undefined,
      _ui: { truncated: true, totalNodes, shown: picked.length },
    };
    return { json: JSON.stringify(out), truncated: true, totalNodes };
  } catch (e) {
    return { error: `falha ao amostrar grafo: ${(e as Error).message}` };
  }
}

/** Melhora mensagens de erro de backends CLI (auth/tier). */
export function friendlyGraphifyError(err: string): string {
  const e = err || "";
  if (/IneligibleTierError|no longer supported for Gemini Code Assist|migrate to the Antigravity/i.test(e)) {
    return "Gemini CLI: plano/tier individual não suportado neste ambiente. Use Gemini (API) com GEMINI_API_KEY no vault, ou outro runner (OpenCode/Claude Code/Grok).";
  }
  if (/not logged in|auth|unauthorized|401|login/i.test(e) && /gemini|codex|opencode|grok|crush|claude/i.test(e)) {
    return `${e.slice(0, 400)} — confira o login do CLI no daemon (rode o CLI uma vez no host).`;
  }
  return e;
}

/** Parseia linhas de progresso do graphify (AST / semantic N/M / tokens). */
export function parseGraphifyProgressLine(line: string): GraphProgress | null {
  const t = line.trim();
  if (!t) return null;
  // "Rebuilt: N nodes…" primeiro (também pode conter a palavra communities)
  if (/Rebuilt:\s*\d+\s+nodes?/i.test(t) || /nodes?,\s*\d+\s+edges?/i.test(t)) {
    return { phase: "done", progress: 100, message: t.slice(0, 200) };
  }
  // "[graphify extract] semantic extraction 3/12 …" ou "semantic 3/12"
  const sem = t.match(/semantic[^0-9]*(\d+)\s*\/\s*(\d+)/i);
  if (sem) {
    const cur = Number(sem[1]), tot = Math.max(1, Number(sem[2]));
    return { phase: "semantic", progress: Math.min(99, Math.round((cur / tot) * 100)), message: t.slice(0, 200) };
  }
  if (/AST\s+extraction|extracting\s+AST|\[graphify[^\]]*\]\s*AST/i.test(t)) {
    return { phase: "ast", progress: 15, message: t.slice(0, 200) };
  }
  if (/semantic\s+extraction|labeling\s+communit/i.test(t)) {
    return { phase: "semantic", progress: 40, message: t.slice(0, 200) };
  }
  // "semantic extraction on 3 files" / "chunk 2/8"
  const chunk = t.match(/chunk\s+(\d+)\s*\/\s*(\d+)/i);
  if (chunk) {
    const cur = Number(chunk[1]), tot = Math.max(1, Number(chunk[2]));
    return { phase: "semantic", progress: Math.min(99, Math.round((cur / tot) * 100)), message: t.slice(0, 200) };
  }
  const files = t.match(/semantic extraction on\s+(\d+)\s+files/i);
  if (files) {
    return { phase: "semantic", progress: 35, message: t.slice(0, 200) };
  }
  if (/\[graphify\s+update\]|incremental|nothing to (update|rebuild)/i.test(t)) {
    return { phase: "update", progress: 50, message: t.slice(0, 200) };
  }
  if (/preserving semantic|preserved semantic|preserve semantic/i.test(t)) {
    return { phase: "update", progress: 70, message: t.slice(0, 200) };
  }
  return null;
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
  const reqBackend = normalizeGraphifyBackend(opts.backend);
  if (opts.semantic && reqBackend === "claude-cli" && opts.claudeCmd) {
    claudeCfgDir = await resolveAuthedClaudeConfigDir(opts.claudeCmd);
  }
  // Backend *-cli: sobe o shim OpenAI-compat ANTES do graphify.
  // graphify 0.8+ ignora OPENAI_BASE_URL no backend openai — usamos ollama
  // (que lê OLLAMA_BASE_URL do env) apontando pro shim loopback.
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
        // claude-cli: nativo no graphify (claude -p no PATH).
        // *-cli: shim loopback via backend ollama + OLLAMA_BASE_URL.
        // API (gemini/openai/…): key do vault no env.
        let backend = reqBackend;
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (shim) {
          // graphify openai ignora OPENAI_BASE_URL; ollama honra OLLAMA_BASE_URL.
          backend = "ollama";
          env.OLLAMA_BASE_URL = shim.baseUrl;
          env.OLLAMA_API_KEY = shim.token; // shim exige Bearer
          env.OLLAMA_MODEL = shim.model;
          // permite chunks em paralelo no shim (default ollama é serial)
          env.GRAPHIFY_OLLAMA_PARALLEL = "1";
          // evita confusão se o user tiver OPENAI_* no ambiente
          delete env.OPENAI_BASE_URL;
          opts.log?.("info", `[graph] shim ${shimRunner} → graphify --backend ollama @ ${shim.baseUrl}`);
        } else {
          if (backend === "claude-cli" && opts.claudeCmd) {
            env.PATH = `${path.dirname(opts.claudeCmd)}:${process.env.PATH ?? ""}`;
            if (claudeCfgDir) env.CLAUDE_CONFIG_DIR = claudeCfgDir; // dir autenticado
          }
          if (opts.model && backend !== "auto") {
            const mEnv = MODEL_ENV[backend];
            if (mEnv) env[mEnv] = opts.model;
          }
          // API key do backend (do vault, já decifrada) → env var(s) do backend.
          if (opts.apiKey) {
            const envs = opts.apiKeyEnv
              ? [opts.apiKeyEnv]
              : (GRAPHIFY_BACKEND_KEY_ENV[backend] ?? []);
            for (const k of envs) if (k) env[k] = opts.apiKey;
          }
        }
        const args = ["extract", workspaceRoot];
        if (backend !== "auto") args.push("--backend", backend);
        // --model do graphify sobrescreve o default do backend
        if (opts.model) args.push("--model", opts.model);
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
      done({ ok: false, error: `graphify ${opts.semantic ? "extract" : "update"} timeout (${timeoutMs}ms)` });
    }, timeoutMs);
    let lineBuf = "";
    const onChunk = (c: Buffer) => {
      const s = c.toString();
      out += s;
      if (!opts.onProgress) return;
      lineBuf += s;
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop() ?? "";
      for (const line of parts) {
        const p = parseGraphifyProgressLine(line);
        if (p) {
          try { opts.onProgress(p); } catch { /* noop */ }
        }
      }
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
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
        done({ ok: false, error: friendlyGraphifyError(`graphify ${cmd} exit ${code}: ${picked}${hint}`) });
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
