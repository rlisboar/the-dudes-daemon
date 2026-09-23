/**
 * T-824 (prova de reinício) — mensagem retida de projeto SEM chave E2EE.
 *
 * Achado na prova ao vivo (SIGTERM no meio do turno, perfil isolado): o spool
 * recusa gravar em claro a mensagem de um projeto sem chave ("perdida sem
 * chave"), mas o id dela ia para os vistos. O processo novo carregava os vistos
 * e descartava o replay do server como duplicata: mensagem perdida, com o aviso
 * "fica retida e é entregue quando o processo novo subir" no chat.
 *
 * Contrato: id que não entrou no spool NÃO consta como visto — o replay do
 * server é a única chance dela.
 */
import "./scratch-home.js";

import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t824p-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t824p-pkeys-${process.pid}-${Date.now()}.json`);

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { AgentHost } = await import("../agent-host.js");
const { getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");
const { createDeliveryDeduper, loadDeliverySeen, saveDeliverySeen } = await import("../inbound-dedup.js");
const { commitReexecSnapshot } = await import("../reexec-snapshot.js");

const PID = "proj_t824p";
const PID_SEM_CHAVE = "proj_t824p_semchave";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}

function hostCom() {
  const host = new AgentHost(() => {}, null, null, {} as never, false, false, false, () => {}, () => {});
  const entries = (host as unknown as { entries: Map<string, unknown> }).entries;
  const runner = { pushUserMessage() {}, isAlive: () => true, stop() {}, isTurnActive: () => false, takeQueuedForDrain: () => [] };
  entries.set("ag_chave", { projectId: PID, runner, info: { id: "ag_chave" } });
  entries.set("ag_sem", { projectId: PID_SEM_CHAVE, runner, info: { id: "ag_sem" } });
  return host;
}

test("T-824 prova: o spool devolve o id da mensagem que ficou fora (sem chave)", () => {
  const host = hostCom();
  host.startDrain("shutdown");
  host.send_message("ag_chave", "com chave", undefined, "id-chave");
  host.send_message("ag_sem", "sem chave", undefined, "id-sem");
  const out = host.writeReexecSpool(path.join(mkdtempSync(path.join(os.tmpdir(), "t824p-")), "sp"));
  assert.equal(out.spooled, 1);
  assert.equal(out.lost, 1);
  assert.deepEqual(out.lostDeliveryIds, ["id-sem"]);
});

test("T-824 prova: id fora do spool não vai para os vistos — o replay do server reentrega", () => {
  const host = hostCom();
  host.startDrain("shutdown");
  host.send_message("ag_chave", "com chave", undefined, "id-chave");
  host.send_message("ag_sem", "sem chave", undefined, "id-sem");
  const dedup = createDeliveryDeduper(500);
  for (const id of ["id-antigo", "id-chave", "id-sem"]) dedup.markSeen(id);
  const perfil = mkdtempSync(path.join(os.tmpdir(), "t824p-perfil-"));
  const logs: string[] = [];
  commitReexecSnapshot({
    tag: "[shutdown]",
    writeSpool: () => host.writeReexecSpool(path.join(perfil, "sp")),
    saveSeen: (excluir) => {
      const fora = new Set(excluir);
      saveDeliverySeen(perfil, dedup.snapshot().filter((id) => !fora.has(id)));
    },
    log: (_l, m) => logs.push(m),
  });
  const novo = createDeliveryDeduper(500);
  for (const id of loadDeliverySeen(perfil)) novo.markSeen(id);
  assert.equal(novo.isSeen("id-sem"), false, "o replay da mensagem sem chave é aceito");
  assert.equal(novo.isSeen("id-chave"), true, "a que foi para o spool não roda duas vezes");
  assert.equal(novo.isSeen("id-antigo"), true, "vistos de antes seguem valendo");
  assert.ok(logs.some((l) => l.includes("fora dos vistos")), logs.join(" | "));
});

test("T-824 prova: o shutdown do daemon filtra os vistos pelos ids fora do spool (fiação do main.ts)", () => {
  const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const ini = src.indexOf("private gravarSpoolEVistos(");
  const bloco = src.slice(ini, src.indexOf("\n  }\n", ini));
  assert.match(bloco, /saveSeen: \(excluir\) =>/);
  assert.match(bloco, /this\.deliveryDedup\.snapshot\(\)\.filter\(\(id\) => !fora\.has\(id\)\)/);
});
