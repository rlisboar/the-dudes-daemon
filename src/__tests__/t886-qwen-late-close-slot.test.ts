/**
 * T-886 — o close TARDIO do turno qwen recuperado não pode roubar o slot do
 * turno NOVO nem voltar o runner a idle (o mesmo guard dos irmãos).
 *
 * Defeito (achado adjacente da revisão QA-A do #841): o `releaseActiveTurnSlot`
 * era incondicional no handler de `close` e o `setState("idle")`/`drainOcQueue`
 * do fim também. Um turno morto pelo hard recover tinha o close aterrando
 * DEPOIS de o drain pôr o turno novo em voo: o handle do gate do turno NOVO era
 * consumido (contador subconta 1 → o pool admite um turno extra e /health
 * subnotifica) e o runner mentia "idle" com turno vivo. gemini/codex/crush
 * (endTurn) e grok (T-593) já usam este guard.
 *
 * Harness: AgentRunner REAL + stub que regista o argv e NUNCA sai. Cleanup em
 * todo caminho (stub vivo prende o stdout e o timer do hard timeout).
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

const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const dir = path.dirname(url.fileURLToPath(import.meta.url));
fs.appendFileSync(path.join(dir, "argv.log"), "spawn\\n");
setInterval(() => {}, 1000);
`;

interface Harness {
  runner: AgentRunner;
  children: ChildProcess[];
  argvLines(): string[];
}

function makeHarness(): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t886-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const cmd = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  const cliCommands = {
    claude: off, opencode: off, gemini: off, codex: off, crush: off,
    grok: off, "grok-custom": off, graphify: off, graphifyMcp: off, qwen: cmd,
  };
  const info = {
    id: `agent_t886_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t886-qwen", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "qwen", autoApprove: true, workspaceRoot: dir,
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onSessionId: () => {}, onExit: () => {},
  } as never);
  const children: ChildProcess[] = [];
  return {
    runner,
    children,
    argvLines: () => {
      try { return readFileSync(path.join(dir, "argv.log"), "utf8").split("\n").filter((l) => l.trim()); } catch { return []; }
    },
  };
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const gateAtivos = () => turnGateStats().ativos;

async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function cleanup(h: Harness): Promise<void> {
  const pending = new Set<ChildProcess>();
  for (const p of h.children) {
    if (p.exitCode !== null || p.signalCode !== null) continue;
    pending.add(p);
    p.once("close", () => pending.delete(p));
  }
  for (const p of h.children) killProcess(p, "SIGKILL");
  h.runner.stop();
  await until(() => pending.size === 0, "close dos filhos mortos");
  _resetTurnGateForTest();
}

async function turnoEmVoo(h: Harness): Promise<ChildProcess> {
  const a = asAny(h.runner);
  a.messageSession.busy = true;
  void a.runQwenMessage("vitima");
  await until(() => h.argvLines().length >= 1 && gateAtivos() === 1, "spawn do stub e slot do gate ocupado");
  const proc = a.ocActiveProc as ChildProcess;
  assert.ok(proc, "pré-condição: turno em voo tem proc");
  h.children.push(proc);
  return proc;
}

test("T-886: close tardio do turno recuperado não consome o slot nem volta a idle", async () => {
  const h = makeHarness();
  const a = asAny(h.runner);
  _resetTurnGateForTest();
  try {
    const proc1 = await turnoEmVoo(h);
    assert.equal(a.currentState, "thinking", "pré-condição: turno em voo está thinking");

    // Bookkeeping do hard recover, sem tick: o turno 1 perde a posse do epoch e
    // o drain põe o turno NOVO em voo (proc e handle do gate novos).
    a.messageSession.bumpEpoch();
    a.ocActiveProc = {
      pid: 999_999, kill: () => true, once: () => {}, on: () => {}, emit: () => {},
      stdout: { setEncoding: () => {}, on: () => {} },
      stderr: { setEncoding: () => {}, on: () => {} },
      exitCode: null, signalCode: null,
    };
    let slotDoNovo = 0;
    a.activeTurnRelease = () => { slotDoNovo++; };
    a.setState("thinking");

    proc1.kill("SIGKILL");
    await until(() => proc1.exitCode !== null || proc1.signalCode !== null, "filho morto");
    await new Promise((r) => setTimeout(r, 250)); // o close aterra async

    assert.equal(slotDoNovo, 0, "close velho NÃO pode consumir o handle do gate do turno novo");
    assert.equal(typeof a.activeTurnRelease, "function", "handle do turno novo continua armado");
    assert.equal(a.currentState, "thinking", "estado não pode voltar a idle com o turno novo vivo");
    assert.ok(a.messageSession.busy, "busy do turno novo preservado");
    assert.ok(a.ocActiveProc, "proc do turno novo preservado");
  } finally {
    await cleanup(h);
  }
});

test("T-886: close COM posse segue liberando o slot e voltando a idle (sem regressão)", async () => {
  const h = makeHarness();
  const a = asAny(h.runner);
  _resetTurnGateForTest();
  try {
    const proc = await turnoEmVoo(h);
    let liberados = 0;
    a.activeTurnRelease = () => { liberados++; };
    proc.kill("SIGKILL");
    await until(() => proc.exitCode !== null || proc.signalCode !== null, "filho morto");
    await until(() => liberados === 1, "release do slot no close com posse");
    await until(() => a.currentState === "idle", "volta a idle");
    assert.equal(a.ocActiveProc, null, "proc liberado");
    assert.equal(a.messageSession.busy, false, "busy zerado");
  } finally {
    await cleanup(h);
  }
});