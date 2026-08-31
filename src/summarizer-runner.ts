/**
 * One-shot CLI invocation used to pre-process agent output before TTS.
 *
 * Spawns the configured runner in headless/print mode in a fresh tmpdir
 * (no project context, no MCP, no session), feeds the agent's output as
 * the user message with the user's custom system prompt prepended, and
 * extracts the assistant text from stdout.
 *
 * Runs are stateless and capped at 60s. Failures bubble up to the orch
 * which reports them back to the web client; the web side falls back to
 * speaking the original (un-summarized) text on error.
 */

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedCliCommands } from "./cli-config.js";
import { extractOneShotText } from "./agent-runner.js";
import { spawnDropped, type DropTarget } from "./privileges.js";
import { normalizeGrokEffort } from "./runners/model-policy.js";
import { isGrokFamily } from "./runners/index.js";
import { acquireTurnSlot } from "./runners/turn-gate.js";
import type { CliRunner } from "./types.js";

export interface SummarizerArgs {
  runner: CliRunner;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  text: string;
  claudeConfigDir?: string;
  cliCommands: ResolvedCliCommands;
  dropTo?: DropTarget | null;
}

export interface SummarizerResult {
  ok: boolean;
  summary?: string;
  error?: string;
  usage?: { input: number; output: number };
}

// Best-effort token usage extraction from the runner's stdout. Each runner
// emits usage info in a different shape; we try the known ones and fall back
// to a char-based heuristic (~4 chars/token) when nothing parseable is found.
function extractUsage(out: string, runner: CliRunner, promptLen: number, outputLen: number): { input: number; output: number } {
  let input = 0;
  let output = 0;
  if (runner === "claude") {
    // claude -p --output-format json emits a single JSON {result, usage:{input_tokens,output_tokens,...}}
    try {
      const trimmed = out.trim();
      const parsed = JSON.parse(trimmed);
      const u = parsed?.usage ?? parsed?.result?.usage;
      if (u) {
        input = Number(u.input_tokens ?? 0);
        output = Number(u.output_tokens ?? 0);
      }
    } catch { /* fallthrough to heuristic */ }
  } else if (runner === "codex") {
    // codex exec --json emits stream events; look for usage field on any event
    for (const line of out.split("\n")) {
      try {
        const ev = JSON.parse(line.trim());
        const u = ev?.usage ?? ev?.item?.usage;
        if (u) {
          input = Math.max(input, Number(u.input_tokens ?? u.prompt_tokens ?? 0));
          output = Math.max(output, Number(u.output_tokens ?? u.completion_tokens ?? 0));
        }
      } catch { /* skip */ }
    }
  } else if (runner === "gemini") {
    for (const line of out.split("\n")) {
      try {
        const ev = JSON.parse(line.trim());
        const u = ev?.usage ?? ev?.usageMetadata;
        if (u) {
          input = Math.max(input, Number(u.input_tokens ?? u.promptTokenCount ?? 0));
          output = Math.max(output, Number(u.output_tokens ?? u.candidatesTokenCount ?? 0));
        }
      } catch { /* skip */ }
    }
  } else if (isGrokFamily(runner)) {
    // Grok json/stream não expõe usage confiável — heurística por chars abaixo.
  }
  if (input === 0 && output === 0) {
    // Heuristic: ~4 chars per token. Input = prompt; output = response text.
    input = Math.ceil(promptLen / 4);
    output = Math.ceil(outputLen / 4);
  }
  return { input, output };
}

const MAX_TIMEOUT_MS = 60_000;

function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (p === "$HOME" || p === "${HOME}") return home;
  if (p.startsWith("$HOME/")) return join(home, p.slice(6));
  if (p.startsWith("${HOME}/")) return join(home, p.slice(8));
  return p;
}

