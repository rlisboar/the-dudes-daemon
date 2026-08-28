/**
 * T-071: cache de fatos do SO (peer pid + cadeia ppid) por conexão Unix
 * no BridgeRelay. Autorização continua no registro a cada request.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { BridgeRelay } from "../bridge-relay.js";
import {
  clearAgentPidRegistry,
  registerAgentPid,
  setParentPidReader,
  setUnixPeerPidReader,
  unregisterAgentPid,
} from "../privileges.js";

afterEach(() => {
  clearAgentPidRegistry();
  setParentPidReader(null);
  setUnixPeerPidReader(null);
});

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

function connectUnix(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

function httpGetKeepAlive(sock: net.Socket, urlPath: string): Promise<{ status: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null, status = 0, ms = 0) => {
      if (settled) return;
      settled = true;
      sock.off("data", onData);
      sock.off("error", onErr);
      if (err) reject(err);
      else resolve({ status, ms });
    };
    const onErr = (e: Error) => finish(e);
    const onData = (c: Buffer) => {
      chunks.push(c);
      const buf = Buffer.concat(chunks);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = buf.subarray(0, sep).toString("latin1");
      const m = /content-length:\s*(\d+)/i.exec(header);
      const len = m ? Number(m[1]) : 0;
      if (buf.length < sep + 4 + len) return;
      const status = Number(header.split(" ")[1]);
      finish(null, status, performance.now() - t0);
    };
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.write(`GET ${urlPath} HTTP/1.1\r\nHost: bridge\r\nConnection: keep-alive\r\n\r\n`);
  });
}

function p50(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * 0.5)]!;
}

test("T-071 A1: ≥3 requests na mesma conexão → peerPidReader 1×, parentPidReader ≤1×/pid", async () => {
  const parentCalls = new Map<number, number>();
  let peerCalls = 0;
  registerAgentPid("ag_a", 100);
  setUnixPeerPidReader(() => {
    peerCalls++;
    return 300;
  });
  setParentPidReader((pid) => {
    parentCalls.set(pid, (parentCalls.get(pid) ?? 0) + 1);
    return ({ 300: 200, 200: 100, 100: 1 } as Record<number, number>)[pid] ?? 0;
  });
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null, undefined, { peerPidSelfTest: async () => true });
  await relay.start();
  const sock = await connectUnix(relay.socketPath);
  try {
    for (let i = 0; i < 3; i++) {
      const r = await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list");
      assert.equal(r.status, 200, `request ${i + 1}`);
    }
    assert.equal(peerCalls, 1, "peerPidReader deve ser 1× na conexão keep-alive");
    assert.ok(parentCalls.size > 0, "parentPidReader deve ter sido usado na 1ª resolução");
    for (const [pid, n] of parentCalls) {
      assert.ok(n <= 1, `parentPidReader(pid=${pid}) = ${n}, esperado ≤1`);
    }
  } finally {
    sock.destroy();
    relay.stop();
    await orch.close();
  }
});

test("T-071 A2: 2 conexões distintas → 2 resoluções de peer independentes", async () => {
  let peerCalls = 0;
  registerAgentPid("ag_a", 4242);
  setUnixPeerPidReader(() => {
    peerCalls++;
    return 4242;
  });
  setParentPidReader(() => 1);
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null, undefined, { peerPidSelfTest: async () => true });
  await relay.start();
  const a = await connectUnix(relay.socketPath);
  const b = await connectUnix(relay.socketPath);
  try {
    assert.equal((await httpGetKeepAlive(a, "/api/bridge/ag_a/tasks_list")).status, 200);
    assert.equal((await httpGetKeepAlive(b, "/api/bridge/ag_a/tasks_list")).status, 200);
    assert.equal(peerCalls, 2);
  } finally {
    a.destroy();
    b.destroy();
    relay.stop();
    await orch.close();
  }
});

test("T-071 A3: close da conexão libera a entrada do cache", async () => {
  registerAgentPid("ag_a", 7);
  setUnixPeerPidReader(() => 7);
  setParentPidReader(() => 1);
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null, undefined, { peerPidSelfTest: async () => true });
  await relay.start();
  const sock = await connectUnix(relay.socketPath);
  try {
    assert.equal((await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list")).status, 200);
    assert.equal(relay.unixPeerOsCacheSize(), 1);
    await new Promise<void>((resolve) => {
      sock.once("close", () => resolve());
      sock.destroy();
    });
    // Map é chaveado pelo socket do servidor; close do cliente não é síncrono.
    const deadline = Date.now() + 1500;
    while (relay.unixPeerOsCacheSize() !== 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(relay.unixPeerOsCacheSize(), 0);
  } finally {
    relay.stop();
    await orch.close();
  }
});

test("T-071 A4: unregisterAgentPid após 1º request → 2º na mesma conexão = 403", async () => {
  registerAgentPid("ag_a", 9001);
  setUnixPeerPidReader(() => 9001);
  setParentPidReader(() => 1);
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null, undefined, { peerPidSelfTest: async () => true });
  await relay.start();
  const sock = await connectUnix(relay.socketPath);
  try {
    assert.equal((await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list")).status, 200);
    unregisterAgentPid(9001);
    assert.equal((await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list")).status, 403);
  } finally {
    sock.destroy();
    relay.stop();
    await orch.close();
  }
});

test("T-071 A6: p50 requests 2..N na mesma conexão (python3 real) < 5ms", async () => {
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  registerAgentPid("ag_bench", process.pid);
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null);
  await relay.start();
  assert.equal(relay.peerPidEnforced, true, "self-test python3 deve passar neste host");
  const sock = await connectUnix(relay.socketPath);
  const samples: number[] = [];
  try {
    const n = 12;
    for (let i = 0; i < n; i++) {
      const r = await httpGetKeepAlive(sock, "/api/bridge/ag_bench/tasks_list");
      assert.equal(r.status, 200, `request ${i + 1} status`);
      samples.push(r.ms);
    }
    const rest = samples.slice(1);
    const first = samples[0]!;
    const med = p50(rest);
    console.log(
      `T-071 A6 medição: first=${first.toFixed(2)}ms p50(2..${n})=${med.toFixed(2)}ms ` +
      `rest=[${rest.map((x) => x.toFixed(1)).join(", ")}]`,
    );
    assert.ok(med < 5, `p50 requests 2..N = ${med.toFixed(2)}ms, esperado < 5ms (first=${first.toFixed(2)}ms)`);
  } finally {
    sock.destroy();
    relay.stop();
    await orch.close();
  }
});
