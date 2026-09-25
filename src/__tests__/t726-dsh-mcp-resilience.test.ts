/**
 * T-726 (absorve a T-717) — o agente dsh não subia na máquina do dono.
 *
 * Causa medida: todo agente do projeto recebe o MCP playwright, que é
 * `npx -y @playwright/mcp` (comando RELATIVO). O ACP do dsh exige path
 * absoluto, o conversor LANÇAVA, o handshake morria e o runner reiniciava a
 * cada ~500ms para sempre, com "[dsh] handshake: ..." no chat e zero resposta.
 *
 * Agora: (a) comando relativo resolve pelo PATH (com o path resolvido no log);
 * (b) MCP EXTRA que não resolve ou não conecta sai da sessão, com aviso
 * nomeando o MCP — o bridge the-dudes continua fatal; (c) o teto do
 * session/new fica acima do teto interno do dsh (~63s), para o -32603 real
 * chegar ao chat; (d) handshake falho vira backoff com parada visível.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DSH_HANDSHAKE_MAX_TRIES,
  SESSION_TIMEOUT_MS,
  mcpNameFromAcpError,
  resolveAcpCommand,
  toAcpMcpServers,
} from "../runners/turns/dsh.js";
import { AgentRunner } from "../agent-runner.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-server.mjs", import.meta.url));

/* ---------------- (a) resolução de comando ---------------- */

test("T-726 (a): resolveAcpCommand — absoluto passa, node vira execPath, relativo do PATH resolve, desconhecido é null", () => {
  assert.equal(resolveAcpCommand("/usr/bin/true"), "/usr/bin/true");
  assert.equal(resolveAcpCommand("node"), process.execPath);
  const npx = resolveAcpCommand("npx");
  assert.ok(npx && path.isAbsolute(npx) && npx.endsWith("/npx"), `npx resolvido: ${npx}`);
  assert.equal(resolveAcpCommand("comando-que-nao-existe-t726"), null);
  assert.equal(resolveAcpCommand("./relativo"), null, "relativo ao cwd é ambíguo no ACP");
  assert.equal(resolveAcpCommand(undefined), null);
});

test("T-726 (a): toAcpMcpServers — npx relativo entra resolvido; o que não resolve sai em skipped com motivo", () => {
  const { servers, skipped } = toAcpMcpServers([
    { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp"] },
    { name: "quebrado", command: "comando-que-nao-existe-t726", args: [] },
    { name: "remoto", url: "https://mcp.test/x", headers: { A: "b" } },
  ]);
  assert.deepEqual(servers.map((s) => s.name), ["playwright", "remoto"]);
  const pw = servers[0] as { command: string };
  assert.ok(path.isAbsolute(pw.command), "command absoluto no wire");
  assert.deepEqual(skipped.map((s) => s.name), ["quebrado"]);
  assert.match(skipped[0]!.reason, /não encontrado no PATH/);
});

test("T-726 (c): teto do session/new acima do teto interno medido do dsh (63s) e nome do MCP extraído do -32603", () => {
  assert.ok(SESSION_TIMEOUT_MS >= 120_000, `session timeout=${SESSION_TIMEOUT_MS}`);
  assert.equal(
    mcpNameFromAcpError("acp -32603: Internal error — mcp-client(playwright): initial connection or tool synchronization failed"),
    "playwright",
  );
  assert.equal(mcpNameFromAcpError("acp -32602: Invalid params"), null);
});

/* ---------------- runner real contra o fake ACP ---------------- */

type Harness = {
  runner: AgentRunner;
  erros: string[];
  logs: string[];
  textos: string[];
  spawns: () => number;
};

function harness(extraMcpServers: Record<string, unknown>, bridgeCommand = "node", failMcp?: string): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t726-"));
  // Wrapper: o runner chama `<cmd> --profile acp`; o fake ignora argv.
  const stub = path.join(dir, "dsh.sh");
  // env no wrapper: o buildEnv do runner não repassa variáveis de teste.
  writeFileSync(stub, `#!/bin/sh\n${failMcp ? `export FAKE_ACP_FAIL_MCP=${JSON.stringify(failMcp)}\n` : ""}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}\n`);
  chmodSync(stub, 0o755);
  const off = { command: "false", source: "override" as const, available: false };
  const erros: string[] = [];
  const logs: string[] = [];
  const textos: string[] = [];
  const info = {
    id: `agent_t726_${process.pid}_${Math.random().toString(36).slice(2, 6)}`,
    ownerUserId: "u", name: "t726", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
    cliRunner: "dsh",
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand, bridgeArgs: ["/tmp/mcp-bridge.cjs"], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "dsh", autoApprove: true, workspaceRoot: dir,
    cliCommands: {
      claude: off, opencode: off, gemini: off, codex: off, crush: off, qwen: off,
      grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
      dsh: { command: stub, source: "override" as const, available: true },
    },
    extraMcpServers,
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (_l: string, m: string) => { logs.push(m); },
    cliLog: () => {}, onState: () => {},
    onAssistantText: (t: string) => { textos.push(t); return true; },
    onToolUse: () => {}, onThinkingText: () => {},
    onError: (m: string) => { erros.push(m); },
    onHung: () => {}, onSessionId: () => {}, onExit: () => {},
  } as never);
  const spawns = () => logs.filter((l) => l.includes("processo saiu")).length;
  return { runner, erros, logs, textos, spawns };
}

