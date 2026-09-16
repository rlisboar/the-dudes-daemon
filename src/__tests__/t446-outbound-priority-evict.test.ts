/**
 * T-446 (M23): overflow da fila outbound evicta thinking/tool_use (efémeros)
 * — agent:text/error/hung/exit (semânticos) só saem se não houver efémeros.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOutboundQueue,
  enqueueCritical,
  flushOutboundQueue,
  isHighPriorityOutbound,
} from "../runners/outbound-delivery.js";

const enq = (q: ReturnType<typeof createOutboundQueue>, type: string, id?: string) =>
  enqueueCritical(q, { type, id }, JSON.stringify({ type, id }));

test("T-446: text sobrevive a uma fila cheia de thinking", () => {
  const q = createOutboundQueue(5);
  for (let i = 0; i < 5; i++) enq(q, "agent:thinking", `t${i}`);
  enq(q, "agent:text", "texto");
  assert.equal(q.items.length, 5);
  assert.ok(q.items.some((i) => i.type === "agent:text"), "text não foi evictado");
  assert.equal(q.items.filter((i) => i.type === "agent:thinking").length, 4);
  assert.equal(q.items[0]!.json, JSON.stringify({ type: "agent:thinking", id: "t1" }), "saiu o efémero mais antigo");
});

test("T-446: exit/error/hung também protegidos", () => {
  const q = createOutboundQueue(3);
  enq(q, "agent:thinking", "t0");
  enq(q, "agent:tool_use", "u0");
  enq(q, "agent:exit", "e0");
  enq(q, "agent:error", "err0");
  enq(q, "agent:hung", "h0");
  assert.deepEqual(q.items.map((i) => i.type), ["agent:exit", "agent:error", "agent:hung"]);
});

test("T-446: sem efémeros, sai o semântico mais antigo (comportamento antigo)", () => {
  const q = createOutboundQueue(2);
  enq(q, "agent:text", "a");
  enq(q, "agent:exit", "b");
  enq(q, "agent:text", "c");
  assert.deepEqual(q.items.map((i) => i.json), [JSON.stringify({ type: "agent:exit", id: "b" }), JSON.stringify({ type: "agent:text", id: "c" })]);
});

test("T-446: flush entrega o que sobrou em FIFO", () => {
  const q = createOutboundQueue(3);
  enq(q, "agent:thinking", "t0");
  enq(q, "agent:text", "a");
  enq(q, "agent:thinking", "t1");
  enq(q, "agent:exit", "e");
  const sent: string[] = [];
  const n = flushOutboundQueue({ queue: q, canSend: () => true, send: (j) => sent.push(j) });
  assert.equal(n, 3);
  assert.deepEqual(sent, [JSON.stringify({ type: "agent:text", id: "a" }), JSON.stringify({ type: "agent:thinking", id: "t1" }), JSON.stringify({ type: "agent:exit", id: "e" })]);
  assert.equal(q.items.length, 0);
});

test("T-446: prioridade classificada corretamente", () => {
  for (const t of ["agent:text", "agent:error", "agent:hung", "agent:exit"]) assert.equal(isHighPriorityOutbound({ type: t }), true);
  for (const t of ["agent:thinking", "agent:tool_use", "agent:state"]) assert.equal(isHighPriorityOutbound({ type: t }), false);
});

test("T-542: overflow com lows de tipos diferentes evicta o MAIS ANTIGO (qualquer low)", () => {
  const q = createOutboundQueue(4);
  enq(q, "agent:thinking", "th0");
  enq(q, "agent:tool_use", "tu0");
  enq(q, "agent:text", "tx");
  enq(q, "agent:exit", "ex");
  // fila cheia; novo thinking entra e o low MAIS ANTIGO (th0) sai.
  enq(q, "agent:thinking", "th1");
  assert.deepEqual(q.items.map((i) => i.json), [
    JSON.stringify({ type: "agent:tool_use", id: "tu0" }),
    JSON.stringify({ type: "agent:text", id: "tx" }),
    JSON.stringify({ type: "agent:exit", id: "ex" }),
    JSON.stringify({ type: "agent:thinking", id: "th1" }),
  ]);
});

test("T-542: sem lows, o semântico mais antigo sai (ordem FIFO preservada)", () => {
  const q = createOutboundQueue(3);
  enq(q, "agent:text", "a");
  enq(q, "agent:error", "b");
  enq(q, "agent:hung", "c");
  enq(q, "agent:exit", "d");
  assert.deepEqual(q.items.map((i) => i.json), [
    JSON.stringify({ type: "agent:error", id: "b" }),
    JSON.stringify({ type: "agent:hung", id: "c" }),
    JSON.stringify({ type: "agent:exit", id: "d" }),
  ]);
});

test("T-542: semântico ANTES do flood — evicta o low mais antigo, nunca o text", () => {
  // Caso que separa evictOne (findIndex no low mais antigo) de um shift
  // ingénuo (que comeria o text mais antigo). MUT evictOne→shift MORRE aqui.
  const q = createOutboundQueue(3);
  enq(q, "agent:text", "T");
  enq(q, "agent:thinking", "h0");
  enq(q, "agent:thinking", "h1");
  enq(q, "agent:thinking", "h2");
  assert.deepEqual(q.items.map((i) => i.json), [
    JSON.stringify({ type: "agent:text", id: "T" }),
    JSON.stringify({ type: "agent:thinking", id: "h1" }),
    JSON.stringify({ type: "agent:thinking", id: "h2" }),
  ]);
});

test("T-542 (obs QA addendum): cap 3 [text, h0, h1] + h2 -> [text, h1, h2]; MUT shift falha", () => {
  const q = createOutboundQueue(3);
  enq(q, "agent:text", "T");
  enq(q, "agent:thinking", "h0");
  enq(q, "agent:thinking", "h1");
  enq(q, "agent:thinking", "h2");
  // Fix: evicta o low MAIS ANTIGO (h0). Shift cego: [h0,h1,h2] e o T morre.
  assert.deepEqual(
    q.items.map((i) => i.json),
    [
      JSON.stringify({ type: "agent:text", id: "T" }),
      JSON.stringify({ type: "agent:thinking", id: "h1" }),
      JSON.stringify({ type: "agent:thinking", id: "h2" }),
    ],
    "sem o fix (shift) o agent:text T é evictado; com o fix h0 sai",
  );
});

test("T-542 (obs QA v2): T no MEIO da fila — [h0, T, h1] + h2 -> [T, h1, h2] (mata findLastIndex)", () => {
  const q = createOutboundQueue(3);
  enq(q, "agent:thinking", "h0");
  enq(q, "agent:text", "T");
  enq(q, "agent:thinking", "h1");
  enq(q, "agent:thinking", "h2");
  // Fix: evicta o low MAIS ANTIGO (h0), preserva ordem dos sobreviventes.
  // MUTs: shift perde o T (h0 sai no lugar errado? shift remove h0 → [T,h1,h2] IGUAL);
  // findLastIndex remove h1 (errado); HIGH vazio remove o T por shift cego.
  assert.deepEqual(
    q.items.map((i) => i.json),
    [
      JSON.stringify({ type: "agent:text", id: "T" }),
      JSON.stringify({ type: "agent:thinking", id: "h1" }),
      JSON.stringify({ type: "agent:thinking", id: "h2" }),
    ],
  );
  // Saturação extra não pode comer o T nem a ordem dos lows recentes.
  enq(q, "agent:thinking", "h3");
  assert.deepEqual(q.items.map((i) => i.type), ["agent:text", "agent:thinking", "agent:thinking"]);
  assert.ok(q.items.some((i) => i.json.includes('"T"')), "text sobrevive a 2 overflows");
});
