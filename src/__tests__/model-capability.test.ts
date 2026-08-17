import test from "node:test";
import assert from "node:assert/strict";
import { inferModelCapability } from "../model-capability.js";

test("model capability metadata distinguishes power and economical tiers", () => {
  assert.deepEqual(inferModelCapability("gpt-5.6-sol"), { capabilityTier: 4, speedTier: 1, costTier: 3 });
  assert.deepEqual(inferModelCapability("gpt-5.6-luna"), { capabilityTier: 1, speedTier: 3, costTier: 1 });
  assert.deepEqual(inferModelCapability("provider/unknown"), { capabilityTier: 2, speedTier: 2, costTier: 2 });
});

test("T-057: grok-4.N family is power-tier (4.5, 4.6, 4.7…) — mesmo tier entre si", () => {
  // capabilityTier 4 = topo (igual 4.5 pré-T-057); costTier 3 = caro.
  // brain-router fallbackScore usa escala 1–3 onde 4.x = 3.
  const power = { capabilityTier: 4, speedTier: 1, costTier: 3 };
  assert.deepEqual(inferModelCapability("grok-4.5"), power);
  assert.deepEqual(inferModelCapability("grok-4.6"), power);
  assert.deepEqual(inferModelCapability("grok-4.7"), power);
  assert.deepEqual(inferModelCapability("xai/grok-4.6"), power);
  // 4.6 idêntico a 4.5 (sem regressão de tier)
  assert.deepEqual(inferModelCapability("grok-4.6"), inferModelCapability("grok-4.5"));
  // composer/build não são 4.x frontier
  assert.notDeepEqual(inferModelCapability("grok-composer-2.5-fast"), power);
});
