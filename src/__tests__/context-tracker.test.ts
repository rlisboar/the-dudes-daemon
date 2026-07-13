import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextTracker, CumulativeUsageTracker } from "../runners/context-tracker.js";

test("context tracker emits usage, one warning and a cooldown-protected full event", () => {
  let now = 1_000_000;
  const usage: Array<[number, number]> = [];
  const warnings: Array<[number, number]> = [];
  let full = 0;
  const tracker = new ContextTracker({
    resolveLimit: () => 100,
    onUsage: (used, limit) => usage.push([used, limit]),
    onWarning: (used, limit) => warnings.push([used, limit]),
    onFull: () => full++,
    now: () => now,
  });
  tracker.reportOccupancy(85);
  tracker.reportOccupancy(90);
  tracker.reportOccupancy(100);
  tracker.reportOccupancy(110);
  assert.deepEqual(warnings, [[85, 100]]);
  assert.equal(full, 1);
  now += 120_000;
  tracker.reportOccupancy(100);
  assert.equal(full, 2);
  tracker.reset();
  assert.deepEqual(usage.at(-1), [0, 100]);
});

test("context tracker resolves model state, honors larger hints and ignores rate limits", () => {
  const usage: Array<[number, number]> = [];
  let full = 0;
  const tracker = new ContextTracker({
    resolveLimit: (resolved, catalog) => catalog ?? (resolved === "known" ? 400 : 200),
    onUsage: (used, limit) => usage.push([used, limit]),
    onFull: () => full++,
  });
  tracker.setResolvedModel("known");
  assert.equal(tracker.limit(), 400);
  tracker.setCatalogLimit(800);
  assert.equal(tracker.limit(), 800);
  tracker.reportOccupancy(500, 1_000);
  assert.deepEqual(usage.at(-1), [500, 1_000]);
  tracker.checkFullError("429 rate limit: maximum tokens per minute exceeded");
  assert.equal(full, 0);
});

test("context tracker suspends automatic full notifications after repeated compact failures", () => {
  let now = 1_000_000;
  let full = 0;
  const errors: string[] = [];
  const tracker = new ContextTracker({
    resolveLimit: () => 100,
    onFull: () => full++,
    onError: (message) => errors.push(message),
    now: () => now,
  });
  for (let i = 0; i < 3; i++) tracker.registerCompactFailure();
  now += 120_000;
  tracker.notifyFull();
  assert.equal(full, 0);
  assert.match(errors.at(-1) ?? "", /auto-compaction suspensa/);
  tracker.reset();
  now += 120_000;
  tracker.notifyFull();
  assert.equal(full, 1);
});

test("cumulative usage tracker primes resumed sessions and clamps counter resets", () => {
  const tracker = new CumulativeUsageTracker<{ input: number; output: number }>(null);
  tracker.prime({ input: 100, output: 20 });
  assert.deepEqual(tracker.delta({ input: 140, output: 30 }), { input: 40, output: 10 });
  assert.deepEqual(tracker.delta({ input: 5, output: 2 }), { input: 0, output: 0 });
  tracker.reset({ input: 0, output: 0 });
  assert.deepEqual(tracker.delta({ input: 7, output: 3 }), { input: 7, output: 3 });
});
