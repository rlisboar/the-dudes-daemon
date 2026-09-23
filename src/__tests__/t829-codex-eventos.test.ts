/**
 * T-829: o runner codex "não aparecia" no dashboard e na RUNS. O parser só
 * virava tool o `mcp_tool_call`; shell/build/testes (`command_execution`) e
 * edições (`file_change`) sumiam, o contador de tools em voo só zerava no
 * turn.completed (11 "em voo" no WEB), `reasoning` não virava thinking, e o
 * turno só fechava no `close` — neto segurando o pipe deixava o agente busy
 * até o HARD recover ("process dead for 20s while busy", 41× no log).
 * Eventos no formato real do codex-cli 0.156.0 (capturados do WEB).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";
import { parseCodexTurnEvent } from "../runners/turn-parsers.js";
import { CODEX_CLOSE_GRACE_MS } from "../runners/turns/codex.js";

const cmdStarted = { type: "item.started", item: { id: "item_72", type: "command_execution", command: "/bin/zsh -lc 'npm run build'", aggregated_output: "", exit_code: null, status: "in_progress" } };
const cmdDone = { type: "item.completed", item: { id: "item_72", type: "command_execution", command: "/bin/zsh -lc 'npm run build'", aggregated_output: "ok\n", exit_code: 0, status: "completed" } };
const mcpStarted = { type: "item.started", item: { id: "item_80", type: "mcp_tool_call", server: "the-dudes", tool: "list_tasks", arguments: { status: "todo" }, status: "in_progress" } };
const mcpDone = { type: "item.completed", item: { id: "item_80", type: "mcp_tool_call", server: "the-dudes", tool: "list_tasks", status: "completed" } };

test("T-829 parser: shell, MCP, edição, busca e raciocínio no formato real do codex", () => {
  assert.deepEqual(parseCodexTurnEvent(cmdStarted), [{ type: "tool", name: "shell", input: { command: "/bin/zsh -lc 'npm run build'" }, id: "item_72" }]);
  assert.deepEqual(parseCodexTurnEvent(cmdDone), [{ type: "tool_done", id: "item_72" }]);
  assert.deepEqual(parseCodexTurnEvent(mcpStarted), [{ type: "tool", name: "list_tasks", input: { status: "todo" }, id: "item_80" }]);
  assert.deepEqual(parseCodexTurnEvent(mcpDone), [{ type: "tool_done", id: "item_80" }]);
  assert.deepEqual(
    parseCodexTurnEvent({ type: "item.completed", item: { id: "item_9", type: "file_change", changes: [{ path: "web/src/Toast.tsx", kind: "update" }], status: "completed" } }),
    [{ type: "tool", name: "file_change", input: { changes: [{ path: "web/src/Toast.tsx", kind: "update" }] } }],
  );
  assert.deepEqual(
    parseCodexTurnEvent({ type: "item.completed", item: { id: "item_10", type: "web_search", query: "codex exec json" } }),
    [{ type: "tool", name: "web_search", input: { query: "codex exec json" } }],
  );
  assert.deepEqual(
    parseCodexTurnEvent({ type: "item.completed", item: { id: "item_11", type: "reasoning", text: "  vou rodar o build  " } }),
    [{ type: "thought", text: "vou rodar o build" }],
  );
  assert.deepEqual(parseCodexTurnEvent({ type: "item.updated", item: { id: "item_72", type: "command_execution" } }), [], "update intermediário não é evento");
  // Tool iniciada sem id (formato antigo) ainda conta em voo: id sintético,
  // e o completed sem id não desconta — o turn.completed zera, como antes.
  const semId = parseCodexTurnEvent({ type: "item.started", item: { type: "mcp_tool_call", tool: "shell", arguments: {} } });
  assert.equal(semId.length, 1);
  assert.match(String((semId[0] as { id?: string }).id), /^anon-\d+$/);
  assert.deepEqual(parseCodexTurnEvent({ type: "item.completed", item: { type: "mcp_tool_call", tool: "shell" } }), []);
});

function makeRunner(fakeCodex: string, sink: { tools: Array<[string, unknown]>; thoughts: string[]; logs: string[] }) {
  const info = {
    id: "agent_t829", ownerUserId: "u", name: "probe", role: "backend",
    systemPrompt: "", color: "#a78bfa", state: "idle", running: true, collectThinking: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const cliCommands = { ...resolveCliCommands(), codex: { command: fakeCodex, source: "override" as const, available: true } };
  return new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "codex", autoApprove: true, workspaceRoot: tmpdir(),
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (_l: string, m: string) => sink.logs.push(m), cliLog: () => {}, onState: () => {},
    onAssistantText: () => true,
    onToolUse: (n: string, i: unknown) => sink.tools.push([n, i]),
    onThinkingText: (t: string) => sink.thoughts.push(t),
    onError: () => {}, onExit: () => {},
  } as never);
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;

test("T-829 runner: tool em voo por item — o completed desconta e o contador volta a 0", () => {
  const sink = { tools: [] as Array<[string, unknown]>, thoughts: [] as string[], logs: [] as string[] };
  const runner = makeRunner("/bin/false", sink);
  const a = asAny(runner);
  const ev = (e: unknown) => a.handleCodexEvent(e, a.messageSession.epoch);
  ev(cmdStarted);
  assert.equal(a.toolsInFlight, 1);
  ev(mcpStarted);
  assert.equal(a.toolsInFlight, 2);
  ev(cmdStarted); // started repetido do mesmo item não conta de novo
  assert.equal(a.toolsInFlight, 2);
  ev(cmdDone);
  assert.equal(a.toolsInFlight, 1);
  ev(mcpDone);
  assert.equal(a.toolsInFlight, 0, "antes do T-829 ficava em 2 até o turn.completed");
  assert.equal(a.toolsInFlightSince, null);
  ev(mcpDone); // completed sem started correspondente não vai a negativo
  assert.equal(a.toolsInFlight, 0);
  assert.deepEqual(sink.tools.map(([n]) => n), ["shell", "list_tasks", "shell"], "shell agora vira tool (RUNS/dashboard)");
  ev({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "pensando no build" } });
  assert.deepEqual(sink.thoughts, ["pensando no build"], "raciocínio chega à UI");
});

test("T-829 runner: neto segurando o pipe não prende o turno — fecha após o exit sem HARD recover", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t829-"));
  const script = path.join(dir, "fake-codex.sh");
  const lines = [
    { type: "thread.started", thread_id: "01a0-t829" },
    cmdStarted,
    cmdDone,
    { type: "item.completed", item: { id: "item_99", type: "agent_message", text: "pronto" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 } },
  ].map((l) => `'${JSON.stringify(l).replace(/'/g, "'\\''")}'`).join(" ");
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '%s\\n' ${lines}`,
    // Neto herda o stdout (pipe do daemon) e sobrevive ao codex.
    "sleep 30 &",
    `echo $! > "${dir}/neto.pid"`,
    "exit 0",
  ].join("\n"));
  chmodSync(script, 0o755);
  const sink = { tools: [] as Array<[string, unknown]>, thoughts: [] as string[], logs: [] as string[] };
  const runner = makeRunner(script, sink);
  const a = asAny(runner);
  const t0 = Date.now();
  runner.pushUserMessage("oi");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !(a.messageSession.busy === false && sink.tools.length > 0)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const ms = Date.now() - t0;
  try {
    assert.equal(a.messageSession.busy, false, "o turno fechou mesmo com o neto segurando o pipe");
    assert.ok(sink.logs.some((m) => m.includes("close não veio")), `fechamento pelo exit logado: ${sink.logs.join(" | ")}`);
    assert.ok(!sink.logs.some((m) => m.includes("HARD recover")), "sem HARD recover");
    assert.equal(a.toolsInFlight, 0);
    assert.ok(ms < 15_000, `fechou em ${ms}ms (grace ${CODEX_CLOSE_GRACE_MS}ms; antes só o watchdog, 20s+)`);
    const neto = Number(readFileSync(path.join(dir, "neto.pid"), "utf8").trim());
    await new Promise((r) => setTimeout(r, 300));
    let vivo = true;
    try { process.kill(neto, 0); } catch { vivo = false; }
    assert.equal(vivo, false, "o neto que ficou no grupo do codex foi colhido");
  } finally {
    runner.stop();
    try { process.kill(Number(readFileSync(path.join(dir, "neto.pid"), "utf8").trim()), "SIGKILL"); } catch { /* já morto */ }
  }
});
