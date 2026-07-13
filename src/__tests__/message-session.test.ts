import { test } from "node:test";
import assert from "node:assert/strict";
import { PerMessageSessionState } from "../runners/message-session.js";

test("message session resumes without reinjecting the system prompt", () => {
  const state = new PerMessageSessionState();
  state.resume("session-1", { needsPrime: true, alreadyHasSystemPrompt: true });
  assert.equal(state.sessionId, "session-1");
  assert.equal(state.needsPrime, true);
  assert.equal(state.firstTurn, false);
});

test("message session resets identity and invalidates stale turn ownership", () => {
  const state = new PerMessageSessionState();
  state.resume("old", { needsPrime: false, alreadyHasSystemPrompt: true });
  const epoch = state.epoch;
  assert.equal(state.owns(epoch, "old"), true);
  state.reset("summary");
  assert.equal(state.owns(epoch, "old"), false);
  assert.equal(state.sessionId, undefined);
  assert.equal(state.firstTurn, true);
  assert.equal(state.pendingSummary, "summary");
});

test("retry reset drops only the broken session without invalidating the current turn", () => {
  const state = new PerMessageSessionState();
  state.resume("broken", { needsPrime: false, alreadyHasSystemPrompt: true });
  const epoch = state.epoch;
  state.resetForRetry("retry summary");
  assert.equal(state.epoch, epoch);
  assert.equal(state.sessionId, undefined);
  assert.equal(state.firstTurn, true);
  assert.equal(state.pendingSummary, "retry summary");
});

test("message queue is bounded, ordered and supports retry at the front", () => {
  const state = new PerMessageSessionState();
  assert.equal(state.enqueue({ content: "one" }, 2), true);
  assert.equal(state.enqueue({ content: "two" }, 2), true);
  assert.equal(state.enqueue({ content: "dropped" }, 2), false);
  state.prepend({ content: "retry" });
  assert.equal(state.dequeue()?.content, "retry");
  assert.equal(state.dequeue()?.content, "one");
  assert.equal(state.clearQueue(), 1);
});

test("first-turn snapshot restores a failed cold start without overwriting a newer summary", () => {
  const state = new PerMessageSessionState();
  state.pendingSummary = "old";
  const snapshot = state.consumeFirstTurn();
  assert.deepEqual(snapshot, { firstTurn: true, pendingSummary: "old" });
  state.restoreFirstTurn(snapshot);
  assert.equal(state.firstTurn, true);
  assert.equal(state.pendingSummary, "old");
  state.consumeFirstTurn();
  state.pendingSummary = "new";
  state.restoreFirstTurn(snapshot);
  assert.equal(state.pendingSummary, "new");
});
