/**
 * T-705 — grok/grok-custom: thinking em STREAM + teto 720s amarrado no watchdog.
 *
 * Causa-raiz (QA 23:2xZ, CLI vivo 1.0.34 / grok-custom 1.6.3): o CLI emite
 * {type:thought,data} (dezenas de thought antes do 1º text). grok.ts
 * acumulava fullThought e só chamava onThinkingText em emitOnce() no close
 * — UI sem thinking durante o turno. GROK_TURN_TIMEOUT_MS (720s) era
 * SIGKILL absoluto, independente de thought/tool. ACP sessionUpdate fica
 * como defesa (help 1.0.34); não é o furo medido neste host.
 */
import "./scratch-home.js";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import {
  grokAbsoluteTimeoutShouldKill,
  hangThresholds,
} from "../runners/turn-watchdog.js";
import { killPidTree, killProcess } from "../runners/process-lifecycle.js";
import { _resetTurnGateForTest } from "../runners/turn-gate.js";

const LEGACY_STUB = `#!/usr/bin/env node
await new Promise((r) => setTimeout(r, 20));
process.stdout.write(JSON.stringify({ type: "thought", data: "raciocinio " }) + "\\n");
await new Promise((r) => setTimeout(r, 250));
process.stdout.write(JSON.stringify({ type: "thought", data: "passo" }) + "\\n");
await new Promise((r) => setTimeout(r, 250));
process.stdout.write(JSON.stringify({ type: "text", data: "PONG" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }) + "\\n");
`;

const ACP_STUB = `#!/usr/bin/env node
await new Promise((r) => setTimeout(r, 20));
process.stdout.write(JSON.stringify({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text: "hmm " },
}) + "\\n");
await new Promise((r) => setTimeout(r, 250));
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s1",
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "ACP" } },
  },
}) + "\\n");
await new Promise((r) => setTimeout(r, 250));
process.stdout.write(JSON.stringify({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "PONG" },
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }) + "\\n");
`;

interface StreamHarness {
  runner: AgentRunner;
  /** T-712: ordem dos callbacks + marcador do close do processo do turno. */
  seq: Array<"thinking" | "text" | "close">;
  thinking: Array<{ t: number; text: string }>;
  texts: Array<{ t: number; text: string }>;
  cliLogs: string[];
  warns: string[];
}

function off() {
  return { command: "false", source: "override" as const, available: false };
}

function makeStreamHarness(opts: {
  runnerId: "grok" | "grok-custom";
  stub: string;
  collectThinking: boolean;
}): StreamHarness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t705-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, opts.stub);
  chmodSync(stub, 0o755);
  const cmd = { command: stub, source: "override" as const, available: true };
  const cliCommands = {
    claude: off(), opencode: off(), gemini: off(), codex: off(), crush: off(), qwen: off(),
    grok: opts.runnerId === "grok" ? cmd : off(),
    "grok-custom": opts.runnerId === "grok-custom" ? cmd : off(),
    graphify: off(), graphifyMcp: off(),
  };
  const seq: StreamHarness["seq"] = [];
  const thinking: StreamHarness["thinking"] = [];
  const texts: StreamHarness["texts"] = [];
  const cliLogs: string[] = [];
  const warns: string[] = [];
  const info = {
    id: `agent_t705_${opts.runnerId}_${process.pid}_${Math.random().toString(36).slice(2, 6)}`,
    ownerUserId: "u", name: "t705", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
    collectThinking: opts.collectThinking,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: opts.runnerId, autoApprove: true, workspaceRoot: dir,
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (lvl: string, msg: string) => { if (lvl === "warn") warns.push(msg); },
    cliLog: (_lvl: string, msg: string) => { cliLogs.push(msg); },
    onState: () => {},
    onAssistantText: (text: string) => { seq.push("text"); texts.push({ t: Date.now(), text }); return true; },
    onThinkingText: (text: string) => { seq.push("thinking"); thinking.push({ t: Date.now(), text }); },
    onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onSessionId: () => {}, onExit: () => {},
  } as never);
  return { runner, seq, thinking, texts, cliLogs, warns };
}

