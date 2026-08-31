/**
 * T-166 — grok-custom: leitores de sessão (RUNS / ocupação / billing) usam
 * ~/.grok-custom, o home onde o wrapper grava. grok oficial continua em ~/.grok.
 * T-164 intacto: buildGrokEnv NÃO seta GROK_HOME para grok-custom.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { grokHomePath, RunnerRuntimeFiles } from "../runners/runtime-files.js";
import { grokSignalsPath } from "../runners/parsers.js";
import { buildGrokEnv } from "../runners/env.js";
import {
  grokSignalsCandidatesFor,
  grokUpdatesCandidatesFor,
  resolveGrokChatHistoryPath,
  sweepGrokChatToolCallsFromPath,
} from "../agent-runner.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/** Schema real do chat_history.jsonl (grok-custom, sessão viva 01a059f0-…). */
function assistantToolLine(id: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    content: "working",
    model_id: "grok-4.5",
    tool_calls: [{ id, name, arguments: JSON.stringify(args) }],
  });
}

function writeSessionFiles(grokHome: string, cwd: string, sessionId: string, chatLine: string): string {
  const dir = path.dirname(grokSignalsPath(grokHome, cwd, sessionId));
  mkdirSync(dir, { recursive: true });
  const chat = path.join(dir, "chat_history.jsonl");
  writeFileSync(chat, `${chatLine}\n`, { mode: 0o600 });
  writeFileSync(path.join(dir, "signals.json"), JSON.stringify({
    contextTokensUsed: 12,
    contextWindowTokens: 500_000,
  }), { mode: 0o600 });
  writeFileSync(path.join(dir, "updates.jsonl"), `${JSON.stringify({ type: "turn_completed", usage: { input: 1 } })}\n`, { mode: 0o600 });
  return chat;
}

