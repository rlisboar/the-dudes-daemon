/**
 * T-1070 (nit do QA-A no #1062): o rastreio de pid que impede CLI órfão
 * (`liveTurnPids` + `trackTurnPid`/`untrackTurnPid`, fix `4e3be34b`) só estava
 * coberto para o qwen, pelo `t598`. Aqui vai um caso POR RUNNER para codex,
 * gemini e crush, sem depender de `ps` (que o sandbox do agente nega — T-897).
 *
 * O que cada caso prova, em sequência:
 *   1. o pid do CLI spawnado ENTRA no rastreio (`liveTurnPids`);
 *   2. o `stop()` mata o CLI **e o NETO** (`sh` + `sleep` em background: prova o
 *      kill do GRUPO) e o Set esvazia;
 *   3. o caminho do hard recover (`recoverHungTurn`) mata pelo pid rastreado;
 *   4. spawn com ENOENT não vaza entrada no rastreio.
 *
 * Sem o `trackTurnPid` do runner correspondente, (1) falha — e (2)/(3) matam o
 * grupo errado (nada), deixando o stub vivo.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** Teardown que aguenta spawn TARDIO. O `stop()` pode preceder o spawn do stub
 *  num caso que já falhou (kill no-op) e, sob a carga da suíte, o spawn tardio
 *  chega DEPOIS de qualquer varredura curta — foi assim que o arquivo pendurou
 *  613s: dois stubs de crush nasceram após o teardown e seguraram os pipes.
 *  Aqui o teardown mata (a) o que o runner rastreia, (b) o `ocActiveProc` e
 *  (c) os pids que o PRÓPRIO stub grava em `sh.pid`/`sleep.pid` — estes últimos
 *  independem do rastreio, então cobrem o tardio. Sem `ps`.
 *
 *  `pisoMs`: só os casos de HARD RECOVER precisam do piso longo (8s), porque só
 *  eles disparam o `auto-continue` em 5s do runner. Nos demais um piso curto
 *  basta — era isso que fazia o arquivo custar 78,5s (9 casos × 8s). */
async function teardown(runner: AgentRunner, dir: string, pisoMs = 1_000): Promise<void> {
  try { runner.stop(); } catch { /* já parado */ }
  const matarPid = (pid: number): boolean => {
    if (!Number.isFinite(pid) || pid <= 1) return false;
    try { process.kill(-pid, "SIGKILL"); return true; } catch { /* sem grupo */ }
    try { process.kill(pid, "SIGKILL"); return true; } catch { return false; }
  };
  let limpos = 0;
  // MÍNIMO de 8s de varredura: depois do hard recover o runner agenda
  // `auto-continue` em 5s e esse spawn nasce DEPOIS do stop — sem cobrir a
  // janela o stub nascia livre (foi o vazamento que pendurou o arquivo).
  for (let i = 0; i < 150; i++) { // até ~15s
    if (i * 100 >= pisoMs && limpos >= 5) break;
    await new Promise((r) => setTimeout(r, 100));
    try { asAny(runner).killTrackedTurnPids("SIGKILL"); } catch { /* observação */ }
    try { asAny(runner).ocActiveProc?.kill?.("SIGKILL"); } catch { /* observação */ }
    let vivos = 0;
    for (const arq of ["sh.pid", "sleep.pid"]) {
      try {
        const pid = Number(readFileSync(path.join(dir, arq), "utf8").trim());
        if (vivo(pid)) { matarPid(pid); vivos++; }
      } catch { /* stub ainda não gravou */ }
    }
    limpos = vivos === 0 && rastreados(runner).size === 0 && !asAny(runner).ocActiveProc ? limpos + 1 : 0;
  }
}

async function until(cond: () => boolean, ms = 60_000, o = "condição"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${o}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Stub detached: `sh` (filho direto, líder do grupo) + `sleep` em background
 *  (NETO). Grava os DOIS pids para o teste travar a semântica de GRUPO: matar só
 *  o filho deixaria o neto vivo segurando os pipes. Args do runner são ignorados. */
function harness(cliRunner: RunnerAlvo, opts: { comando?: string } = {}): { runner: AgentRunner; stub: string; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `t1070-${cliRunner}-`));
  const stub = path.join(dir, "cli.sh");
  writeFileSync(stub, [
    "#!/bin/sh",
    `echo "$$" > "${dir}/sh.pid"`,
    "sleep 300 &",
    `echo $! > "${dir}/sleep.pid"`,
    "wait",
    "",
  ].join("\n"));
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
    log: process.env.T1070_VERBOSE ? (l: string, m: string) => console.log(`  [log] ${l} ${m.slice(0, 100)}`) : () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onThinkingText: () => {}, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onExit: () => {},
  } as never);
  return { runner, stub, dir };
}

