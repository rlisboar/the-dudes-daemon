/**
 * T-414/A14: 404 HTTP genérico não apaga sessionId no claude.
 * Missing-session real só conta se a linha de stderr vier ANTES do init.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { classifyRunnerFailure, isMissingSessionFailure } from "../runners/error-classifier.js";

const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const dir = path.dirname(url.fileURLToPath(import.meta.url));
const mode = fs.readFileSync(path.join(dir, "mode"), "utf8").trim();
const send = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };
if (mode === "after-init-404") {
  send({ type: "system", subtype: "init", session_id: "sess-keep", model: "claude-stub" });
  process.stderr.write("GET /x 404 Not Found\\n");
  setInterval(() => {}, 1000);
} else if (mode === "before-init-404") {
  process.stderr.write("GET /x 404 Not Found\\n");
  send({ type: "system", subtype: "init", session_id: "sess-keep", model: "claude-stub" });
  setInterval(() => {}, 1000);
} else if (mode === "before-init-real") {
  process.stderr.write("no conversation found with session id abc\\n");
  setInterval(() => {}, 1000);
} else if (mode === "after-init-real") {
  send({ type: "system", subtype: "init", session_id: "sess-keep", model: "claude-stub" });
  process.stderr.write("no conversation found with session id abc\\n");
  setInterval(() => {}, 1000);
}
`;

function makeClaude(mode: string): { runner: AgentRunner; sessionEvents: string[]; stop: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t414-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(path.join(dir, "mode"), mode);
  const sessionEvents: string[] = [];
  const cmd = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  const info = {
    id: `agent_t414_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t414", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    sessionId: "sess-keep",
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "claude", autoApprove: true, workspaceRoot: dir,
    cliCommands: {
      claude: cmd, opencode: off, gemini: off, codex: off, crush: off,
      qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
    },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onExit: () => {},
    onSessionId: (id: string) => { sessionEvents.push(id); },
    resumeSessionId: "sess-keep",
  } as never);
  return {
    runner,
    sessionEvents,
    stop: () => { runner.stop(); },
  };
}

async function until(cond: () => boolean, ms = 4000, what = "condição"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("T-414 classificador: GET 404 genérico NÃO é missing_session; textos reais dos CLIs ainda são", () => {
  assert.equal(classifyRunnerFailure("GET /x 404 Not Found"), "other");
  assert.equal(isMissingSessionFailure("GET /x 404 Not Found"), false);
  assert.equal(isMissingSessionFailure("couldn't resume session: 404 not found"), true);
  assert.equal(isMissingSessionFailure("no conversation found with session id abc"), true);
  assert.equal(isMissingSessionFailure("session not found"), true);
  assert.equal(isMissingSessionFailure("no such session"), true);
  assert.equal(
    isMissingSessionFailure("No saved session found with ID 0e5f0580-b460-4728-bf1f-4a811395e524."),
    true,
  );
});

test("T-414 claude: 404 genérico DEPOIS do init NÃO apaga sessionId nem força restart", async () => {
  const h = makeClaude("after-init-404");
  try {
    await h.runner.start();
    await until(() => h.runner.info.sessionId === "sess-keep" || h.sessionEvents.includes("sess-keep"), 4000, "init");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.runner.info.sessionId, "sess-keep");
    assert.equal(h.sessionEvents.includes(""), false, "onSessionId(\"\") não deve disparar");
    const a = h.runner as unknown as { sessionInvalid: boolean };
    assert.equal(a.sessionInvalid, false);
  } finally {
    h.stop();
  }
});

test("T-414 claude: 404 genérico ANTES do init também NÃO apaga sessionId", async () => {
  const h = makeClaude("before-init-404");
  try {
    await h.runner.start();
    await until(() => h.runner.info.sessionId === "sess-keep" || h.sessionEvents.includes("sess-keep"), 4000, "init");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.runner.info.sessionId, "sess-keep");
    assert.equal(h.sessionEvents.includes(""), false);
  } finally {
    h.stop();
  }
});

test("T-414 claude: texto real de sessão perdida ANTES do init apaga sessionId", async () => {
  const h = makeClaude("before-init-real");
  try {
    await h.runner.start();
    await until(() => h.runner.info.sessionId === undefined || h.sessionEvents.includes(""), 4000, "sessionInvalid");
    assert.equal(h.runner.info.sessionId, undefined);
    assert.ok(h.sessionEvents.includes(""), "onSessionId(\"\") no missing-session pré-init");
  } finally {
    h.stop();
  }
});

test("T-414 claude: texto real de sessão perdida DEPOIS do init NÃO apaga sessionId", async () => {
  const h = makeClaude("after-init-real");
  try {
    await h.runner.start();
    await until(() => h.sessionEvents.includes("sess-keep") || h.runner.info.sessionId === "sess-keep", 4000, "init");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.runner.info.sessionId, "sess-keep");
    assert.equal(h.sessionEvents.includes(""), false);
  } finally {
    h.stop();
  }
});
