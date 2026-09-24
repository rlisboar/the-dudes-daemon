/**
 * T-441 (M18): turno do claude contínuo conta no idle do self-update —
 * runner.isTurnActive() + host.hasActiveTurn() no isIdle do gate.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";

import { allRunnerSources } from "./_sources.js";
const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const dir = path.dirname(url.fileURLToPath(import.meta.url));
const mode = fs.readFileSync(path.join(dir, "mode"), "utf8").trim();
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
send({ type: "system", subtype: "init", session_id: "s1", model: "stub" });
if (mode === "echo-result") {
  let buf = "";
  process.stdin.on("data", (c) => {
    buf += c.toString();
    if (buf.includes("\\n")) {
      buf = "";
      send({ type: "result", subtype: "success", result: "ok" });
    }
  });
}
setInterval(() => {}, 1000);
`;

function harness(mode: string, runner: "claude" | "codex" = "claude"): {
  runner: AgentRunner;
  stopped: () => void;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t441-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(path.join(dir, "mode"), mode);
  const off = { command: "false", source: "override" as const, available: false };
  const cmd = { command: stub, source: "override" as const, available: true };
  const info = {
    id: `agent_t441_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t441", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const r = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: runner, autoApprove: true, workspaceRoot: dir,
    cliCommands: {
      claude: cmd, codex: cmd, opencode: off, gemini: off, crush: off,
      qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
    },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onExit: () => {},
  } as never);
  return { runner: r, stopped: () => r.stop() };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("T-441: turno claude vivo conta como ativo; result volta a idle", async (t) => {
  const h = harness("echo-result");
  // T-1078 (QA-A): o teardown NÃO pode depender de chegar à última linha. Em
  // qualquer asserção/`until` que estoure, o stub do claude (persistente, com
  // setInterval) ficava vivo segurando os pipes e o processo do ARQUIVO nunca
  // saía — a suíte pendurava quando roda sem `--test-force-exit` (1 em 3).
  t.after(() => h.stopped());
  await h.runner.start();
  await until(() => h.runner.isAlive());
  assert.equal(h.runner.isTurnActive(), false, "idle antes de enviar");
  h.runner.pushUserMessage("trabalhe");
  assert.equal(h.runner.isTurnActive(), true, "turno em voo precisa ser visível pro self-update");
  await until(() => !h.runner.isTurnActive(), 8000);
  assert.equal(h.runner.isTurnActive(), false, "result fechou o turno");
  h.stopped();
});

test("T-441: per-message não conta (turn-gate é a fonte)", async (t) => {
  const h = harness("echo-result", "codex");
  t.after(() => h.stopped());
  await h.runner.start();
  await until(() => h.runner.isAlive());
  assert.equal(h.runner.isTurnActive(), false);
  h.stopped();
});

test("T-441 wiring: isIdle do self-update consulta hasActiveTurn; host usa isTurnActive", () => {
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(main, /!this\.host\.hasActiveTurn\(\)/, "isIdle precisa olhar turno fora do gate");
  const host = readFileSync(new URL("../agent-host.ts", import.meta.url), "utf8");
  assert.match(host, /hasActiveTurn\(\): boolean \{[\s\S]{0,160}isTurnActive\(\)/);
  const runner = allRunnerSources(new URL("../agent-runner.ts", import.meta.url));
  assert.match(runner, /if \(this\.opts\.cliRunner !== "claude"\) return false;/);
  assert.match(runner, /pendingMessages\.length > 0 && procAlive\(this\.proc\)/);
});