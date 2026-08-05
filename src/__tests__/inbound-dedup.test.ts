/**
 * T-037: dedup deliveryId + buffer local sem runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentInboundBuffer, createDeliveryDeduper } from "../inbound-dedup.js";

test("deliveryId: primeiro accept true, segundo false (não duplica TASK_ASSIGN)", () => {
  const d = createDeliveryDeduper(10);
  assert.equal(d.accept("del-1"), true);
  assert.equal(d.accept("del-1"), false);
  assert.equal(d.accept("del-2"), true);
  // legado sem id sempre processa
  assert.equal(d.accept(undefined), true);
  assert.equal(d.accept(""), true);
});

test("buffer: agent:send sem runner enfileira; drain entrega na ordem", () => {
  const buf = createAgentInboundBuffer({ maxPerAgent: 5 });
  buf.push("ag-1", { content: "first", deliveryId: "d1", enqueuedAt: Date.now() });
  buf.push("ag-1", { content: "second", deliveryId: "d2", enqueuedAt: Date.now() });
  // duplicata do mesmo deliveryId ignorada
  buf.push("ag-1", { content: "first-again", deliveryId: "d1", enqueuedAt: Date.now() });
  assert.equal(buf.size("ag-1"), 2);
  const drained = buf.drain("ag-1");
  assert.equal(drained.length, 2);
  assert.equal(drained[0]!.content, "first");
  assert.equal(drained[1]!.content, "second");
  assert.equal(buf.size("ag-1"), 0);
});

test("buffer cap: descarta os mais antigos", () => {
  const buf = createAgentInboundBuffer({ maxPerAgent: 2 });
  buf.push("a", { content: "1", enqueuedAt: Date.now() });
  buf.push("a", { content: "2", enqueuedAt: Date.now() });
  buf.push("a", { content: "3", enqueuedAt: Date.now() });
  const d = buf.drain("a");
  assert.deepEqual(d.map((m) => m.content), ["2", "3"]);
});
