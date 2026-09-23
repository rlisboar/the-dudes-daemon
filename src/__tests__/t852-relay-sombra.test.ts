/**
 * T-852 (relay) — a sombra sai do relay, DEPOIS da resposta 2xx do server.
 *
 * Fecha o ponto de integração: `tasks_add` que o server aceita dispara uma
 * chamada ao Jev; resposta não-2xx não dispara; projeto sem Jev não dispara.
 * O upstream é um HTTP local; o POST do agente entra pelo socket do relay.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t852r-key-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t852r-pkeys-${process.pid}.json`);
process.env.THE_DUDES_PEER_PID_INSECURE = "1"; // self-test false → modo explícito dos testes de relay
process.env.TYPESAFE_TASK_SHADOW = "1";
process.env.TYPESAFE_API_KEY = "k";

const { BridgeRelay } = await import("../bridge-relay.js");
const { getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");
const { registrarJevDoProjeto } = await import("../typesafe-delegate-shadow.js");
const { setTaskShadowFetch, _resetTaskShadowForTest, flushTaskShadowDebounceForTests, settleTaskShadowForTests, definirElencoProjeto } = await import("../typesafe-task-shadow.js");

const PID = "proj_t852_relay";
const AG = "ag_t852";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}

let chamadas = 0;
setTaskShadowFetch(async () => {
  chamadas++;
  return { status: 200, text: async () => JSON.stringify({ model: "jev-1.13.0", answers: {
    domain: { type: "choice", choice: "PM", probabilities: { PM: 1 }, confidence: 1 },
    complexity: { type: "choice", choice: "simple", probabilities: { simple: 1 }, confidence: 1 },
    destructive: { type: "noul", noul: 0 },
    security: { type: "noul", noul: 0 },
    acceptance: { type: "noul", noul: 1 },
  } }) };
});

function post(relay: { socketPath: string }, ag: string, op: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { socketPath: relay.socketPath, method: "POST", path: `/api/bridge/${ag}/${op}`, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
    );
    req.on("error", reject);
    req.end(data);
  });
}

test("T-852 (relay): 2xx dispara a sombra; erro do server e projeto sem Jev não", async () => {
  let status = 200;
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (status !== 200) { res.writeHead(status); res.end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ task: { id: "task_relay", title: "Título", description: "desc", status: "todo", assigneeAgentId: "agent_pm" } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const porta = (upstream.address() as { port: number }).port;

  const relay = new BridgeRelay(`http://127.0.0.1:${porta}`, null, () => PID, { peerPidSelfTest: async () => false });
  await relay.start();
  try {
    registrarJevDoProjeto(PID, true);
    definirElencoProjeto(() => [{ agentId: "agent_pm", name: "PM", role: "coordenação" }, { agentId: "agent_web", name: "WEB", role: "web/**" }]);
    _resetTaskShadowForTest();
    chamadas = 0;

    // 1) 2xx → dispara, com o task da RESPOSTA (não do request).
    assert.equal(await post(relay, AG, "tasks_add", { title: "do request", description: "desc" }), 200);
    flushTaskShadowDebounceForTests();
    await settleTaskShadowForTests();
    assert.equal(chamadas, 1, "resposta 2xx dispara a sombra");

    // 2) status-only não dispara.
    assert.equal(await post(relay, AG, "tasks_update", { id: "task_relay", status: "doing" }), 200);
    flushTaskShadowDebounceForTests();
    await settleTaskShadowForTests();
    assert.equal(chamadas, 1, "status-only fica de fora");

    // 3) edited dispara de novo (título mudou no upstream).
    assert.equal(await post(relay, AG, "tasks_update", { id: "task_relay", title: "novo" }), 200);
    flushTaskShadowDebounceForTests();
    await settleTaskShadowForTests();
    assert.equal(chamadas, 1, "mesmo hash não reposta");

    // 4) erro do server (500) não dispara.
    status = 500;
    assert.equal(await post(relay, AG, "tasks_add", { title: "x", description: "y" }), 500);
    flushTaskShadowDebounceForTests();
    await settleTaskShadowForTests();
    assert.equal(chamadas, 1, "sem 2xx, sem sombra");

    // 5) projeto sem Jev não dispara.
    status = 200;
    registrarJevDoProjeto(PID, false);
    assert.equal(await post(relay, AG, "tasks_add", { title: "z", description: "w" }), 200);
    flushTaskShadowDebounceForTests();
    await settleTaskShadowForTests();
    assert.equal(chamadas, 1, "Jev desligado no projeto");
  } finally {
    relay.stop();
    upstream.close();
  }
});