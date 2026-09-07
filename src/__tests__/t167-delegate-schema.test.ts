/**
 * T-167 A2 — schema MCP do delegate aceita preferred_runner=grok-custom.
 * Reusa POLICY_GATED_RUNNERS (7 runners, T-157) — não cria 4ª lista.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { POLICY_GATED_RUNNERS } from "../runner-policy.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BRIDGE = readFileSync(join(AQUI, "../mcp-bridge.ts"), "utf8");

test("T-167 A2: schema MCP delegate aceita grok-custom (POLICY_GATED_RUNNERS)", () => {
  assert.match(BRIDGE, /preferred_runner:\s*z\.enum\(POLICY_GATED_RUNNERS\)/);
  assert.doesNotMatch(
    BRIDGE,
    /preferred_runner:\s*z\.enum\(\["claude", "codex", "opencode", "gemini", "crush", "grok"\]\)/,
  );
  assert.ok((POLICY_GATED_RUNNERS as readonly string[]).includes("grok-custom"));
  assert.ok((POLICY_GATED_RUNNERS as readonly string[]).includes("qwen"));
  assert.equal(POLICY_GATED_RUNNERS.length, 8);

  const schema = z.enum(POLICY_GATED_RUNNERS);
  assert.equal(schema.parse("grok-custom"), "grok-custom");
  assert.equal(schema.parse("grok"), "grok");
  assert.throws(() => schema.parse("runner-inexistente"));
});
