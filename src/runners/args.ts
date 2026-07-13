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
}

export function grokHeadlessArgs(input: GrokHeadlessArgs): string[] {
  const args = ["-p", input.prompt, "--output-format", input.outputFormat, "--no-auto-update", "--cwd", input.workspaceRoot];
  if (input.model) args.push("-m", input.model);
  const effort = grokThinkingEffort(input.effort, !!input.collectThinking, !!input.forCompact);
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
