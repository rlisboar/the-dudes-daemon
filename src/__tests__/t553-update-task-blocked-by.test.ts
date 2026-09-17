/**
 * T-553 — o tool MCP `update_task` tem de expor e ENVIAR blockedByTaskId.
 *
 * O bug do lado do daemon não era de fiação, era de schema: o SDK valida os
 * argumentos pelo shape registado em `server.tool(...)`, e o campo faltava.
 * O `blockedByTaskId` chegava ao CLI, era descartado na validação e o
 * `postJSON("tasks_update", args)` seguia sem ele — por isso o bridge (que
 * agora o sabe ler) recebia um patch vazio.
 *
 * Aqui não se lê o fonte: sobe-se o bridge REAL como processo, fala-se MCP
 * por stdio (listTools + callTool) e observa-se o corpo que sai para um
 * upstream falso. É o contrato observável, não a intenção.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(AQUI, "..", "mcp-bridge.ts");
const AGENT = "agent_t553";

interface Visto { path: string; body: Record<string, unknown> }

/** Upstream falso: captura o corpo que o bridge manda para /api/bridge/*. */
async function upstreamFalso(): Promise<{ url: string; vistos: Visto[]; close: () => Promise<void> }> {
  const vistos: Visto[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { /* cru */ }
      vistos.push({ path: req.url ?? "", body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ task: { id: "task_x", title: "x", status: "todo" } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const porta = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${porta}`,
    vistos,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

async function ligarBridge(orchUrl: string): Promise<{ client: Client; fechar: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", BRIDGE],
    cwd: path.join(AQUI, "..", ".."),
    env: {
      ...process.env,
      THE_DUDES_AGENT_ID: AGENT,
      THE_DUDES_AGENT_NAME: "t553",
      THE_DUDES_AGENT_TOKEN: "tok-t553",
      THE_DUDES_ORCH_URL: orchUrl,
      // socket vazio: o caminho exercido é o HTTP, que é o que se observa
      THE_DUDES_BRIDGE_SOCKET: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "t553", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, fechar: () => client.close() };
}

test("T-553: listTools do bridge expõe blockedByTaskId em update_task (nullable, opcional)", async () => {
  const up = await upstreamFalso();
  const { client, fechar } = await ligarBridge(up.url);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "update_task");
    assert.ok(tool, "update_task não está registada");
    const props = (tool.inputSchema as { properties?: Record<string, any> }).properties ?? {};
    assert.ok("blockedByTaskId" in props, `update_task sem blockedByTaskId no schema: ${Object.keys(props).join(",")}`);
    // nullable + opcional: null limpa, ausência preserva. required não o lista.
    const required = (tool.inputSchema as { required?: string[] }).required ?? [];
    assert.ok(!required.includes("blockedByTaskId"), "blockedByTaskId não pode ser obrigatório");
    const tipo = props.blockedByTaskId?.type;
    assert.ok(
      tipo === "string" || (Array.isArray(tipo) && tipo.includes("null")),
      `blockedByTaskId tem de aceitar null (type=${JSON.stringify(tipo)})`,
    );
    // add_task continua a expor o campo (não regrediu ao mexer no vizinho)
    const add = tools.find((t) => t.name === "add_task");
    assert.ok(add && "blockedByTaskId" in ((add.inputSchema as any).properties ?? {}));
  } finally {
    await fechar();
    await up.close();
  }
});

test("T-553: callTool update_task envia blockedByTaskId (id e null) ao upstream", async () => {
  const up = await upstreamFalso();
  const { client, fechar } = await ligarBridge(up.url);
  try {
    await client.callTool({ name: "update_task", arguments: { id: "task_x", blockedByTaskId: "task_bloqueador" } });
    assert.equal(up.vistos.length, 1, "um POST por callTool");
    assert.equal(up.vistos[0]!.path, `/api/bridge/${AGENT}/tasks_update`);
    assert.equal(up.vistos[0]!.body.id, "task_x");
    assert.equal(up.vistos[0]!.body.blockedByTaskId, "task_bloqueador", "a aresta não chegou ao bridge");

    // null explícito TEM de viajar (é o "limpa"); não pode ser confundido com
    // ausência, que o JSON.stringify descarta.
    await client.callTool({ name: "update_task", arguments: { id: "task_x", blockedByTaskId: null } });
    assert.equal(up.vistos.length, 2);
    assert.ok("blockedByTaskId" in up.vistos[1]!.body, "null foi omitido do corpo");
    assert.equal(up.vistos[1]!.body.blockedByTaskId, null, "null tem de limpar no bridge");

    // campo ausente continua a não viajar (patch preserva o que não foi tocado)
    await client.callTool({ name: "update_task", arguments: { id: "task_x", status: "doing" } });
    assert.ok(!("blockedByTaskId" in up.vistos[2]!.body));
    assert.equal(up.vistos[2]!.body.status, "doing");
  } finally {
    await fechar();
    await up.close();
  }
});