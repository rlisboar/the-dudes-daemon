/**
 * T-440 (M17): claude stale no AgentHost — proc que nunca subiu ou morreu sem
 * emitExit não pode ficar "running" fantasma.
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
if (mode === "live") {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "stub" }) + "\\n");
  setInterval(() => {}, 1000);
}
`;

function harness(mode: string | null, commandOverride?: string): {
  runner: AgentRunner;
  exits: Array<number | null>;
  errors: string[];
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t440-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(path.join(dir, "mode"), mode ?? "live");
  const exits: Array<number | null> = [];
  const errors: string[] = [];
  const off = { command: "false", source: "override" as const, available: false };
  const info = {
    id: `agent_t440_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t440", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "claude", autoApprove: true, workspaceRoot: dir,
    cliCommands: {
      claude: { command: commandOverride ?? stub, source: "override" as const, available: true },
      opencode: off, gemini: off, codex: off, crush: off,
      qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
    },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: (m: string) => { errors.push(m); }, onExit: (code: number | null) => { exits.push(code); },
  } as never);
  return { runner, exits, errors };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("T-440: start() com runner indisponível emite exit (não fica running fantasma)", async () => {
  const h = harness("live");
  (h.runner as unknown as { opts: { cliCommands: Record<string, unknown> } }).opts.cliCommands.claude = { command: "x", available: false };
  await h.runner.start();
  assert.deepEqual(h.exits, [1], "onExit(1) precisa disparar");
  assert.equal(h.runner.isAlive(), false);
  assert.ok(h.errors.some((e) => /not found/.test(e)));
});

test("T-440: spawn error do claude (binário inexistente) emite exit e isAlive=false", async () => {
  const h = harness("live", "/nao/existe/claude-t440");
  await h.runner.start();
  await until(() => h.exits.length > 0);
  assert.equal(h.exits[0], 1, "spawn error vira exit(1)");
  assert.equal(h.runner.isAlive(), false, "cadáver não pode reportar vivo");
  assert.ok(h.errors.some((e) => /spawn error/.test(e)));
});

test("T-440: stop() sem proc vivo emite exit(0) (host desanexa)", async () => {
  const h = harness("live");
  h.runner.stop();
  await until(() => h.exits.length > 0, 2000);
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.runner.isAlive(), false);
});

test("T-440: claude vivo reporta isAlive=true; após stop=false", async () => {
  const h = harness("live");
  await h.runner.start();
  await until(() => h.runner.isAlive());
  assert.equal(h.runner.isAlive(), true);
  h.runner.stop();
  await until(() => !h.runner.isAlive());
});

test("T-440 wiring: host exige isAlive no reconnect; startClaude tem on('error')", () => {
  const host = readFileSync(new URL("../agent-host.ts", import.meta.url), "utf8");
  assert.match(host, /if \(!reconfig && existing\.runner\.isAlive\(\)\)/, "reconnect precisa validar liveness");
  const runner = allRunnerSources(new URL("../agent-runner.ts", import.meta.url));
  assert.match(runner, /proc\.on\("error", \((?:err|e)(?:: any)?\) => \{[\s\S]{0,240}emitExit\(1\)/);
  assert.match(runner, /if \(!(?:this|self)\.ensureRunnerAvailable\("claude"\)\) \{ (?:this|self)\.emitExit\(1\); return; \}/);
  assert.match(runner, /isAlive\(\): boolean/);
});