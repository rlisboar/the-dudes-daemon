import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeOneShotArgs, codexOneShotArgs, crushOneShotArgs, geminiOneShotArgs, grokHeadlessArgs, opencodeOneShotArgs } from "../runners/args.js";

const prompt = "summarize this safely; do not split";

test("one-shot builders keep prompt as one argv and apply model/session flags", () => {
  for (const args of [
    claudeOneShotArgs({ prompt, model: "opus", sessionId: "sid" }),
    geminiOneShotArgs({ prompt, model: "gemini-3" }),
    codexOneShotArgs({ prompt, model: "gpt-5", sessionId: "thread" }),
    crushOneShotArgs({ prompt, model: "x", sessionId: "uuid", dataDir: "/tmp/crush" }),
    opencodeOneShotArgs({ prompt, model: "x", sessionId: "ses_1", autoApprove: true }),
  ]) assert.equal(args.filter((arg) => arg === prompt).length, 1);
});

test("codex resume and cold-start argv preserve CLI ordering", () => {
  assert.deepEqual(codexOneShotArgs({ prompt }), ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt]);
  assert.deepEqual(codexOneShotArgs({ prompt, sessionId: "thread" }).slice(0, 3), ["exec", "resume", "--json"]);
});

test("grok plan, compact and thinking policies are mutually consistent", () => {
  const plan = grokHeadlessArgs({ prompt, outputFormat: "streaming-json", workspaceRoot: "/repo", planMode: true, collectThinking: true, effort: "low" });
  assert.ok(plan.includes("plan"));
  assert.ok(plan.includes("high"));
  assert.ok(!plan.includes("--always-approve"));
  const compact = grokHeadlessArgs({ prompt, outputFormat: "json", workspaceRoot: "/repo", planMode: true, forCompact: true });
  assert.ok(compact.includes("--always-approve"));
  assert.ok(compact.includes("--no-subagents"));
  assert.ok(!compact.includes("--permission-mode"));
});
