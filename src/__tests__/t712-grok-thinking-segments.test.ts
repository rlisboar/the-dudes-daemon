/**
 * T-712 — regressão da T-705: o CLI grok emite `thought` POR TOKEN e cada
 * onThinkingText virava um bloco na UI (~12 blocos no mesmo segundo, um por
 * palavra). Agora o segmento contíguo de thought sai como UM agent:thinking,
 * antes do text/tool; tetos de tempo/tamanho só partem raciocínio longo.
 * Stub CLI real passando pelo AgentRunner (mesmo harness da T-705).
 */
import "./scratch-home.js";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { GROK_THINKING_FLUSH_CHARS, GROK_THINKING_FLUSH_MS } from "../runners/turns/grok.js";
import { killPidTree, killProcess } from "../runners/process-lifecycle.js";
import { _resetTurnGateForTest } from "../runners/turn-gate.js";

type Ev = { kind: "thinking" | "text" | "tool"; t: number; text: string };

/** Script de stub: lista de [delayMs, objetoJSON] escritos em stdout. */
function stubScript(lines: Array<[number, unknown]>): string {
  return `#!/usr/bin/env node
const lines = ${JSON.stringify(lines)};
for (const [ms, obj] of lines) {
  if (ms) await new Promise((r) => setTimeout(r, ms));
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
`;
}

function off() {
  return { command: "false", source: "override" as const, available: false };
}

function harness(runnerId: "grok" | "grok-custom", script: string, collectThinking = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t712-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, script);
  chmodSync(stub, 0o755);
  const cmd = { command: stub, source: "override" as const, available: true };
  const cliCommands = {
    claude: off(), opencode: off(), gemini: off(), codex: off(), crush: off(), qwen: off(),
    grok: runnerId === "grok" ? cmd : off(),
    "grok-custom": runnerId === "grok-custom" ? cmd : off(),
    graphify: off(), graphifyMcp: off(),
  };
  const events: Ev[] = [];
  const info = {
    id: `agent_t712_${runnerId}_${process.pid}_${Math.random().toString(36).slice(2, 6)}`,
    ownerUserId: "u", name: "t712", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
    collectThinking,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: runnerId, autoApprove: true, workspaceRoot: dir,
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: (text: string) => { events.push({ kind: "text", t: Date.now(), text }); return true; },
    onThinkingText: (text: string) => { events.push({ kind: "thinking", t: Date.now(), text }); },
    onToolUse: (name: string) => { events.push({ kind: "tool", t: Date.now(), text: name }); },
    onError: () => {}, onHung: () => {}, onSessionId: () => {}, onExit: () => {},
  } as never);
  after(async () => {
    const a = runner as unknown as Record<string, any>;
    for (const pid of (a.liveTurnPids as Set<number>) ?? []) killPidTree(pid, "SIGKILL");
    if (a.ocActiveProc) killProcess(a.ocActiveProc, "SIGKILL");
    runner.stop();
    _resetTurnGateForTest();
    await new Promise((r) => setTimeout(r, 50));
  });
  return { runner, events };
}

