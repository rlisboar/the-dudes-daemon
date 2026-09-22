/**
 * T-796: o "teto de 30min do POST" era FALSO — o par falha/retry do opencode
 * acontecia em 7–12s (SERVER 14:38:47/14:38:55, THREEJS 14:46:10/14:46:18).
 *
 * Causa 1: o agente HTTP global do Node arma 5s de timeout no socket; o POST
 * síncrono do opencode fica mudo o turno inteiro (quem streama é o /event) e
 * o handler de `timeout` matava um turno saudável aos 5s com a mensagem
 * ERRADA ("timeout 1800000ms"), abortando a sessão no serve — o retry então
 * voltava MessageAborted.
 * Causa 2: no MessageAborted o sessionId era invalidado ANTES dos owns() do
 * turno; owns() compara sessionId, devolvia false e o early-return deixava
 * busy=true + estado não-idle para sempre. O watchdog contava agente OCIOSO
 * como turno vivo: soft 180s, HARD recover 600s, nudge sintético e
 * auto-continue esgotado (QA-A/DEVOPS/DAEMON/QA-B/WEB em 14:43 e 14:54).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";

import { AgentRunner, OPENCODE_POST_CAP_MS, OPENCODE_TURN_TIMEOUT_MS } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";
import { requestJson } from "../runners/opencode-transport.js";
import { runOpenCodeMessageAttached } from "../runners/turns/opencode.js";

function slowServer(delayMs: number) {
  const server = http.createServer((_req, res) => {
    setTimeout(() => { res.setHeader("content-type", "application/json"); res.end("{}"); }, delayMs);
  });
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

test("T-796: POST novo com relógio velho sobrevive ao timeout de 5s do socket", async () => {
  // 6s > os 5s de keep-alive que o agente global do Node arma no socket.
  const s = await slowServer(6_000);
  try {
    const velho = Date.now() - 40 * 60_000; // agente ocioso há 40min
    const out = await requestJson(s.base, "/x", "POST", {}, OPENCODE_TURN_TIMEOUT_MS, {
      idleTimeoutMs: OPENCODE_TURN_TIMEOUT_MS,
      totalTimeoutMs: OPENCODE_POST_CAP_MS,
      activity: () => velho,
    });
    assert.deepEqual(out, {}, "o POST tem de completar (nem socket nem relógio velho)");
  } finally { await s.close(); }
});

function makeRunner(logs: string[]) {
  const info = {
    id: `agent_t796_${process.pid}`, ownerUserId: "u", name: "t796", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "opencode", autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: resolveCliCommands(), verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (_lvl: string, msg: string) => { logs.push(msg); }, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: (m: string) => { logs.push(m); }, onHung: () => {},
    onExit: () => {},
  } as never);
  (runner as unknown as { drainOcQueue: () => void }).drainOcQueue = () => {};
  return runner;
}

/** Prepara o runner para um turno REAL (POST via ocServeFetch stub). */
function prepTurn(runner: AgentRunner, sessionId: string) {
  const a = runner as unknown as Record<string, any>;
  a.stopped = false;
  a.info.model = undefined;
  a.messageSession.busy = true;
  a.messageSession.sessionId = sessionId;
  a.messageSession.needsPrime = false;
  a.messageSession.consumeFirstTurnIfNeeded = () => ({ firstTurn: false, pendingSummary: undefined });
  a.setState("thinking");
  a.openCodeTransport = { ready: () => true, abortSession: async () => {}, stop: () => {} };
  a.fetchOcCatalogLimit = () => {};
  a.traceCli = () => {};
  a.attachNonImageFiles = (content: string) => ({ content, cleanup: () => {} });
  a.scheduleAttachmentCleanup = () => {};
  a.turnLatency.enqueue = () => {};
  a.turnLatency.activate = () => {};
  a.ensureRunnerAvailable = () => true;
  a.runOpenCodeMessage = async () => {};
  return a;
}

test("T-796: MessageAborted (info.error) não deixa busy/estado presos", async () => {
  const logs: string[] = [];
  const runner = makeRunner(logs);
  try {
    const a = prepTurn(runner, "ses_abortada");
    a.ocServeFetch = async () => ({
      info: { error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
      parts: [],
    });
    // retry esgotado (2 > OC_EMPTY_RETRIES): não re-agenda nada.
    await runOpenCodeMessageAttached(runner, "msg", undefined, 2);
    const onde = `estado=${a.currentState} epoch=${a.messageSession.epoch} stopped=${a.stopped} logs=${logs.join(" | ")}`;
    assert.equal(a.messageSession.busy, false, `turno que se invalida continua dono do busy (${onde})`);
    assert.equal(a.currentState, "idle", "turno terminou — estado não pode ficar preso");
    assert.equal(a.messageSession.sessionId, undefined, "sessão abortada é invalidada para o próximo turno");
    assert.ok(logs.some((l) => /MessageAborted/.test(l)), "erro do provider segue reportado");
  } finally {
    (runner as unknown as { stopped: boolean }).stopped = true;
    runner.stop();
  }
});

test("T-796: agente per-message sem turno (busy=false) não vira HARD recover", () => {
  const logs: string[] = [];
  const runner = makeRunner(logs);
  try {
    const a = runner as unknown as Record<string, any>;
    // Estado deixado por um soft anterior, SEM turno em voo.
    a.messageSession.busy = false;
    a.setState("stalled");
    a.activityClock.lastActivityAt = Date.now() - 11 * 60_000; // > hard (600s)
    (runner as unknown as { tickHangWatch: () => void }).tickHangWatch();
    assert.equal(a.currentState, "idle", "idle esperando mensagem volta a idle (não fica stalled)");
    assert.equal(logs.some((l) => /HARD recover/.test(l)), false, "idle sem turno não dispara hard recover");
  } finally {
    (runner as unknown as { stopped: boolean }).stopped = true;
    runner.stop();
  }
});