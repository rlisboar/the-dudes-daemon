/**
 * T-417/A9 — guarda de epoch no `close` TARDIO de gemini, codex e crush.
 *
 * Defeito: um turno recuperado como pendurado (SIGKILL do hard recover) ou
 * invalidado por clear/compact deixa de ser dono da sessão, mas o `close` do
 * ChildProcess dele continua a chegar — e chegava DEPOIS de o drain ter posto
 * um turno NOVO em voo, libertando o slot do gate desse turno novo, anulando
 * `ocActiveProc` e zerando `busy` (agente mudo até restart manual). O qwen
 * aprendeu isto na T-371 e o grok na T-240; aqui é o MESMO bloco copiado, não
 * um protocolo de epoch alternativo.
 *
 * Harness: AgentRunner REAL + CLI stub executável que regista o argv de cada
 * spawn e NUNCA sai (padrão T-240/T-251/T-371). As asserções de slot são sobre
 * o contador GLOBAL do turn-gate (`turnGateStats().ativos`): TODO teste abre e
 * fecha com `_resetTurnGateForTest()` para que a ordem dos testes não pese.
 *
 * Cleanup em TODO caminho: o stub vivo prende o stdout do filho e o timer do
 * `armHardTimeout` (12min, sem unref) prende o event loop — o teste PENDA se o
 * filho não for morto à mão (pitfall T-376).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { hangThresholds } from "../runners/turn-watchdog.js";
import { killProcess } from "../runners/process-lifecycle.js";
import { turnGateStats, _resetTurnGateForTest } from "../runners/turn-gate.js";

/** Stub: regista o argv de cada spawn e fica vivo para sempre (turno pendurado).
 *  O argv é achatado: gemini/codex/crush levam o prompt (system + user, com
 *  linhas novas dentro) como ARGV (`-p …`) — sem isto um spawn contaria como
 *  N linhas e a contagem de spawns (critério 3) nunca fecharia. O qwen da
 *  T-371 não tinha este problema porque lá o prompt vai pelo stdin. */
const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const dir = path.dirname(url.fileURLToPath(import.meta.url));
const flat = process.argv.slice(2).join(" ").replace(/[\\r\\n]+/g, " ");
fs.appendFileSync(path.join(dir, "argv.log"), flat + "\\n");
setInterval(() => {}, 1000);
`;

type PerMsgRunner = "gemini" | "codex" | "crush";

const RUNNERS: Array<{ runner: PerMsgRunner; method: string }> = [
  { runner: "gemini", method: "runGeminiMessage" },
  { runner: "codex", method: "runCodexMessage" },
  { runner: "crush", method: "runCrushMessage" },
];

interface Harness {
  runner: AgentRunner;
  warns: string[];
  /** TODO ChildProcess real spawnado pelo runner — morto à mão no cleanup. */
  children: ChildProcess[];
  argvLines(): string[];
}

function makeHarness(cliRunner: PerMsgRunner): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t417-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const warns: string[] = [];
  const cmd = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  const cliCommands = {
    claude: off, opencode: off, qwen: off, grok: off, "grok-custom": off,
    graphify: off, graphifyMcp: off,
    gemini: cliRunner === "gemini" ? cmd : off,
    codex: cliRunner === "codex" ? cmd : off,
    crush: cliRunner === "crush" ? cmd : off,
  };
  const info = {
    id: `agent_t417_${cliRunner}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: `t417-${cliRunner}`, role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner, autoApprove: true, workspaceRoot: dir,
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (lvl: string, msg: string) => { if (lvl === "warn") warns.push(msg); },
    cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onSessionId: () => {}, onExit: () => {},
  } as never);
  const children: Harness["children"] = [];
  return {
    runner,
    warns,
    children,
    argvLines: () => {
      try {
        return readFileSync(path.join(dir, "argv.log"), "utf8").split("\n").filter((l) => l.trim());
      } catch {
        return [];
      }
    },
  };
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const tick = (r: AgentRunner) => (r as unknown as { tickHangWatch: () => void }).tickHangWatch();
const gateAtivos = () => turnGateStats().ativos;

