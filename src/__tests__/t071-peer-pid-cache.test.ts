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
  readParentPidCached,
  registerAgentPid,
  resetParentPidCache,
  setParentPidReader,
  setUnixPeerPidReader,
  unregisterAgentPid,
} from "../privileges.js";

afterEach(() => {
  clearAgentPidRegistry();
  setParentPidReader(null);
  setUnixPeerPidReader(null);
  resetParentPidCache();
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

test("T-071 A6: p50 requests 2..N na mesma conexão (python3 real) < budget derivado do cold start (T-242/T-569)", async () => {
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  registerAgentPid("ag_bench", process.pid);
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null);
  await relay.start();
  assert.equal(relay.peerPidEnforced, true, "self-test python3 deve passar neste host");
  const sock = await connectUnix(relay.socketPath);
  const samples: number[] = [];
  try {
    // T-569: janela maior que a original (12) — o p50 sai de 20 amostras em vez
    // de 11, então um único request patológico não decide a mediana.
    const n = 21;
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
    // T-242: budget <5ms media ruído de scheduler do host sob a suíte paralela
    // (probes PG + outros arquivos de teste): p50 isolado 1,0–1,9ms, mas 5,19–43,8ms
    // com carga (3 flakes seguidos na QA: T-233/T-188/T-240).
    //
    // T-569: o teto FIXO de 50ms perdeu a margem real. Medido no CI (run
    // 35124375568, head 146f017): p50 = 54,69ms com first = 204,32ms — o ruído
    // do host não cabe num número fixo. O teto passa a ser PROPORCIONAL ao cold
    // start desta própria execução (o `first` paga spawn de python3 + walk de
    // ppid, e é medido sob a MESMA carga): mesma classe do T-599, arquivo outro.
    //
    // O fator 0,6 separa "cache pagando" de "cache quebrado", com números
    // medidos dos dois lados:
    //   - cache ON, pior caso conhecido (CI acima): med/first = 0,27 → 2,2x de folga
    //   - cache OFF (medido neste host, T-569): med = 518ms vs first = 606ms → 0,86
    // A asserção funcional NÃO afrouxa: com o cache desligado a mediana encosta
    // no cold start e reprova (518ms > 364ms). O piso de 50ms é o budget do
    // T-242, e só passa a valer em host ocioso (first < 84ms).
    const FLOOR_MS = 50;
    const RATIO_DO_COLD_START = 0.6;
    const budget = Math.max(FLOOR_MS, first * RATIO_DO_COLD_START);
    assert.ok(
      med < budget,
      `p50 requests 2..N = ${med.toFixed(2)}ms, esperado < ${budget.toFixed(2)}ms ` +
      `(budget = max(${FLOOR_MS}ms, first*${RATIO_DO_COLD_START}), first=${first.toFixed(2)}ms)`,
    );
    // Asserção funcional explícita: as requests em cache têm de ser mais baratas
    // que a 1ª (que paga o spawn). Com o cache desligado as duas se igualam.
    assert.ok(
      med < first,
      `p50 requests 2..N = ${med.toFixed(2)}ms tem de ser < 1ª request = ${first.toFixed(2)}ms ` +
      `(a 1ª paga o spawn do python3; o cache tem de tirar esse custo do caminho)`,
    );
  } finally {
    sock.destroy();
    relay.stop();
    await orch.close();
  }
});

/*
 * T-592: o 403 em rajada. O leitor de peer-pid (spawn de processo) estoura o
 * timeout sob carga e o walk de ppid pode truncar num hop; nenhum dos dois
 * pode ser cacheado como fato definitivo da conexão. Medido em produção
 * (T-578/T-592): 7/12 curls em 403, 5/5 em conexões novas, sem mudança de
 * código entre as medições.
 */

test("T-592 A5: leitor devolve null na 1ª request → 2ª request na MESMA conexão = 200 (null não fica cacheado)", async () => {
  let peerCalls = 0;
  registerAgentPid("ag_a", 100);
  // 3 primeiras chamadas = as 3 tentativas da 1ª request (spawn estourou).
  setUnixPeerPidReader(() => {
    peerCalls++;
    return peerCalls <= 3 ? null : 300;
  });
  setParentPidReader((pid) => ({ 300: 200, 200: 100, 100: 1 } as Record<number, number>)[pid] ?? 0);
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null, undefined, { peerPidSelfTest: async () => true });
  await relay.start();
  const sock = await connectUnix(relay.socketPath);
  try {
    const r1 = await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list");
    assert.equal(r1.status, 403, "1ª request com o leitor falho");
    const r2 = await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list");
    assert.equal(r2.status, 200, "2ª request na MESMA conexão tem de re-perguntar ao SO");
    assert.equal(peerCalls, 4, "3 tentativas na 1ª request + 1 na 2ª");
  } finally {
    sock.destroy();
    relay.stop();
    await orch.close();
  }
});

