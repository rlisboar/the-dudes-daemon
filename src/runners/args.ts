import type { EffortLevel } from "../types.js";
import { grokThinkingEffort } from "./model-policy.js";

export interface OneShotArgs {
  prompt: string;
  model?: string;
  sessionId?: string;
}

export const claudeOneShotArgs = ({ prompt, model, sessionId }: OneShotArgs): string[] => {
  const args = ["--print", "-p", prompt];
  if (model) args.push("--model", model);
  if (sessionId) args.push("--resume", sessionId);
  return args;
};

export const geminiOneShotArgs = ({ prompt, model }: OneShotArgs): string[] => {
  const args = ["--output-format", "stream-json", "--skip-trust", "--yolo", "--resume", "latest", "-p", prompt];
  if (model) args.push("--model", model);
  return args;
};

export const codexOneShotArgs = ({ prompt, model, sessionId }: OneShotArgs): string[] => {
  const flags = ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
  if (model) flags.push("-m", model);
  return sessionId ? ["exec", "resume", ...flags, sessionId, prompt] : ["exec", ...flags, prompt];
};

export function crushOneShotArgs(input: OneShotArgs & { dataDir: string }): string[] {
  const args = ["run", "--quiet", "--data-dir", input.dataDir];
  if (input.model) args.push("-m", input.model);
  if (input.sessionId) args.push("--session", input.sessionId);
  args.push(input.prompt);
  return args;
}

export function opencodeOneShotArgs(input: OneShotArgs & { autoApprove: boolean }): string[] {
  const args = ["run", "--format", "json"];
  if (input.autoApprove) args.push("--dangerously-skip-permissions");
  if (input.model) args.push("--model", input.model);
  if (input.sessionId) args.push("-s", input.sessionId);
  args.push(input.prompt);
  return args;
}

export interface GrokHeadlessArgs extends OneShotArgs {
  outputFormat: "streaming-json" | "json" | "plain";
  workspaceRoot: string;
  effort?: EffortLevel;
  collectThinking?: boolean;
  planMode?: boolean;
  forCompact?: boolean;
  /** Socket do leader POR AGENTE (ver RunnerRuntimeFiles.grokLeaderSocket).
   *  Sem isto todos os agentes dividem `~/.grok/leader.sock` — inclusive com
   *  o `grok` interativo do usuário e com outro daemon na mesma máquina. */
  leaderSocket?: string;
  /** T-162: identidade do runner — grok-custom aceita xhigh universal. */
  runner?: string;
}

export function grokHeadlessArgs(input: GrokHeadlessArgs): string[] {
  // --trust: MCP/hooks/LSP de projeto (.grok/config.toml) só sobem em pastas
  // trusted. Sem isso, workspaces secundários (ex.: baremetalv2 do latitude)
  // ficam com the-dudes "Tool not found" enquanto claudinho (já trusted) funciona.
  const args = [
    "-p", input.prompt,
    "--output-format", input.outputFormat,
    "--no-auto-update",
    "--trust",
    "--cwd", input.workspaceRoot,
  ];
  if (input.leaderSocket) args.push("--leader-socket", input.leaderSocket);
  if (input.model) args.push("-m", input.model);
  // T-057: effort wire depende do modelo (4.6+ aceita xhigh).
  // T-162: runner grok-custom aceita xhigh com qualquer model.
  const effort = grokThinkingEffort(input.effort, !!input.collectThinking, !!input.forCompact, input.model, input.runner);
  if (effort) args.push("--effort", effort);
  if (input.sessionId) args.push("--resume", input.sessionId);
  if (input.planMode && !input.forCompact) {
    args.push("--permission-mode", "plan", "--tools", "read_file,grep,list_dir,web_search,web_fetch");
  } else {
    args.push("--always-approve");
  }
  if (input.forCompact) args.push("--no-subagents", "--no-memory", "--max-turns", "8");
  return args;
}