/** Lê um pid gravado pelo stub (com retry: a gravação é pós-spawn). */
async function lerPid(arquivo: string): Promise<number> {
  await until(() => { try { return Number(readFileSync(arquivo, "utf8").trim()) > 0; } catch { return false; } }, 20_000, arquivo);
  return Number(readFileSync(arquivo, "utf8").trim());
}

/** Sobe um turno e devolve o pid RASTREADO (filho) + o do NETO (`sleep`). */
async function turnoComPidRastreado(cliRunner: RunnerAlvo): Promise<{ runner: AgentRunner; dir: string; pid: number; pidNeto: number }> {
  const { runner, dir } = harness(cliRunner);
  runner.pushUserMessage("trabalho longo");
  await until(() => rastreados(runner).size > 0, 60_000, `${cliRunner}: pid no rastreio`);
  const pids = [...rastreados(runner)];
  assert.equal(pids.length, 1, `${cliRunner}: um turno = um pid rastreado`);
  const pid = pids[0]!;
  assert.equal(asAny(runner).ocActiveProc?.pid, pid, `${cliRunner}: é o pid do processo spawnado`);
  assert.equal(vivo(pid), true, `${cliRunner}: stub vivo antes do kill`);
  // NETO: é ele que prova a semântica de GRUPO — matar só o filho o deixaria
  // rodando segurando os pipes (é o CLI real atrás do wrapper).
  const pidNeto = await lerPid(path.join(dir, "sleep.pid"));
  assert.equal(vivo(pidNeto), true, `${cliRunner}: neto (sleep) vivo antes do kill`);
  return { runner, dir, pid, pidNeto };
}

for (const cliRunner of RUNNERS) {
  test(`T-1070 ${cliRunner}: stop mata o CLI rastreado (e o NETO) e limpa o Set`, async (t) => {
    const { runner, dir, pid, pidNeto } = await turnoComPidRastreado(cliRunner);
    t.after(() => teardown(runner, dir));
    runner.stop();
    await until(() => !vivo(pid), 12_000, `${cliRunner}: processo morto pelo stop`);
    await until(() => !vivo(pidNeto), 12_000, `${cliRunner}: NETO morto pelo stop (kill do grupo, não só do filho)`);
    await until(() => rastreados(runner).size === 0, 12_000, `${cliRunner}: Set de pids limpo no stop`);
  });

  test(`T-1070 ${cliRunner}: hard recover mata por pid RASTREADO (e o NETO)`, async (t) => {
    const { runner, dir, pid, pidNeto } = await turnoComPidRastreado(cliRunner);
    // piso longo: o recover agenda `auto-continue` em 5s e esse spawn nasce
    // depois do stop (é o único caso com essa janela).
    t.after(() => teardown(runner, dir, 8_000));
    // Caminho real do watchdog (é ele que chama killTrackedTurnPids quando
    // `ocActiveProc` já foi anulado por um close tardio).
    await asAny(runner).recoverHungTurn("teste t1070", 0);
    await until(() => !vivo(pid), 12_000, `${cliRunner}: processo morto pelo hard recover`);
    await until(() => !vivo(pidNeto), 12_000, `${cliRunner}: NETO morto pelo hard recover`);
    await until(() => rastreados(runner).size === 0, 12_000, `${cliRunner}: Set limpo pelo recover`);
  });

  test(`T-1070 ${cliRunner}: spawn ENOENT não vaza pid no rastreio`, async (t) => {
    const dirFora = mkdtempSync(path.join(os.tmpdir(), `t1070-enoent-${cliRunner}-`));
    const { runner, dir } = harness(cliRunner, { comando: path.join(dirFora, "nao-existe.sh") });
    t.after(() => teardown(runner, dir));
    runner.pushUserMessage("trabalho longo");
    // O turno morre por spawn-error: o invariante é NÃO VAZAR (o settle pode
    // atrasar sob carga — o `until` vira best-effort, não veredicto).
    await until(() => asAny(runner).messageSession.busy === false, 20_000, `${cliRunner}: turno falha limpo`).catch(() => {});
    assert.equal(rastreados(runner).size, 0, `${cliRunner}: ENOENT não registra pid`);
    assert.equal(asAny(runner).ocActiveProc, null, `${cliRunner}: sem proc pendurado`);
  });
}