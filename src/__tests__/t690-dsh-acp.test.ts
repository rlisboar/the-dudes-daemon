/**
 * T-690: cliente ACP v1 stdio (turns/dsh.ts) contra um fake do servidor
 * (fixtures/fake-acp-server.mjs) — handshake, turno com updates mapeados,
 * permissão auto-respondida, resume sem replay, cancel e kill.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DshClient, dshEffortValue, toAcpMcpServers } from "../runners/turns/dsh.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-server.mjs", import.meta.url));

type Ev = [string, unknown];

function makeClient(): { client: DshClient; dir: string; logPath: string; events: Ev[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "t690acp-"));
  const logPath = path.join(dir, "log.jsonl");
  const events: Ev[] = [];
  const client = new DshClient({
    onText: (t) => events.push(["text", t]),
    onThought: (t) => events.push(["thought", t]),
    onTool: (e) => events.push(["tool", e]),
    onUsage: (u, s) => events.push(["usage", { u, s }]),
    onConfig: (o) => events.push(["config", o]),
    onStderr: (l) => events.push(["stderr", l]),
    onExit: (c) => events.push(["exit", c]),
  });
  client.start(process.execPath, [FIXTURE], { cwd: dir, env: { ...process.env, FAKE_ACP_LOG: logPath } });
  return { client, dir, logPath, events };
}

const readLog = (p: string): Array<Record<string, unknown>> =>
  readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("T-690 ACP: handshake + turno mapeia updates, auto-responde permissão e devolve stopReason", async () => {
  const { client, dir, logPath, events } = makeClient();
  try {
    const init = await client.initialize();
    assert.equal(init.protocolVersion, 1);
    const sess = await client.newSession(dir, []);
    assert.equal(sess.sessionId, "57eb3eca-0a64-411f-890d-8478bef47e71");
    assert.ok(sess.configOptions.some((o) => o.id === "model"), "configOptions do session/new expostas");

    await client.setConfigOption("model", '["dsflash","deepseek-flash-41"]');
    await client.setConfigOption("reasoning_effort", "high");

    const stop = await client.prompt("responda OK");
    assert.equal(stop, "end_turn");

    const kinds = events.map(([k]) => k);
    assert.ok(kinds.includes("thought"), `thinking mapeado: ${kinds.join(",")}`);
    assert.ok(kinds.includes("tool"), "tool mapeado");
    assert.ok(kinds.includes("text"), "texto mapeado");
    assert.ok(kinds.includes("usage"), "usage mapeado");
    assert.equal(events.find(([k]) => k === "text")?.[1], "OK");
    assert.equal((events.find(([k]) => k === "tool")?.[1] as { phase: string }).phase, "call");

    const log = readLog(logPath);
    const sent = log.filter((e) => e.dir === "recv");
    const newReq = sent.find((m) => m.method === "session/new") as { params?: { cwd?: string; mcpServers?: unknown[] } };
    assert.equal(newReq?.params?.cwd, dir, "cwd absoluto do workspace no session/new");
    const modelReq = sent.find((m) => m.method === "session/set_config_option" && (m.params as { configId?: string })?.configId === "model");
    assert.equal((modelReq?.params as { value?: string })?.value, '["dsflash","deepseek-flash-41"]');
    // Permissão: o cliente respondeu allow_once (sem isso o fake não settle).
    const permResp = log.find((e) => e.dir === "recv" && (e as { result?: { outcome?: { optionId?: string } } }).result?.outcome?.optionId === "allow_once");
    assert.ok(permResp, `permissão auto-respondida com allow_once: ${JSON.stringify(log).slice(0, 300)}`);
  } finally {
    client.kill();
  }
});

test("T-690 ACP: resume reusa o sessionId sem replay de updates", async () => {
  const { client, dir, events } = makeClient();
  try {
    await client.initialize();
    const sess = await client.resumeSession("57eb3eca-0a64-411f-890d-8478bef47e71", dir, []);
    assert.equal(sess.sessionId, "57eb3eca-0a64-411f-890d-8478bef47e71");
    assert.equal(events.filter(([k]) => k === "text").length, 0, "resume não replaya");
  } finally {
    client.kill();
  }
});

test("T-690 ACP: cancel do prompt em voo settle com stopReason cancelled", async () => {
  const { client, dir } = makeClient();
  try {
    await client.initialize();
    await client.newSession(dir, []);
    const p = client.prompt("responda OK");
    await wait(120); // prompt entregue; fake aguarda a janela de settle
    client.cancel();
    const stop = await p;
    assert.equal(stop, "cancelled");
  } finally {
    client.kill();
  }
});

test("T-690 ACP: kill encerra e request posterior rejeita", async () => {
  const { client, dir, events } = makeClient();
  await client.initialize();
  await client.newSession(dir, []);
  client.kill();
  await wait(400);
  assert.ok(events.some(([k]) => k === "exit"), "onExit disparou");
  await assert.rejects(() => client.prompt("x"));
});

test("T-690 ACP: toAcpMcpServers — command node vira execPath, env Record vira [{name,value}]", () => {
  const wire = toAcpMcpServers([{
    name: "the-dudes",
    command: "node",
    args: ["/tmp/mcp-bridge.cjs"],
    env: { THE_DUDES_AGENT_ID: "agent_x", FOO: "bar" },
  }]);
  assert.equal(wire.length, 1);
  const s = wire[0] as { command: string; args: string[]; env: Array<{ name: string; value: string }> };
  assert.equal(s.command, process.execPath, "node relativo → process.execPath (ACP exige absoluto)");
  assert.ok(s.command.startsWith("/"), "command absoluto");
  assert.deepEqual(s.args, ["/tmp/mcp-bridge.cjs"]);
  assert.deepEqual(s.env, [
    { name: "THE_DUDES_AGENT_ID", value: "agent_x" },
    { name: "FOO", value: "bar" },
  ]);
});

test("T-690 ACP: toAcpMcpServers — HTTP leva type+headers array (campo required)", () => {
  const wire = toAcpMcpServers([{
    name: "extra",
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer x" },
  }]);
  assert.deepEqual(wire, [{
    type: "http",
    name: "extra",
    url: "https://example.test/mcp",
    headers: [{ name: "Authorization", value: "Bearer x" }],
  }]);
});

test("T-690 ACP: session/new no fio leva mcpServers no shape ACP (não Record)", async () => {
  const { client, dir, logPath } = makeClient();
  try {
    await client.initialize();
    await client.newSession(dir, [{
      name: "the-dudes",
      command: "node",
      args: ["/tmp/bridge.cjs"],
      env: { THE_DUDES_AGENT_ID: "a1" },
    }]);
    const log = readLog(logPath).filter((e) => e.dir === "recv");
    const newReq = log.find((m) => m.method === "session/new") as {
      params?: { mcpServers?: Array<{ command?: string; env?: unknown; args?: string[] }> };
    };
    const mcp = newReq?.params?.mcpServers?.[0];
    assert.ok(mcp, "mcpServers presente no session/new");
    assert.equal(mcp.command, process.execPath);
    assert.ok(Array.isArray(mcp.env), "env é array [{name,value}], não Record");
    assert.deepEqual(mcp.env, [{ name: "THE_DUDES_AGENT_ID", value: "a1" }]);
    assert.deepEqual(mcp.args, ["/tmp/bridge.cjs"]);
  } finally {
    client.kill();
  }
});

test("T-690 ACP: mapeamento de effort none→off (unidade)", () => {
  assert.equal(dshEffortValue("none"), "off");
  assert.equal(dshEffortValue("minimal"), "off");
  assert.equal(dshEffortValue("low"), "low");
  assert.equal(dshEffortValue("high"), "high");
  assert.equal(dshEffortValue("xhigh"), "max");
  assert.equal(dshEffortValue("max"), "max");
  assert.equal(dshEffortValue(undefined), undefined);
  assert.equal(dshEffortValue("medium"), undefined, "ACP não tem medium");
});