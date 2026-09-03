import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMemoryCharBudget,
  memoryBodySame,
  memoryManualDupDecision,
  memoryPinBudgetWarning,
  memoryQueryMatch,
  memoryTitleNearDup,
  memoryTypePriority,
  normalizeMemoryText,
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

test("normalizeMemoryText folds accents and punctuation", () => {
  assert.equal(normalizeMemoryText("Configuração"), "configuracao");
  assert.equal(normalizeMemoryText("backend/T-230"), "backend t 230");
  assert.equal(normalizeMemoryText("  AÇÃO   crua! "), "acao crua");
});

test("memoryQueryMatch folds accents: 'configuracao' acha 'Configuração'", () => {
  const hay = "T-230: Configuração do hot-set de memória";
  assert.equal(memoryQueryMatch(hay, "configuracao", "and"), true);
  assert.equal(memoryQueryMatch(hay, "CONFIGURACAO memoria", "and"), true);
  assert.equal(memoryQueryMatch(hay, "configuracao", "or"), true);
  assert.equal(memoryQueryMatch(hay, "inexistente", "and"), false);
});

test("memoryQueryMatch folds punctuation: 't-230' acha 'T-230'", () => {
  const hay = "Summarizer grok-custom: branch backend/T-230";
  assert.equal(memoryQueryMatch(hay, "t-230", "and"), true);
  assert.equal(memoryQueryMatch(hay, "backend t 230", "and"), true);
});

test("memoryTitleNearDup tolerates accents via shared normalizer", () => {
  assert.equal(memoryTitleNearDup("Configuração do proxy", "configuracao do proxy"), true);
  assert.equal(memoryTitleNearDup("Memória: hot-set", "memoria hot set"), true);
});

test("memoryBodySame ignores accents and whitespace collapse", () => {
  assert.equal(memoryBodySame("Usar Postgres na Configuração", "usar postgres na configuracao"), true);
  assert.equal(memoryBodySame("linha 1\nlinha 2", "linha 1 linha 2"), true);
  assert.equal(memoryBodySame("corpo completamente diferente", "outro corpo"), false);
});

test("memoryManualDupDecision: near-dup com corpo igual → skip", () => {
  const existing = [{ id: "mem_abc", title: "Deploy produção", body: "rsync server/dist para /opt/the-dudes" }];
  const d = memoryManualDupDecision(existing, "deploy producao", "rsync server/dist para /opt/the-dudes");
  assert.equal(d.action, "skip");
  if (d.action === "skip") {
    assert.equal(d.nearId, "mem_abc");
    assert.equal(d.nearTitle, "Deploy produção");
  }
});

test("memoryManualDupDecision: near-dup com corpo novo → supersede", () => {
  const existing = [{ id: "mem_def", title: "Deploy produção", body: "ftp antigo, obsoleto" }];
  const d = memoryManualDupDecision(existing, "Deploy produção", "agora é rsync + systemctl restart");
  assert.equal(d.action, "supersede");
  if (d.action === "supersede") {
    assert.equal(d.nearId, "mem_def");
    assert.equal(d.nearTitle, "Deploy produção");
  }
});

test("memoryManualDupDecision: sem near-dup → create", () => {
  const existing = [{ id: "mem_x", title: "Lunch menu", body: "pizza" }];
  assert.equal(memoryManualDupDecision(existing, "Deploy produção", "rsync").action, "create");
  assert.equal(memoryManualDupDecision([], "Qualquer título", "corpo").action, "create");
});

test("memoryPinBudgetWarning: pinned com body > 2000 chars avisa", () => {
  const big = "x".repeat(2001);
  const warn = memoryPinBudgetWarning(true, big);
  assert.ok(warn.includes("2001"));
  assert.ok(warn.includes("8000"));
  assert.equal(memoryPinBudgetWarning(true, "x".repeat(2000)), "");
  assert.equal(memoryPinBudgetWarning(false, big), "");
  assert.equal(memoryPinBudgetWarning(undefined, big), "");
});
