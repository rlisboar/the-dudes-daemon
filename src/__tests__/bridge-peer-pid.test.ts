import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { BridgeRelay } from "../bridge-relay.js";
import {
  clearAgentPidRegistry,
  getParentPid,
  getUnixPeerPid,
  readParentPidCached,
  registerAgentPid,
  resetParentPidCache,
  resolveAgentIdFromPid,
  setParentPidReader,
  setUnixPeerPidReader,
  spawnDropped,
  unregisterAgentPid,
} from "../privileges.js";
import { RunnerRuntimeFiles } from "../runners/runtime-files.js";

afterEach(() => {
  clearAgentPidRegistry();
  setParentPidReader(null);
  setUnixPeerPidReader(null);
});

function unixStatus(socketPath: string, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

test("T-061: resolveAgentIdFromPid sobe a cadeia de pais", () => {
  registerAgentPid("ag_a", 100);
  setParentPidReader((pid) => ({ 300: 200, 200: 100, 100: 1 }[pid] ?? 0));
  assert.equal(resolveAgentIdFromPid(300), "ag_a");
  assert.equal(resolveAgentIdFromPid(200), "ag_a");
  assert.equal(resolveAgentIdFromPid(100), "ag_a");
  assert.equal(resolveAgentIdFromPid(50), null);
});

test("T-061: spawnDropped registra THE_DUDES_AGENT_ID; bindProcess também", () => {
  const child = spawnDropped(
    process.execPath,
    ["-e", "setInterval(()=>{}, 1000)"],
    { env: { ...process.env, THE_DUDES_AGENT_ID: "ag_spawn" }, stdio: "ignore" },
    null,
  );
  assert.ok(child.pid);
  assert.equal(resolveAgentIdFromPid(child.pid!), "ag_spawn");
  child.kill();
  const files = new RunnerRuntimeFiles({
    workspaceRoot: process.cwd(),
    agentId: "ag_bound",
    agentToken: "tok",
  });
  files.bindProcess(5555);
  assert.equal(resolveAgentIdFromPid(5555), "ag_bound");
  files.cleanup();
});

test("T-061: self-test passa → enforce", async () => {
  const on = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
    peerPidSelfTest: async () => true,
  });
  await on.start();
  try {
    assert.equal(on.peerPidEnforced, true);
    assert.equal(on.peerPidAllowInsecure, false);
  } finally {
    on.stop();
  }
});

test("T-093: self-test falha → fail-CLOSED, conexão RECUSADA (503) + log acionável", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(String(args[0])); };
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  try {
    const off = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
      peerPidSelfTest: async () => false,
    });
    await off.start();
    try {
      assert.equal(off.peerPidEnforced, false);
      assert.equal(off.peerPidAllowInsecure, false);
      assert.ok(logs.some((l) => l.includes("fail-CLOSED")));
      assert.ok(logs.some((l) => l.includes("python3")));
      assert.equal(await unixStatus(off.socketPath, "/api/bridge/ag_x/tasks_list"), 503);
      assert.ok(logs.some((l) => l.includes("refusing unverifiable")));
    } finally {
      off.stop();
    }
  } finally {
    console.error = orig;
  }
});

test("T-093: self-test throw → fail-CLOSED (não fail-OPEN)", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(String(args[0])); };
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  try {
    const boom = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
      peerPidSelfTest: async () => { throw new Error("no python3"); },
    });
    await boom.start();
    try {
      assert.equal(boom.peerPidEnforced, false);
      assert.equal(boom.peerPidAllowInsecure, false);
      assert.equal(await unixStatus(boom.socketPath, "/api/bridge/ag_x/tasks_list"), 503);
      assert.ok(logs.some((l) => l.includes("fail-CLOSED")));
    } finally {
      boom.stop();
    }
  } finally {
    console.error = orig;
  }
});

test("T-093: THE_DUDES_PEER_PID_INSECURE=1 → aceita + loga downgrade por conexão", async () => {
  const logs: string[] = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => { logs.push(String(args[0])); };
  console.warn = (...args: unknown[]) => { logs.push(String(args[0])); };
  const prev = process.env.THE_DUDES_PEER_PID_INSECURE;
  process.env.THE_DUDES_PEER_PID_INSECURE = "1";
  try {
    const insecure = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
      peerPidSelfTest: async () => false,
    });
    await insecure.start();
    try {
      assert.equal(insecure.peerPidEnforced, false);
      assert.equal(insecure.peerPidAllowInsecure, true);
      assert.ok(logs.some((l) => l.includes("INSECURE override")));
      // Aceita o handle (não 503): orch fake → 502 no fetch.
      assert.equal(await unixStatus(insecure.socketPath, "/api/bridge/ag_x/tasks_list"), 502);
      assert.ok(logs.some((l) => l.includes("accepting unverifiable")));
    } finally {
      insecure.stop();
    }
  } finally {
    console.error = origErr;
    console.warn = origWarn;
    if (prev === undefined) delete process.env.THE_DUDES_PEER_PID_INSECURE;
    else process.env.THE_DUDES_PEER_PID_INSECURE = prev;
  }
});

