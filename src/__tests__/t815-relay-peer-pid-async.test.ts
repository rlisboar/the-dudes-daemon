/**
 * T-815: o relay resolvia o peer-pid com spawnSync(perl) + execFileSync(ps)
 * por hop DENTRO do handler — o event loop inteiro do daemon parava a cada
 * conexão nova do mcp-bridge (medido no dashboard T-812: 53 spawnSync + 22
 * execFileSync em poucos minutos no host do dono). Estes testes rodam o
 * caminho DEFAULT (sem leitor injetado) com spawnSync/execFileSync proibidos:
 * se algum voltar para o caminho do relay, a resolução falha e o teste cai.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { BridgeRelay } from "../bridge-relay.js";
import {
  clearAgentPidRegistry,
  getParentPidAsync,
  getUnixPeerPidAsync,
  registerAgentPid,
  resetParentPidCache,
  setParentPidReader,
  setUnixPeerPidReader,
} from "../privileges.js";

const require = createRequire(import.meta.url);
const cp = require("node:child_process") as Record<string, unknown>;

afterEach(() => {
  clearAgentPidRegistry();
  setParentPidReader(null);
  setUnixPeerPidReader(null);
  resetParentPidCache();
});

/** Troca spawnSync/execFileSync por funções que lançam e conta as tentativas. */
async function semChamadaSincrona<T>(fn: () => Promise<T>): Promise<{ value: T; tentativas: string[] }> {
  const orig = { spawnSync: cp.spawnSync, execFileSync: cp.execFileSync };
  const tentativas: string[] = [];
  cp.spawnSync = (bin: string) => { tentativas.push(`spawnSync ${bin}`); throw new Error("T-815: spawnSync proibido"); };
  cp.execFileSync = (bin: string) => { tentativas.push(`execFileSync ${bin}`); throw new Error("T-815: execFileSync proibido"); };
  syncBuiltinESMExports();
  try {
    return { value: await fn(), tentativas };
  } finally {
    cp.spawnSync = orig.spawnSync;
    cp.execFileSync = orig.execFileSync;
    syncBuiltinESMExports();
  }
}

