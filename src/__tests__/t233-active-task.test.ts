/**
 * T-233: activeTaskId por agente com sinal autoritativo do server.
 *
 * - activeTaskId é setado SOMENTE por setActiveTask (wire do main em
 *   agent:send com taskId explícito — nunca por parse de texto);
 * - saveExtractedMemory envia taskId quando há task ativa; sem task ativa,
 *   o payload vai SEM o campo (retrocompat);
 * - task done (clearActiveTask com o id) zera — sem staleness; done
 *   atrasado de task antiga não apaga reatribuição mais nova.
 *
 * A captura do memory_add é real: unix socket com HTTP server (mesmo
 * caminho do postBridgeJson do AgentRunner).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";

type Capture = { payloads: Array<{ route: string | undefined; body: any }>; close: () => Promise<void> };

function startCapture(socketPath: string): Promise<Capture> {
  const payloads: Array<{ route: string | undefined; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
    req.on("end", () => {
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      payloads.push({ route: req.url, body });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ memory: { id: `mem_${randomUUID().slice(0, 8)}` } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({
      payloads,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

function makeRunner(socketPath: string): AgentRunner {
  const info = {
    id: "agent_t233", ownerUserId: "user_t233", name: "probe", role: "backend",
    systemPrompt: "", color: "#a78bfa", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const opts = {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "claude", autoApprove: true, workspaceRoot: os.tmpdir(),
    bridgeSocketPath: socketPath, cliCommands: resolveCliCommands(),
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {}, onAssistantText: () => true,
    onToolUse: () => {}, onError: () => {}, onExit: () => {},
  } as never;
  return new AgentRunner(info, opts);
}

const SOCK = path.join(os.tmpdir(), `t233-${process.pid}-${randomUUID().slice(0, 6)}.sock`);
const capture = await startCapture(SOCK);
after(async () => { await capture.close(); });

/** Salva memória e devolve SOMENTE os memory_add gerados por esta chamada. */
async function saveAndCapture(runner: AgentRunner, items: unknown[]): Promise<any[]> {
  const base = capture.payloads.length;
  await (runner as unknown as { saveExtractedMemory: (items: unknown[]) => Promise<void> })
    .saveExtractedMemory(items);
  return capture.payloads
    .slice(base)
    .filter((p) => (p.route ?? "").endsWith("/memory_add"))
    .map((p) => p.body);
}

test("T-233: atribuição → compact → memória com taskId correto", async () => {
  const runner = makeRunner(SOCK);
  // agent:send com taskId (wire do main) → setActiveTask
  runner.setActiveTask("task_abc123");
  const bodies = await saveAndCapture(runner, [
    { title: "T-233 decisão", body: "body", type: "decision", supersedes: [] },
  ]);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.taskId, "task_abc123");
  assert.equal(bodies[0]!.scope, "agent");
});

test("T-233: task done → compact → memória SEM taskId (sem staleness)", async () => {
  const runner = makeRunner(SOCK);
  runner.setActiveTask("task_done1");
  runner.clearActiveTask("task_done1"); // task:updated done da ativa
  const bodies = await saveAndCapture(runner, [
    { title: "pos-done", body: "body", type: "fact", supersedes: [] },
  ]);
  assert.equal(bodies.length, 1);
  assert.ok(!("taskId" in bodies[0]!), "payload retrocompat: sem campo quando não há task ativa");
});

test("T-233: done atrasado de task antiga não apaga reatribuição mais nova", async () => {
  const runner = makeRunner(SOCK);
  runner.setActiveTask("task_nova");
  runner.clearActiveTask("task_antiga"); // done atrasado — não é a ativa
  const bodies1 = await saveAndCapture(runner, [
    { title: "reatribuida", body: "body", type: "fact", supersedes: [] },
  ]);
  assert.equal(bodies1[0]!.taskId, "task_nova");
  runner.clearActiveTask("task_nova"); // done da ativa → limpa
  const bodies2 = await saveAndCapture(runner, [
    { title: "pos-done-2", body: "body", type: "fact", supersedes: [] },
  ]);
  assert.ok(!("taskId" in bodies2[0]!));
});

test("T-233: taskId malformado é ignorado (nunca vira proveniência)", async () => {
  const runner = makeRunner(SOCK);
  runner.setActiveTask("id com espaço");
  const bodies = await saveAndCapture(runner, [
    { title: "inv", body: "body", type: "fact", supersedes: [] },
  ]);
  assert.ok(!("taskId" in bodies[0]!));
});

test("T-233: sem task ativa desde o boot → payload sem taskId", async () => {
  const runner = makeRunner(SOCK);
  const bodies = await saveAndCapture(runner, [
    { title: "sem-task", body: "body", type: "fact", supersedes: [] },
  ]);
  assert.ok(!("taskId" in bodies[0]!));
});