test("T-166 A1: grokChatHistoryPath com grok-custom resolve ~/.grok-custom (não ~/.grok)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "t166-a1-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "ws");
  mkdirSync(cwd, { recursive: true });
  const sid = "01a059f0-68cb-7ce1-bba8-00ff46c28571";
  try {
    const customFiles = new RunnerRuntimeFiles({
      workspaceRoot: cwd, agentId: "ag-c", agentToken: "t", home, runner: "grok-custom",
    });
    const officialFiles = new RunnerRuntimeFiles({
      workspaceRoot: cwd, agentId: "ag-g", agentToken: "t", home, runner: "grok",
    });
    const customHome = customFiles.grokHome();
    const officialHome = officialFiles.grokHome();
    assert.equal(customHome, path.join(home, ".grok-custom"));
    assert.equal(officialHome, path.join(home, ".grok"));
    assert.equal(grokHomePath(home, "grok-custom"), customHome);

    const customChat = writeSessionFiles(
      customHome, cwd, sid,
      assistantToolLine("call-custom", "list_dir", { target_directory: "." }),
    );
    const officialChat = writeSessionFiles(
      officialHome, cwd, sid,
      assistantToolLine("call-official", "bash", { command: "decoy" }),
    );

    const found = resolveGrokChatHistoryPath(customHome, cwd, sid);
    assert.equal(found, customChat);
    assert.ok(found.startsWith(customHome + path.sep), "A1 falha se ainda apontar ~/.grok");
    assert.ok(!found.startsWith(officialHome + path.sep));
    assert.notEqual(found, officialChat);

    // Sem o home custom, o mesmo SID no ~/.grok é outra sessão (decoy).
    assert.equal(resolveGrokChatHistoryPath(officialHome, cwd, sid), officialChat);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T-166 A2: grokSweepToolCalls emite onToolUse a partir do chat_history (schema assistant+tool_calls)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "t166-a2-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "ws");
  mkdirSync(cwd, { recursive: true });
  const sid = "01a059f0-68cb-7ce1-bba8-00ff46c28571";
  try {
    const files = new RunnerRuntimeFiles({
      workspaceRoot: cwd, agentId: "ag-c", agentToken: "t", home, runner: "grok-custom",
    });
    const chat = writeSessionFiles(
      files.grokHome(), cwd, sid,
      assistantToolLine("chatcmpl-tool-bc07d311b7c0da72", "read_file", { target_file: "x.ts" }),
    );
    const historyPath = resolveGrokChatHistoryPath(files.grokHome(), cwd, sid);
    assert.equal(historyPath, chat);

    const uses: Array<{ name: string; input: unknown }> = [];
    const seen = new Set<string>();
    const result = sweepGrokChatToolCallsFromPath(historyPath!, null, seen, (call) => {
      uses.push({ name: call.name, input: call.input });
    });
    assert.ok(result);
    assert.equal(result.emitted, true);
    assert.equal(uses.length, 1);
    assert.equal(uses[0].name, "read_file");
    assert.deepEqual(uses[0].input, { target_file: "x.ts" });
    assert.ok(seen.has("chatcmpl-tool-bc07d311b7c0da72"));

    // Segunda passada: dedupe — não re-emite.
    const again = sweepGrokChatToolCallsFromPath(historyPath!, result.cursor, seen, (call) => {
      uses.push({ name: call.name, input: call.input });
    });
    assert.ok(again);
    assert.equal(again.emitted, false);
    assert.equal(uses.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T-166 A3: grok oficial continua lendo $HOME/.grok (A/B)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "t166-a3-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "ws");
  mkdirSync(cwd, { recursive: true });
  const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  try {
    const grok = new RunnerRuntimeFiles({
      workspaceRoot: cwd, agentId: "ag-g", agentToken: "t", home, runner: "grok",
    });
    const custom = new RunnerRuntimeFiles({
      workspaceRoot: cwd, agentId: "ag-c", agentToken: "t", home, runner: "grok-custom",
    });
    writeSessionFiles(grok.grokHome(), cwd, sid, assistantToolLine("g1", "list_dir", { target_directory: "/oficial" }));
    writeSessionFiles(custom.grokHome(), cwd, sid, assistantToolLine("c1", "list_dir", { target_directory: "/custom" }));

    const fromGrok = resolveGrokChatHistoryPath(grok.grokHome(), cwd, sid);
    const fromCustom = resolveGrokChatHistoryPath(custom.grokHome(), cwd, sid);
    assert.ok(fromGrok?.startsWith(path.join(home, ".grok") + path.sep));
    assert.ok(fromCustom?.startsWith(path.join(home, ".grok-custom") + path.sep));
    assert.notEqual(fromGrok, fromCustom);

    for (const p of grokSignalsCandidatesFor(grok.grokHome(), cwd, sid)) {
      assert.ok(p.startsWith(grok.grokHome() + path.sep), p);
    }
    for (const p of grokUpdatesCandidatesFor(custom.grokHome(), cwd, sid)) {
      assert.ok(p.startsWith(custom.grokHome() + path.sep), p);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T-166 A4: buildGrokEnv(runner=grok-custom) NÃO seta GROK_HOME (T-164 intacto)", () => {
  const env = buildGrokEnv({
    base: { PATH: "/usr/bin", HOME: "/home/u" },
    tokenFile: "/tmp/token",
    features: {},
    grokHome: grokHomePath("/home/u", "grok-custom"),
    runner: "grok-custom",
  });
  assert.equal("GROK_HOME" in env, false);
  assert.notEqual(env.GROK_HOME, path.join("/home/u", ".grok"));
  const official = buildGrokEnv({
    base: { PATH: "/usr/bin", HOME: "/home/u" },
    tokenFile: "/tmp/token",
    features: {},
    grokHome: grokHomePath("/home/u", "grok"),
    runner: "grok",
  });
  assert.equal(official.GROK_HOME, path.join("/home/u", ".grok"));
});

test("T-166: 401 e leitores do agent-runner usam grokHome() (sem literal grok-custom)", () => {
  const src = readFileSync(path.join(AQUI, "../agent-runner.ts"), "utf8");
  assert.ok(!/"grok-custom"/.test(src), "T-150: nenhum literal grok-custom em agent-runner.ts");
  assert.match(src, /isAuthenticationFailure[\s\S]{0,400}runtimeFiles\.grokHome\(\)/);
  assert.match(src, /runner:\s*opts\.cliRunner/);
  assert.match(src, /resolveGrokChatHistoryPath\(this\.runtimeFiles\.grokHome\(\)/);
});
