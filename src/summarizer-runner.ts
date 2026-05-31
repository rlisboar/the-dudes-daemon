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

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedCliCommands } from "./cli-config.js";
import { extractOneShotText } from "./agent-runner.js";
import { spawnDropped, type DropTarget } from "./privileges.js";
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
function extractUsage(out: string, runner: CliRunner, sysLen: number, originalLen: number, summaryLen: number): { input: number; output: number } {
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
  }
  if (input === 0 && output === 0) {
    // Heuristic: ~4 chars per token. Input includes system + user message.
    input = Math.ceil((sysLen + originalLen) / 4);
    output = Math.ceil(summaryLen / 4);
  }
  return { input, output };
}

const MAX_TIMEOUT_MS = 60_000;

function expandHome(p: string): string {
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (p === "$HOME" || p === "${HOME}") return home;
  if (p.startsWith("$HOME/")) return join(home, p.slice(6));
  if (p.startsWith("${HOME}/")) return join(home, p.slice(8));
  return p;
}

export async function runSummarizer(args: SummarizerArgs): Promise<SummarizerResult> {
  const status = args.cliCommands[args.runner];
  if (!status?.available) {
    return { ok: false, error: `${args.runner} CLI não disponível no daemon` };
  }
  const cliCommand = status.command;

  const sys = (args.systemPrompt ?? "").trim();
  const txt = args.text.trim();
  if (!txt) return { ok: false, error: "texto vazio" };

  const fullPrompt = sys
    ? `${sys}\n\n---\n\nMensagem do agente a resumir:\n\n${txt}`
    : `Resuma de forma curta e natural pra ser lida em voz alta:\n\n${txt}`;

  const cwd = mkdtempSync(join(tmpdir(), "the-dudes-sum-"));
  // Scrub secrets do daemon antes de spawn — summarizer CLI process
  // veria THE_DUDES_DAEMON_TOKEN via /proc/<pid>/environ. Prompt
  // injection no agente que dispara summarize ataca o summarizer
  // process e exfiltra. Mesmo motivo do scrub em agent-runner.buildEnv.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.THE_DUDES_DAEMON_TOKEN;
  delete env.THE_DUDES_TOKEN;
  delete env.THE_DUDES_ENCRYPTION_KEY;
  if (args.runner === "claude") {
    env.CLAUDE_CONFIG_DIR = args.claudeConfigDir
      ? expandHome(args.claudeConfigDir)
      : join(homedir(), ".config", "claude");
  }
  if (args.runner === "gemini") {
    env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  }

  let cmd = cliCommand;
  let argv: string[];

  if (args.runner === "claude") {
    // Use json output format so we can extract real usage tokens.
    argv = ["-p", fullPrompt, "--output-format", "json"];
    if (args.model) argv.push("--model", args.model);
  } else if (args.runner === "codex") {
    argv = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
    if (args.model) argv.push("-m", args.model);
    if (args.effort) argv.push("-c", `reasoning_effort=${args.effort}`);
    argv.push(fullPrompt);
  } else if (args.runner === "gemini") {
    argv = ["--output-format", "json", "--skip-trust", "--yolo", "-p", fullPrompt];
    if (args.model) argv.push("--model", args.model);
  } else if (args.runner === "opencode") {
    const ocArgs = ["run", "--format", "json"];
    if (args.model) ocArgs.push("--model", args.model);
    ocArgs.push(fullPrompt);
    cmd = "python3";
    argv = ["-c", "import pty,sys; pty.spawn(sys.argv[1:])", cliCommand, ...ocArgs];
  } else {
    return { ok: false, error: `runner inválido: ${args.runner}` };
  }

  return new Promise<SummarizerResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    const finish = (r: SummarizerResult) => {
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
      finish({ ok: false, error: `timeout após ${MAX_TIMEOUT_MS / 1000}s` });
    }, MAX_TIMEOUT_MS);

    proc.on("error", (e: Error) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message });
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      let summary: string;
      if (args.runner === "claude") {
        // claude -p --output-format json emits single JSON {result, usage}
        try {
          const parsed = JSON.parse(stdout.trim());
          summary = String(parsed?.result ?? parsed?.text ?? "").trim();
        } catch {
          summary = stdout.trim();
        }
      } else {
        summary = extractOneShotText(stdout, args.runner);
      }
      if (summary) {
        const usage = extractUsage(stdout, args.runner, sys.length, txt.length, summary.length);
        finish({ ok: true, summary, usage });
        return;
      }
      finish({
        ok: false,
        error: stderr.trim().slice(0, 500) || `runner exit ${code ?? "?"}, sem texto`,
      });
    });
  });
}
