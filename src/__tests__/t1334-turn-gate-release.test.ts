import "./scratch-home.js";

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { EventEmitter } from "node:events";
import { AgentRunner } from "../agent-runner.js";
import { _resetTurnGateForTest, turnGateDebug, turnGateStats } from "../runners/turn-gate.js";

type DeferredPost = { resolve(value: unknown): void; reject(error: Error): void };

function makeOpenCode() {
  const errors: string[] = [];
  const retained: Array<Array<{ content: string }>> = [];
  const activeSlotsObserved: number[] = [];
  const info = {
    id: `agent_t1334_${process.pid}`, ownerUserId: "owner", name: "T-1334", role: "backend",
    systemPrompt: "", color: "#fff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const off = { command: "false", source: "override" as const, available: false };
  const on = { command: "node", source: "override" as const, available: true };
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0", agentToken: "t",
    cliRunner: "opencode", autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: { claude: off, opencode: on, gemini: off, codex: off, crush: off, qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => { activeSlotsObserved.push(turnGateStats().ativos); }, onAssistantText: () => true, onToolUse: () => {},
    onError: (message: string) => errors.push(message), onExit: () => {}, onHung: () => {},
    onQueueRetained: (items: Array<{ content: string }>) => retained.push(items),
  } as never);
  const internals = runner as unknown as Record<string, any>;
  const posts: DeferredPost[] = [];
  let session = 0;
  internals.ensureOcServer = async () => {};
  internals.fetchOcCatalogLimit = async () => {};
  internals.openCodeTransport = { ready: () => true, stop: () => {}, start: async () => {} };
  internals.messageSession.needsPrime = false;
  internals.ocServeFetch = async (route: string, method: string) => {
    if (route === "/session" && method === "POST") return { id: `session-${++session}` };
    if (route.endsWith("/message") && method === "POST") {
      return await new Promise((resolve, reject) => posts.push({ resolve, reject }));
    }
    return [];
  };
  internals.ocProcessNewParts = async () => { internals.ocRunSawOutput = true; };
  internals.attachNonImageFiles = (content: string) => ({ content, cleanup: () => {} });
  internals.scheduleAttachmentCleanup = () => {};
  return { runner, internals, posts, retained, errors, activeSlotsObserved };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function agentHolders(agentName: string) {
  return turnGateDebug().holders.filter((holder) => holder.label === `opencode:${agentName}`);
}

test("T-1334: stop releases an OpenCode slot immediately and retains its queued turns", async () => {
  _resetTurnGateForTest();
  const h = makeOpenCode();
  try {
    h.runner.pushUserMessage("in-flight", undefined, undefined, "delivery-1");
    await until(() => h.posts.length === 1 && agentHolders("T-1334").length === 1, "OpenCode POST slot");
    h.runner.pushUserMessage("queued-2", undefined, undefined, "delivery-2");
    h.runner.pushUserMessage("queued-3", undefined, undefined, "delivery-3");
    assert.equal(h.internals.messageSession.queuedCount(), 2);
    // Keep the stop path from emitting exit synchronously: the assertion must
    // prove stop itself releases the slot, while the OpenCode POST is pending.
    const proc = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null; pid?: number; kill(signal: NodeJS.Signals): boolean };
    proc.exitCode = null;
    proc.signalCode = null;
    proc.kill = () => { proc.exitCode = 0; return true; };
    h.internals.ocActiveProc = proc;

    h.runner.stop();

    assert.deepEqual(agentHolders("T-1334"), [], "runner parado não pode permanecer nos holders do gate");
    assert.equal(turnGateStats().ativos, 0);
    assert.deepEqual(h.retained.flat().map((item) => item.content), ["queued-2", "queued-3"]);
  } finally {
    h.runner.stop();
    _resetTurnGateForTest();
  }
});

test("T-1334: OpenCode drains queued messages only after releasing the prior slot", async () => {
  _resetTurnGateForTest();
  const h = makeOpenCode();
  try {
    h.runner.pushUserMessage("turn-1", undefined, undefined, "delivery-1");
    h.runner.pushUserMessage("turn-2", undefined, undefined, "delivery-2");
    await until(() => h.posts.length === 1 && agentHolders("T-1334").length === 1, "first OpenCode POST");

    h.posts[0]!.resolve({ info: {}, parts: [] });
    await until(() => h.posts.length === 2, "second OpenCode POST");
    assert.equal(agentHolders("T-1334").length, 1, "um agente nunca deve ter dois slots main ao mesmo tempo");
    assert.equal(turnGateStats().ativos, 1);

    h.posts[1]!.resolve({ info: {}, parts: [] });
    await until(() => agentHolders("T-1334").length === 0 && turnGateStats().ativos === 0, "final OpenCode release");
    assert.equal(h.internals.messageSession.queuedCount(), 0);
    assert.ok(Math.max(...h.activeSlotsObserved) <= 1, `observed concurrent slots: ${h.activeSlotsObserved.join(",")}`);
  } finally {
    h.runner.stop();
    _resetTurnGateForTest();
  }
});

test("T-1334: OpenCode releases its slot when the serve POST fails with a provider error", async () => {
  _resetTurnGateForTest();
  const h = makeOpenCode();
  try {
    void h.internals.runOpenCodeMessage("provider failed", undefined, 99);
    await until(() => h.posts.length === 1 && agentHolders("T-1334").length === 1, "failing OpenCode POST");
    h.posts[0]!.reject(new Error("APIError: 524"));
    await until(() => agentHolders("T-1334").length === 0 && turnGateStats().ativos === 0, "release after provider error");
    assert.ok(h.errors.some((message) => message.includes("524")), "provider error remains visible");
  } finally {
    h.runner.stop();
    _resetTurnGateForTest();
  }
});

test("T-1334 regression: a late completion after resetWithSummary cannot release the new turn lease", async () => {
  _resetTurnGateForTest();
  const h = makeOpenCode();
  let drains = 0;
  const originalDrain = h.internals.drainOcQueue.bind(h.runner);
  h.internals.drainOcQueue = () => { drains++; return originalDrain(); };
  try {
    h.runner.pushUserMessage("old-session-turn");
    await until(() => h.posts.length === 1 && agentHolders("T-1334").length === 1, "old session POST slot");

    h.runner.resetWithSummary("new session");
    assert.deepEqual(agentHolders("T-1334"), [], "reset libera o lease da sessão invalidada");
    h.internals.messageSession.busy = false; // clear concluiu e libera a próxima mensagem

    h.runner.pushUserMessage("new-session-turn");
    await until(() => h.posts.length === 2 && agentHolders("T-1334").length === 1, "new session POST slot");
    assert.equal(turnGateStats().ativos, 1);

    const drainsBeforeLateCompletion = drains;
    h.posts[0]!.resolve({ info: {}, parts: [] });
    await until(() => drains > drainsBeforeLateCompletion, "late old-session completion cleanup");
    assert.equal(agentHolders("T-1334").length, 1, "a completion tardia libera só o lease antigo, não o novo");
    assert.equal(turnGateStats().ativos, 1);

    h.posts[1]!.resolve({ info: {}, parts: [] });
    await until(() => agentHolders("T-1334").length === 0 && turnGateStats().ativos === 0, "new session release");
  } finally {
    h.runner.stop();
    _resetTurnGateForTest();
  }
});
