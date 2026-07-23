import test from "node:test";
import assert from "node:assert/strict";
import { inferModelCapability } from "../model-capability.js";

test("model capability metadata distinguishes power and economical tiers", () => {
  assert.deepEqual(inferModelCapability("gpt-5.6-sol"), { capabilityTier: 4, speedTier: 1, costTier: 3 });
  assert.deepEqual(inferModelCapability("gpt-5.6-luna"), { capabilityTier: 1, speedTier: 3, costTier: 1 });
  assert.deepEqual(inferModelCapability("provider/unknown"), { capabilityTier: 2, speedTier: 2, costTier: 2 });
});