/** HTTP loopback ao opencode serve. Resolve com JSON; rejeita em !2xx/timeout. */
function ocFetch(baseUrl: string, path: string, method: string, body: unknown, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(baseUrl + path); } catch (e) { reject(e as Error); return; }
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const txt = Buffer.concat(chunks).toString("utf8");
          const sc = res.statusCode ?? 0;
          if (sc >= 200 && sc < 300) { try { resolve(txt ? JSON.parse(txt) : {}); } catch { resolve({}); } }
          else reject(new Error(`HTTP ${sc}${txt ? ` — ${txt.slice(0, 150)}` : ""}`));
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * One-shot via opencode usando o MESMO transporte dos agentes: sobe um
 * `opencode serve` efêmero, POST /session + POST /message, depois GET de TODAS
 * as mensagens (o POST só devolve a última; texto/tool ficam em msgs do loop).
 * `opencode run --format json` falhava aqui (reasoning models não serializam
 * texto no stdout). cwd limpo = sem opencode.json = provider zai-coding-plan ok.
 */
async function runOpenCodeText(prompt: string, args: CliTextArgs, cwd: string, env: NodeJS.ProcessEnv): Promise<CliTextResult> {
  const cliCommand = args.cliCommands.opencode!.command;
  const timeoutMs = args.timeoutMs ?? MAX_TIMEOUT_MS;
  // strip do sufixo legado de effort (glm-5.2:high) — não é configurável aqui
  const raw = (args.model ?? "").replace(/:(off|minimal|none|low|medium|high|xhigh|max)$/, "");
  const slash = raw.indexOf("/");
  const providerID = slash > 0 ? raw.slice(0, slash) : "";
  const modelID = slash > 0 ? raw.slice(slash + 1) : raw;

  let proc;
  try {
    proc = spawnDropped(cliCommand, ["serve", "--port", "0", "--hostname", "127.0.0.1"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] }, args.dropTo ?? null);
  } catch (e) {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: `opencode serve spawn falhou: ${(e as Error).message}` };
  }
  const cleanup = () => {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  try {
    const serveUrl = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const onData = (c: string) => { buf += c; const m = buf.match(/https?:\/\/[\w.:-]+:\d+/); if (m) resolve(m[0]); };
      proc.stdout?.setEncoding("utf8");
      proc.stderr?.setEncoding("utf8");
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      proc.on("exit", (code) => reject(new Error(`serve saiu antes de subir (code ${code})`)));
      setTimeout(() => reject(new Error("serve boot timeout (10s)")), 10_000);
    });

    const sess = await ocFetch(serveUrl, "/session", "POST", providerID && modelID ? { model: { id: modelID, providerID } } : {}, 15_000);
    const sid = sess?.id;
    if (!sid) throw new Error("sessão sem id");

    await ocFetch(
      serveUrl, `/session/${sid}/message`, "POST",
      { ...(providerID && modelID ? { model: { providerID, modelID } } : {}), parts: [{ type: "text", text: prompt }] },
      Math.max(20_000, timeoutMs - 12_000),
    );

    const msgs = await ocFetch(serveUrl, `/session/${sid}/message`, "GET", undefined, 15_000);
    let text = "";
    let input = 0, output = 0;
    if (Array.isArray(msgs)) {
      for (const m of msgs) {
        if ((m?.info?.role ?? m?.role) !== "assistant") continue;
        for (const p of (m?.parts ?? [])) {
          if (p?.type === "text" && p.text) text += (text ? "\n" : "") + String(p.text).trim();
          if ((p?.type === "step-finish" || p?.type === "step_finish") && p.tokens) {
            input += Number(p.tokens.input ?? 0);
            output += Number(p.tokens.output ?? 0);
          }
        }
      }
    }
    text = text.trim();
    cleanup();
    if (!text) return { ok: false, error: "opencode: turno terminou sem texto" };
    if (!input && !output) {
      input = Math.ceil(prompt.length / 4);
      output = Math.ceil(text.length / 4);
    }
    return { ok: true, text, usage: { input, output } };
  } catch (e) {
    cleanup();
    return { ok: false, error: `opencode: ${(e as Error).message}` };
  }
}

