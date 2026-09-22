/**
 * T-784: OpenCode parava de dar sinal de vida nos momentos que MAIS
 * trabalham — permission.asked (espera do dono) e tool running (build/suíte)
 * — e o relógio de ociosidade estourava o soft (stalled falso). Aqui:
 * permission.asked renova o relógio; tool running/completed controla
 * toolsInFlight (com tool em voo o soft não acende; teto segue toolsHardMs).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";
import { hangPhase, hangThresholds } from "../runners/turn-watchdog.js";
import { ocHandlePermissionAsked, ocHandleStreamPart, runOpenCodeMessageAttached } from "../runners/turns/opencode.js";

function makeRunner(): { runner: AgentRunner; a: any; hung: Array<{ soft: boolean }> } {
  const hung: Array<{ soft: boolean }> = [];
  const info = {
    id: `agent_t784_${process.pid}`, ownerUserId: "u", name: "t784", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "opencode", autoApprove: false, workspaceRoot: os.tmpdir(),
    cliCommands: resolveCliCommands(), verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: (h: { soft: boolean }) => { hung.push(h); },
    onExit: () => {},
  } as never);
  (runner as unknown as { drainOcQueue: () => void }).drainOcQueue = () => {};
  const a = runner as unknown as Record<string, any>;
  return { runner, a, hung };
}

const tick = (r: AgentRunner) => (r as unknown as { tickHangWatch: () => void }).tickHangWatch();

test("T-784: permission.asked renova o relógio de atividade", async () => {
  const { runner, a } = makeRunner();
  try {
    a.messageSession.busy = true;
    a.setState("thinking");
    a.messageSession.sessionId = "sess-perm";
    // relógio velho: sem o touch o soft de 3min já teria vencido
    a.activityClock.lastActivityAt = Date.now() - 10 * 60_000;
    a.bridgePost = async () => ({ allow: true });
    a.ocServeFetch = async () => ({});
    await ocHandlePermissionAsked(runner, { id: "p1", sessionID: "sess-perm", permission: "bash", metadata: {} });
    assert.ok(Date.now() - a.activityClock.lastActivityAt < 1_000, "permission.asked deve tocar o relógio");
    assert.equal(hangPhase(Date.now() - a.activityClock.lastActivityAt, hangThresholds("opencode")), "ok");
  } finally {
    runner.stop();
  }
});

test("T-784: tool running incrementa toolsInFlight; completed/error decrementa; soft não acende com tool em voo", () => {
  const { runner, a } = makeRunner();
  try {
    a.messageSession.busy = true;
    a.setState("thinking");
    a.messageSession.sessionId = "sess-tool";
    const stream = (part: any) => ocHandleStreamPart(runner, { part });

    // tool entra em execução
    stream({ id: "t1", type: "tool", sessionID: "sess-tool", state: { status: "running" } });
    assert.equal(a.toolsInFlight, 1, "running incrementa toolsInFlight");
    assert.ok(a.toolsInFlightSince > 0);

    // 2ª tool em paralelo
    stream({ id: "t2", type: "tool", sessionID: "sess-tool", state: { status: "running" } });
    assert.equal(a.toolsInFlight, 2);

    // tool longa: relógio vencido há 10min — com tool em voo o tick NÃO
    // pode marcar stalled (volta pra dentro da janela do toolsHardMs)
    a.activityClock.lastActivityAt = Date.now() - 10 * 60_000;
    tick(runner);
    assert.equal(a.currentState, "thinking", "com tool em voo o soft não acende");
    assert.equal(a.messageSession.busy, true, "tool viva: turno não é recolhido");

    // tools terminam: decrementa até zero (e limpa o since). O touch dos
    // próprios parts completa o relógio (é atividade semântica legítima).
    stream({ id: "t1", type: "tool", sessionID: "sess-tool", state: { status: "completed", time: { end: 1 } } });
    assert.equal(a.toolsInFlight, 1);
    stream({ id: "t2", type: "tool", sessionID: "sess-tool", state: { status: "error", time: { end: 1 } } });
    assert.equal(a.toolsInFlight, 0);
    assert.equal(a.toolsInFlightSince, null);

    // sem tool em voo, o silêncio volta a contar (4min: > soft 3min, < hard 10min)
    a.activityClock.lastActivityAt = Date.now() - 4 * 60_000;
    tick(runner);
    assert.equal(a.currentState, "stalled", "sem tool em voo, ociosidade real vira soft");
  } finally {
    runner.stop();
  }
});

test("T-784: part de outra sessão e pending não mexem no relógio de tools", () => {
  const { runner, a } = makeRunner();
  try {
    a.messageSession.sessionId = "sess-minha";
    ocHandleStreamPart(runner, { part: { id: "x", type: "tool", sessionID: "outra-sessao", state: { status: "running" } } });
    assert.equal(a.toolsInFlight, 0, "part de outra sessão não conta");
    ocHandleStreamPart(runner, { part: { id: "y", type: "tool", sessionID: "sess-minha", state: { status: "pending" } } });
    assert.equal(a.toolsInFlight, 0, "pending ainda não é running");
  } finally {
    runner.stop();
  }
});

test("T-788 F1: REEMISSÃO do mesmo part id não incrementa — 3 running + 1 completed = 0", () => {
  const { runner, a } = makeRunner();
  try {
    a.messageSession.busy = true;
    a.setState("thinking");
    a.messageSession.sessionId = "sess-reemit";
    const stream = (part: any) => ocHandleStreamPart(runner, { part });
    const running = () => ({ id: "p-unico", type: "tool", sessionID: "sess-reemit", state: { status: "running" } });

    // O serve reemite o MESMO part a cada chunk (ctx.metadata)
    stream(running());
    stream(running());
    stream(running());
    assert.equal(a.toolsInFlight, 1, "3 reemissões do mesmo part = UMA tool em voo");

    stream({ id: "p-unico", type: "tool", sessionID: "sess-reemit", state: { status: "completed", time: { end: 1 } } });
    assert.equal(a.toolsInFlight, 0, "completed único fecha o contador — não gruda >0");
    assert.equal(a.toolsInFlightSince, null);
    assert.equal((a.ocToolRunningPartIds as Set<string>).size, 0);

    // reemissão após completed não ressuscita o contador (e nem conta)
    stream(running());
    assert.equal(a.toolsInFlight, 1);
    stream({ id: "p-unico", type: "tool", sessionID: "sess-reemit", state: { status: "error", time: { end: 1 } } });
    assert.equal(a.toolsInFlight, 0);
  } finally {
    runner.stop();
  }
});

test("T-788 F1: zera no início do turno e no hard recover", async () => {
  const { runner, a } = makeRunner();
  try {
    a.messageSession.busy = true;
    a.setState("thinking");
    a.messageSession.sessionId = "sess-reset";
    ocHandleStreamPart(runner, { part: { id: "z1", type: "tool", sessionID: "sess-reset", state: { status: "running" } } });
    assert.equal(a.toolsInFlight, 1);
    // início do turno (espelha runOpenCodeMessageAttached)
    a.ocToolRunningPartIds.clear();
    a.ocPendingPermissionIds.clear();
    a.toolsInFlight = 0;
    a.toolsInFlightSince = null;
    assert.equal((a.ocToolRunningPartIds as Set<string>).size, 0);

    // recover: contador residual zerado junto
    ocHandleStreamPart(runner, { part: { id: "z2", type: "tool", sessionID: "sess-reset", state: { status: "running" } } });
    a.toolsInFlight = 2; // gruda (estado ruim que motivou o F1)
    a.messageSession.epoch = 3;
    (runner as unknown as { recoverHungTurn: (r: string, i: number) => void }).recoverHungTurn("teste", 999_000);
    assert.equal(a.toolsInFlight, 0, "recover zera toolsInFlight");
    assert.equal((a.ocToolRunningPartIds as Set<string>).size, 0, "recover zera o set de partIds");
    assert.equal((a.ocPendingPermissionIds as Set<string>).size, 0, "recover zera permissions pendentes");
  } finally {
    runner.stop();
  }
});

test("T-788 F2: permission.asked pendente renova o relógio no tick — espera de 5min não vira stalled", async () => {
  const { runner, a } = makeRunner();
  try {
    a.messageSession.busy = true;
    a.setState("thinking");
    a.messageSession.sessionId = "sess-perm2";
    let resolveBridge: (r: any) => void = () => {};
    a.bridgePost = () => new Promise((r) => { resolveBridge = r; }); // aprovação pendente
    a.ocServeFetch = async () => ({});
    const handled = ocHandlePermissionAsked(runner, { id: "perm-1", sessionID: "sess-perm2", permission: "bash", metadata: {} });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((a.ocPendingPermissionIds as Set<string>).has("perm-1"), true, "ask registrado como pendente");

    // espera da aprovação: 4min depois (> soft 3min, < bridge 5min) o tick
    // renova o relógio em vez de marcar stalled
    a.activityClock.lastActivityAt = Date.now() - 4 * 60_000;
    tick(runner);
    assert.equal(a.currentState, "thinking", "ask pendente: sem stalled");
    assert.ok(Date.now() - a.activityClock.lastActivityAt < 1_000, "tick renovou o relógio");

    // resposta chega: pendência sai (finally) e a ociosidade volta a valer
    resolveBridge({ allow: true });
    await handled;
    assert.equal((a.ocPendingPermissionIds as Set<string>).size, 0, "pendência removida ao responder");
  } finally {
    runner.stop();
  }
});

test("T-788 F2: erro na política/serve também remove a pendência (finally)", async () => {
  const { runner, a } = makeRunner();
  try {
    a.messageSession.sessionId = "sess-perm3";
    a.bridgePost = async () => { throw new Error("política offline"); };
    a.ocServeFetch = async () => { throw new Error("serve fora"); };
    await ocHandlePermissionAsked(runner, { id: "perm-2", sessionID: "sess-perm3", permission: "bash" });
    assert.equal((a.ocPendingPermissionIds as Set<string>).has("perm-2"), false, "falha não gruda pendência");
  } finally {
    runner.stop();
  }
});

test("T-790 G1: início do turno REAL zera toolsInFlight residual (running sem terminal)", async () => {
  const { runner, a } = makeRunner();
  try {
    a.stopped = false;
    a.info.model = undefined;
    a.messageSession.busy = true;
    a.messageSession.epoch = 11;
    a.messageSession.sessionId = "sess-g1";
    a.messageSession.needsPrime = false;
    a.messageSession.consumeFirstTurnIfNeeded = () => ({ firstTurn: false, pendingSummary: undefined });
    a.messageSession.owns = () => true;
    a.openCodeTransport = { ready: () => true, abortSession: async () => {}, stop: () => {} };
    a.fetchOcCatalogLimit = () => {};
    a.traceCli = () => {};
    a.attachNonImageFiles = (content: string) => ({ content, cleanup: () => {} });
    a.scheduleAttachmentCleanup = () => {};
    a.turnLatency.enqueue = () => {};
    a.turnLatency.activate = () => {};
    a.ensureRunnerAvailable = () => true;
    a.runOpenCodeMessage = async () => {};
    a.ocHandlePermissionAsked = () => {};
    // Residual do turno anterior: running que NUNCA recebeu terminal — o
    // error tardio caiu no return de "não está no set" e o contador grudou.
    a.ocToolRunningPartIds = new Set(["fantasma"]);
    a.toolsInFlight = 1;
    a.toolsInFlightSince = Date.now() - 25 * 60_000;
    // O turno REAL (POST rejeita logo) — o reset do início é o que estamos
    // provando; nada é setado à mão depois.
    a.ocServeFetch = async () => { throw new Error("timeout 600000ms"); };
    await runOpenCodeMessageAttached(runner, "msg", undefined, 2); // retry esgotado: sem re-agendar
    a.stopped = true;
    assert.equal(a.toolsInFlight, 0, "início do turno zera o contador residual");
    assert.equal(a.toolsInFlightSince, null, "início do turno zera o since");
    assert.equal((a.ocToolRunningPartIds as Set<string>).size, 0, "início do turno zera o set de partIds");
  } finally {
    runner.stop();
  }
});
