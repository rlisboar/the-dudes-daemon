/**
 * T-574 (C5): o payload de `tasks_list` ganhou a chave `total` (aditiva). Isto
 * prova, contra código real, que o consumidor que ATRAVESSA o payload continua
 * funcionando: o relay do daemon, que reescreve a resposta no lugar para
 * decifrar titulos (bridge-relay.ts, ramo E2EE de listas).
 *
 * O risco nomeado no card era um cliente que validasse o payload por shape
 * FECHADO (zod strict): o campo novo derrubaria a validacao. O relay nao valida
 * shape — muta `json.tasks` e re-serializa —, entao `total` tem de chegar
 * intacto do outro lado. Se um dia ele passar a validar, este teste cai.
 *
 * Caminho exercitado de verdade: socket unix do relay -> upstream falso.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { BridgeRelay } from "../bridge-relay.js";
import {
  clearAgentPidRegistry,
  registerAgentPid,
  setParentPidReader,
  setUnixPeerPidReader,
} from "../privileges.js";

const AGENT = "ag_574c5";
const ROTA = `/api/bridge/${AGENT}/tasks_list`;

afterEach(() => {
  clearAgentPidRegistry();
  setParentPidReader(null);
  setUnixPeerPidReader(null);
});

async function listenOrch(payload: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((_req, res) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
    res.end(body);
  });
  await new Promise<void>((resolve) => { srv.listen(0, "127.0.0.1", resolve); });
  const addr = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Relay com peer-pid stubado (mesmo padrão do t071) e o ramo E2EE ATIVO:
 *  o lookup devolve projeto, entao o relay reescreve a resposta. */
async function relayComProjeto(orchUrl: string): Promise<BridgeRelay> {
  registerAgentPid(AGENT, 100);
  setUnixPeerPidReader(() => 100);
  setParentPidReader(() => 1);
  const relay = new BridgeRelay(orchUrl, null, () => "proj_574", { peerPidSelfTest: async () => true });
  await relay.start();
  return relay;
}

async function postPeloRelay(socketPath: string): Promise<{ status: number; body: any }> {
  const req = http.request({
    socketPath,
    method: "POST",
    path: ROTA,
    headers: { "Content-Type": "application/json" },
  });
  req.end(JSON.stringify({ brief: true }));
  const [res] = await once(req, "response") as [http.IncomingMessage];
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  await once(res, "end");
  return { status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}

test("T-574 C5: relay repassa `total` intacto mesmo reescrevendo a resposta (ramo E2EE ativo)", async () => {
  const orch = await listenOrch({
    tasks: [{ id: "task_1", title: "titulo em claro" }],
    total: 598,
  });
  const relay = await relayComProjeto(orch.url);
  try {
    const r = await postPeloRelay(relay.socketPath);
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 598, "o consumidor do caminho nao pode perder nem renomear `total`");
    assert.deepEqual(r.body.tasks, [{ id: "task_1", title: "titulo em claro" }]);
    // Payload shape-estrito sobreviveria: as chaves de topo sao as duas conhecidas.
    assert.deepEqual(Object.keys(r.body).sort(), ["tasks", "total"]);
  } finally {
    relay.stop();
    await orch.close();
  }
});

test("T-574 C5: payload SEM `total` (servidor pre-deploy) segue passando igual", async () => {
  const orch = await listenOrch({ tasks: [{ id: "task_9", title: "antigo" }] });
  const relay = await relayComProjeto(orch.url);
  try {
    const r = await postPeloRelay(relay.socketPath);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { tasks: [{ id: "task_9", title: "antigo" }] });
    assert.ok(!("total" in r.body), "o relay nao pode inventar a chave que o servidor nao mandou");
  } finally {
    relay.stop();
    await orch.close();
  }
});