import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { BridgeRelay } from "../bridge-relay.js";

test("T-1300: relay blocks member side effects before upstream and preserves owner routing", async (t) => {
  const previousOverride = process.env.THE_DUDES_PEER_PID_INSECURE;
  process.env.THE_DUDES_PEER_PID_INSECURE = "1";
  t.after(() => {
    if (previousOverride === undefined) delete process.env.THE_DUDES_PEER_PID_INSECURE;
    else process.env.THE_DUDES_PEER_PID_INSECURE = previousOverride;
  });

  const upstreamRequests: string[] = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      upstreamRequests.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const port = (upstream.address() as { port: number }).port;

  let ownerTurn: boolean | undefined = false;
  const relay = new BridgeRelay(`http://127.0.0.1:${port}`, null, undefined, {
    peerPidSelfTest: async () => false,
    agentOwnerTurnLookup: () => ownerTurn,
  });
  await relay.start();
  t.after(() => relay.stop());

  const post = (op: string) => new Promise<number>((resolve, reject) => {
    const body = "{}";
    const req = http.request({
      socketPath: relay.socketPath,
      method: "POST",
      path: `/api/bridge/agent-a/${op}`,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });

  assert.equal(await post("send_webhook"), 403);
  assert.equal(await post("permission"), 403, "membro não pode converter aprovação em autorização do dono");
  assert.deepEqual(upstreamRequests, [], "operação de risco não chega ao server");
  assert.equal(await post("tasks_list"), 200);
  assert.deepEqual(upstreamRequests, ["/api/bridge/agent-a/tasks_list"], "operação de leitura passa");

  ownerTurn = true;
  assert.equal(await post("tasks_add"), 200);
  assert.equal(await post("permission"), 200, "turno do dono ainda pode usar a rota de aprovação");
  assert.deepEqual(upstreamRequests, [
    "/api/bridge/agent-a/tasks_list",
    "/api/bridge/agent-a/tasks_add",
    "/api/bridge/agent-a/permission",
  ], "turno do dono mantém a política server-side existente");
});
