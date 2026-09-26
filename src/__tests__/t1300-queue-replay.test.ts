import assert from "node:assert/strict";
import test from "node:test";

import { AgentHost } from "../agent-host.js";
import { isNonOwnerTurn, markNonOwnerMessage, type InboundTurnPrincipal } from "../runners/turn-security.js";

function fakeHost() {
  const delivered: Array<{ content: string; principal?: InboundTurnPrincipal }> = [];
  const runner = {
    canAcceptNonOwnerTurn: () => true,
    pushUserMessage: (content: string, _images: unknown, _latency: unknown, _deliveryId: string, principal: InboundTurnPrincipal) => { delivered.push({ content, principal }); },
  };
  const host = Object.create(AgentHost.prototype) as any;
  host.entries = new Map([["agent-a", { runner, projectId: undefined }]]);
  host.log = () => {};
  return { host, delivered };
}

test("T-1300: legacy queue replay without sender becomes a non-owner turn", () => {
  const { host, delivered } = fakeHost();
  const accepted = host.queueDeliver("agent-a", [{ id: "legacy-item", content: "inspect files" }]);
  assert.deepEqual(accepted, ["legacy-item"]);
  assert.equal(delivered.length, 1);
  assert.equal(isNonOwnerTurn(delivered[0]!.principal), true);
  assert.match(markNonOwnerMessage(delivered[0]!.content, delivered[0]!.principal), /UNTRUSTED INPUT/);
});

test("T-1300: queue replay with isAgentOwner true keeps the owner's normal turn", () => {
  const { host, delivered } = fakeHost();
  const accepted = host.queueDeliver("agent-a", [{
    id: "owner-item", content: "inspect files", from: { type: "user", id: "owner", name: "Owner" }, isAgentOwner: true,
  }]);
  assert.deepEqual(accepted, ["owner-item"]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.principal?.isAgentOwner, true);
  assert.equal(isNonOwnerTurn(delivered[0]!.principal), false);
  assert.equal(markNonOwnerMessage(delivered[0]!.content, delivered[0]!.principal), "inspect files");
});