/** Proc do turno NOVO: basta ter a superfície que o close toca. */
function fakeTurnProc(): any {
  return {
    pid: 999_999, kill: () => true, once: () => {}, on: () => {}, emit: () => {},
    stdout: { setEncoding: () => {}, on: () => {} },
    stderr: { setEncoding: () => {}, on: () => {} },
    exitCode: null, signalCode: null,
  };
}

async function until(cond: () => boolean, what: string, ms = 45_000): Promise<void> {
// O predicado é o fato que o teste precisa; o teto folgado só absorve atraso
// de spawn/event loop sob dois workers de carga.
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Budget dos waits de SPAWN (os que precedem asserção de slot). O spawn do stub
 *  é um `node` novo sob a carga do runner de CI: 5s já estourou ali (observado
 *  nos dois lados, base e tip, na mesma rodada). Como o `until` espera um FATO,
 *  subir o budget não afrouxa asserção — só o tempo que o teste tolera. */
const SPAWN_BUDGET_MS = 45_000;

/** Cleanup: mata os filhos reais (senão o teste PENDA — ver cabeçalho), pára o
 *  runner e zera o gate para o próximo teste começar do zero.
 *
 *  T-417 flake: é o `close` do filho morto que devolve o slot ao contador
 *  GLOBAL do gate (`endTurn` → `releaseActiveTurnSlot`), e ele aterra
 *  assíncrono. Com espera FIXA esse close podia aterrar depois do
 *  `_resetTurnGateForTest()` do teste SEGUINTE e derrubar a pré-condição dele
 *  ("turno 1 segura o slot" com 0 no contador). Aqui a espera é pelo FATO —
 *  cada filho fechado — e só depois o gate zera. */
async function cleanup(h: Harness): Promise<void> {
  // Liga o listener ANTES do kill (T-577): se o close já aterrou, o filho
  // nem entra no pending. T-599: `until` (teto + mensagem) em vez de
  // Promise.all sem prazo — um close que nunca vem falha o teste, não pende.
  const pending = new Set<ChildProcess>();
  for (const p of h.children) {
    if (p.exitCode !== null || p.signalCode !== null) continue;
    pending.add(p);
    p.once("close", () => pending.delete(p));
    if (p.exitCode !== null || p.signalCode !== null) pending.delete(p);
  }
  for (const p of h.children) killProcess(p, "SIGKILL");
  h.runner.stop();
  await until(() => pending.size === 0, "close dos filhos mortos");
  _resetTurnGateForTest();
}

/** Turno em voo com o stub pendurado: 1 slot do gate, `activeTurnRelease` do
 *  próprio runner (o handle que um close WRONG não pode consumir). */
async function spawnHangingTurn(h: Harness, method: string, content: string): Promise<any> {
  const a = asAny(h.runner);
  a.messageSession.busy = true; // o que o drainOcQueue faria antes de despachar
  void a[method](content);
  // T-417 flake / T-599: esperar o FATO (slot ocupado), não só o spawn — o
  // slot é adquirido ANTES do spawn, mas quem o segura é o turno, não a
  // linha de argv. Budget do T-577 (5s já estourou sob carga).
  await until(
    () => h.argvLines().length >= 1 && gateAtivos() === 1,
    "spawn do stub e slot do gate ocupado",
    SPAWN_BUDGET_MS,
  );
  const proc = a.ocActiveProc;
  assert.ok(proc && typeof proc.emit === "function", "pré-condição: turno em voo tem proc");
  h.children.push(proc);
  assert.equal(gateAtivos(), 1, "pré-condição: turno em voo segura 1 slot do gate");
  assert.equal(typeof a.activeTurnRelease, "function", "pré-condição: o turno tem handle do gate");
  return proc;
}

/* ---------- critério 1: close com epoch velho não toca no turno NOVO ---------- */

for (const { runner, method } of RUNNERS) {
  test(`T-417 ${runner}: close com epoch velho não liberta o slot nem zera busy/proc do turno novo`, async () => {
    const h = makeHarness(runner);
    const a = asAny(h.runner);
    _resetTurnGateForTest();
    try {
      const proc1 = await spawnHangingTurn(h, method, "vitima");
      assert.equal(a.currentState, "thinking", "pré-condição: turno em voo está thinking");

      // Bookkeeping de um hard recover, sem o tick — o que se testa é o close:
      a.messageSession.bumpEpoch(); // turno 1 perde a posse do epoch
      const proc2 = fakeTurnProc(); // proc do turno NOVO que o drain pôs em voo
      a.ocActiveProc = proc2;
      // O handle do gate é agora do turno NOVO (o do turno 1 foi devolvido pelo
      // recover — coberto pelo teste do resetWithSummary):
      let novoLibertado = 0;
      a.activeTurnRelease = () => { novoLibertado++; };

      let closeChegou = false;
      proc1.once("close", () => { closeChegou = true; });
      proc1.kill("SIGKILL");
      await until(() => closeChegou, "close real do proc morto após o turno novo", SPAWN_BUDGET_MS);

      assert.equal(novoLibertado, 0, "close velho não pode consumir o handle do gate do turno novo");
      assert.equal(a.activeTurnRelease !== null, true, "handle do turno novo continua armado");
      assert.equal(gateAtivos(), 1, "close velho não pode alterar a contagem do gate");
      assert.equal(a.ocActiveProc, proc2, "close velho não pode apagar o proc do turno novo");
      assert.equal(a.messageSession.busy, true, "close velho não pode zerar o busy do turno novo");
      assert.notEqual(a.currentState, "idle", "close velho não pode pôr o runner idle");

      assert.equal(novoLibertado, 0, "close real do proc morto também não liberta o handle alheio");
      assert.equal(a.ocActiveProc, proc2, "close real do proc morto também não apaga o proc novo");
      assert.equal(a.messageSession.busy, true, "close real do proc morto também não zera o busy");
    } finally {
      await cleanup(h);
    }
  });
}

/* ---------- critério 2: close com epoch atual continua a libertar o slot ---------- */

for (const { runner, method } of RUNNERS) {
  test(`T-417 ${runner}: close com epoch ATUAL liberta o slot e fecha o turno`, async () => {
    const h = makeHarness(runner);
    const a = asAny(h.runner);
    _resetTurnGateForTest();
    try {
      const proc = await spawnHangingTurn(h, method, "dono");
      a.messageSession.busy = true;

      proc.emit("close", null); // este turno ainda é o dono do epoch

      assert.equal(gateAtivos(), 0, `close do turno dono tem de libertar o slot: ${JSON.stringify(turnGateStats())}`);
      assert.equal(a.activeTurnRelease, null, "handle consumido e anulado (idempotência)");
      assert.equal(a.ocActiveProc, null, "close do dono anula ocActiveProc");
      await until(() => a.messageSession.busy === false, "busy liberado pelo turno dono");
      await until(() => a.currentState === "idle", "runner idle após o turno dono fechar");

      // Idempotência: um segundo close não volta a baixar o contador.
      proc.emit("close", null);
      assert.equal(gateAtivos(), 0, "close repetido não liberta duas vezes");
    } finally {
      await cleanup(h);
    }
  });
}

/* ---------- critério 3: recoverHungTurn → spawn novo → close do morto ---------- */

// Sem `method`: aqui o turno entra pelo drain REAL (pushUserMessage), para o
// recoverHungTurn ter fila para drenar — é esse turno novo que se protege.
for (const { runner } of RUNNERS) {
  test(`T-417 ${runner}: close do turno morto por recoverHungTurn não altera o epoch do turno novo`, async () => {
    const h = makeHarness(runner);
    const a = asAny(h.runner);
    _resetTurnGateForTest();
    try {
      // Turno 1 pelo drain REAL, para o recover poder drenar a fila.
      h.runner.pushUserMessage("turno-1");
      await until(
        () => h.argvLines().length === 1 && gateAtivos() === 1,
        "spawn do turno 1 e slot do gate ocupado",
        SPAWN_BUDGET_MS,
      );
      const proc1 = a.ocActiveProc;
      h.children.push(proc1);
      let closeRealChegou = false;
      proc1.once("close", () => { closeRealChegou = true; });
      const epoch1 = a.messageSession.epoch;
      assert.equal(a.messageSession.busy, true, "turno 1 em voo");
      assert.equal(gateAtivos(), 1, "turno 1 segura o slot");

      // Mensagem atras dele: o turno NOVO que o drain do recover vai despachar.
      h.runner.pushUserMessage("turno-2");
      assert.equal(a.messageSession.queuedCount(), 1, "turno 2 na fila atras do turno 1");

      a.activityClock.lastActivityAt = Date.now() - (hangThresholds(runner).hardMs + 5_000);
      tick(h.runner);

      assert.ok(
        h.warns.some((w) => w.includes("HARD recover")),
        `o recover tem de correr de facto: ${h.warns.join(" | ")}`,
      );
      assert.notEqual(a.messageSession.epoch, epoch1, "recover invalidou a geração do turno 1");
      await until(
        () => h.argvLines().length === 2 && gateAtivos() === 1,
        "spawn do turno novo pelo drain do recover e slot do gate ocupado",
        SPAWN_BUDGET_MS,
      );

      const proc2 = a.ocActiveProc;
      h.children.push(proc2);
      const epoch2 = a.messageSession.epoch;
      assert.ok(proc2 && proc2 !== proc1, "turno novo tem proc proprio");
      assert.equal(a.messageSession.busy, true, "turno novo esta em voo");
      assert.equal(gateAtivos(), 1, "o slot em voo agora é o do turno novo");
      const handle2 = a.activeTurnRelease;

      await until(() => closeRealChegou, "close real do turno 1 após o recover", SPAWN_BUDGET_MS);
      assert.equal(a.messageSession.busy, true, "close real do morto não zera o busy do turno novo");
      proc1.emit("close", null); // e chega explicitamente mais uma vez

      assert.equal(a.messageSession.epoch, epoch2, "close do morto não mexe no epoch do turno novo");
      assert.equal(a.activeTurnRelease, handle2, "close do morto não consome o handle do turno novo");
      assert.equal(gateAtivos(), 1, "close do morto não liberta o slot do turno novo");
      assert.equal(a.ocActiveProc, proc2, "close do morto não apaga o proc do turno novo");
      assert.equal(a.messageSession.busy, true, "close do morto não zera o busy do turno novo");
      assert.notEqual(a.currentState, "idle", "close do morto não pôs o runner idle");
    } finally {
      await cleanup(h);
    }
  });
}

/* ---------- acompanhante obrigatório: clear/compact devolve o slot invalidado ---------- */

for (const { runner, method } of RUNNERS) {
  test(`T-417 ${runner}: resetWithSummary (clear/compact) devolve o slot do turno que ele invalida`, async () => {
    const h = makeHarness(runner);
    const a = asAny(h.runner);
    _resetTurnGateForTest();
    try {
      const proc = await spawnHangingTurn(h, method, "a-meio-do-turno");
      const epoch = a.messageSession.epoch;

      h.runner.resetWithSummary("resumo do compact");

      assert.equal(a.messageSession.epoch, epoch + 1, "reset bumpou o epoch");
      assert.equal(gateAtivos(), 0, "o slot do turno invalidado volta NO reset (senão vaza até MAX_HOLD_MS)");
      assert.equal(a.activeTurnRelease, null, "handle devolvido pelo reset");

      proc.emit("close", null); // close tardio do turno que o reset invalidou

      assert.equal(gateAtivos(), 0, "close velho não pode libertar além do que é seu (contador ficaria negativo)");
      assert.equal(a.messageSession.busy, true, "busy do turno em voo não é tocado pelo close velho");
    } finally {
      await cleanup(h);
    }
  });
}
