/**
 * T-827: com o runner dsh a aba RUNS mostrava toda tool com input `{}`. O
 * driver chamava `onToolUse(título, {})` e ignorava o `rawInput` que o dsh
 * manda no `tool_call` do ACP (medido no dsh 0.1.5: bash {command,
 * description}, read {file_path, limit}). A fixture do servidor ACP falso
 * agora manda o rawInput como o dsh real.
 */
import "./scratch-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "../agent-runner.js";
import { DshClient, dshToolInput } from "../runners/turns/dsh.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-server.mjs", import.meta.url));

const until = async (fn: () => boolean, ms: number, label: string) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("T-827: rawInput do ACP só vale como objeto", () => {
  assert.deepEqual(dshToolInput({ command: "ls" }), { command: "ls" });
  assert.equal(dshToolInput(undefined), undefined);
  assert.equal(dshToolInput(null), undefined);
  assert.equal(dshToolInput("ls"), undefined);
  assert.equal(dshToolInput(["ls"]), undefined);
});

test("T-827: cliente ACP entrega o rawInput do tool_call no evento de tool", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t827acp-"));
  const tools: Array<{ phase: string; input?: Record<string, unknown> }> = [];
  const client = new DshClient({
    onText: () => {}, onThought: () => {}, onUsage: () => {}, onConfig: () => {}, onStderr: () => {}, onExit: () => {},
    onTool: (e) => tools.push(e),
  });
  client.start(process.execPath, [FIXTURE], { cwd: dir, env: { ...process.env, FAKE_ACP_LOG: path.join(dir, "log.jsonl") } });
  try {
    await client.initialize();
    await client.newSession(dir, []);
    await client.prompt("responda OK");
    const call = tools.find((t) => t.phase === "call");
    assert.deepEqual(call?.input, { status: "open", limit: 5 });
    assert.equal(tools.find((t) => t.phase === "update")?.input, undefined, "update sem rawInput não inventa input");
  } finally {
    client.kill();
  }
});

test("T-827: runner dsh manda os argumentos da tool no onToolUse (antes ia {})", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t827drv-"));
  const prev = process.env.FAKE_ACP_LOG;
  const prevPass = process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH;
  process.env.FAKE_ACP_LOG = path.join(dir, "acp.jsonl");
  process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = "FAKE_ACP_LOG";
  const usos: Array<{ nome: string; input: unknown }> = [];
  const texts: string[] = [];
  const info = {
    id: "agent_t827drv", ownerUserId: "u", name: "probe", role: "backend",
    systemPrompt: "sys", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: ["-e", ""], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "dsh", autoApprove: true, workspaceRoot: dir,
    cliCommands: { dsh: { command: FIXTURE, available: true, source: "override" } },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: (t: string) => { texts.push(t); return true; },
    onThinkingText: () => {}, onToolUse: (nome: string, input: unknown) => { usos.push({ nome, input }); },
    onError: () => {}, onHung: () => {}, onExit: () => {}, onSessionId: () => {}, onContextUsage: () => {},
  } as never);
  try {
    await runner.start();
    runner.pushUserMessage("responda OK");
    await until(() => texts.length > 0, 10_000, "texto do turno");
    assert.deepEqual(usos, [{ nome: "list_tasks", input: { status: "open", limit: 5 } }]);
  } finally {
    runner.stop();
    if (prev === undefined) delete process.env.FAKE_ACP_LOG; else process.env.FAKE_ACP_LOG = prev;
    if (prevPass === undefined) delete process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH; else process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = prevPass;
  }
});
