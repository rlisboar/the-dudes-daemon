/**
 * T-1070 (nit do QA-A no #1062): o rastreio de pid que impede CLI órfão
 * (`liveTurnPids` + `trackTurnPid`/`untrackTurnPid`, fix `4e3be34b`) só estava
 * coberto para o qwen, pelo `t598`. Aqui vai um caso POR RUNNER para codex,
 * gemini e crush, sem depender de `ps` (que o sandbox do agente nega — T-897).
 *
 * O que cada caso prova, em sequência:
 *   1. o pid do CLI spawnado ENTRA no rastreio (`liveTurnPids`);
 *   2. o `stop()` mata (grupo: stub é `sh` + `sleep`) e o Set esvazia;
 *   3. o caminho do hard recover (`recoverHungTurn`) mata pelo pid rastreado;
 *   4. spawn com ENOENT não vaza entrada no rastreio.
 *
 * Sem o `trackTurnPid` do runner correspondente, (1) falha — e (2)/(3) matam o
 * grupo errado (nada), deixando o stub vivo.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";

type RunnerAlvo = "codex" | "gemini" | "crush";
const RUNNERS: RunnerAlvo[] = ["codex", "gemini", "crush"];

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const rastreados = (r: AgentRunner): Set<number> => asAny(r).liveTurnPids as Set<number>;
const vivo = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function until(cond: () => boolean, ms = 8_000, o = "condição"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${o}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Stub detached: escreve o próprio pid e dorme (neto `sleep` incluído, para o
 *  kill do GRUPO ter o que alcançar). Args do runner são ignorados. */
function harness(cliRunner: RunnerAlvo, opts: { comando?: string } = {}): { runner: AgentRunner; stub: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `t1070-${cliRunner}-`));
  const stub = path.join(dir, "cli.sh");
  writeFileSync(stub, `#!/bin/sh\necho "$$" > "${dir}/pid.txt"\nsleep 300\n`);
  chmodSync(stub, 0o755);
  const info = {
    id: `agent_t1070_${cliRunner}_${process.pid}_${Math.random().toString(36).slice(2, 6)}`,
    ownerUserId: "u", name: `t1070${cliRunner}`, role: "backend",
    systemPrompt: "sys", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner, autoApprove: true, workspaceRoot: dir,
    cliCommands: {
      ...resolveCliCommands(),
      [cliRunner]: { command: opts.comando ?? stub, source: "override" as const, available: true },
    },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onThinkingText: () => {}, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onExit: () => {},
  } as never);
  return { runner, stub };
}

/** Sobe um turno e devolve o pid RASTREADO (o do processo spawnado). */
async function turnoComPidRastreado(cliRunner: RunnerAlvo): Promise<{ runner: AgentRunner; pid: number }> {
  const { runner } = harness(cliRunner);
  runner.pushUserMessage("trabalho longo");
  await until(() => rastreados(runner).size > 0, 8_000, `${cliRunner}: pid no rastreio`);
  const pids = [...rastreados(runner)];
  assert.equal(pids.length, 1, `${cliRunner}: um turno = um pid rastreado`);
  const pid = pids[0]!;
  assert.equal(asAny(runner).ocActiveProc?.pid, pid, `${cliRunner}: é o pid do processo spawnado`);
  assert.equal(vivo(pid), true, `${cliRunner}: stub vivo antes do kill`);
  return { runner, pid };
}

for (const cliRunner of RUNNERS) {
  test(`T-1070 ${cliRunner}: stop mata o CLI rastreado e limpa o Set`, async (t) => {
    const { runner, pid } = await turnoComPidRastreado(cliRunner);
    t.after(() => { try { runner.stop(); } catch { /* já parado */ } });
    runner.stop();
    await until(() => !vivo(pid), 5_000, `${cliRunner}: processo morto pelo stop`);
    await until(() => rastreados(runner).size === 0, 5_000, `${cliRunner}: Set de pids limpo no stop`);
  });

  test(`T-1070 ${cliRunner}: hard recover mata por pid RASTREADO (sem ps)`, async (t) => {
    const { runner, pid } = await turnoComPidRastreado(cliRunner);
    t.after(() => { try { runner.stop(); } catch { /* já parado */ } });
    // Caminho real do watchdog (é ele que chama killTrackedTurnPids quando
    // `ocActiveProc` já foi anulado por um close tardio).
    await asAny(runner).recoverHungTurn("teste t1070", 0);
    await until(() => !vivo(pid), 5_000, `${cliRunner}: processo morto pelo hard recover`);
    await until(() => rastreados(runner).size === 0, 5_000, `${cliRunner}: Set limpo pelo recover`);
  });

  test(`T-1070 ${cliRunner}: spawn ENOENT não vaza pid no rastreio`, async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `t1070-enoent-${cliRunner}-`));
    const { runner } = harness(cliRunner, { comando: path.join(dir, "nao-existe.sh") });
    t.after(() => { try { runner.stop(); } catch { /* já parado */ } });
    runner.pushUserMessage("trabalho longo");
    // O turno morre por spawn-error: nada de pid pendurado nem busy preso.
    await until(() => asAny(runner).messageSession.busy === false, 8_000, `${cliRunner}: turno falha limpo`);
    assert.equal(rastreados(runner).size, 0, `${cliRunner}: ENOENT não registra pid`);
    assert.equal(asAny(runner).ocActiveProc, null, `${cliRunner}: sem proc pendurado`);
  });
}