test("T-093: self-test real no host (python3) → enforce", async () => {
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  const relay = new BridgeRelay("http://127.0.0.1:9", null);
  await relay.start();
  try {
    assert.equal(
      relay.peerPidEnforced,
      true,
      "host deve passar o self-test peer-pid (python3 ctypes/getsockopt)",
    );
  } finally {
    relay.stop();
  }
});

/*
 * T-592: o leitor default de peer-pid e a cadeia de ppid eram o gargalo real
 * do 403 em rajada. Medido neste host com load ~80: `/usr/bin/python3` (stub
 * do CommandLineTools, re-executa) levava 2,0–3,8s por spawn contra timeout de
 * 800ms — a resolução devolvia null SEMPRE. `/usr/bin/perl` faz o mesmo
 * getsockopt em ~66ms. Estes dois testes medem o caminho real, sem injeção.
 */

test("T-592: leitor default resolve o peer pid real do host (perl) dentro do timeout", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t592-peer-"));
  const sockPath = path.join(dir, "s.sock");
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(sockPath, resolve));
  const accepted = new Promise<net.Socket>((resolve) => srv.once("connection", resolve));
  const client = net.connect(sockPath);
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  const serverSock = await accepted;
  try {
    const t0 = performance.now();
    const pid = getUnixPeerPid(serverSock);
    const ms = performance.now() - t0;
    console.log(`T-592 leitor default: ${ms.toFixed(1)}ms pid=${pid} esperado=${process.pid}`);
    assert.equal(pid, process.pid, "leitor default tem de resolver o pid do peer");
    assert.ok(ms < 1500, `resolução levou ${ms.toFixed(1)}ms — o timeout antigo era 800ms`);
  } finally {
    client.destroy();
    serverSock.destroy();
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-592: ppid do host é lido corretamente e o cache curto devolve o mesmo valor", () => {
  resetParentPidCache();
  const want = Number(
    execFileSync("ps", ["-p", String(process.pid), "-o", "ppid="], { encoding: "utf8" }).trim(),
  );
  assert.equal(getParentPid(process.pid), want);
  assert.equal(getParentPid(process.pid), want, "2ª leitura vem do cache (sem novo spawn)");
});

/*
 * T-592: a política de cache do ppid. Os testes de relay injetam o reader e
 * por isso NÃO passam pelo cache — sem este teste, guardar um ppid null no
 * cache (o bug) ficava invisível: as tentativas da mesma request leriam todas
 * o mesmo null e o walk nunca seria refeito no host.
 */
test("T-592 A9: ppid que FALHOU não entra no cache; ppid resolvido entra", () => {
  resetParentPidCache();
  let falhas = 0;
  const estoura: (pid: number) => number | null = () => { falhas++; return null; };
  assert.equal(readParentPidCached(4242, estoura), null);
  assert.equal(readParentPidCached(4242, estoura), null);
  assert.equal(falhas, 2, "null cacheado faria a 2ª tentativa reler o mesmo null do cache");

  let oks = 0;
  const resolve: (pid: number) => number | null = () => { oks++; return 111; };
  assert.equal(readParentPidCached(4243, resolve), 111);
  assert.equal(readParentPidCached(4243, resolve), 111);
  assert.equal(oks, 1, "ppid resolvido tem de vir do cache (T-071: sem 1 spawn por request)");

  // Um pid que passa a resolver sai do estado "falhou" na leitura seguinte.
  let n = 0;
  const instavel: (pid: number) => number | null = () => (++n === 1 ? null : 222);
  assert.equal(readParentPidCached(4244, instavel), null);
  assert.equal(readParentPidCached(4244, instavel), 222);
  assert.equal(readParentPidCached(4244, instavel), 222, "agora sim, cacheado");
  assert.equal(n, 2);
  resetParentPidCache();
});

test("T-592: re-spawn do CLI não derruba o pid antigo enquanto ele vive (bridge do CLI antigo continua resolvendo)", () => {
  registerAgentPid("ag_x", 111); // CLI antigo, vivo e ainda servindo o bridge
  setParentPidReader((pid) => (pid === 900 ? 111 : 0)); // bridge 900 → CLI antigo
  assert.equal(resolveAgentIdFromPid(900), "ag_x");

  registerAgentPid("ag_x", 222); // hard recover: CLI NOVO para o MESMO agente
  assert.equal(resolveAgentIdFromPid(222), "ag_x");
  assert.equal(resolveAgentIdFromPid(900), "ag_x", "pid do CLI antigo continua no registro");

  unregisterAgentPid(222); // o CLI novo sai: não pode levar o antigo junto
  assert.equal(resolveAgentIdFromPid(900), "ag_x");
});

test("T-061: caminho feliz — agentId da URL ≠ peer → 403", async () => {
  registerAgentPid("ag_victim", 4242);
  registerAgentPid("ag_thief", 7777);
  setUnixPeerPidReader(() => 7777);
  setParentPidReader(() => 1);
  const relay = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
    peerPidSelfTest: async () => true,
  });
  await relay.start();
  try {
    assert.equal(await unixStatus(relay.socketPath, "/api/bridge/ag_victim/tasks_list"), 403);
    assert.equal(await unixStatus(relay.socketPath, "/api/bridge/ag_thief/get_credential"), 502);
  } finally {
    relay.stop();
  }
});
