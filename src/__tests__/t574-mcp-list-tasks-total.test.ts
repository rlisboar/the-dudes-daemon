/**
 * T-574 (C7): o `list_tasks` do MCP passa a EXPOR a contagem que o servidor manda.
 *
 * POR QUE: o servidor ganhou `total` (tasks que casam com o filtro, antes do
 * slice) para o leitor distinguir lista COMPLETA de lista CAPADA. Só que o
 * cliente que mais usamos é este — o `list_tasks` do MCP —, e ele lia só
 * `r.tasks` e renderizava texto: sem cabecalho, um cap na rota continuava
 * invisivel para o agente, que trataria uma lista parcial como o board inteiro.
 *
 * O teste sobe um bridge FALSO num socket unix e chama o handler REGISTRADO
 * (não uma cópia do texto): o contrato é a saída da tool. Cobre tambem o
 * servidor ANTERIOR ao deploy, que não manda `total` — o formato antigo tem de
 * continuar intacto, porque os dois estados convivem durante a leva.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "t574mcp-"));
const SOCK = join(dir, "bridge.sock");
const TOKEN_FILE = join(dir, "agent.token");
writeFileSync(TOKEN_FILE, "tok\n");

// A env é fixada ANTES do import dinâmico: o módulo lê AGENT_ID/BRIDGE_SOCKET no
// topo (é um programa, não uma lib — ver T-577 em t469).
process.env.THE_DUDES_AGENT_ID = "agent_t574";
process.env.THE_DUDES_BRIDGE_SOCKET = SOCK;
process.env.THE_DUDES_AGENT_TOKEN_FILE = TOKEN_FILE;
delete process.env.THE_DUDES_FEATURES;
delete process.env.THE_DUDES_AGENT_ROLE;

const { server } = await import("../mcp-bridge.js");

type Payload = { tasks?: unknown[]; total?: number };
/** Resposta do bridge falso: fixa por teste, com `total` opcional. */
let resposta: Payload = { tasks: [] };
let ultimoBody: Record<string, unknown> = {};

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    ultimoBody = body ? JSON.parse(body) : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(resposta));
  });
});
await new Promise<void>((r) => fake.listen(SOCK, () => r()));

after(async () => {
  await server.close();
  await new Promise<void>((r) => fake.close(() => r()));
  process.stdin.unref?.();
});

function task(n: number) {
  return { id: `task_${n}`, taskNumber: n, status: "done", title: `t${n}` };
}

function call(args: Record<string, unknown> = {}): Promise<string> {
  const reg = (server as unknown as {
    _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: { text: string }[] }> }>;
  })._registeredTools;
  return reg.list_tasks!.handler(args).then((r) => r.content[0]!.text);
}

test("T-574 C7: lista completa — cabecalho 'M de N' sem marcacao de corte", async () => {
  resposta = { tasks: [task(1), task(2)], total: 2 };
  const out = await call();
  assert.match(out, /^2 de 2 task\(s\)\n/);
  assert.ok(!/CAPADO/.test(out), "lista completa nao pode dizer CAPADO");
  assert.match(out, /- \[done\] task_1 #1 · t1/);
});

test("T-574 C7: lista CAPADA (payload < total) — marcacao explicita de parcialidade", async () => {
  resposta = { tasks: [task(1), task(2)], total: 5 };
  const out = await call({ limit: 2 });
  assert.match(out, /^2 de 5 task\(s\) — CAPADO: lista PARCIAL/);
  assert.equal(out.split("\n").filter((l) => l.startsWith("- ")).length, 2);
});

test("T-574 C7: servidor SEM `total` (pre-deploy) — formato antigo, sem cabecalho", async () => {
  resposta = { tasks: [task(7)] };
  const out = await call();
  assert.equal(out, "- [done] task_7 #7 · t7");
});

test("T-574 C7: servidor sem `total` e board vazio — '(no tasks yet)' intacto", async () => {
  resposta = { tasks: [] };
  const out = await call();
  assert.equal(out, "(no tasks yet)");
});

test("T-574 C7: board vazio COM `total` — contagem antes do aviso, sem quebrar o parse", async () => {
  resposta = { tasks: [], total: 0 };
  const out = await call();
  assert.equal(out, "0 de 0 task(s)\n(no tasks yet)");
});

test("T-574 C7: `total` invalido (string/bool/negativo) cai no formato antigo", async () => {
  for (const invalido of ["3", true, -1, 1.5]) {
    resposta = { tasks: [task(9)], total: invalido as unknown as number };
    const out = await call();
    assert.equal(out, "- [done] task_9 #9 · t9", `total=${String(invalido)} nao pode virar cabecalho`);
  }
});

test("T-574 C7: o filtro do usuario segue indo no corpo (nada regride no request)", async () => {
  resposta = { tasks: [task(3)], total: 1 };
  await call({ status: "done", assignee: "agent_x", limit: 10 });
  assert.deepEqual(ultimoBody, { status: "done", assignee: "agent_x", limit: 10, brief: true });
});