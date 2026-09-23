/**
 * T-846 — close 4000 "superseded" (outro processo com o mesmo token assumiu).
 *
 * Antes: todo close que não fosse parada local reconectava na hora, então os
 * dois processos se revezavam para sempre. Agora o daemon para os CLIs locais,
 * loga uma vez e volta PASSIVO depois de um cooldown; 4001 "occupied" (token
 * ainda ocupado) só espera, com o mesmo backoff; qualquer outro close mantém o
 * comportamento de sempre.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { decidirClose, proximoDelayPassivo, PASSIVO_BASE_MS, PASSIVO_CAP_MS } = await import("../ws-handoff.js");
const { AgentHost } = await import("../agent-host.js");

const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");

test("T-846: só 4000/superseded e 4001/occupied entram no caminho passivo", () => {
  assert.equal(decidirClose(4000, "superseded"), "passivo-superseded");
  assert.equal(decidirClose(4001, "occupied"), "passivo-occupied");
  // Mesmo código com outro motivo, ou outro código: caminho normal.
  assert.equal(decidirClose(4000, "outra coisa"), "normal");
  assert.equal(decidirClose(4001, "(no reason)"), "normal");
  for (const code of [1000, 1001, 1005, 1006, 1011, 1002]) {
    assert.equal(decidirClose(code, "x"), "normal", `code ${code}`);
  }
});

test("T-846: cooldown começa em 30s, dobra e para no teto de 5min", () => {
  const meio = () => 0.5; // jitter neutro
  assert.equal(proximoDelayPassivo(0, meio), PASSIVO_BASE_MS);
  assert.equal(proximoDelayPassivo(PASSIVO_BASE_MS, meio), 60_000);
  assert.equal(proximoDelayPassivo(60_000, meio), 120_000);
  assert.equal(proximoDelayPassivo(240_000, meio), PASSIVO_CAP_MS);
  assert.equal(proximoDelayPassivo(PASSIVO_CAP_MS, meio), PASSIVO_CAP_MS, "não passa do teto");
  // jitter ±25%
  assert.equal(proximoDelayPassivo(0, () => 0), Math.floor(PASSIVO_BASE_MS * 0.75));
  assert.equal(proximoDelayPassivo(0, () => 1), Math.floor(PASSIVO_BASE_MS * 1.25));
});

test("T-846: no close de handoff não há connect imediato; o passivo sai com backoff", () => {
  const iClose = src.indexOf('ws.on("close"');
  assert.ok(iClose > 0);
  const bloco = src.slice(iClose, src.indexOf('ws.on("error"', iClose));
  assert.match(bloco, /decidirClose\(code, reasonStr\)/, "decide pelo código E motivo");
  assert.match(
    bloco,
    /if \(decisao !== "normal"\) \{\s*this\.agendarRetomadaPassiva\(decisao\);\s*return;\s*\}/,
    "4000/4001 saem ANTES do agendamento normal (senão volta a revezar)",
  );

  const iMet = src.indexOf("private agendarRetomadaPassiva(");
  assert.ok(iMet > 0, "método existe");
  const metodo = src.slice(iMet, src.indexOf("\n  /** T-970", iMet));
  assert.match(metodo, /proximoDelayPassivo\(this\.passivoDelayMs\)/);
  assert.match(metodo, /this\.helloPassivo = true/);
  assert.match(metodo, /this\.agendarConnect\(delay\)/);
  assert.match(metodo, /this\.host\.stopLocalClis\(/, "os CLIs locais param no 4000");
  assert.match(metodo, /log\(\s*"warn"/, "warn uma vez no handoff");
  assert.match(metodo, /this\.handoffLogado/, "flag de log único");

  // O hello carrega o passivo e o welcome volta ao normal.
  assert.match(src, /passive: this\.helloPassivo/);
  const iWelcome = src.indexOf('case "daemon:welcome":');
  const welcome = src.slice(iWelcome, src.indexOf("return;", iWelcome));
  assert.match(welcome, /this\.helloPassivo = false/);
  assert.match(welcome, /this\.passivoDelayMs = 0/);
});

test("T-846: stopLocalClis mata todos os CLIs locais e não mexe no worktree", () => {
  const logs: string[] = [];
  const host = new AgentHost(() => {}, null, null, {} as never, false, false, false, (_l: string, m: string) => { logs.push(m); }, () => {});
  const entries = (host as unknown as { entries: Map<string, unknown> }).entries;
  const parados: string[] = [];
  const semRunner: string[] = [];
  for (const id of ["a", "b"]) {
    entries.set(id, { projectId: "p", info: { id }, runner: { stop: () => { parados.push(id); } } });
  }
  entries.set("c", { projectId: "p", info: { id: "c" } });
  assert.equal(host.stopLocalClis("teste"), 2, "só quem tem runner");
  assert.deepEqual(parados.sort(), ["a", "b"]);
  assert.ok(logs.some((l) => l.includes("CLI(s) local(is) parado(s)")), logs.join("\n"));
  assert.equal(host.stopLocalClis("teste"), 2, "idempotente (o processo novo re-spawna pelo replay)");
  void semRunner;
});