async function runTurn(h: ReturnType<typeof harness>, ms = 20_000): Promise<Ev[]> {
  h.runner.pushUserMessage("ping");
  const t0 = Date.now();
  const a = h.runner as unknown as Record<string, any>;
  while (!(h.events.some((e) => e.kind === "text") && !a.messageSession.busy)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout; eventos=${JSON.stringify(h.events)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  return h.events;
}

const END = { type: "end", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
// 30 tokens como o CLI emite (espaço à esquerda faz parte do token).
const WORDS = "I'm a security specialist . I will check the auth flow , then the token store and the bridge".split(" ");
const TOKENS = Array.from({ length: 30 }, (_, i) => (i === 0 ? WORDS[0]! : ` ${WORDS[i % WORDS.length]}`));

for (const runnerId of ["grok", "grok-custom"] as const) {
  test(`T-712 ${runnerId}: 30 thoughts de 1 token + text → exatamente 1 bloco, concatenado, ANTES do text`, async () => {
    assert.equal(TOKENS.length, 30);
    const h = harness(runnerId, stubScript([
      ...TOKENS.map((tok, i): [number, unknown] => [i === 0 ? 20 : 5, { type: "thought", data: tok }]),
      [5, { type: "text", data: "PONG" }],
      [0, END],
    ]));
    const ev = await runTurn(h);
    const thinking = ev.filter((e) => e.kind === "thinking");
    assert.equal(thinking.length, 1, JSON.stringify(thinking));
    assert.equal(thinking[0]!.text, TOKENS.join(""), "espaços dos tokens preservados");
    const iThink = ev.findIndex((e) => e.kind === "thinking");
    const iText = ev.findIndex((e) => e.kind === "text");
    assert.ok(iThink < iText, "thinking antes do agent:text");
    assert.equal(ev[iText]!.text, "PONG");
  });
}

test("T-712 grok-custom: thought→tool→thought→text → 2 blocos, na ordem certa", async () => {
  const h = harness("grok-custom", stubScript([
    [20, { type: "thought", data: "vou" }],
    [5, { type: "thought", data: " ler" }],
    [5, { type: "tool_call", toolCallId: "call_1", toolName: "read_file", rawInput: { path: "a.ts" } }],
    [5, { type: "thought", data: "achei" }],
    [5, { type: "thought", data: " o bug" }],
    [5, { type: "text", data: "PONG" }],
    [0, END],
  ]));
  const ev = await runTurn(h);
  assert.deepEqual(
    ev.map((e) => `${e.kind}:${e.text}`),
    ["thinking:vou ler", "tool:read_file", "thinking:achei o bug", "text:PONG"],
  );
});

test("T-712 grok: thinking contínuo acima do teto de tamanho → >1 bloco, nunca 1 por token", async () => {
  // 30 tokens de 100 chars = 3000 chars > GROK_THINKING_FLUSH_CHARS (2000).
  const tok = "x".repeat(99) + " ";
  const h = harness("grok", stubScript([
    ...Array.from({ length: 30 }, (_, i): [number, unknown] => [i === 0 ? 20 : 2, { type: "thought", data: tok }]),
    [5, { type: "text", data: "PONG" }],
    [0, END],
  ]));
  const ev = await runTurn(h);
  const thinking = ev.filter((e) => e.kind === "thinking");
  assert.ok(thinking.length > 1 && thinking.length < 30, `blocos=${thinking.length}`);
  assert.equal(thinking.map((t) => t.text).join(""), tok.repeat(30), "nada perdido entre blocos");
  assert.ok(thinking[0]!.text.length >= GROK_THINKING_FLUSH_CHARS);
  assert.ok(ev.findIndex((e) => e.kind === "text") > ev.findIndex((e) => e.kind === "thinking"));
});

test("T-712 grok: thinking contínuo acima do teto de tempo → bloco sai durante o raciocínio", async () => {
  // Tokens a cada 400ms por ~10s (> GROK_THINKING_FLUSH_MS=8s), texto só no fim.
  const n = Math.ceil((GROK_THINKING_FLUSH_MS + 2_000) / 400);
  const h = harness("grok", stubScript([
    ...Array.from({ length: n }, (_, i): [number, unknown] => [i === 0 ? 20 : 400, { type: "thought", data: ` t${i}` }]),
    [5, { type: "text", data: "PONG" }],
    [0, END],
  ]));
  const ev = await runTurn(h, 30_000);
  const thinking = ev.filter((e) => e.kind === "thinking");
  const text = ev.find((e) => e.kind === "text")!;
  assert.ok(thinking.length >= 2 && thinking.length < n, `blocos=${thinking.length} tokens=${n}`);
  assert.ok(text.t - thinking[0]!.t >= 1_000, "1º bloco saiu pelo teto de tempo, bem antes do text");
  assert.equal(thinking.map((t) => t.text).join(""), Array.from({ length: n }, (_, i) => ` t${i}`).join(""));
});

test("T-712 collectThinking=false: segmento não emite nada", async () => {
  const h = harness("grok", stubScript([
    ...TOKENS.map((tok, i): [number, unknown] => [i === 0 ? 20 : 5, { type: "thought", data: tok }]),
    [5, { type: "text", data: "PONG" }],
    [0, END],
  ]), false);
  const ev = await runTurn(h);
  assert.equal(ev.filter((e) => e.kind === "thinking").length, 0);
});

test("T-712: segmento sem text/tool depois (só raciocínio) sai no close, 1 bloco", async () => {
  const h = harness("grok", stubScript([
    [20, { type: "thought", data: "só" }],
    [5, { type: "thought", data: " pensando" }],
    [0, END],
  ]));
  h.runner.pushUserMessage("ping");
  const a = h.runner as unknown as Record<string, any>;
  const t0 = Date.now();
  while (!(h.events.length > 0 && !a.messageSession.busy)) {
    if (Date.now() - t0 > 20_000) throw new Error(`timeout; eventos=${JSON.stringify(h.events)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.deepEqual(h.events.map((e) => `${e.kind}:${e.text}`), ["thinking:só pensando"]);
});