async function parUnix(): Promise<{ server: net.Socket; client: net.Socket; close: () => void }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t815-peer-"));
  const sockPath = path.join(dir, "s.sock");
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(sockPath, resolve));
  const accepted = new Promise<net.Socket>((resolve) => srv.once("connection", resolve));
  const client = net.connect(sockPath);
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  const server = await accepted;
  return {
    server,
    client,
    close: () => {
      client.destroy();
      server.destroy();
      srv.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

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

test("T-815: leitor default de peer-pid resolve o pid real sem spawnSync e sem parar o loop", async () => {
  const par = await parUnix();
  try {
    let timerRodou = false;
    setTimeout(() => { timerRodou = true; }, 0);
    const { value: pid, tentativas } = await semChamadaSincrona(() => getUnixPeerPidAsync(par.server));
    assert.deepEqual(tentativas, [], "o caminho default não pode chamar spawnSync/execFileSync");
    assert.equal(pid, process.pid, "o peer da conexão é este processo");
    // Leitura síncrona devolveria antes da fase de timers; a assíncrona espera
    // o close do perl, e o timer de 0ms roda no meio.
    assert.equal(timerRodou, true, "o event loop tem de ter girado durante a leitura");
  } finally {
    par.close();
  }
});

test("T-815: ppid assíncrono lê o pai real sem execFileSync e cacheia o resultado", async () => {
  resetParentPidCache();
  const origExecFile = cp.execFile as (...a: unknown[]) => unknown;
  let psCalls = 0;
  cp.execFile = (bin: unknown, ...rest: unknown[]) => { if (bin === "ps") psCalls++; return origExecFile(bin, ...rest); };
  syncBuiltinESMExports();
  let r: Awaited<ReturnType<typeof semChamadaSincrona<number[]>>>;
  try {
    r = await semChamadaSincrona(async () => [
      (await getParentPidAsync(process.pid))!,
      (await getParentPidAsync(process.pid))!,
    ]);
  } finally {
    cp.execFile = origExecFile;
    syncBuiltinESMExports();
  }
  assert.deepEqual(r.tentativas, [], "o caminho default não pode chamar execFileSync");
  assert.deepEqual(r.value, [process.ppid, process.ppid]);
  // macOS lê pelo ps (1 spawn, a 2ª vem do cache); Linux lê /proc (0 spawn).
  assert.equal(psCalls, process.platform === "linux" ? 0 : 1, "2ª leitura dentro do TTL vem do cache");
});

test("revisão T-815: socket já fechado não é sondado (o número do fd pode ser de outra conexão)", async () => {
  const par = await parUnix();
  try {
    par.server.destroy();
    await new Promise((r) => setImmediate(r));
    const { value, tentativas } = await semChamadaSincrona(() => getUnixPeerPidAsync(par.server));
    assert.equal(value, null);
    assert.deepEqual(tentativas, []);
  } finally {
    par.close();
  }
});

test("revisão T-815: requests em pipeline na MESMA conexão resolvem o peer uma vez só (fila por conexão)", async () => {
  let leituras = 0;
  registerAgentPid("agent_pipe", 4242);
  setUnixPeerPidReader(() => { leituras++; return 4242; });
  setParentPidReader(() => 1);
  const relay = new BridgeRelay("http://127.0.0.1:9", null, undefined, { peerPidSelfTest: async () => true });
  await relay.start();
  try {
    const sock = net.connect(relay.socketPath);
    await new Promise<void>((r) => sock.once("connect", () => r()));
    let raw = "";
    sock.setEncoding("utf8");
    sock.on("data", (c: string) => { raw += c; });
    const req = "GET /api/bridge/agent_pipe/tasks_list HTTP/1.1\r\nHost: relay\r\n\r\n";
    sock.write(req + req);
    const t0 = Date.now();
    while ((raw.match(/HTTP\/1\.1 \d{3}/g) ?? []).length < 2 && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 20));
    sock.destroy();
    const status = (raw.match(/HTTP\/1\.1 (\d{3})/g) ?? []).map((l) => l.slice(9));
    assert.deepEqual(status, ["502", "502"], `as duas passaram pelo peer check (resposta: ${raw.slice(0, 200)})`);
    assert.equal(leituras, 1, "o fato do SO foi lido uma vez para a conexão");
  } finally {
    relay.stop();
  }
});

test("T-815: leitor injetado continua síncrono e é chamado igual (contagem preservada)", async () => {
  let peer = 0;
  let parent = 0;
  setUnixPeerPidReader(() => { peer++; return 4321; });
  setParentPidReader(() => { parent++; return 1; });
  assert.equal(await getUnixPeerPidAsync({}), 4321);
  assert.equal(await getParentPidAsync(4321), 1);
  assert.deepEqual([peer, parent], [1, 1]);
});

test("T-815: relay com leitores default autoriza o peer real e barra o alheio, sem chamada síncrona", async () => {
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  const relay = new BridgeRelay("http://127.0.0.1:9", null);
  await relay.start();
  try {
    assert.equal(relay.peerPidEnforced, true, "self-test real (assíncrono) tem de passar no host");
    // O peer é este processo; o agente registrado é o PAI → o walk precisa
    // ler o ppid pelo SO (ps no macOS, /proc no Linux).
    registerAgentPid("agent_t815", process.ppid);
    const { value: [proprio, alheio], tentativas } = await semChamadaSincrona(async () => [
      await unixStatus(relay.socketPath, "/api/bridge/agent_t815/tasks_list"),
      await unixStatus(relay.socketPath, "/api/bridge/agent_outro/tasks_list"),
    ]);
    assert.deepEqual(tentativas, [], "a resolução do peer no relay não pode chamar spawnSync/execFileSync");
    assert.equal(proprio, 502, "peer casou com o agente: o relay segue para o upstream (inalcançável → 502)");
    assert.equal(alheio, 403, "agente da URL ≠ peer: 403 continua valendo");
  } finally {
    relay.stop();
  }
});
