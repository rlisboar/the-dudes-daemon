import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";
import { isCodexMissingRolloutError } from "../runners/turn-parsers.js";

const SID = "01a0d6c3-a5e8-7450-99b0-eb8b4892708d";

function makeRunner(fakeCodex: string, logs: string[]): AgentRunner {
  const info = {
    id: "agent_t1265", ownerUserId: "user_t1265", name: "resume-probe", role: "backend",
    systemPrompt: "synthetic system", color: "#a78bfa", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  return new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "synthetic", cliRunner: "codex", autoApprove: true, workspaceRoot: tmpdir(),
    cliCommands: { ...resolveCliCommands(), codex: { command: fakeCodex, source: "override", available: true } },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (_level: string, msg: string) => logs.push(msg), cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {}, onError: (msg: string) => logs.push(`error:${msg}`), onExit: () => {},
  } as never);
}

const asAny = (runner: AgentRunner) => runner as unknown as Record<string, any>;

async function waitFor(cond: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return cond();
}

test("T-1265: resume sem rollout re-enfileira em sessão fria, preserva resumo e registra recuperação", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "t1265-resume-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });
  const invocations = path.join(home, "invocations.txt");
  const coldPrompt = path.join(home, "cold-prompt.txt");
  const fake = path.join(home, "fake-codex.sh");
  writeFileSync(fake, [
    "#!/bin/sh",
    `case " $* " in *" exec resume "*) printf '%s\\n' resume >> "${invocations}"; echo 'Error: thread/resume failed: no rollout found for thread id ${SID}' >&2; exit 0;; esac`,
    `printf '%s\\n' cold >> "${invocations}"`,
    `for arg in "$@"; do prompt="$arg"; done; printf '%s' "$prompt" > "${coldPrompt}"`,
    `printf '%s\\n' '{"type":"thread.started","thread_id":"fresh-t1265"}' '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}'`,
  ].join("\n") + "\n");
  chmodSync(fake, 0o755);

  const logs: string[] = [];
  const runner = makeRunner(fake, logs);
  t.after(() => runner.stop());
  const state = asAny(runner).messageSession;
  state.resume(SID, { needsPrime: false, alreadyHasSystemPrompt: true });
  state.pendingSummary = "synthetic previous context digest";

  asAny(runner).runCodexMessage("ping after restart");
  const spawned = await waitFor(() => existsSync(invocations));
  assert.equal(spawned, true, `CLI fake não iniciou: ${logs.join(" | ")}`);
  assert.equal(await waitFor(() => readFileSync(invocations, "utf8").trim().split("\n").length >= 2), true,
    `falha de resume precisa disparar um segundo spawn cold-start: ${logs.join(" | ")}`);
  assert.equal(await waitFor(() => !state.busy && state.sessionId === "fresh-t1265"), true,
    "sessão nova deve completar e ficar registrada");
  const calls = readFileSync(invocations, "utf8").trim().split("\n");
  assert.deepEqual(calls, ["resume", "cold"]);
  const prompt = readFileSync(coldPrompt, "utf8");
  assert.match(prompt, /synthetic previous context digest/);
  assert.match(prompt, /ping after restart/);
  assert.ok(logs.some((line) => /resume falhou \(no rollout found\).*sessão nova.*resumo de contexto preservado/.test(line)),
    "a causa e o fallback devem aparecer no log do daemon");
});

test("T-1265: classificador do fallback só reconhece caminho de rollout ausente/obsoleto", () => {
  assert.equal(isCodexMissingRolloutError("thread/resume failed: no rollout found for thread id t1"), true);
  assert.equal(isCodexMissingRolloutError("state db returned stale rollout path /tmp/old.jsonl"), true);
  assert.equal(isCodexMissingRolloutError("authentication failed"), false);
  assert.equal(isCodexMissingRolloutError("session is not resumable"), false);
});
