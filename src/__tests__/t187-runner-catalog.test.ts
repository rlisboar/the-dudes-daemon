import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { POLICY_GATED_RUNNERS } from "../runner-policy.js";
import { RUNNERS, isKnownCliRunner } from "@the-dudes/protocol";

test("T-187: POLICY_GATED_RUNNERS deriva do catálogo (@the-dudes/protocol)", () => {
  // Fonte única: RUNNER_CATALOG em packages/protocol/index.js. A cópia
  // hardcoded aqui já esqueceu o grok-custom (T-157).
  assert.deepEqual([...POLICY_GATED_RUNNERS], [...RUNNERS]);
  assert.ok((POLICY_GATED_RUNNERS as readonly string[]).includes("grok-custom"));
});

test("T-187: descoberta de models itera o catálogo inteiro", () => {
  // model-discovery.ts importa RUNNERS do protocol — nenhuma lista local.
  const src = readFileSync(fileURLToPath(new URL("../model-discovery.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /const RUNNERS/, "lista local de runners reapareceu em model-discovery.ts");
});

test("T-187: nenhuma allowlist hardcoded restante nos fontes policy-gated do daemon", () => {
  const fingerprint = /"claude",\s*"codex",\s*"opencode",\s*"gemini",\s*"crush",\s*"grok",\s*"grok-custom"/;
  const files = ["../runner-policy.ts", "../model-discovery.ts", "../protocol.ts"];
  for (const f of files) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
    assert.doesNotMatch(src, fingerprint, `allowlist hardcoded reapareceu em ${f}`);
  }
});

test("T-187: isKnownCliRunner do catálogo cobre os policy-gated e rejeita desconhecido", () => {
  for (const runner of POLICY_GATED_RUNNERS) assert.equal(isKnownCliRunner(runner), true);
  assert.equal(isKnownCliRunner("runner-inexistente"), false);
});
