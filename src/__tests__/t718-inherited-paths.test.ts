/**
 * T-718: regressão nos caminhos que HERDAM o decrypt do daemon (auditoria
 * T-719): bridge-relay, webhook-dispatch, transcript (main.ts), migrated seed
 * (agent-host.ts) e o restante de main.ts. Vetor do SECURITY: tag REMOVIDA
 * (base64 re-codificado válido), com XOR no corpo ou AAD de outro campo. Com a
 * leitura tolerante do #596 cada um desses caminhos entregava o plaintext
 * (forjado) como autêntico; agora nenhum entrega.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import {
  clearAgentPidRegistry,
  registerAgentPid,
  resetParentPidCache,
  setParentPidReader,
  setUnixPeerPidReader,
} from "../privileges.js";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t718inh-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t718inh-pkeys-${process.pid}-${Date.now()}.json`);

const { BridgeRelay } = await import("../bridge-relay.js");
const { getDaemonPublicKey, rememberProjectKey, encryptForProject, decryptForProject } = await import("../daemon-crypto.js");
const { aadV2, E2EE_TABLE } = await import("@the-dudes/protocol/e2ee-fields");
const { dispatchWebhook } = await import("../webhook-dispatch.js");
const { decryptTranscriptBlobs } = await import("../transcript-decrypt.js");
const { migratedSeedFor } = await import("../migrated-seed.js");

const PID = "proj-t596";
const AGENT = "ag_t596";
{
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  rememberProjectKey(PID, wrapped.toString("base64"));
}

afterEach(() => {
  clearAgentPidRegistry();
  setParentPidReader(null);
  setUnixPeerPidReader(null);
  resetParentPidCache();
});

const V2 = "e2e:v2:";
const aad = (table: string, field: string) => aadV2({ projectId: PID, table, field });
const selar = (plain: string, table: string, field: string) => encryptForProject(plain, PID, aad(table, field))!;
/** Vetor T-719: apaga os 16 bytes da tag e re-codifica base64 válido. */
function semTag(blob: string, xorCorpo = false): string {
  const b = Buffer.from(blob.slice(V2.length), "base64");
  const s = Buffer.from(b.subarray(0, b.length - 16));
  if (xorCorpo) s[12] ^= 0x20;
  return V2 + s.toString("base64");
}
const SEGREDO = "SEGREDO-T718 conteúdo que o server não pode forjar";
const quiet = <T>(fn: () => Promise<T> | T): Promise<T> => {
  const orig = console.warn;
  console.warn = () => {};
  return Promise.resolve(fn()).finally(() => { console.warn = orig; });
};

function listenOrch(payload: (path: string) => unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const body = Buffer.from(JSON.stringify(payload(req.url ?? "")), "utf8");
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
    res.end(body);
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r, j) => srv.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

function postBridge(sock: net.Socket, urlPath: string, body = "{}"): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null, status = 0, json: any = null) => {
      if (settled) return;
      settled = true;
      sock.off("data", onData);
      sock.off("error", onErr);
      if (err) reject(err);
      else resolve({ status, json });
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
      const raw = buf.subarray(sep + 4, sep + 4 + len).toString("utf8");
      let json: any = null;
      try { json = JSON.parse(raw); } catch { /* deixa null */ }
      finish(null, Number(header.split(" ")[1]), json);
    };
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.write(
      `POST ${urlPath} HTTP/1.1\r\nHost: bridge\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`,
    );
  });
}

