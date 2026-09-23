/**
 * T-841 — endTurn idempotente por turno, não por epoch.
 *
 * O epoch só muda em reset/bump. No 2º turno normal do codex/gemini o close
 * era engolido: busy ficava true, o watchdog fazia HARD recover e a mensagem
 * rodava de novo. Três turnos seguidos no mesmo epoch fecham todos.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";
import { _resetTurnGateForTest } from "../runners/turn-gate.js";

function stub(kind: "codex" | "gemini", mark: string): string {
  return `#!/usr/bin/env node
import fs from "node:fs";
const mark = ${JSON.stringify(mark)};
const prev = fs.existsSync(mark) ? fs.readFileSync(mark, "utf8").split("\\n").filter(Boolean).length : 0;
const n = prev + 1;
fs.appendFileSync(mark, String(n) + "\\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (${JSON.stringify(kind)} === "codex") {
  send({ type: "thread.started", thread_id: "t841" });
  send({ type: "item.completed", item: { id: "m" + n, type: "agent_message", text: "resp-" + n } });
  send({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } });
} else {
  send({ type: "message", role: "assistant", content: "resp-" + n });
  send({ type: "result", stats: { input_tokens: 1, output_tokens: 1 } });
}
`;
}

function runnerFor(kind: "codex" | "gemini", script: string, dir: string) {
  const off = { command: "false", source: "override" as const, available: false };
  const cmd = { command: script, source: "override" as const, available: true };
  const base = resolveCliCommands();
  const cliCommands = {
    ...base,
    claude: off, opencode: off, gemini: off, codex: off, crush: off, qwen: off,
    grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
    [kind]: cmd,
  };
  const texts: string[] = [];
  const logs: string[] = [];
  const info = {
    id: `ag_t841_${kind}`, ownerUserId: "u", name: kind, role: "backend",
    systemPrompt: "", color: "#fff", state: "idle", running: true, collectThinking: false,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
    cliRunner: kind,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: kind, autoApprove: true, workspaceRoot: dir,
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (_l: string, m: string) => logs.push(m), cliLog: () => {}, onState: () => {},
    onAssistantText: (t: string) => { texts.push(t); return true; },
    onToolUse: () => {}, onThinkingText: () => {}, onError: () => {}, onExit: () => {},
  } as never);
  return { runner, texts, logs };
}

async function tresTurnos(kind: "codex" | "gemini") {
  _resetTurnGateForTest();
  const dir = mkdtempSync(path.join(tmpdir(), `t841-${kind}-`));
  const script = path.join(dir, "cli.mjs");
  const mark = path.join(dir, "n.txt");
  writeFileSync(script, stub(kind, mark));
  chmodSync(script, 0o755);
  const { runner, texts, logs } = runnerFor(kind, script, dir);
  const a = runner as unknown as {
    messageSession: { busy: boolean; epoch: number };
    hardRecoverTimes?: number[];
    __endedTurnKeys?: Set<string>;
  };
  const epoch0 = a.messageSession.epoch;
  try {
    runner.pushUserMessage("um");
    runner.pushUserMessage("dois");
    runner.pushUserMessage("tres");
    const t0 = Date.now();
    while (Date.now() - t0 < 8_000 && !(texts.length >= 3 && a.messageSession.busy === false)) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.deepEqual(texts, ["resp-1", "resp-2", "resp-3"], `${kind}: uma resposta por mensagem`);
    assert.equal(a.messageSession.busy, false, `${kind}: busy solto depois do 3º turno`);
    assert.equal(a.messageSession.epoch, epoch0, `${kind}: os três turnos no mesmo epoch`);
    assert.equal((a.hardRecoverTimes ?? []).length, 0, `${kind}: sem HARD recover`);
    assert.ok(!logs.some((l) => l.includes("HARD recover")), logs.filter((l) => l.includes("HARD")).join(" | "));
    assert.equal(a.__endedTurnKeys?.size, 3, `${kind}: cada turno tem chave própria`);
  } finally {
    runner.stop();
  }
}

test("T-841 codex: 3 turnos seguidos no mesmo epoch fecham, sem resposta duplicada", async () => {
  await tresTurnos("codex");
});

test("T-841 gemini: 3 turnos seguidos no mesmo epoch fecham, sem resposta duplicada", async () => {
  await tresTurnos("gemini");
});
