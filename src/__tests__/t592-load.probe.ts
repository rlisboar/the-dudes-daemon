/**
 * T-592 — PROVA SOB CARGA (o host ocioso não é o cenário real).
 *
 * Contexto (PM, 2026-09-16T09:46Z): o unblock matou 31 turnos abandonados e o
 * python3 caiu de 2,2s para 0,3s. Medir "200" com o host assim e dar por bom
 * não cobre o cenário que produzia o 403 em rajada — o host VOLTA a carregar
 * enquanto os turnos abandonados se acumulam (T-593).
 *
 * Este probe:
 *   1. gera carga sintética reproduzível (N processos queimando CPU);
 *   2. mede o leitor REAL de peer-pid (perl, o caminho novo) sob essa carga;
 *   3. mede o caminho ANTIGO (python3 com timeout de 800ms) sob a MESMA carga,
 *      para mostrar que ele é que falhava — não o perl;
 *   4. sobe o BridgeRelay real (reader real, self-test real, enforcement on) e
 *      dispara o critério do PM: 30 requests na MESMA conexão + 30 conexões
 *      novas, contando 200/403/503.
 *
 * Uso:  node --import tsx src/__tests__/t592-load.probe.ts [nBurners]
 * Env:  PROBE_BURNERS (default 90), PROBE_ORPHAN_PCT (default 0 = sem injeção)
 *
 * Não é `*.test.ts` de propósito: gera carga e leva ~1min — na suíte do CI
 * atrapalharia os testes de timing do resto do daemon.
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { BridgeRelay } from "../bridge-relay.js";
import { clearAgentPidRegistry, getUnixPeerPid, registerAgentPid, unixSocketFd } from "../privileges.js";

const BURNERS = Number(process.argv[2] ?? process.env.PROBE_BURNERS ?? 90);
const AGENT = "ag_probe";
const N_SAME_CONN = 30;
const N_NEW_CONN = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pctl(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!;
}

const burners: ReturnType<typeof spawn>[] = [];
function startLoad(n: number): void {
  for (let i = 0; i < n; i++) {
    // `yes` em stdout ignorado: 100% CPU em write syscall, sem startup de node
    // (o objetivo é load average alto e reprodutível, não um perfil exato).
    burners.push(spawn("yes", [], { stdio: ["ignore", "ignore", "ignore"] }));
  }
}
function stopLoad(): void {
  for (const b of burners) { try { b.kill("SIGKILL"); } catch { /* */ } }
  burners.length = 0;
}
process.on("exit", stopLoad);

/** Script do caminho ANTIGO (privileges.ts, pré-T-592): só python3, teto 800ms. */
const PY_SCRIPT = [
  "import ctypes,sys",
  "fd=3",
  "libc=ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
  "pid=ctypes.c_int(0)",
  "sz=ctypes.c_uint32(4)",
  "r=libc.getsockopt(fd,0,2,ctypes.byref(pid),ctypes.byref(sz))",
  "sys.exit(1) if r!=0 else print(pid.value)",
].join(";");

type LegacySample = { ms: number; ok: boolean; err: string };

function legacyPythonReader(sock: object): LegacySample {
  const fd = unixSocketFd(sock);
  const t0 = performance.now();
  const out = spawnSync("/usr/bin/python3", ["-c", PY_SCRIPT], {
    encoding: "utf8", timeout: 800, stdio: ["ignore", "pipe", "pipe", fd as number],
  });
  const ms = performance.now() - t0;
  const ok = out.status === 0 && Number((out.stdout ?? "").trim()) === process.pid;
  return { ms, ok, err: out.error ? String((out.error as NodeJS.ErrnoException).code) : out.signal ?? "" };
}

