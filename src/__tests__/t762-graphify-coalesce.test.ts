/**
 * T-762: o refresh do graphify é ÚNICO por projeto. N agentes que sobem juntos
 * compartilham o MESMO `graphify update` (single-flight por root) — a base
 * antiga já coalescia em memória; aqui fica PINADO que 5 chamadas concorrentes
 * geram 1 spawn, e que depois de concluir um novo refresh pode rodar.
 * Também pina que o teto do update deriva do medido (165–170s neste repo).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph, GRAPHIFY_UPDATE_TIMEOUT_MS } from "../graph-indexer.js";

const FAKE = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const dir = path.dirname(url.fileURLToPath(import.meta.url));
fs.appendFileSync(path.join(dir, "spawns.log"), String(Date.now()) + "\\n");
setTimeout(() => {
  process.stdout.write("Re-extracting code files...\\n");
  process.stdout.write("Rebuilt: 5 nodes, 4 edges\\n");
  process.exit(0);
}, 400);
`;

function setup(): { dir: string; bin: string; spawns: () => number } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t762-"));
  const bin = path.join(dir, "graphify");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  return {
    dir, bin,
    spawns: () => existsSync(path.join(dir, "spawns.log")) ? readFileSync(path.join(dir, "spawns.log"), "utf8").split("\n").filter(Boolean).length : 0,
  };
}

test("T-762: 5 refreshes concorrentes do mesmo root = 1 spawn (single-flight) e 1ª conclusão libera a próxima", async () => {
  const { dir, bin, spawns } = setup();
  const results = await Promise.all([
    buildGraph(dir, bin), buildGraph(dir, bin), buildGraph(dir, bin), buildGraph(dir, bin), buildGraph(dir, bin),
  ]);
  assert.equal(spawns(), 1, "N agentes no mesmo segundo não podem spawnar N graphify update");
  for (const r of results) {
    assert.equal(r.ok, true, `todas as chamadas recebem o MESMO resultado: ${JSON.stringify(r)}`);
    assert.equal(r.nodeCount, 5);
  }
  await buildGraph(dir, bin);
  assert.equal(spawns(), 2, "depois de concluir, um refresh novo roda normalmente (sem latch permanente)");
});

test("T-762: teto do update deriva do medido (165–170s solo) com margem declarada", () => {
  assert.equal(GRAPHIFY_UPDATE_TIMEOUT_MS, 900_000);
  assert.ok(GRAPHIFY_UPDATE_TIMEOUT_MS >= 2 * 332_000, "margem >= 2x o pior medido (332s)");
});