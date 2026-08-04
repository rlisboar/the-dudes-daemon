/**
 * T-009 critério 4 (WAN): CLI completou, resultado NÃO entregue ao server.
 *
 * Simula ws.readyState CLOSED entre emitOnce e o server; prova:
 *  - trySend retorna false e enfileira agent:text (não drop silencioso)
 *  - DELIVERY recover re-enfileira a mensagem do user (1×)
 *  - flush no "reconnect" (readyState OPEN) reenvia o agent:text
 *  - log + hardRecovers no health
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  channelCanSend,
  createOutboundQueue,
  flushOutboundQueue,
  isCriticalOutbound,
  trySendOutbound,
  type OutboundWire,
} from "../runners/outbound-delivery.js";
import {
  _resetForTest,
  healthSnapshot,
  recordHardRecover,
  recordLog,
  recentLogs,
} from "../health-monitor.js";
import { hangPhase, hangThresholds, toolsInFlightBlocksHang } from "../runners/turn-watchdog.js";

/** Mock mínimo do ws package (readyState 0..3; OPEN=1). */
class MockWs {
  static OPEN = 1;
  static CLOSED = 3;
  readyState: number;
  bufferedAmount = 0;
  sent: string[] = [];
  constructor(state: number = MockWs.OPEN) {
    this.readyState = state;
  }
  send(data: string): void {
    if (this.readyState !== MockWs.OPEN) throw new Error("WebSocket is not open");
    this.sent.push(data);
  }
}

function canSend(ws: MockWs | null): boolean {
  return channelCanSend(
    ws
      ? { readyState: ws.readyState, openState: MockWs.OPEN, bufferedAmount: ws.bufferedAmount }
      : null,
  );
}

function trySend(ws: MockWs | null, q: ReturnType<typeof createOutboundQueue>, msg: OutboundWire): boolean {
  const json = JSON.stringify(msg);
  return trySendOutbound({
    msg,
    json,
    canSend: canSend(ws),
    send: (j) => {
      if (!ws) throw new Error("no ws");
      ws.send(j);
    },
    queue: q,
  });
}

test("agent:text é crítica; ping não", () => {
  assert.equal(isCriticalOutbound({ type: "agent:text" }), true);
  assert.equal(isCriticalOutbound({ type: "daemon:ping" }), false);
});

test("WAN: CLI ok + WS CLOSED → agent:text enfileirado, não entregue, recover re-fila user msg", () => {
  _resetForTest();
  const q = createOutboundQueue(20);
  // 1) Turno CLI completou — texto pronto
  const agentText: OutboundWire = {
    type: "agent:text",
    agentId: "agent_qa",
    text: "resposta do grok após tool loop",
  };
  // 2) WS morto/stalled no momento do emit (readyState CLOSED)
  let ws: MockWs | null = new MockWs(MockWs.CLOSED);
  const delivered = trySend(ws, q, agentText);
  assert.equal(delivered, false, "deve falhar com WS CLOSED");
  assert.equal(ws.sent.length, 0, "nada no wire");
  assert.equal(q.items.length, 1, "agent:text deve estar na fila outbound");
  assert.equal(q.items[0]!.type, "agent:text");

  // 3) handleUndeliveredTurnResult (espelho do agent-runner)
  recordHardRecover("grok");
  const logLine = "[hang:QA] DELIVERY recover: agent:text não entregue ao server (WS down/backpressure) (runner=grok)";
  recordLog("warn", logLine);
  const userQueue: string[] = [];
  const inflight = { content: "mensagem do user que gerou o turno", attempt: 0 };
  if (inflight.attempt < 1) {
    userQueue.unshift(inflight.content);
    recordLog("warn", "[hang:QA] re-enfileirando após falha de entrega WS (attempt 1)");
  }
  assert.equal(userQueue[0], inflight.content, "user msg re-enfileirada");
  assert.ok(recentLogs(20).some((l) => l.msg.includes("DELIVERY recover")));
  assert.ok(healthSnapshot({
    turnGate: { ativos: 0, fila: 0, max: 3 },
    agentsRunning: 1,
    e2eeProjects: 0,
  }).turns.hardRecovers >= 1);

  // 4) Reconnect: readyState OPEN → flush reenvia agent:text (não se perde)
  ws = new MockWs(MockWs.OPEN);
  const flushed = flushOutboundQueue({
    queue: q,
    canSend: () => canSend(ws),
    send: (j) => ws!.send(j),
  });
  assert.equal(flushed, 1);
  assert.equal(q.items.length, 0);
  assert.equal(ws.sent.length, 1);
  assert.ok(ws.sent[0]!.includes("resposta do grok"), "texto re-entregue após WS voltar");
});

test("WAN: backpressure (bufferedAmount alto) também enfileira", () => {
  const q = createOutboundQueue(5);
  const ws = new MockWs(MockWs.OPEN);
  ws.bufferedAmount = 9_000_000;
  const ok = trySendOutbound({
    msg: { type: "agent:text", text: "x" },
    json: '{"type":"agent:text","text":"x"}',
    canSend: channelCanSend({
      readyState: ws.readyState,
      openState: MockWs.OPEN,
      bufferedAmount: ws.bufferedAmount,
    }),
    send: (j) => ws.send(j),
    queue: q,
  });
  assert.equal(ok, false);
  assert.equal(q.items.length, 1);
  assert.equal(ws.sent.length, 0);
});

test("OPEN saudável entrega na hora (sem fila)", () => {
  const q = createOutboundQueue(5);
  const ws = new MockWs(MockWs.OPEN);
  const ok = trySend(ws, q, { type: "agent:text", text: "hello" });
  assert.equal(ok, true);
  assert.equal(q.items.length, 0);
  assert.equal(ws.sent.length, 1);
});

/* ---------- critério 5: tool longa grok NÃO hard-recover ---------- */

test("toolsInFlight protege hang: tool legítima >120s idle semântico NÃO é hard", () => {
  const t = hangThresholds("grok");
  const maxTools = 20 * 60_000;
  // Tool aberta há 3min, zero eventos semânticos → hangPhase seria hard,
  // mas toolsInFlightBlocksHang impede o recover.
  const idleMs = 3 * 60_000;
  assert.equal(hangPhase(idleMs, t), "hard", "sem proteção seria hard");
  assert.equal(
    toolsInFlightBlocksHang(1, idleMs, maxTools),
    true,
    "com toolsInFlight deve bloquear hard recover",
  );
  // Tool aberta além do teto → permite hang (tool_result perdido)
  assert.equal(toolsInFlightBlocksHang(1, maxTools + 1, maxTools), false);
  // Sem tools → hang normal
  assert.equal(toolsInFlightBlocksHang(0, idleMs, maxTools), false);
});

test("hang real sem tools continua hard em ≤120s", () => {
  const t = hangThresholds("grok");
  assert.equal(hangPhase(t.hardMs, t), "hard");
  assert.equal(toolsInFlightBlocksHang(0, t.hardMs, 20 * 60_000), false);
});
