import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRunnerFailure, isAbortedFailure, isApiErrorMessage,
  isAuthenticationFailure, isLoopStopMessage, isMissingSessionFailure,
} from "../runners/error-classifier.js";

test("rate limit takes precedence over context-like token wording", () => {
  const message = "429 rate limit of 80000 input tokens per minute; reduce prompt or maximum tokens requested";
  assert.equal(classifyRunnerFailure(message), "rate_limit");
});

test("classifier recognizes context, missing sessions, auth and transient network failures", () => {
  assert.equal(classifyRunnerFailure("Your input exceeds the context window of this model"), "context_full");
  assert.equal(classifyRunnerFailure("couldn't resume session: 404 not found"), "missing_session");
  // qwen-code 0.23.0 (texto exato medido): resume de sessão apagada do QWEN_HOME
  assert.equal(
    classifyRunnerFailure("No saved session found with ID 0e5f0580-b460-4728-bf1f-4a811395e524. Run qwen --resume without an ID to choose from existing sessions."),
    "missing_session",
  );
  assert.equal(classifyRunnerFailure("401 invalid or expired credentials"), "authentication");
  assert.equal(classifyRunnerFailure("socket hang up ECONNRESET"), "transient_network");
  assert.equal(classifyRunnerFailure("API Error: provider rejected request"), "provider_error");
});

test("abort classification accepts exit codes and textual timeout signals", () => {
  assert.equal(isAbortedFailure("", 137), true);
  assert.equal(isAbortedFailure("turn timed out", 1), true);
  assert.equal(isAbortedFailure("ordinary failure", 1), false);
});

test("classification convenience predicates share the same rules", () => {
  assert.equal(isMissingSessionFailure("no conversation found with session id abc"), true);
  assert.equal(isAuthenticationFailure("failed to authenticate bearer"), true);
  assert.equal(isApiErrorMessage("  API Error: failed"), true);
  assert.equal(isApiErrorMessage("agent quoted API Error in prose"), false);
  assert.equal(isLoopStopMessage("[loop-stop] Conversation paused"), true);
  assert.equal(isLoopStopMessage("continue normally"), false);
});
