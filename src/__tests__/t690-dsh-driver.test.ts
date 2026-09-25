/**
 * T-690: driver do runner dsh no AgentRunner REAL — spawn do fake ACP, handshake,
 * prompt e mapeamento de eventos até onAssistantText/sessão/uso; stop limpa.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "../agent-runner.js";
import type { AgentUsage } from "../types.js";
import { DSH_DEFAULT_MODEL } from "../runners/turns/dsh.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-server.mjs", import.meta.url));
const SESSION = "57eb3eca-0a64-411f-890d-8478bef47e71";

const until = async (fn: () => boolean, ms: number, label: string) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

function makeRunner(dir: string, over: { model?: string; effort?: string } = {}) {
  const texts: string[] = [];
  const sessions: string[] = [];
  const usages: Array<[number, number]> = [];
  const usageDeltas: AgentUsage[] = [];
  const logs: string[] = [];
  const tools: string[] = [];
  const info = {
    id: "agent_t690drv", ownerUserId: "u", name: "probe", role: "backend",
    systemPrompt: "sys", color: "#7aa2ff", state: "idle", running: true,
    model: over.model, effort: over.effort, collectThinking: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const opts = {
    bridgeCommand: "node", bridgeArgs: ["-e", ""], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "dsh", autoApprove: true, workspaceRoot: dir,
    cliCommands: { dsh: { command: FIXTURE, available: true, source: "override" } },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (_level: string, message: string) => { logs.push(message); }, cliLog: () => {}, onState: () => {},
    onAssistantText: (t: string) => { texts.push(t); return true; },
    onThinkingText: () => {}, onToolUse: (n: string) => { tools.push(n); },
    onError: () => {}, onHung: () => {}, onExit: () => {},
    onSessionId: (id: string) => { sessions.push(id); },
    onContextUsage: (u: number, l: number) => { usages.push([u, l]); },
    onUsageDelta: (delta: AgentUsage) => { usageDeltas.push(delta); },
  } as never;
  const runner = new AgentRunner(info, opts);
  return { runner, texts, sessions, usages, usageDeltas, logs, tools };
}

const readLog = (p: string) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

test("T-690 driver: start sobe o ACP, handshake registra sessão e o prompt entrega texto/uso", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t690drv-"));
  const logPath = path.join(dir, "acp.jsonl");
  const prev = process.env.FAKE_ACP_LOG;
  const prevPass = process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH;
  process.env.FAKE_ACP_LOG = logPath;
  process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = "FAKE_ACP_LOG";
  const { runner, texts, sessions, usages, usageDeltas, logs, tools } = makeRunner(dir);
  try {
    await runner.start();
    runner.pushUserMessage("responda OK");
    await until(() => texts.length > 0, 10_000, "texto do turno");
    await until(() => usageDeltas.length > 0, 10_000, "delta estimado do turno");
    assert.equal(texts.join(""), "OK");
    assert.equal(sessions[0], SESSION, "sessão do session/new registrada");
    assert.ok(usages.length > 0, "usage_update vira ocupação de contexto");
    assert.ok(tools.length > 0, "tool_call vira onToolUse");
    const log = readLog(logPath).filter((e) => e.dir === "recv");
    const newReq = log.find((m) => m.method === "session/new") as {
      params?: { cwd?: string; mcpServers?: Array<{ command?: string; env?: unknown; args?: string[] }> };
    };
    assert.equal(newReq?.params?.cwd, dir, "cwd=workspace no session/new");
    const mcp = newReq?.params?.mcpServers?.[0];
    assert.ok(mcp, "bridge the-dudes no session/new");
    assert.equal(mcp.command, process.execPath, "command do bridge é absoluto (node→execPath)");
    assert.ok(Array.isArray(mcp.env), "env ACP é array, não Record");
    const setModel = log.find((m) => m.method === "session/set_config_option" && (m.params as { configId?: string })?.configId === "model");
    assert.equal((setModel?.params as { value?: string })?.value, DSH_DEFAULT_MODEL, "sem model no agente → default dsflash");
    const prompt = log.find((m) => m.method === "session/prompt") as { params?: { prompt?: Array<{ text?: string }> } };
    const promptText = prompt?.params?.prompt?.[0]?.text ?? "";
    assert.deepEqual(usageDeltas, [{
      input: Math.ceil(promptText.length / 4),
      output: 1,
      cacheCreate: 0,
      cacheRead: 0,
    }], "a resposta ACP só dá stopReason; o runner estima tokens pelo comprimento do turno");
    assert.equal(logs.filter((line) => line.includes("uso estimado")).length, 1, "o delta é explicitamente marcado como estimado no log");
    assert.ok(promptText.includes("responda OK"), "prompt carrega a mensagem");
    assert.ok(prompt?.params?.prompt?.[0]?.text?.includes("sys"), "first-turn de sessão nova leva o system prompt");
  } finally {
    runner.stop();
    process.env.FAKE_ACP_LOG = prev;
    process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = prevPass;
  }
});

test("T-690 driver: model/effort do agente viram set_config_option (model opaco + effort mapeado)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t690drv2-"));
  const logPath = path.join(dir, "acp.jsonl");
  const prev = process.env.FAKE_ACP_LOG;
  const prevPass = process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH;
  process.env.FAKE_ACP_LOG = logPath;
  process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = "FAKE_ACP_LOG";
  const { runner, texts } = makeRunner(dir, { model: '["dsflash","deepseek-flash-41"]', effort: "max" });
  try {
    await runner.start();
    runner.pushUserMessage("responda OK");
    await until(() => texts.length > 0, 10_000, "turno com config");
    const log = readLog(logPath).filter((e) => e.dir === "recv");
    const setModel = log.find((m) => m.method === "session/set_config_option" && (m.params as { configId?: string })?.configId === "model");
    assert.equal((setModel?.params as { value?: string })?.value, '["dsflash","deepseek-flash-41"]');
    const setEffort = log.find((m) => m.method === "session/set_config_option" && (m.params as { configId?: string })?.configId === "reasoning_effort");
    assert.equal((setEffort?.params as { value?: string })?.value, "max");
  } finally {
    runner.stop();
    process.env.FAKE_ACP_LOG = prev;
    process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = prevPass;
  }
});

test("T-690 driver: stop mata o processo e não reinicia", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t690drv3-"));
  const prev = process.env.FAKE_ACP_LOG;
  const prevPass = process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH;
  process.env.FAKE_ACP_LOG = path.join(dir, "acp.jsonl");
  process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = "FAKE_ACP_LOG";
  const { runner, sessions } = makeRunner(dir);
  try {
    await runner.start();
    await until(() => sessions.length > 0, 10_000, "handshake");
    const pid = (runner as unknown as { proc: { pid?: number } | null }).proc?.pid;
    runner.stop();
    await until(() => {
      const p = (runner as unknown as { proc: unknown }).proc;
      return !p;
    }, 5_000, "proc encerrado");
    if (pid) {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      // SIGTERM + escalonamento em 3s; aguarda até 4s.
      const t0 = Date.now();
      while (alive && Date.now() - t0 < 4_000) {
        await new Promise((r) => setTimeout(r, 100));
        try { process.kill(pid, 0); } catch { alive = false; }
      }
      assert.equal(alive, false, "processo ACP morto no stop");
    }
  } finally {
    process.env.FAKE_ACP_LOG = prev;
    process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = prevPass;
  }
});

test("T-1201 dsh: estima cada turno uma vez sem somar os contadores cumulativos de contexto", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t1201dsh-"));
  const logPath = path.join(dir, "acp.jsonl");
  const prevLog = process.env.FAKE_ACP_LOG;
  const prevReplies = process.env.FAKE_ACP_REPLY_SEQUENCE;
  const prevPass = process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH;
  process.env.FAKE_ACP_LOG = logPath;
  process.env.FAKE_ACP_REPLY_SEQUENCE = "OK|abcdefgh";
  process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = "FAKE_ACP_LOG,FAKE_ACP_REPLY_SEQUENCE";
  const { runner, texts, usages, usageDeltas, logs } = makeRunner(dir);
  try {
    await runner.start();
    runner.pushUserMessage("responda OK");
    await until(() => usageDeltas.length >= 1, 10_000, "delta do turno 1");
    runner.pushUserMessage("abcdefgh");
    await until(() => usageDeltas.length >= 2, 10_000, "delta do turno 2");

    const prompts = readLog(logPath)
      .filter((event) => event.dir === "recv" && event.method === "session/prompt")
      .map((event) => (event.params as { prompt?: Array<{ text?: string }> } | undefined)?.prompt?.[0]?.text ?? "");
    assert.equal(prompts.length, 2, "cada mensagem foi enviada em um prompt ACP");
    assert.deepEqual(usageDeltas, [
      { input: Math.ceil(prompts[0]!.length / 4), output: 1, cacheCreate: 0, cacheRead: 0 },
      { input: 2, output: 2, cacheCreate: 0, cacheRead: 0 },
    ], "cada delta usa só prompt/saída do próprio turno (sem acumular turnos anteriores)");
    assert.deepEqual(usages, [[0, 0], [7457, 1048576], [7988, 1048576]], "usage_update continua sendo ocupação de contexto");
    assert.deepEqual(texts, ["OK", "abcdefgh"]);
    assert.equal(logs.filter((line) => line.includes("uso estimado")).length, 2, "cada turno estimado é marcado uma vez");
  } finally {
    runner.stop();
    process.env.FAKE_ACP_LOG = prevLog;
    process.env.FAKE_ACP_REPLY_SEQUENCE = prevReplies;
    process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = prevPass;
  }
});