async function comRelay(
  payload: (path: string) => unknown,
  fn: (post: (p: string, body?: string) => Promise<{ status: number; json: any }>) => Promise<void>,
): Promise<void> {
  registerAgentPid(AGENT, 7);
  setUnixPeerPidReader(() => 7);
  setParentPidReader(() => 1);
  const orch = await listenOrch(payload);
  const relay = new BridgeRelay(orch.url, null, () => PID, { peerPidSelfTest: async () => true });
  await relay.start();
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(relay.socketPath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  try {
    await fn((p, body) => postBridge(sock, p, body));
  } finally {
    sock.destroy();
    relay.stop();
    await orch.close();
  }
}


test("T-718 herdado: bridge-relay tasks_get — tag removida (com/sem XOR) NÃO chega em claro ao agente; íntegro chega", async () => {
  const integro = selar(SEGREDO, E2EE_TABLE.TASKS, "description");
  const variantes = { integro, semTag: semTag(integro), forjado: semTag(integro, true) };
  for (const [nome, desc] of Object.entries(variantes)) {
    await quiet(() => comRelay(
      (p) => (p.endsWith("/tasks_get") ? { task: { id: "t1", title: "x", description: desc, status: "todo" }, commentCount: 0 } : {}),
      async (post) => {
        const r = await post(`/api/bridge/${AGENT}/tasks_get`, JSON.stringify({ id: "t1" }));
        const d = String(r.json?.task?.description ?? "");
        if (nome === "integro") assert.equal(d, SEGREDO, "íntegro segue legível");
        else {
          assert.ok(!d.includes("SEGREDO") && !d.includes("conteúdo"), `${nome}: plaintext vazou ao agente: ${d.slice(0, 60)}`);
          assert.ok(d.startsWith(V2), `${nome}: fica o blob cru (falha visível), não texto`);
        }
      },
    ));
  }
});

test("T-718 herdado: bridge-relay — blob de OUTRO campo (AAD errado) sem tag não abre", async () => {
  const deTitulo = semTag(selar(SEGREDO, E2EE_TABLE.TASKS, "title"));
  await quiet(() => comRelay(
    (p) => (p.endsWith("/tasks_get") ? { task: { id: "t1", title: "x", description: deTitulo, status: "todo" }, commentCount: 0 } : {}),
    async (post) => {
      const r = await post(`/api/bridge/${AGENT}/tasks_get`, JSON.stringify({ id: "t1" }));
      assert.ok(!String(r.json?.task?.description ?? "").includes("SEGREDO"));
    },
  ));
});

test("T-718 herdado: webhook-dispatch — msg.content sem tag NÃO sai em claro no POST", async () => {
  const recebido: string[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { recebido.push(b); res.writeHead(200); res.end("ok"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    const integro = selar(SEGREDO, E2EE_TABLE.MESSAGES, "content");
    for (const content of [semTag(integro), semTag(integro, true)]) {
      await quiet(() => dispatchWebhook({
        event: { type: "message", ts: 1, msg: { from: "a", to: "b", content } },
        projectId: PID, url: `http://127.0.0.1:${port}/wh`, secret: null, format: "generic",
      }));
    }
    await quiet(() => dispatchWebhook({
      event: { type: "message", ts: 1, msg: { from: "a", to: "b", content: integro } },
      projectId: PID, url: `http://127.0.0.1:${port}/wh`, secret: null, format: "generic",
    }));
  } finally {
    srv.close();
  }
  assert.equal(recebido.length, 3);
  assert.ok(!recebido[0]!.includes("SEGREDO") && !recebido[1]!.includes("SEGREDO"), "sem tag: nada em claro no webhook");
  assert.ok(recebido[2]!.includes("SEGREDO"), "controle: íntegro decifra no webhook");
});

test("T-718 herdado: transcript (main.ts:924-929) — blob sem tag → falha aad_or_data, zero linhas em claro", async () => {
  // Mesma lambda de decrypt do main.ts (AAD messages.content).
  const decrypt = (blob: string, pid: string) =>
    decryptForProject(blob, pid, aadV2({ projectId: pid, table: E2EE_TABLE.MESSAGES, field: "content" }));
  const integro = selar(SEGREDO, E2EE_TABLE.MESSAGES, "content");
  const r = await quiet(() => decryptTranscriptBlobs(["linha clara", semTag(integro)], { projectId: PID, hasKey: true, decrypt }));
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "aad_or_data");
  const ok = decryptTranscriptBlobs([integro], { projectId: PID, hasKey: true, decrypt });
  assert.equal(ok.ok, true);
});

test("T-718 herdado: agent-host migrated seed (agent-host.ts:685) — digest sem tag é DESCARTADO, não vira prompt", async () => {
  const decrypt = (blob: string, pid: string) =>
    decryptForProject(blob, pid, aadV2({ projectId: pid, table: E2EE_TABLE.SUMMARIES, field: "summary" }));
  const integro = selar(SEGREDO, E2EE_TABLE.SUMMARIES, "summary");
  for (const digest of [semTag(integro), semTag(integro, true)]) {
    const r = await quiet(() => migratedSeedFor({ id: "a", name: "a", usage: {}, seedDigest: digest } as never, undefined, { projectId: PID, decrypt }));
    assert.equal(r.seed, undefined);
    assert.equal(r.dropped, true);
  }
});

test("T-718 herdado (estrutural): nenhum arquivo do daemon decifra por conta própria — main.ts/agent-host/relay/webhook só via decryptForProject/decryptBytesForProject", () => {
  const dir = new URL("../", import.meta.url).pathname;
  const fontes: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (n === "__tests__" || n === "node_modules" || n.startsWith(".")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".ts")) fontes.push(p);
    }
  };
  walk(dir);
  const comDecipher = fontes.filter((f) => /createDecipheriv/.test(readFileSync(f, "utf8"))).map((f) => path.relative(dir, f));
  assert.deepEqual(comDecipher, ["daemon-crypto.ts"], "decrypt AES-GCM só no daemon-crypto (autentica ou null)");
  for (const f of ["main.ts", "agent-host.ts", "bridge-relay.ts", "webhook-dispatch.ts"]) {
    const s = readFileSync(path.join(dir, f), "utf8");
    assert.ok(/decryptForProject|decryptBytesForProject/.test(s), `${f} usa o primitivo central`);
    assert.doesNotMatch(s, /decryptPartial|\.update\([^)]*\)\s*\.toString\(/, `${f} sem decrypt parcial próprio`);
  }
});
