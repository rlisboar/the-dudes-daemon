/**
 * T-710: depois do self-update o AgentHost nasce vazio. O agent:send que
 * chega antes do re-spawn (replay do server no hello) não pode sumir: fica
 * no buffer do host e é entregue quando o runner volta.
 */
import "./scratch-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentHost } from "../agent-host.js";

type HostInternals = {
  entries: Map<string, { runner: { pushUserMessage: (c: string) => void } | null }>;
  inboundBuffer: { size: (agentId?: string) => number };
};

test("T-710: host novo bufferiza send_message para agent ausente e entrega quando o runner volta", async () => {
  const host = new AgentHost(() => {}, null, null, {} as never, false, false, false, () => {}, () => {});
  const internals = host as unknown as HostInternals;

  host.send_message("ag-qa", "cobrança 1", undefined, "d1");
  host.send_message("ag-qa", "cobrança 2", undefined, "d2");
  assert.equal(internals.inboundBuffer.size("ag-qa"), 2, "nada é dropado no gap pós-reexec");

  const delivered: string[] = [];
  internals.entries.set("ag-qa", { runner: { pushUserMessage: (c) => delivered.push(c) } });
  assert.equal(host.flushInboundBuffer("ag-qa"), 2);
  assert.deepEqual(delivered, ["cobrança 1", "cobrança 2"], "ordem preservada");
  assert.equal(internals.inboundBuffer.size("ag-qa"), 0);

  internals.entries.clear();
  await host.shutdown();
});

test("T-710: spawn drena o buffer do agent ao final", () => {
  const src = readFileSync(new URL("../agent-host.ts", import.meta.url), "utf8");
  const spawn = src.indexOf("async spawn(msg: AgentSpawn)");
  const flush = src.indexOf("this.flushInboundBuffer(msg.agent.id)", spawn);
  assert.ok(spawn > 0 && flush > spawn, "spawn chama flushInboundBuffer");
});
