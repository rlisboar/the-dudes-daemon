import { test } from "node:test";
import assert from "node:assert/strict";
import { compatibleSessionId, isPerMessageRunner, RUNNER_ADAPTERS, runnerAdapter } from "../runners/index.js";

const uuid = "123e4567-e89b-12d3-a456-426614174000";

test("catalog contains exactly the supported runners (T-150: + grok-custom)", () => {
  assert.deepEqual(Object.keys(RUNNER_ADAPTERS).sort(), ["claude", "codex", "crush", "gemini", "grok", "grok-custom", "opencode", "qwen"]);
  assert.equal(isPerMessageRunner("claude"), false);
  for (const id of ["codex", "crush", "gemini", "grok", "grok-custom", "opencode", "qwen"] as const) assert.equal(isPerMessageRunner(id), true);
});

test("session compatibility is runner-specific", () => {
  assert.equal(compatibleSessionId("claude", uuid), uuid);
  assert.equal(compatibleSessionId("claude", "ses_123"), undefined);
  assert.equal(compatibleSessionId("opencode", "ses_123"), "ses_123");
  assert.equal(compatibleSessionId("opencode", uuid), undefined);
  assert.equal(compatibleSessionId("crush", uuid), uuid);
  assert.equal(compatibleSessionId("crush", "short"), undefined);
  assert.equal(compatibleSessionId("grok", uuid), uuid);
  assert.equal(compatibleSessionId("gemini", "opaque-session"), "opaque-session");
  assert.equal(compatibleSessionId("codex", "opaque-thread"), "opaque-thread");
  assert.equal(compatibleSessionId("qwen", uuid), uuid, "qwen: sessão é uuid nosso");
  assert.equal(compatibleSessionId("qwen", "opaque"), undefined);
});

test("adapter resolves its configured command", () => {
  const commands = Object.fromEntries(Object.keys(RUNNER_ADAPTERS).map((id) => [id, { command: `/bin/${id}` }])) as never;
  assert.equal(runnerAdapter("codex").command(commands), "/bin/codex");
  assert.equal(runnerAdapter("opencode").resumedSessionAlreadyHasSystemPrompt, false);
  assert.equal(runnerAdapter("grok").resumedSessionAlreadyHasSystemPrompt, true);
});