async function until(cond: () => boolean, what: string, ms = 12_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function cleanupRunner(runner: AgentRunner): Promise<void> {
  const a = runner as unknown as Record<string, any>;
  const pids = new Set<number>([
    ...(a.liveTurnPids as Set<number> ?? []),
    ...(a.ocActiveProc?.pid ? [a.ocActiveProc.pid as number] : []),
  ]);
  for (const pid of pids) killPidTree(pid, "SIGKILL");
  if (a.ocActiveProc) killProcess(a.ocActiveProc, "SIGKILL");
  runner.stop();
  _resetTurnGateForTest();
  await new Promise((r) => setTimeout(r, 50));
}

async function runStreamCase(runnerId: "grok" | "grok-custom", stub: string): Promise<StreamHarness> {
  const h = makeStreamHarness({ runnerId, stub, collectThinking: true });
  after(() => cleanupRunner(h.runner));
  h.runner.pushUserMessage("ping");
  // T-712: marca o close do processo do turno ANTES do handler do grok.ts
  // (prependListener), que é quem chama emitOnce → agent:text.
  const a = h.runner as unknown as Record<string, any>;
  await until(() => !!a.ocActiveProc, `${runnerId} spawn do turno`);
  (a.ocActiveProc as import("node:child_process").ChildProcess).prependListener("close", () => h.seq.push("close"));
  await until(() => h.texts.length > 0, `${runnerId} text`);
  await until(() => !a.messageSession.busy, `${runnerId} idle`);
  // Mesma exigência de antes, sem polling de janela: o 1º thinking vem antes
  // do 1º text E foi emitido no ingest (antes do close/emitOnce).
  const iThinking = h.seq.indexOf("thinking");
  const iClose = h.seq.indexOf("close");
  const iText = h.seq.indexOf("text");
  assert.ok(iThinking >= 0 && iClose >= 0 && iText >= 0, `seq=${h.seq.join(",")}`);
  assert.ok(iThinking < iText, `thinking ANTES do agent:text — seq=${h.seq.join(",")}`);
  assert.ok(iThinking < iClose, `thinking no ingest, não no close/emitOnce — seq=${h.seq.join(",")}`);
  return h;
}

test("T-705 grok collectThinking: ≥1 agent:thinking ANTES do agent:text (legado type=thought)", async () => {
  const h = await runStreamCase("grok", LEGACY_STUB);
  assert.ok(h.thinking.length >= 1, `thinking=${h.thinking.length}`);
  assert.equal(h.texts[0]?.text, "PONG");
  assert.ok(h.thinking[0]!.t <= h.texts[0]!.t, `thinking@${h.thinking[0]!.t} text@${h.texts[0]!.t}`);
  assert.ok(
    h.cliLogs.some((l) => l.includes("grok:thinking") && l.includes("block_received")),
    h.cliLogs.join(" | "),
  );
});

test("T-705 grok-custom collectThinking: ≥1 agent:thinking ANTES do agent:text (legado type=thought)", async () => {
  const h = await runStreamCase("grok-custom", LEGACY_STUB);
  assert.ok(h.thinking.length >= 1, `thinking=${h.thinking.length}`);
  assert.equal(h.texts[0]?.text, "PONG");
  assert.ok(h.thinking[0]!.t <= h.texts[0]!.t);
  assert.ok(
    h.cliLogs.some((l) => l.includes("grok:thinking") && l.includes("block_received")),
    h.cliLogs.join(" | "),
  );
});

test("T-705 grok-custom collectThinking: thinking em stream ANTES do text (ACP sessionUpdate, defesa)", async () => {
  const h = await runStreamCase("grok-custom", ACP_STUB);
  assert.ok(h.thinking.length >= 1, `thinking=${JSON.stringify(h.thinking)}`);
  assert.equal(h.texts[0]?.text, "PONG");
  assert.ok(h.thinking[0]!.t <= h.texts[0]!.t);
  assert.ok(h.thinking.some((x) => x.text.includes("ACP") || x.text.includes("hmm")));
  assert.ok(
    h.cliLogs.some((l) => l.includes("grok:thinking") && l.includes("block_received")),
    h.cliLogs.join(" | "),
  );
});

test("T-705 collectThinking=false: loga block_received e NÃO emite onThinkingText", async () => {
  const h = makeStreamHarness({ runnerId: "grok", stub: LEGACY_STUB, collectThinking: false });
  after(() => cleanupRunner(h.runner));
  h.runner.pushUserMessage("ping");
  await until(() => h.texts.length > 0, "text sem thinking");
  assert.equal(h.thinking.length, 0, "gate collectThinking permanece");
  assert.ok(
    h.cliLogs.some((l) => l.includes("grok:thinking") && l.includes("block_received") && l.includes("collectFlag=false")),
    h.cliLogs.join(" | "),
  );
});

/* ---------- thought periódico < softMs não HARD aos ~304s ---------- */

function makeHangRunner(): { runner: AgentRunner; warns: string[] } {
  const warns: string[] = [];
  const info = {
    id: `agent_t705hang_${process.pid}`,
    ownerUserId: "u", name: "t705h", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "grok", autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: {}, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (lvl: string, msg: string) => { if (lvl === "warn") warns.push(msg); },
    cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onExit: () => {},
  } as never);
  (runner as unknown as { drainOcQueue: () => void }).drainOcQueue = () => {};
  return { runner, warns };
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const tick = (r: AgentRunner) => (r as unknown as { tickHangWatch: () => void }).tickHangWatch();
const hardWarns = (warns: string[]) => warns.filter((w) => w.includes("HARD recover"));

function aliveChild(): ChildProcess {
  return spawn("sleep", ["300"], { stdio: "ignore" });
}

test("T-705: thought periódico < softMs NÃO dispara HARD recover aos ~304s", () => {
  const { runner, warns } = makeHangRunner();
  const child = aliveChild();
  after(() => {
    try { child.kill("SIGKILL"); } catch { /* */ }
    try { runner.stop(); } catch { /* */ }
  });
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.ocActiveProc = child;
  a.activityClock.firstEventAt = Date.now() - 30_000;
  const soft = hangThresholds("grok").softMs;
  assert.equal(soft, 3 * 60_000, "T-784: soft pós-evento é 3min");
  // 50s < softMs; 7 ciclos = 350s > 304s medidos em prod
  const ciclos = 7;
  for (let i = 0; i < ciclos; i++) {
    a.activityClock.lastActivityAt = Date.now() - 50_000;
    tick(runner);
    assert.equal(a.messageSession.busy, true, `ciclo ${i + 1}: thought recente não mata`);
    assert.equal(hardWarns(warns).length, 0, `ciclo ${i + 1}: ${warns.join(" | ")}`);
  }
  assert.ok(ciclos * 50_000 > 304_000, "cobertura simulada >304s");
});

/* ---------- 720s amarrado no watchdog ---------- */

test("T-705: grok.ts emite onThinkingText no ingest (stream), não no emitOnce", () => {
  const src = readFileSync(new URL("../runners/turns/grok.ts", import.meta.url), "utf8");
  const thoughtAt = src.indexOf('event.type === "thought"');
  const emitAt = src.indexOf("const emitOnce");
  assert.ok(thoughtAt >= 0 && emitAt > thoughtAt, "bloco thought antes do emitOnce");
  const thoughtBlock = src.slice(thoughtAt, emitAt);
  const emitBlock = src.slice(emitAt, emitAt + 900);
  assert.match(thoughtBlock, /onThinkingText/);
  assert.match(thoughtBlock, /grok:thinking.*block_received/);
  assert.doesNotMatch(emitBlock, /onThinkingText/);
  assert.match(src, /grokAbsoluteTimeoutShouldKill/);
  assert.match(src, /rearmOnSkipMs|grokRearmMs/);
});

test("T-705: GROK_TURN_TIMEOUT 720s NÃO mata com evento semântico recente; SEM evento mata", () => {
  const g = hangThresholds("grok");
  const gc = hangThresholds("grok-custom");
  assert.equal(g.postEventMs, gc.postEventMs, "família grok: mesmos tetos");

  assert.equal(grokAbsoluteTimeoutShouldKill({
    idleMs: 120_000, toolsInFlight: 0, toolsAgeMs: 0, runner: "grok",
  }), false, "idle 2min < postEventMs");
  assert.equal(grokAbsoluteTimeoutShouldKill({
    idleMs: 280_000, toolsInFlight: 0, toolsAgeMs: 0, runner: "grok-custom",
  }), false, "idle 280s ainda dentro dos 5min");
  assert.equal(grokAbsoluteTimeoutShouldKill({
    idleMs: 304_000, toolsInFlight: 0, toolsAgeMs: 0, runner: "grok",
  }), true, "idle 304s (banda medida) recolhe");
  assert.equal(grokAbsoluteTimeoutShouldKill({
    idleMs: 720_000, toolsInFlight: 0, toolsAgeMs: 0, runner: "grok",
  }), true, "silêncio no teto absoluto continua recolhido");
  assert.equal(grokAbsoluteTimeoutShouldKill({
    idleMs: 400_000, toolsInFlight: 1, toolsAgeMs: 5 * 60_000, runner: "grok",
  }), false, "tool viva protege (T-240)");
  assert.equal(grokAbsoluteTimeoutShouldKill({
    idleMs: 400_000, toolsInFlight: 1, toolsAgeMs: 11 * 60_000, runner: "grok",
  }), true, "tool vencida + silêncio → mata");
});
