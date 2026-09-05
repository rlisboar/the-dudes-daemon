/**
 * T-251 (P1-5): turn-gate para TODOS os runners per-message. Antes só o Grok
 * adquiria slot do semáforo; gemini/codex/crush/opencode rodavam fora do gate
 * e o self-update (idle = gate vazio, T-088) podia matar o CLI em turno vivo.
 *
 * Provas aqui: turno de gemini/codex/opencode (e crush) OCUPA o slot do gate
 * e um turno além do MAX FICA NA FILA (estado "queued", watchdog parado);
 * quando o processo/POST do turno termina, o slot volta. A guarda estática
 * amarra o idle do self-update ao mesmo turnGateStats.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { acquireTurnSlot, turnGateStats } from "../runners/turn-gate.js";

function stubCli(): string {
  const p = path.join(os.tmpdir(), `t251-cli-stub-${process.pid}.mjs`);
  writeFileSync(p, "setInterval(() => {}, 1000);\n");
  return p;
}

function stubCommands(stub: string) {
  const cmd = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  return {
    claude: off, opencode: cmd, gemini: cmd, codex: cmd, crush: cmd,
    grok: cmd, "grok-custom": off, graphify: off, graphifyMcp: off,
  };
}

function makeRunner(cliRunner: string, states: string[]): { runner: AgentRunner; errors: string[] } {
  const stub = stubCli();
  const errors: string[] = [];
  const info = {
    id: `agent_${cliRunner}`, ownerUserId: "u", name: cliRunner, role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const opts = {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner, autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: stubCommands(stub), verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: (s: string) => states.push(s),
    onAssistantText: () => true, onToolUse: () => {},
    onError: (m: string) => { errors.push(m); },
    onHung: () => {}, onExit: () => {},
  } as never;
  const runner = new AgentRunner(info, opts);
  (runner as unknown as { drainOcQueue: () => void }).drainOcQueue = () => {};
  return { runner, errors };
}

const any = (r: AgentRunner) => r as unknown as Record<string, any>;

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout aguardando condição do gate");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function killTurnProc(r: AgentRunner): void {
  const p = any(r).ocActiveProc as { kill: (s: string) => void } | null;
  if (p) p.kill("SIGKILL");
}

async function assertSlotReleased(r: AgentRunner): Promise<void> {
  await until(() => turnGateStats().ativos === 0);
  any(r).stop?.();
}

for (const runnerName of ["gemini", "codex", "crush"] as const) {
  test(`T-251: turno ${runnerName} em execução OCUPA o slot do turn-gate e o libera no close`, async () => {
    const states: string[] = [];
    const { runner } = makeRunner(runnerName, states);
    const before = turnGateStats().ativos;
    void any(runner)[`run${runnerName[0]!.toUpperCase()}${runnerName.slice(1)}Message`]("oi");
    await until(() => turnGateStats().ativos === before + 1);
    assert.ok(states.includes("queued") || states.includes("thinking"), "turno passou pelo gate");
    killTurnProc(runner);
    await assertSlotReleased(runner);
  });
}

test("T-251: turno opencode (POST /message em voo) ocupa o gate e libera quando o POST resolve", async () => {
  const states: string[] = [];
  const { runner } = makeRunner("opencode", states);
  const a = any(runner);
  a.ensureOcServer = async () => {};
  a.openCodeTransport = { ready: () => true, stop: () => {}, start: async () => {} };
  let releasePost: () => void = () => {};
  const postInFlight = new Promise<void>((r) => { releasePost = r; });
  a.fetchOcCatalogLimit = async () => {};
  a.ocServeFetch = async (route: string, method: string) => {
    if (route === "/session" && method === "POST") return { id: "s1" };
    if (route.endsWith("/message") && method === "POST") { await postInFlight; return { info: {}, parts: [] }; }
    return [];
  };
  a.scheduleAttachmentCleanup = () => {};
  a.attachNonImageFiles = (m: string) => ({ content: m, cleanup: () => {} });
  a.messageSession.needsPrime = false;

  const before = turnGateStats().ativos;
  void a.runOpenCodeMessage("oi");
  await until(() => turnGateStats().ativos === before + 1);
  assert.equal(a.waitingTurnGate, false, "gate concedido — flag limpa");
  releasePost();
  await assertSlotReleased(runner);
});

test("T-251: turno além do MAX fica NA FILA (queued) e passa quando um slot libera", async () => {
  const max = turnGateStats().max;
  const holders: Array<() => void> = [];
  for (let i = 0; i < max; i++) holders.push(await acquireTurnSlot(`t251-holder-${i}`));
  const states: string[] = [];
  const { runner } = makeRunner("gemini", states);
  void any(runner).runGeminiMessage("oi");
  await until(() => turnGateStats().fila === 1);
  assert.ok(states.includes("queued"), "turno ocupou a fila do gate, não o CLI");
  holders[0]!();
  await until(() => turnGateStats().fila === 0);
  assert.equal(turnGateStats().ativos, max, "slot liberado foi concedido ao turno que esperava");
  killTurnProc(runner);
  await until(() => turnGateStats().ativos === max - 1);
  for (const h of holders.slice(1)) h();
});

test("T-251: idle do self-update continua amarrado ao turnGateStats (fonte lida)", () => {
  const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const m = src.match(/isIdle:\s*\(\)\s*=>\s*\{[\s\S]{0,200}turnGateStats\(\)[\s\S]{0,200}\}/);
  assert.ok(m, "isIdle do self-update deve consultar turnGateStats — turnos de QUALQUER runner ocupam o gate e adiam o update");
});
