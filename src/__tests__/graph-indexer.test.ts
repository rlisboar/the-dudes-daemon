import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyGraphifyError, normalizeGraphifyBackend, parseGraphifyProgressLine } from "../graph-indexer.js";

test("parseGraphifyProgressLine: semantic N/M", () => {
  const p = parseGraphifyProgressLine("[graphify extract] semantic extraction 3/12 files");
  assert.ok(p);
  assert.equal(p!.phase, "semantic");
  assert.equal(p!.progress, 25);
});

test("parseGraphifyProgressLine: AST phase", () => {
  const p = parseGraphifyProgressLine("[graphify extract] AST extraction…");
  assert.ok(p);
  assert.equal(p!.phase, "ast");
  assert.equal(p!.progress, 15);
});

test("parseGraphifyProgressLine: rebuild done", () => {
  const p = parseGraphifyProgressLine("Rebuilt: 17 nodes, 19 edges, 3 communities");
  assert.ok(p);
  assert.equal(p!.phase, "done");
  assert.equal(p!.progress, 100);
});

test("parseGraphifyProgressLine: noise returns null", () => {
  assert.equal(parseGraphifyProgressLine("hello world"), null);
  assert.equal(parseGraphifyProgressLine(""), null);
});

test("normalizeGraphifyBackend maps anthropic→claude and defaults", () => {
  assert.equal(normalizeGraphifyBackend(undefined), "claude-cli");
  assert.equal(normalizeGraphifyBackend("anthropic"), "claude");
  assert.equal(normalizeGraphifyBackend("opencode-cli"), "opencode-cli");
  assert.equal(normalizeGraphifyBackend("gemini"), "gemini");
});

test("friendlyGraphifyError maps Gemini tier errors", () => {
  const msg = friendlyGraphifyError("IneligibleTierError: no longer supported for Gemini Code Assist for individuals");
  assert.ok(msg.includes("Gemini CLI"));
  assert.ok(msg.includes("GEMINI_API_KEY") || msg.includes("OpenCode"));
});

test("parseGraphifyProgressLine: chunk N/M", () => {
  const p = parseGraphifyProgressLine("processing chunk 2/8");
  assert.ok(p);
  assert.equal(p!.phase, "semantic");
  assert.equal(p!.progress, 25);
});