async function until(cond: () => boolean, what: string, ms = 45_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const ready = (h: Harness) => !!(h.runner as unknown as { dshReady?: boolean }).dshReady;

test("T-726 (b): MCP extra que não resolve — agente SOBE sem ele, com aviso nomeando o MCP; log traz o path resolvido dos que entraram", async () => {
  const h = harness({
    playwright: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] },
    quebrado: { type: "stdio", command: "comando-que-nao-existe-t726", args: [] },
  });
  try {
    await h.runner.start();
    await until(() => ready(h), "dsh ready");
    h.runner.pushUserMessage("oi");
    await until(() => h.textos.length > 0, "texto após remover MCP que não resolve");
    const aviso = h.erros.find((e) => e.includes('MCP "quebrado"'));
    assert.ok(aviso, `aviso do MCP quebrado: ${JSON.stringify(h.erros)}`);
    assert.match(aviso!, /não encontrado no PATH/);
    assert.match(aviso!, /sobe sem ele/);
    assert.ok(!h.erros.some((e) => e.includes("handshake:")), "o handshake NÃO morre por causa do extra");
    assert.ok(h.logs.some((l) => /MCP playwright → \/.*npx/.test(l)), `path resolvido no log: ${h.logs.filter((l) => l.includes("MCP")).join(" | ")}`);
  } finally { h.runner.stop(); }
});

test("T-726 (b)/(c): MCP extra que não CONECTA (-32603 do dsh) — retry sem ele, agente sobe e o chat nomeia o MCP", async () => {
  const h = harness({ playwright: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] } }, "node", "playwright");
  try {
    await h.runner.start();
    await until(() => ready(h), "dsh ready após MCP -32603");
    h.runner.pushUserMessage("oi");
    await until(() => h.textos.length > 0, "texto após remover MCP que não conectou");
    const aviso = h.erros.find((e) => e.includes('MCP "playwright" não conectou'));
    assert.ok(aviso, `aviso do -32603: ${JSON.stringify(h.erros)}`);
    assert.match(aviso!, /-32603/);
    assert.match(aviso!, /initial connection or tool synchronization failed/, "motivo real do dsh chega ao chat");
  } finally { h.runner.stop(); }
});

test("T-726 (b): bridge the-dudes que não resolve é FATAL (não sobe sem o bridge)", async () => {
  const h = harness({}, "bridge-inexistente-t726");
  try {
    await h.runner.start();
    await until(() => h.erros.some((e) => e.includes("handshake:")), "erro do bridge MCP fatal");
    const err = h.erros.find((e) => e.includes("handshake:"))!;
    assert.match(err, /bridge the-dudes indisponível/);
    assert.equal(ready(h), false, "não fica pronto sem o bridge");
  } finally { h.runner.stop(); }
});

test("T-726 (d): handshake que falha em série faz backoff e PARA com motivo visível (sem loop cego)", async () => {
  const h = harness({}, "bridge-inexistente-t726");
  try {
    await h.runner.start();
    await until(() => h.erros.some((e) => e.includes("agente PARADO")), "parada após falhas de handshake", 90_000);
    const parada = h.erros.find((e) => e.includes("agente PARADO"))!;
    assert.match(parada, new RegExp(`falhou ${DSH_HANDSHAKE_MAX_TRIES}x seguidas`));
    // T-731: o motivo tem de estar JUNTO, mas qual erro é depende do
    // ambiente — no CI o /tmp/the-dudes é partilhado e outro arquivo de teste
    // pode limpar o agent.token entre as tentativas, então a última falha
    // vira ENOENT em vez do erro do bridge. O contrato de (d) é "parou com
    // motivo visível", não um texto específico; o texto do bridge fatal já é
    // coberto pelo teste (b) do bridge.
    assert.match(parada, /Último motivo: \S.*\./, `motivo junto: ${parada}`);
    assert.ok(!/desconhecido/.test(parada), `motivo real, não placeholder: ${parada}`);
    const saidas = h.spawns();
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(h.spawns(), saidas, "nenhum restart novo depois da parada");
    assert.ok(h.logs.some((l) => /restart com resume em \d+ms \(falha \d+\/5\)/.test(l)), "backoff declarado no log");
  } finally { h.runner.stop(); }
});
