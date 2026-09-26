import "./scratch-home.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DshClient } from "../runners/turns/dsh.js";
import { GrokAcpClient } from "../runners/turns/grok-acp.js";
import { acpPermissionDecisionForTurn } from "../runners/turn-security.js";
import { tmpdir } from "./tmp.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-server.mjs", import.meta.url));

function permissionFromLog(path: string): { choice?: string; result?: unknown } {
  const entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
  const answer = entries.find((entry) => entry.dir === "recv" && entry.id === 100 && entry.result?.outcome?.optionId);
  return { choice: answer?.result?.outcome?.optionId, result: answer?.result };
}

test("T-1300: dsh ACP rejects member tool request but owner stays on allow_once", async () => {
  for (const isAgentOwner of [false, true]) {
    const dir = tmpdir(`t1300-dsh-${isAgentOwner ? "owner" : "member"}-`);
    const logPath = `${dir}/acp.jsonl`;
    const texts: string[] = [];
    const tools: Array<{ phase: string; status?: string }> = [];
    const client = new DshClient({
      onText: (text) => texts.push(text), onThought: () => {}, onTool: (tool) => tools.push(tool),
      onUsage: () => {}, onConfig: () => {}, onStderr: () => {}, onExit: () => {},
      onPermissionRequest: () => acpPermissionDecisionForTurn({ isAgentOwner }),
    });
    client.start(process.execPath, [FIXTURE], { cwd: dir, env: { ...process.env, FAKE_ACP_LOG: logPath } });
    try {
      await client.initialize();
      await client.newSession(dir, []);
      const stop = await client.prompt("responda OK");
      const expected = isAgentOwner ? "allow_once" : "reject_once";
      assert.equal(permissionFromLog(logPath).choice, expected);
      if (isAgentOwner) {
        assert.equal(stop, "end_turn");
        assert.deepEqual(texts, ["OK"]);
        assert.ok(tools.some((tool) => tool.status === "completed"));
      } else {
        assert.equal(stop, "permission_denied");
        assert.deepEqual(texts, [], "texto após tool negada não é produzido");
        assert.ok(tools.some((tool) => tool.status === "failed"));
      }
    } finally { client.kill(); }
  }
});

test("T-1300: Grok ACP rejects member tool request but owner stays on allow_once", async () => {
  for (const isAgentOwner of [false, true]) {
    const dir = tmpdir(`t1300-grok-${isAgentOwner ? "owner" : "member"}-`);
    const logPath = `${dir}/acp.jsonl`;
    const texts: string[] = [];
    const tools: Array<{ phase: string; status?: string }> = [];
    const client = new GrokAcpClient({
      onText: (text) => texts.push(text), onThought: () => {}, onTool: (tool) => tools.push(tool),
      onUsage: () => {}, onConfig: () => {}, onStderr: () => {}, onExit: () => {},
      onPermissionRequest: () => acpPermissionDecisionForTurn({ isAgentOwner }),
    });
    client.start(process.execPath, [FIXTURE], { cwd: dir, env: { ...process.env, FAKE_ACP_LOG: logPath }, dropTo: null });
    try {
      await client.initialize();
      await client.novaSessao(dir, []);
      const result = await client.prometer("responda OK") as { stopReason?: string };
      const expected = isAgentOwner ? "allow_once" : "reject_once";
      assert.equal(permissionFromLog(logPath).choice, expected);
      if (isAgentOwner) {
        assert.equal(result.stopReason, "end_turn");
        assert.deepEqual(texts, ["OK"]);
        assert.ok(tools.some((tool) => tool.status === "completed"));
      } else {
        assert.equal(result.stopReason, "permission_denied");
        assert.deepEqual(texts, [], "texto após tool negada não é produzido");
        assert.ok(tools.some((tool) => tool.status === "failed"));
      }
    } finally { client.matar(); }
  }
});