export async function runSummarizer(args: SummarizerArgs): Promise<SummarizerResult> {
  const sys = (args.systemPrompt ?? "").trim();
  const txt = args.text.trim();
  if (!txt) return { ok: false, error: "texto vazio" };

  const fullPrompt = sys
    ? `${sys}\n\n---\n\nMensagem do agente a resumir:\n\n${txt}`
    : `Resuma de forma curta e natural pra ser lida em voz alta:\n\n${txt}`;

  const r = await runCliText(fullPrompt, {
    runner: args.runner,
    model: args.model,
    effort: args.effort,
    cliCommands: args.cliCommands,
    dropTo: args.dropTo,
    claudeConfigDir: args.claudeConfigDir,
  });
  return r.ok ? { ok: true, summary: r.text, usage: r.usage } : { ok: false, error: r.error };
}

/** Args do one-shot CLI genérico (prompt → texto). Base do summarizer e do shim
 *  OpenAI-compat (graph-llm-shim) que deixa o graphify usar opencode/codex/gemini
 *  CLI como backend semântico. */
export interface CliTextArgs {
  runner: CliRunner;
  model?: string;
  effort?: string;
  cliCommands: ResolvedCliCommands;
  dropTo?: DropTarget | null;
  claudeConfigDir?: string;
  /** timeout total do one-shot (default 60s). O ship do grafo usa maior. */
  timeoutMs?: number;
}

export interface CliTextResult {
  ok: boolean;
  text?: string;
  error?: string;
  usage?: { input: number; output: number };
}

/**
 * One-shot stateless: roda o CLI (claude/codex/gemini print mode, ou opencode via
 * serve) num tmpdir limpo (sem projeto/MCP/sessão), passa `prompt` como mensagem
 * do usuário e devolve o texto do assistente. Dropa privilégios e faz scrub dos
 * secrets do daemon (superfície de prompt injection). Reusado pelo TTS summarizer
 * e pelo shim OpenAI-compat do grafo.
 */
export async function runCliText(prompt: string, args: CliTextArgs): Promise<CliTextResult> {
  const status = args.cliCommands[args.runner];
  if (!status?.available) {
    return { ok: false, error: `${args.runner} CLI não disponível no daemon` };
  }
  const cliCommand = status.command;
  const timeoutMs = args.timeoutMs ?? MAX_TIMEOUT_MS;
  const promptText = prompt.trim();
  if (!promptText) return { ok: false, error: "prompt vazio" };

  // T-055: pool `bg` — summarizer/shim não roubam slots dos turnos de agente.
  const releaseSlot = await acquireTurnSlot(`bg:${args.runner}`, undefined, "bg");
  try {
    return await runCliTextWithSlot(promptText, args, cliCommand, timeoutMs);
  } finally {
    releaseSlot();
  }
}

