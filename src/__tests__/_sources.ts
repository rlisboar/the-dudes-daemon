/**
 * R7 (T-462): testes estruturais varrem o fonte do agent-runner. Com a
 * extração para runners/turns|bootstrap|compact|one-shot|support, o "fonte do
 * runner" é a concatenação — os indexOf/asserts seguem valendo.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function allRunnerSources(runnerPath: string | URL): string {
  if (runnerPath instanceof URL) runnerPath = fileURLToPath(runnerPath);
  const dir = path.dirname(runnerPath);
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const files = [
    runnerPath,
    path.join(dir, "runners", "bootstrap.ts"),
    path.join(dir, "runners", "compact.ts"),
    path.join(dir, "runners", "one-shot.ts"),
    path.join(dir, "runners", "support.ts"),
    ...["opencode", "gemini", "qwen", "codex", "grok", "crush", "claude"].map((r) => path.join(dir, "runners", "turns", `${r}.ts`)),
  ];
  return files.map(read).join("\n");
}
