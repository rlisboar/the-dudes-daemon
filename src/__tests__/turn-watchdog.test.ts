import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createActivityClock,
  hangPhase,
  hangThresholds,
  touchActivityClock,
} from "../runners/turn-watchdog.js";

describe("turn-watchdog", () => {
  it("grok thresholds are stricter than claude continuous", () => {
    const g = hangThresholds("grok");
    const c = hangThresholds("claude");
    assert.ok(g.softMs < c.softMs);
    assert.ok(g.hardMs < c.hardMs);
    // Claude soft ≥ 10min: tools longas sem stream não devem marcar stalled cedo
    assert.ok(c.softMs >= 10 * 60_000);
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

  it("claude hard threshold is finite (continuous must recover eventually)", () => {
    // Regressão: continuous sem busy nunca hard-recoverava se hardMs
    // fosse "infinito". Garante hard finito e > soft.
    const c = hangThresholds("claude");
    assert.ok(Number.isFinite(c.hardMs));
    assert.ok(c.hardMs > c.softMs);
    assert.ok(c.hardMs <= 30 * 60_000); // ≤30min
  });
});
