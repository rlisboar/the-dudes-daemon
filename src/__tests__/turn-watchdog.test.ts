import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createActivityClock,
  hangPhase,
  hangThresholds,
  touchActivityClock,
} from "../runners/turn-watchdog.js";

describe("turn-watchdog", () => {
  it("grok thresholds are stricter than default", () => {
    const g = hangThresholds("grok");
    const d = hangThresholds("claude");
    assert.ok(g.softMs < d.softMs);
    assert.ok(g.hardMs < d.hardMs);
  });

  it("hangPhase transitions ok → soft → hard", () => {
    const t = hangThresholds("grok");
    assert.equal(hangPhase(0, t), "ok");
    assert.equal(hangPhase(t.softMs, t), "soft");
    assert.equal(hangPhase(t.hardMs, t), "hard");
  });

  it("touchActivityClock resets soft flag", () => {
    const c = createActivityClock(1_000);
    c.softReported = true;
    c.deadSince = 500;
    touchActivityClock(c, 2_000);
    assert.equal(c.lastActivityAt, 2_000);
    assert.equal(c.softReported, false);
    assert.equal(c.deadSince, null);
  });
});
