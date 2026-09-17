/**
 * T-417 (flake de CI) — SONDA determinística do vazamento que derrubava a
 * pré-condição "turno 1 segura o slot" do teste SEGUINTE.
 *
 * Mecanismo: quem devolve o slot ao contador GLOBAL do gate é o handler de
 * `close` do filho morto (`endTurn` → `releaseActiveTurnSlot`) e o `close`
 * aterra assíncrono. O `cleanup` do `t417-late-close-epoch-guard.test.ts`
 * matava o filho, parava o runner, esperava 250ms FIXOS e só então zerava o
 * contador (`_resetTurnGateForTest`). Sob carga o close pode aterrar DEPOIS
 * desse zero: o release do teste anterior decrementa o contador que o teste
 * seguinte acabou de subir, e a asserção vê 0 onde esperava 1 — foi o único
 * FAIL do CI (run 35139205291, 612 pass / 1 fail, só no gêmeo codex, cujos
 * gêmeos gemini e crush passaram na mesma run).
 *
 * O mesmo cenário é montado duas vezes: (1) reset SEM esperar o fato — o close
 * tardio deixa o contador devendo 1 (chega a -1); (2) reset DEPOIS do fato
 * (cada filho fechado) — nenhuma transição depois, sem dívida para o próximo
 * teste. O arquivo real usa a forma (2).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { killProcess } from "../runners/process-lifecycle.js";
import { turnGateStats, _resetTurnGateForTest } from "../runners/turn-gate.js";

/** Mesmo stub do t417: regista o argv de cada spawn e NUNCA sai. */
const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const dir = path.dirname(url.fileURLToPath(import.meta.url));
const flat = process.argv.slice(2).join(" ").replace(/[\\r\\n]+/g, " ");
fs.appendFileSync(path.join(dir, "argv.log"), flat + "\\n");
setInterval(() => {}, 1000);
`;

function makeHarness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t417leak-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const cmd = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  const cliCommands = {
    claude: off, opencode: off, qwen: off, grok: off, "grok-custom": off,
    graphify: off, graphifyMcp: off, gemini: off, codex: cmd, crush: off,
  };
  const info = {
    id: `t417leak_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t417-leak", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "codex", autoApprove: true, workspaceRoot: dir,
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onSessionId: () => {}, onExit: () => {},
  } as never);
  const children: ChildProcess[] = [];
  return {
    runner, children,
    argvLines: () => {
      try {
        return readFileSync(path.join(dir, "argv.log"), "utf8").split("\n").filter((l) => l.trim());
      } catch { return []; }
    },
  };
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const gateAtivos = () => turnGateStats().ativos;

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Turno em voo com o stub pendurado (o slot do gate é adquirido ANTES do
 *  spawn, então esperar o argv não prova o slot — é o que a sonda mede). */
async function turnoEmVoo(h: ReturnType<typeof makeHarness>): Promise<ChildProcess> {
  const a = asAny(h.runner);
  h.runner.pushUserMessage("turno-1");
  await until(() => h.argvLines().length === 1, "spawn do stub");
  const proc = a.ocActiveProc as ChildProcess;
  h.children.push(proc);
  return proc;
}

/** Observa o contador por `ms` e devolve as transições vistas. */
async function observar(ms: number): Promise<string[]> {
  const t0 = Date.now();
  const transicoes: string[] = [];
  let last = gateAtivos();
  while (Date.now() - t0 < ms) {
    const now = gateAtivos();
    if (now !== last) {
      transicoes.push(`t+${Date.now() - t0}ms: ${last} → ${now}`);
      last = now;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return transicoes;
}

test("T-417 flake: reset do gate ANTES do close do filho morto deixa dívida de -1", async () => {
  const h = makeHarness();
  _resetTurnGateForTest();
  const proc = await turnoEmVoo(h);
  assert.equal(gateAtivos(), 1, "pré-condição: turno em voo segura o slot");

  // Cleanup na forma ANTIGA: mata, para o runner e zera o gate JÁ (sem esperar
  // o close aterrar) — é o que a espera fixa de 250ms tentava garantir.
  killProcess(proc, "SIGKILL");
  h.runner.stop();
  _resetTurnGateForTest();

  const transicoes = await observar(2_000);
  const depoisDoReset = transicoes.filter((t) => !t.startsWith("t+0ms"));
  assert.ok(
    transicoes.some((t) => t.endsWith("→ -1")),
    `o close do filho morto tem de decrementar DEPOIS do reset (transições: ${transicoes.join(" | ") || "nenhuma"})`,
  );
  assert.equal(gateAtivos(), -1, "contador devendo 1: o próximo teste subiria para 0 e veria 0 no lugar de 1");
  assert.ok(depoisDoReset.length > 0, "a transição tem de ser DEPOIS do reset, não antes");
});

test("T-417 flake: reset do gate DEPOIS do close do filho morto não deixa dívida", async () => {
  const h = makeHarness();
  _resetTurnGateForTest();
  await turnoEmVoo(h);
  assert.equal(gateAtivos(), 1, "pré-condição: turno em voo segura o slot");

  // Cleanup na forma NOVA: a espera é pelo FATO (o filho fechou) e só então o
  // gate zera — nenhum release do teste anterior pode cair no teste seguinte.
  const fechando = h.children.map((p) => new Promise<void>((res) => {
    if (p.exitCode !== null || p.signalCode !== null) return res();
    p.once("close", () => res());
  }));
  for (const p of h.children) killProcess(p, "SIGKILL");
  h.runner.stop();
  await Promise.all(fechando);
  _resetTurnGateForTest();

  const transicoes = await observar(2_000);
  assert.deepEqual(transicoes, [], `sem dívida: nenhuma transição após o reset (visto: ${transicoes.join(" | ")})`);
  assert.equal(gateAtivos(), 0, "contador em zero, pronto para o próximo teste");
});