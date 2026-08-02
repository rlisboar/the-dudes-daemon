import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMemoryCharBudget,
  memoryQueryMatch,
  memoryTitleNearDup,
  memoryTypePriority,
  parseAndStripMemory,
  sortByMemoryTypePriority,
} from "../memory-utils.js";

test("memoryTypePriority ranks decision before fact", () => {
  assert.ok(memoryTypePriority("decision") < memoryTypePriority("fact"));
  assert.ok(memoryTypePriority("preference") < memoryTypePriority("reference"));
});

test("sortByMemoryTypePriority puts sticky first", () => {
  const sorted = sortByMemoryTypePriority([
    { type: "fact", id: "a" },
    { type: "decision", id: "b" },
    { type: "preference", id: "c" },
  ]);
  assert.equal(sorted[0]!.type, "decision");
  assert.equal(sorted[1]!.type, "preference");
  assert.equal(sorted[2]!.type, "fact");
});

test("applyMemoryCharBudget prefers sticky under pressure", () => {
  const blocks = [
    { type: "fact", text: "F".repeat(400) },
    { type: "decision", text: "D".repeat(300) },
    { type: "preference", text: "P".repeat(300) },
    { type: "fact", text: "X".repeat(400) },
  ];
  const { kept, dropped } = applyMemoryCharBudget(blocks, 700, 0.5);
  assert.ok(kept.some((t) => t.startsWith("D") || t.includes("D".repeat(10)) || t[0] === "D"));
  // decision block is "D"*300
  assert.ok(kept.some((t) => t.length === 300 && t[0] === "D"));
  assert.ok(dropped >= 1);
});

test("parseAndStripMemory extracts JSON line", () => {
  const raw =
    "Summary of the work done.\n\nMEMORY_JSON: [{\"title\":\"DB\",\"body\":\"Use Postgres\",\"type\":\"decision\"}]";
  const { clean, items } = parseAndStripMemory(raw);
  assert.ok(!clean.includes("MEMORY_JSON"));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, "DB");
  assert.equal(items[0]!.type, "decision");
});

test("parseAndStripMemory tolerates trailing comma", () => {
  const raw = 'MEMORY_JSON: [{"title":"A","body":"B","type":"fact",}]';
  const { items } = parseAndStripMemory(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, "A");
});

test("memoryTitleNearDup detects similar titles", () => {
  assert.equal(memoryTitleNearDup("Deploy production API", "deploy production api"), true);
  assert.equal(memoryTitleNearDup("Deploy production API", "lunch menu"), false);
});

test("memoryQueryMatch and/or modes", () => {
  const hay = "postgres partition monthly deploy";
  assert.equal(memoryQueryMatch(hay, "postgres deploy", "and"), true);
  assert.equal(memoryQueryMatch(hay, "postgres redis", "and"), false);
  assert.equal(memoryQueryMatch(hay, "postgres redis", "or"), true);
  assert.equal(memoryQueryMatch(hay, "", "and"), true);
});
