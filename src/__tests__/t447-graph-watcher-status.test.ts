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

// T-1004: `timeout` + teardown em `t.after`. Antes o `stopGraphWatch` só rodava
// no fim do corpo: um assert falho deixava o FSWatcher recursivo (FSEvents no
// macOS) e o timer do debounce vivos, e o arquivo pendurava até ser cancelado
// (643s na validação local do lote d4c7be6e).
// T-1004: nada de sono fixo esperando o FS. Sob carga o FSEvents do macOS
// (a) entregava o burst 1 depois dos 250ms e (b) PERDIA os eventos escritos
// logo depois de o stream abrir, antes de ele estar ativo. Agora: aquece o
// watcher com uma sonda até ele provar que entrega (e deixa essa janela
// fechar), espera cada pending chegar, usa um debounce folgado (eventos
// atrasados do burst 2 ainda caem na mesma janela, que cada evento reinicia) e
// confere a contagem quando o debounce dispara — o fim real da janela.
const DEBOUNCE_MS = 3_000;
// T-1088: 35s — sob carga dupla a janela do aquecimento demora.
const TETO_MS = 35_000;
async function ate(cond: () => boolean, oque: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > TETO_MS) assert.fail(`timeout (${TETO_MS}ms) aguardando ${oque}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("T-447: N eventos na janela de debounce = 1 watch-pending", { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "t447-"));
  t.after(() => { stopGraphWatch(root); });
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
    debounceMs: DEBOUNCE_MS,
    onStatus: (status, info) => statuses.push({ status, phase: info?.phase }),
    log: () => {},
  });

  const pendings = () => statuses.filter((s) => s.phase === "watch-pending").length;
  const builds = () => statuses.filter((s) => s.phase === "watch" && s.status === "building").length;
  const readys = () => statuses.filter((s) => s.phase === "watch" && s.status === "ready").length;

  // Aquecimento: a sonda é regravada até o watcher provar que entrega; depois
  // a janela dela fecha (build → ready) e o contador parte do zero relativo.
  const t0 = Date.now();
  let n = 0;
  while (pendings() === 0) {
    if (Date.now() - t0 > TETO_MS) assert.fail(`watcher não entregou evento em ${TETO_MS}ms`);
    writeFileSync(path.join(root, "src", "sonda.ts"), String(n++));
    await new Promise((r) => setTimeout(r, 200));
  }
  await ate(() => readys() >= 1, "a janela do aquecimento fechar");
  const p0 = pendings();
  const b0 = builds();
  const r0 = readys();

  // Burst 1: 5 ficheiros; o 1º evento entregue abre a janela (1 pending).
  for (let i = 0; i < 5; i++) writeFileSync(path.join(root, "src", `a${i}.ts`), "a");
  await ate(() => pendings() >= p0 + 1, "o pending do burst 1");
  // Burst 2 na MESMA janela (o debounce ainda não disparou).
  for (let i = 0; i < 5; i++) writeFileSync(path.join(root, "src", `b${i}.ts`), "b");

  // Debounce venceu → update roda (building → ready) e fecha a janela. Só aí
  // a contagem é final: todos os eventos dos dois bursts já contaram.
  await ate(() => builds() > b0, "update após debounce");
  assert.equal(pendings() - p0, 1, "os dois bursts na mesma janela = 1 pending");
  await ate(() => readys() > r0, "ready pós-build");

  // Nova rajada depois do update = nova janela = novo pending (não suprime demais).
  const before = pendings();
  writeFileSync(path.join(root, "src", "c.ts"), "c");
  await ate(() => pendings() === before + 1, "o pending da janela nova");
  assert.equal(pendings(), before + 1, "janela nova re-avisa stale");
});