test("T-592 A7: falha isolada do leitor (null 1×) resolve na MESMA request — sem 403 e sem perder o cache", async () => {
  let peerCalls = 0;
  registerAgentPid("ag_a", 100);
  setUnixPeerPidReader(() => {
    peerCalls++;
    return peerCalls === 1 ? null : 300;
  });
  setParentPidReader((pid) => ({ 300: 200, 200: 100, 100: 1 } as Record<number, number>)[pid] ?? 0);
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null, undefined, { peerPidSelfTest: async () => true });
  await relay.start();
  const sock = await connectUnix(relay.socketPath);
  try {
    assert.equal((await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list")).status, 200);
    assert.equal(peerCalls, 2, "1 falha + 1 sucesso na mesma request");
    // Cache preservado: a 2ª request não volta a spawnar (T-071 A1).
    assert.equal((await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list")).status, 200);
    assert.equal(peerCalls, 2, "peerPid resolvido tem de ficar cacheado na conexão");
  } finally {
    sock.destroy();
    relay.stop();
    await orch.close();
  }
});

test("T-592 A8: hop ilegível não congela walk truncado — cadeia é refeita até resolver", async () => {
  const parentCalls = new Map<number, number>();
  let peerCalls = 0;
  registerAgentPid("ag_a", 100);
  setUnixPeerPidReader(() => { peerCalls++; return 300; });
  setParentPidReader((pid) => {
    const n = (parentCalls.get(pid) ?? 0) + 1;
    parentCalls.set(pid, n);
    if (pid === 300 && n === 1) return null; // 1º hop do walk estoura (ps timeout)
    return ({ 300: 200, 200: 100, 100: 1 } as Record<number, number>)[pid] ?? 0;
  });
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null, undefined, { peerPidSelfTest: async () => true });
  await relay.start();
  const sock = await connectUnix(relay.socketPath);
  try {
    assert.equal(
      (await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list")).status,
      200,
      "walk truncado tem de ser refeito, não virar 403",
    );
    assert.equal(parentCalls.get(300), 2, "hop ilegível tem de ser re-lido");
    assert.equal(peerCalls, 1, "peerPid não tem de ser re-lido por causa do walk");
    // Cadeia completa agora: request seguinte não re-walka.
    assert.equal((await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list")).status, 200);
    assert.equal(parentCalls.get(300), 2, "walk resolvido tem de ficar cacheado na conexão");
  } finally {
    sock.destroy();
    relay.stop();
    await orch.close();
  }
});

test("T-592 A10: hop que falhou NÃO fica no cache de ppid — o retry relê o SO de verdade", async () => {
  /*
   * A5/A8 injetam o reader de ppid, e por isso passam POR CIMA do cache de
   * ppid. Este é o teste que fecha o furo: o reader aqui é o caminho real
   * (`readParentPidCached`) com um `ps` que estoura 1×, que é o que acontece
   * no host sob carga. Com o null cacheado, as 3 tentativas da mesma request
   * leriam o mesmo null e o 403 voltaria a ser permanente.
   */
  resetParentPidCache();
  const inner = new Map<number, number>();
  let peerCalls = 0;
  registerAgentPid("ag_a", 100);
  setUnixPeerPidReader(() => { peerCalls++; return 300; });
  setParentPidReader((pid) => readParentPidCached(pid, (p) => {
    const n = (inner.get(p) ?? 0) + 1;
    inner.set(p, n);
    if (p === 300 && n === 1) return null; // `ps` estourou no 1º hop
    return ({ 300: 200, 200: 100, 100: 1 } as Record<number, number>)[p] ?? 0;
  }));
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null, undefined, { peerPidSelfTest: async () => true });
  await relay.start();
  const sock = await connectUnix(relay.socketPath);
  try {
    assert.equal(
      (await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list")).status,
      200,
      "1 hop ilegível não pode virar 403 na request",
    );
    assert.equal(inner.get(300), 2, "a falha não pode ter ficado no cache de ppid");
    assert.equal(peerCalls, 1, "peerPid não tem de ser re-lido por causa do walk");
    assert.equal((await httpGetKeepAlive(sock, "/api/bridge/ag_a/tasks_list")).status, 200);
    assert.equal(inner.get(300), 2, "cadeia resolvida tem de ficar cacheada (T-071 A1)");
  } finally {
    sock.destroy();
    relay.stop();
    await orch.close();
  }
});

test("T-569: self-test do peer-pid RETENTA — fail-closed só depois de esgotar as tentativas", async () => {
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  // Simula o pico transitório medido: sob load ~40 num host de 18 cpus o
  // `connection` do self-test de boot não chegou dentro do teto e o caso A6
  // durou 1620ms. Aqui o host "não consegue" resolver o peer nas 2 primeiras
  // tentativas e consegue na 3ª. Antes do fix (T-569) a 1ª falha já era
  // DEFINITIVA: peerPidEnforced ficava false e o relay respondia 503 em toda
  // request até restart.
  let tentativas = 0;
  setUnixPeerPidReader(() => (++tentativas < 3 ? null : process.pid));
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null);
  await relay.start();
  try {
    assert.equal(tentativas, 3, "o self-test tem de ter retentado até conseguir");
    assert.equal(relay.peerPidEnforced, true, "3ª tentativa tem de valer (não é fail-closed)");
  } finally {
    relay.stop();
    await orch.close();
  }
});

test("T-569: self-test que falha em TODAS as tentativas continua fail-closed", async () => {
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  let tentativas = 0;
  setUnixPeerPidReader(() => { tentativas++; return null; });
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null);
  await relay.start();
  const sock = await connectUnix(relay.socketPath);
  try {
    assert.equal(tentativas, 3, "esgotar as tentativas (3) antes de desistir");
    assert.equal(relay.peerPidEnforced, false);
    // Fail-CLOSED preservado: sem INSECURE, request não-verificável é 503.
    assert.equal((await httpGetKeepAlive(sock, "/api/bridge/ag_x/tasks_list")).status, 503);
  } finally {
    sock.destroy();
    relay.stop();
    await orch.close();
  }
});
