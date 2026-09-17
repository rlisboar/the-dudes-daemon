/**
 * T-604: `THE_DUDES_PEER_PID_INSECURE=1` volta a ser um downgrade EXPLÍCITO.
 *
 * Antes: `peerPidAllowInsecure = !ok && env` — o env só valia se o self-test
 * FALHASSE. A T-592 subiu o teto do self-test (1500 -> 4500ms) e pôs o leitor
 * perl antes do python3; o self-test passou a PASSAR em CI, o enforcement
 * ligava, o fixture do T-135 perdia o downgrade e o playwright — IRMÃO do
 * daemon (o globalSetup spawna o daemon), não filho — levava 403 na sonda.
 *
 * Contrato provado aqui:
 *  C1. env setado + self-test PASSANDO => downgrade (enforced=false,
 *      allowInsecure=true) e peer fora da cadeia ACEITO (200).
 *  C2. contraprova: env AUSENTE + self-test passando => enforced=true e peer
 *      fora da cadeia = 403 "bridge peer does not match agent".
 *  C3. regressão: env AUSENTE + self-test FALHANDO => 503 fail-CLOSED, e só
 *      depois de esgotar as 3 tentativas.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BridgeRelay } from "../bridge-relay.js";
import {
  clearAgentPidRegistry,
  registerAgentPid,
  setParentPidReader,
  setUnixPeerPidReader,
} from "../privileges.js";

const ENV = "THE_DUDES_PEER_PID_INSECURE";

function restoreEnv(prev: string | undefined): void {
  if (prev === undefined) delete process.env[ENV];
  else process.env[ENV] = prev;
}

afterEach(() => {
  clearAgentPidRegistry();
  setParentPidReader(null);
  setUnixPeerPidReader(null);
});

/** Upstream fake: sempre 200 `{}` — quem responde 403/503 é o relay. */
async function listenOrch(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((_req, res) => {
    const body = Buffer.from("{}", "utf8");
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

function unixRequest(socketPath: string, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

function captureLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => { logs.push(String(args[0])); };
  console.warn = (...args: unknown[]) => { logs.push(String(args[0])); };
  return {
    logs,
    restore: () => { console.error = origErr; console.warn = origWarn; },
  };
}

test("T-604 C1: env=1 + self-test PASSANDO => downgrade explícito; peer fora da cadeia ACEITO (200)", async () => {
  const prev = process.env[ENV];
  process.env[ENV] = "1";
  const cap = captureLogs();
  // Peer 4242 não é filho de nenhum agente registrado: sob enforcement daria 403.
  registerAgentPid("ag_outro", 999_999);
  setUnixPeerPidReader(() => 4242);
  setParentPidReader(() => 1);
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null, undefined, {
    // O ponto do card: o self-test PASSA (o caso que o CI virou depois da T-592).
    peerPidSelfTest: async () => true,
  });
  await relay.start();
  try {
    assert.equal(relay.peerPidEnforced, false, "env setado => enforcement desligado mesmo com self-test ok");
    assert.equal(relay.peerPidAllowInsecure, true, "env setado => downgrade explícito");
    assert.ok(
      cap.logs.some((l) => l.includes("INSECURE override")),
      "o downgrade tem que ser logado (é o que a prova do T-135 procura no daemon.log)",
    );
    const r = await unixRequest(relay.socketPath, "/api/bridge/ag_x/tasks_list");
    assert.equal(r.status, 200, `peer fora da cadeia deve ser ACEITO com o env setado (body=${r.body})`);
    assert.ok(
      cap.logs.some((l) => l.includes("accepting unverifiable")),
      "log por conexão do downgrade",
    );
  } finally {
    relay.stop();
    await orch.close();
    cap.restore();
    restoreEnv(prev);
  }
});

test("T-604 C2 (contraprova): env AUSENTE + self-test passando => enforce; peer fora da cadeia = 403", async () => {
  const prev = process.env[ENV];
  delete process.env[ENV];
  registerAgentPid("ag_outro", 999_999);
  setUnixPeerPidReader(() => 4242);
  setParentPidReader(() => 1);
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null, undefined, { peerPidSelfTest: async () => true });
  await relay.start();
  try {
    assert.equal(relay.peerPidEnforced, true, "sem env, self-test ok => enforcement");
    assert.equal(relay.peerPidAllowInsecure, false);
    const r = await unixRequest(relay.socketPath, "/api/bridge/ag_x/tasks_list");
    assert.equal(r.status, 403);
    assert.match(r.body, /bridge peer does not match agent/);
  } finally {
    relay.stop();
    await orch.close();
    restoreEnv(prev);
  }
});

test("T-604 C3 (regressão): env AUSENTE + self-test FALHANDO => 503 fail-CLOSED só após esgotar as 3 tentativas", async () => {
  const prev = process.env[ENV];
  delete process.env[ENV];
  const cap = captureLogs();
  // Self-test REAL (defaultPeerPidSelfTest) forçado a falhar: o peer lido nunca
  // é o próprio pid, então cada tentativa fecha em false. O contador prova que
  // o fail-CLOSED só vale DEPOIS das 3 tentativas (T-569).
  let leituras = 0;
  setUnixPeerPidReader(() => {
    leituras++;
    return process.pid + 1;
  });
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null);
  await relay.start();
  try {
    assert.equal(leituras, 3, `self-test deve tentar 3× antes de desistir (leituras=${leituras})`);
    assert.equal(relay.peerPidEnforced, false);
    assert.equal(relay.peerPidAllowInsecure, false);
    assert.ok(cap.logs.some((l) => l.includes("fail-CLOSED")), "log acionável do fail-CLOSED");
    const r = await unixRequest(relay.socketPath, "/api/bridge/ag_x/tasks_list");
    assert.equal(r.status, 503);
    assert.match(r.body, /THE_DUDES_PEER_PID_INSECURE=1/);
  } finally {
    relay.stop();
    await orch.close();
    cap.restore();
    restoreEnv(prev);
  }
});