async function runCliTextWithSlot(
  promptText: string,
  args: CliTextArgs,
  cliCommand: string,
  timeoutMs: number,
): Promise<CliTextResult> {
  const cwd = mkdtempSync(join(tmpdir(), "the-dudes-cli-"));
  // Scrub secrets do daemon antes de spawn — summarizer CLI process
  // veria THE_DUDES_DAEMON_TOKEN via /proc/<pid>/environ. Prompt
  // injection no agente que dispara summarize ataca o summarizer
  // process e exfiltra. Mesmo motivo do scrub em agent-runner.buildEnv.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.THE_DUDES_DAEMON_TOKEN;
  delete env.THE_DUDES_TOKEN;
  delete env.THE_DUDES_ENCRYPTION_KEY;
  if (args.runner === "claude") {
    const claudeHome = args.dropTo?.home ?? homedir();
    delete env.CLAUDE_CONFIG_DIR;
    if (args.claudeConfigDir) env.CLAUDE_CONFIG_DIR = expandHome(args.claudeConfigDir, claudeHome);
  }
  if (args.runner === "gemini") {
    env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  }
  if (isGrokFamily(args.runner)) {
    // Auth/sessões no home real do user — nunca no tmpdir efêmero do summarizer.
    const home = args.dropTo?.home ?? process.env.HOME ?? homedir();
    env.HOME = home;
    env.GROK_HOME = join(home, ".grok");
    env.GROK_DISABLE_AUTOUPDATER = "1";
  }

  // opencode usa o transporte serve (igual aos agentes), não `opencode run`.
  if (args.runner === "opencode") {
    return runOpenCodeText(promptText, args, cwd, env);
  }

  const cmd = cliCommand;
  let argv: string[];

  if (args.runner === "claude") {
    // Use json output format so we can extract real usage tokens.
    argv = ["-p", promptText, "--output-format", "json"];
    if (args.model) argv.push("--model", args.model);
    if (args.effort) argv.push("--effort", args.effort);
  } else if (args.runner === "codex") {
    argv = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
    if (args.model) argv.push("-m", args.model);
    if (args.effort) argv.push("-c", `reasoning_effort=${args.effort}`);
    argv.push(promptText);
  } else if (args.runner === "gemini") {
    argv = ["--output-format", "json", "--skip-trust", "--yolo", "-p", promptText];
    if (args.model) argv.push("--model", args.model);
  } else if (args.runner === "crush") {
    // crush run é texto puro no stdout (sem JSON) — extractOneShotText cai no
    // raw e extractUsage na heurística de chars. Data dir no tmpdir efêmero
    // pra sessão descartável não poluir o data dir global do usuário.
    argv = ["run", "--quiet", "--data-dir", join(cwd, ".crush")];
    if (args.model) argv.push("-m", args.model);
    argv.push(promptText);
  } else if (isGrokFamily(args.runner)) {
    // Grok Build headless (docs: 14-headless-mode.md): -p + json + always-approve.
    // GROK_HOME explícito pro auth do user (não o tmpdir efêmero do summarizer).
    // Effort: só low|medium|high no wire.
    argv = [
      "-p", promptText,
      "--output-format", "json",
      "--always-approve",
      "--no-auto-update",
      "--no-subagents",
      "--no-memory",
      "--max-turns", "4",
      "--cwd", cwd,
    ];
    if (args.model) argv.push("-m", args.model);
    const grokEffort = normalizeGrokEffort(args.effort);
    if (grokEffort) argv.push("--effort", grokEffort);
  } else {
    return { ok: false, error: `runner inválido: ${args.runner}` };
  }

  return new Promise<CliTextResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    const finish = (r: CliTextResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    // Dropa privilégios via spawnDropped (não spawn cru com uid/gid): quando o
    // daemon roda como root, setpriv faz initgroups(3) e descarta os
    // supplementary groups herdados (wheel/docker/adm). O summarizer roda uma
    // CLI de LLM sobre texto derivado do agente (superfície de prompt
    // injection), então deve dropar igual aos CLIs de agente.
    let proc;
    try {
      proc = spawnDropped(cmd, argv, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }, args.dropTo ?? null);
    } catch (e) {
      return finish({ ok: false, error: `spawn failed: ${(e as Error).message}` });
    }

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (c: string) => { stdout += c; });
    proc.stderr?.on("data", (c: string) => { stderr += c; });

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      finish({ ok: false, error: `timeout após ${timeoutMs / 1000}s` });
    }, timeoutMs);

    proc.on("error", (e: Error) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message });
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      let text: string;
      if (args.runner === "claude") {
        // claude -p --output-format json emits single JSON {result, usage}
        try {
          const parsed = JSON.parse(stdout.trim());
          text = String(parsed?.result ?? parsed?.text ?? "").trim();
        } catch {
          text = stdout.trim();
        }
      } else {
        text = extractOneShotText(stdout, args.runner);
      }
      if (text) {
        const usage = extractUsage(stdout, args.runner, promptText.length, text.length);
        finish({ ok: true, text, usage });
        return;
      }
      finish({
        ok: false,
        error: stderr.trim().slice(0, 500) || `runner exit ${code ?? "?"}, sem texto`,
      });
    });
  });
}
