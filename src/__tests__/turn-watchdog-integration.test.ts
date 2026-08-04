/**
 * Simula o loop de hang detection (sem spawn real de CLI).
 * Espelha a lógica de tickHangWatch: activity clock + thresholds.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createActivityClock,
  hangPhase,
  hangThresholds,
  touchActivityClock,
} from "../runners/turn-watchdog.js";

describe("hang detection scenario (Grok)", () => {
  it("soft then hard as idle grows without activity", () => {
    const t = hangThresholds("grok");
    const clock = createActivityClock(0);
    const events: string[] = [];

    // abaixo de soft: ok
    assert.equal(hangPhase(t.softMs - 1, t), "ok");

    // soft uma vez
    assert.equal(hangPhase(t.softMs, t), "soft");
    if (!clock.softReported) {
      clock.softReported = true;
      events.push("soft");
    }

    // still soft, no duplicate if we guard with softReported
    assert.equal(clock.softReported, true);

    // activity resets soft
    touchActivityClock(clock, 200_000);
    assert.equal(clock.softReported, false);
    assert.equal(hangPhase(0, t), "ok");

    // freeze again until hard
    clock.lastActivityAt = 200_000;
    const idleHard = t.hardMs;
    assert.equal(hangPhase(idleHard, t), "hard");
    events.push("hard");

    assert.deepEqual(events, ["soft", "hard"]);
  });

  it("dead process window is shorter than soft for grok", () => {
    const t = hangThresholds("grok");
    assert.ok(t.deadProcMs < t.softMs);
    assert.ok(t.deadProcMs <= 20_000);
  });

  it("grok hard is ≤120s (aceitável; armHardTimeout 12min é só backstop)", () => {
    // T-009: detecção ≤120s. hard 4min era longo demais sob thrash e ainda
    // assim não disparava se activity contasse bytes brutos.
    const t = hangThresholds("grok");
    assert.ok(t.hardMs <= 120_000, `hardMs=${t.hardMs} > 120s`);
    assert.ok(t.hardMs > t.softMs);
    assert.ok(t.softMs <= 90_000);
  });
});
