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
  assert.ok(plan.includes("--trust"));
  assert.ok(!plan.includes("--always-approve"));
  const compact = grokHeadlessArgs({ prompt, outputFormat: "json", workspaceRoot: "/repo", planMode: true, forCompact: true });
  assert.ok(compact.includes("--always-approve"));
  assert.ok(compact.includes("--trust"));
  assert.ok(compact.includes("--no-subagents"));
  assert.ok(!compact.includes("--permission-mode"));
  // xhigh em modelo legado/sem model → high (wire 4.5)
  const xhigh = grokHeadlessArgs({ prompt, outputFormat: "json", workspaceRoot: "/repo", effort: "xhigh" });
  const effortIdx = xhigh.indexOf("--effort");
  assert.ok(effortIdx >= 0);
  assert.equal(xhigh[effortIdx + 1], "high");
  assert.ok(!xhigh.includes("xhigh"));
  // T-057: grok-4.6 passa xhigh intacto
  const x46 = grokHeadlessArgs({
    prompt, outputFormat: "json", workspaceRoot: "/repo", effort: "xhigh", model: "grok-4.6",
  });
  const i46 = x46.indexOf("--effort");
  assert.equal(x46[i46 + 1], "xhigh");
});

test("grok leader socket isolates the agent when informed", () => {
  // Sem socket: cai no leader compartilhado de ~/.grok (comportamento do CLI).
  const shared = grokHeadlessArgs({ prompt, outputFormat: "json", workspaceRoot: "/repo" });
  assert.ok(!shared.includes("--leader-socket"));
  const isolated = grokHeadlessArgs({
    prompt, outputFormat: "json", workspaceRoot: "/repo", leaderSocket: "/tmp/td-grok/abc.sock",
  });
  const idx = isolated.indexOf("--leader-socket");
  assert.ok(idx >= 0);
  assert.equal(isolated[idx + 1], "/tmp/td-grok/abc.sock");
});

test("qwen: headless stream-json com sessão uuid própria (criação vs resume), prompt via STDIN", async () => {
  const { qwenOneShotArgs } = await import("../runners/args.js");
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  // criação: --session-id (sem -r); SEM `-p`/posicional — o prompt vai pelo stdin
  assert.deepEqual(
    qwenOneShotArgs({ prompt: "oi", newSessionId: uuid }),
    ["--output-format", "stream-json", "-y", "--session-id", uuid],
  );
  // resume: -r (sem --session-id)
  assert.deepEqual(
    qwenOneShotArgs({ prompt: "oi", model: "qwen3-coder-plus", sessionId: uuid }),
    ["--output-format", "stream-json", "-y", "--model", "qwen3-coder-plus", "-r", uuid],
  );
  // resume vence criação se ambos vierem
  assert.ok(qwenOneShotArgs({ prompt: "x", sessionId: uuid, newSessionId: "outra" }).includes("-r"));
  // regressão: prompt iniciado por `-` nunca chega ao argv (yargs partia-o)
  assert.ok(!qwenOneShotArgs({ prompt: "- bullet", sessionId: uuid }).some((a) => a.includes("bullet")));
});
