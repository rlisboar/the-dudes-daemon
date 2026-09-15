/**
 * T-416/A10: gemini/codex/crush — touchActivity + toolsInFlight.
 * Turno com tools sem mudança de state NÃO vira hung soft aos 5 min.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";

function makeRunner(cliRunner: "gemini" | "codex" | "crush"): {
  runner: AgentRunner;
  hung: Array<{ soft: boolean }>;
} {
  const hung: Array<{ soft: boolean }> = [];
  const info = {
    id: `agent_t416_${cliRunner}`, ownerUserId: "u", name: "t416", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner, autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: resolveCliCommands(), verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: (h: { soft: boolean }) => { hung.push(h); },
    onExit: () => {},
  } as never);
  (runner as unknown as { drainOcQueue: () => void }).drainOcQueue = () => {};
  return { runner, hung };
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const tick = (r: AgentRunner) => (r as unknown as { tickHangWatch: () => void }).tickHangWatch();

const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../agent-runner.ts"),
  "utf8",
);

test("T-416: os 3 handlers chamam touchActivity (gemini linha, codex linha, crush chunk)", () => {
  const gemini = SRC.slice(SRC.indexOf("ingestGeminiLine"), SRC.indexOf("runGeminiMessage"));
  const codex = SRC.slice(SRC.indexOf("handleCodexEvent"), SRC.indexOf("readCodexRolloutSignals"));
  const crush = SRC.slice(SRC.indexOf("ingestCrushChunk"), SRC.indexOf("runGeminiMessage"));
  assert.match(gemini, /this\.touchActivity\(\)/);
  assert.match(codex, /this\.touchActivity\(\)/);
  assert.match(crush, /this\.touchActivity\(\)/);
  assert.match(gemini, /noteGrokToolInFlight/);
  assert.match(codex, /noteGrokToolInFlight/);
  assert.match(crush, /noteGrokToolInFlight/);
});

test("T-416: turno com tools e sem setState NÃO dispara hung soft aos 5 min (fake timers)", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });

  const { runner: gemini, hung: hungG } = makeRunner("gemini");
  const g = asAny(gemini);
  g.messageSession.busy = true;
  g.setState("thinking");
  const gEpoch = g.messageSession.epoch;
  g.ingestGeminiLine({ type: "tool_call", name: "shell", args: { cmd: "sleep 600" } }, gEpoch, {
    addText: () => {},
    onResult: () => {},
    flush: () => {},
  });
  assert.equal(g.toolsInFlight, 1, "gemini conta toolsInFlight");
  assert.equal(g.currentState, "thinking", "setState thinking é no-op");

  const { runner: codex, hung: hungC } = makeRunner("codex");
  const c = asAny(codex);
  c.messageSession.busy = true;
  c.setState("thinking");
  c.handleCodexEvent(
    { type: "item.started", item: { type: "mcp_tool_call", tool: "shell", arguments: { cmd: "sleep 600" } } },
    c.messageSession.epoch,
  );
  assert.equal(c.toolsInFlight, 1, "codex conta toolsInFlight");

  const { runner: crush, hung: hungK } = makeRunner("crush");
  const k = asAny(crush);
  k.messageSession.busy = true;
  k.setState("thinking");
  k.ingestCrushChunk("output a fluir sem evento de state");
  assert.equal(k.toolsInFlight, 1, "crush conta toolsInFlight no chunk");

  t.mock.timers.tick(5 * 60_000);
  tick(gemini);
  tick(codex);
  tick(crush);

  assert.equal(hungG.length, 0, "gemini: 5 min com tool, sem hung soft");
  assert.equal(hungC.length, 0, "codex: 5 min com tool, sem hung soft");
  assert.equal(hungK.length, 0, "crush: 5 min com chunk/tool, sem hung soft");
  assert.equal(g.messageSession.busy, true);
  assert.equal(c.messageSession.busy, true);
  assert.equal(k.messageSession.busy, true);
});
