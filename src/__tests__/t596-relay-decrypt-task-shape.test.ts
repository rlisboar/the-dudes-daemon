/**
 * #596: a allowlist de decrypt do relay cobria só ops de LISTA. `tasks_get`
 * (e as confirmações de escrita, que devolvem `{ task }`) ficavam de fora — o
 * agente recebia `e2e:v2:…` no `get_task` enquanto `list_tasks full=true`
 * entregava o mesmo campo em claro.
 *
 * O teste sobe um upstream falso e passa pelo socket do relay de verdade:
 * prova a ROTA (path → decrypt), não só a regex.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import {
  clearAgentPidRegistry,
  registerAgentPid,
  resetParentPidCache,
  setParentPidReader,
  setUnixPeerPidReader,
} from "../privileges.js";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t596-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t596-pkeys-${process.pid}-${Date.now()}.json`);

const { BridgeRelay } = await import("../bridge-relay.js");
const { getDaemonPublicKey, rememberProjectKey, encryptForProject } = await import("../daemon-crypto.js");
const { aadV2, E2EE_TABLE } = await import("@the-dudes/protocol/e2ee-fields");

const PID = "proj-t596";
const AGENT = "ag_t596";
{
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  rememberProjectKey(PID, wrapped.toString("base64"));
}

const selar = (plain: string, field: string): string =>
  selarTabela(plain, E2EE_TABLE.TASKS, field);

const selarTabela = (plain: string, table: string, field: string): string =>
  encryptForProject(plain, PID, aadV2({ projectId: PID, table, field }))!;

afterEach(() => {
  clearAgentPidRegistry();
  setParentPidReader(null);
  setUnixPeerPidReader(null);
  resetParentPidCache();
});

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

test("#596: tasks_get entrega title/description em claro", async () => {
  const titulo = "T-596 card";
  const desc = "descrição longa do card — precisa chegar legível ao agente";
  await comRelay(
    (p) => (p.endsWith("/tasks_get")
      ? { task: { id: "task_x", title: selar(titulo, "title"), description: selar(desc, "description"), status: "todo" }, commentCount: 0 }
      : {}),
    async (post) => {
      const r = await post(`/api/bridge/${AGENT}/tasks_get`, JSON.stringify({ id: "task_x" }));
      assert.equal(r.status, 200);
      assert.equal(r.json.task.title, titulo);
      assert.equal(r.json.task.description, desc);
      assert.equal(r.json.task.status, "todo", "campo não cifrado não deve ser tocado");
      assert.equal(r.json.commentCount, 0);
    },
  );
});

test("#596: confirmações de escrita (tasks_add/tasks_update/tasks_lock/tasks_unlock) também abrem", async () => {
  for (const op of ["tasks_add", "tasks_update", "tasks_lock", "tasks_unlock"]) {
    await comRelay(
      (p) => (p.endsWith(`/${op}`) ? { task: { id: "task_y", title: selar(`t-${op}`, "title"), description: selar(`d-${op}`, "description") } } : {}),
      async (post) => {
        const r = await post(`/api/bridge/${AGENT}/${op}`, JSON.stringify({ id: "task_y" }));
        assert.equal(r.status, 200, op);
        assert.equal(r.json.task.title, `t-${op}`, op);
        assert.equal(r.json.task.description, `d-${op}`, op);
      },
    );
  }
});

test("#596: tasks_list segue abrindo (sem regressão) e blob que não abre fica como veio", async () => {
  await comRelay(
    (p) => (p.endsWith("/tasks_list")
      ? {
        tasks: [
          { id: "t1", title: selar("um", "title"), description: selar("dois", "description") },
          { id: "t2", title: "e2e:v2:nao-abre", description: selar("tres", "description") },
        ],
      }
      : {}),
    async (post) => {
      const r = await post(`/api/bridge/${AGENT}/tasks_list`, "{}");
      assert.equal(r.status, 200);
      assert.equal(r.json.tasks[0].title, "um");
      assert.equal(r.json.tasks[0].description, "dois");
      assert.equal(r.json.tasks[1].title, "e2e:v2:nao-abre", "fail-open: devolve o blob, não some com o campo");
      assert.equal(r.json.tasks[1].description, "tres");
    },
  );
});

test("#596: op fora da allowlist não é tocado", async () => {
  await comRelay(
    () => ({ task: { title: selar("x", "title"), description: selar("y", "description") } }),
    async (post) => {
      const r = await post(`/api/bridge/${AGENT}/workspace_list`, "{}");
      assert.equal(r.status, 200);
      assert.ok(String(r.json.task.title).startsWith("e2e:v2:"), "workspace_list não está na allowlist");
    },
  );
});
test("#596: ampliar a allowlist não engole os ramos de plano (gate por op, não por forma de campo)", async () => {
  // Se o ramo do `{ task }` fosse escolhido só pela FORMA do campo, uma op de
  // plano que carregasse `task` junto de `plan` sairia pelo ramo errado e o
  // plano ficaria cifrado. O gate por op mantém os dois.
  await comRelay(
    (p) => (p.endsWith("/plans_get")
      ? { plan: { id: "plan_1", title: selarTabela("plano cifrado", E2EE_TABLE.PLANS, "title") }, task: { id: "t", title: "e2e:v2:task-de-outra-tabela" } }
      : {}),
    async (post) => {
      const r = await post(`/api/bridge/${AGENT}/plans_get`, JSON.stringify({ id: "plan_1" }));
      assert.equal(r.status, 200);
      assert.equal(r.json.plan.title, "plano cifrado", "plans_get segue no ramo do plano");
      assert.equal(r.json.task.title, "e2e:v2:task-de-outra-tabela", "e a op de plano não é tratada como op de task");
    },
  );
});