async function unixPair(): Promise<{ sockPath: string; serverSock: net.Socket; close: () => void }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t592probe-"));
  const sockPath = path.join(dir, "s.sock");
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(sockPath, resolve));
  const accepted = new Promise<net.Socket>((resolve) => srv.once("connection", resolve));
  const client = net.connect(sockPath);
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const serverSock = await accepted;
  return {
    sockPath, serverSock,
    close: () => { client.destroy(); serverSock.destroy(); srv.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function listenOrch(): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((_req, res) => {
    const body = Buffer.from("{}", "utf8");
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
    res.end(body);
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

function httpGet(sock: net.Socket, urlPath: string): Promise<{ status: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null, status = 0) => {
      if (settled) return;
      settled = true;
      sock.off("data", onData);
      sock.off("error", onErr);
      if (err) reject(err); else resolve({ status, ms: performance.now() - t0 });
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
      finish(null, Number(header.split(" ")[1]));
    };
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.write(`GET ${urlPath} HTTP/1.1\r\nHost: bridge\r\nConnection: keep-alive\r\n\r\n`);
  });
}

function connectUnix(sockPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

async function main(): Promise<void> {
  const load1 = () => os.loadavg()[0]!.toFixed(1);
  console.log(`[probe] host: ${os.cpus().length} cores · load antes=${load1()} · burners=${BURNERS}`);
  startLoad(BURNERS);
  await sleep(8_000);
  console.log(`[probe] CARGA ATIVA · load=${load1()}`);

  // ---- 1/3: leitor REAL (perl) sob carga -----------------------------------
  const pair = await unixPair();
  const realMs: number[] = [];
  let realOk = 0;
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const pid = getUnixPeerPid(pair.serverSock);
    realMs.push(performance.now() - t0);
    if (pid === process.pid) realOk += 1;
  }
  const legacy = Array.from({ length: 10 }, () => legacyPythonReader(pair.serverSock));
  pair.close();

  console.log(`[probe] leitor NOVO (perl, teto 1000ms): ok=${realOk}/10 p50=${pctl(realMs, 0.5).toFixed(1)}ms max=${pctl(realMs, 1).toFixed(1)}ms`);
  console.log(
    `[probe] leitor ANTIGO (python3, teto 800ms): ok=${legacy.filter((l) => l.ok).length}/10 ` +
    `p50=${pctl(legacy.map((l) => l.ms), 0.5).toFixed(1)}ms max=${pctl(legacy.map((l) => l.ms), 1).toFixed(1)}ms ` +
    `erros=[${[...new Set(legacy.filter((l) => !l.ok).map((l) => l.err))].join(",")}]`,
  );

  // ---- 2/3: relay real, enforcement on, critério do PM ----------------------
  const orch = await listenOrch();
  const relay = new BridgeRelay(orch.url, null);
  await relay.start();
  console.log(`[probe] relay: peerPidEnforced=${relay.peerPidEnforced} allowInsecure=${relay.peerPidAllowInsecure}`);
  if (!relay.peerPidEnforced) {
    console.log("[probe] FALHA: self-test não passou sob carga — o relay está fail-CLOSED (503)");
  }

  clearAgentPidRegistry();
  registerAgentPid(AGENT, process.pid);

  const sameConn: number[] = [];
  const sock = await connectUnix(relay.socketPath);
  for (let i = 0; i < N_SAME_CONN; i++) {
    try { sameConn.push((await httpGet(sock, `/api/bridge/${AGENT}/tasks_list`)).status); }
    catch { sameConn.push(0); }
  }
  sock.destroy();

  const newConn: number[] = [];
  for (let i = 0; i < N_NEW_CONN; i++) {
    try {
      const s = await connectUnix(relay.socketPath);
      newConn.push((await httpGet(s, `/api/bridge/${AGENT}/tasks_list`)).status);
      s.destroy();
    } catch { newConn.push(0); }
  }

  // Enforcement: urlAgent bogus tem de continuar 403 (não é fail-open).
  const bogusSock = await connectUnix(relay.socketPath);
  const bogus = (await httpGet(bogusSock, "/api/bridge/agent_BOGUS/tasks_list")).status;
  bogusSock.destroy();

  const count = (xs: number[], v: number) => xs.filter((x) => x === v).length;
  console.log(
    `[probe] 1 conexão / ${N_SAME_CONN} requests: 200=${count(sameConn, 200)} ` +
    `403=${count(sameConn, 403)} 503=${count(sameConn, 503)} erro=${count(sameConn, 0)}`,
  );
  console.log(
    `[probe] ${N_NEW_CONN} conexões novas: 200=${count(newConn, 200)} ` +
    `403=${count(newConn, 403)} 503=${count(newConn, 503)} erro=${count(newConn, 0)}`,
  );
  console.log(`[probe] enforcement: urlAgent bogus → ${bogus} (esperado 403)`);

  const ok = realOk === 10
    && count(sameConn, 200) === N_SAME_CONN
    && count(newConn, 200) === N_NEW_CONN
    && bogus === 403
    && relay.peerPidEnforced;
  console.log(`[probe] VEREDITO: ${ok ? "PASS" : "FAIL"} · load final=${load1()}`);

  relay.stop();
  orch.close();
  stopLoad();
  await sleep(500);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("[probe] erro:", e); stopLoad(); process.exit(2); });