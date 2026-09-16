/**
 * T-447 (M24): rajada de eventos FS emite UM `graph:status` watch-pending por
 * janela de debounce — antes era um frame por evento (npm install → milhares).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGraphWatch, stopGraphWatch } from "../graph-watcher.js";

test("T-447: N eventos na janela de debounce = 1 watch-pending", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "t447-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  const graphDir = path.join(root, "graphify-out");
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(path.join(graphDir, "graph.json"), JSON.stringify({ nodes: [{ id: 1 }], edges: [] }));

  const bin = path.join(root, "graphify-stub.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(path.join(graphDir, "graph.json"))}, JSON.stringify({ nodes: [{ id: 1 }], edges: [] }));
`);
  chmodSync(bin, 0o755);

  const statuses: Array<{ status: string; phase?: string }> = [];
  ensureGraphWatch(root, bin, {
    debounceMs: 1200,
    onStatus: (status, info) => statuses.push({ status, phase: info?.phase }),
    log: () => {},
  });

  // Burst 1: 5 ficheiros; espera o FS entregar; Burst 2 na MESMA janela.
  for (let i = 0; i < 5; i++) writeFileSync(path.join(root, "src", `a${i}.ts`), "a");
  await new Promise((r) => setTimeout(r, 250));
  const pendingAfterBurst1 = statuses.filter((s) => s.phase === "watch-pending").length;
  for (let i = 0; i < 5; i++) writeFileSync(path.join(root, "src", `b${i}.ts`), "b");
  await new Promise((r) => setTimeout(r, 250));
  const pendingAfterBurst2 = statuses.filter((s) => s.phase === "watch-pending").length;

  assert.equal(pendingAfterBurst1, 1, "1 pending no burst 1");
  assert.equal(pendingAfterBurst2, 1, "burst 2 na mesma janela NÃO re-emite pending");

  // Debounce venceu → update roda (building → ready) e fecha a janela.
  const deadline = Date.now() + 8_000;
  while (!statuses.some((s) => s.phase === "watch" && s.status === "building") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(statuses.some((s) => s.status === "building"), "update após debounce");
  while (!statuses.some((s) => s.status === "ready" && s.phase === "watch") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(statuses.some((s) => s.status === "ready" && s.phase === "watch"), "ready pós-build");

  // Nova rajada depois do update = nova janela = novo pending (não suprime demais).
  const before = statuses.filter((s) => s.phase === "watch-pending").length;
  writeFileSync(path.join(root, "src", "c.ts"), "c");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(statuses.filter((s) => s.phase === "watch-pending").length, before + 1, "janela nova re-avisa stale");

  stopGraphWatch(root);
});
