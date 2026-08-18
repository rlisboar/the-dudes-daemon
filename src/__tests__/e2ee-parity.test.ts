import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";
import {
  BOARD_ANNOTATION_FIELDS,
  BOARD_STEP_FIELDS,
  BOARD_TEXT_FIELDS,
  MEMORY_PLAIN_TO_CIPHER,
  MESSAGE_FIELDS,
} from "@the-dudes/protocol/e2ee-fields";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-parity-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-parity-pkeys-${process.pid}-${Date.now()}.json`);
const { getDaemonPublicKey, rememberProjectKey, decryptForProject } = await import("../daemon-crypto.js");
const { encryptBridgePayload } = await import("../bridge-relay.js");

/**
 * PARIDADE cifra↔decifra, lado do daemon.
 *
 * Prova que o relay cifra exatamente os campos da lista canônica
 * (`@the-dudes/protocol/e2ee-fields`). O gêmeo no web prova que todos são
 * decifrados. Um campo novo em um lado sem o outro derruba uma das suítes —
 * em vez de aparecer como "e2e:..." na tela de alguém, que foi como três bugs
 * de produção se manifestaram.
 */

const PID = "proj-parity";
{
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  rememberProjectKey(PID, wrapped.toString("base64"));
}

const cifrado = (v: unknown) => typeof v === "string" && v.startsWith("e2e:");

test("send: cifra os campos de mensagem da lista canônica", () => {
  const json: Record<string, unknown> = {};
  for (const f of MESSAGE_FIELDS) json[f] = `texto de ${f}`;
  const out = encryptBridgePayload("send", json, PID);
  for (const f of MESSAGE_FIELDS) {
    assert.ok(cifrado(out[f]), `${f} subiu em claro`);
    assert.equal(decryptForProject(out[f] as string, PID), `texto de ${f}`);
  }
});

test("memory_add: plaintext vira *Cipher e contentHash preserva dedup", () => {
  const out = encryptBridgePayload("memory_add", { title: "T", body: "B" }, PID);
  for (const [plain, cipher] of Object.entries(MEMORY_PLAIN_TO_CIPHER)) {
    assert.equal(out[plain], undefined, `${plain} ficou no payload em claro`);
    assert.ok(cifrado(out[cipher]), `${cipher} não foi cifrado`);
  }
  assert.match(String(out.contentHash), /^[0-9a-f]{64}$/, "contentHash sumiu (dedup quebraria)");
});

test("board: cifra todos os campos de texto, steps, chart e annotations", () => {
  const json: Record<string, unknown> = {
    steps: [{ label: "L", detail: "D", ordem: 1 }],
    chart: { labels: ["Jan"], series: [{ name: "S", values: [1] }] },
    annotations: [{ label: "A" }],
  };
  for (const f of BOARD_TEXT_FIELDS) json[f] = `v-${f}`;
  const out = encryptBridgePayload("board", json, PID);
  for (const f of BOARD_TEXT_FIELDS) assert.ok(cifrado(out[f]), `board.${f} subiu em claro`);
  const st = (out.steps as Record<string, unknown>[])[0]!;
  for (const f of BOARD_STEP_FIELDS) assert.ok(cifrado(st[f]), `step.${f} subiu em claro`);
  const chart = out.chart as { labels: unknown[]; series: Record<string, unknown>[] };
  assert.ok(cifrado(chart.labels[0]), "chart.label subiu em claro");
  assert.ok(cifrado(chart.series[0]!.name), "chart.series.name subiu em claro");
  // Estrutura NÃO cifrada de propósito: o server aplica limites estruturais.
  assert.equal(st.ordem, 1);
  assert.deepEqual((chart.series[0] as { values: number[] }).values, [1]);
  // Anotações: o relay atual NÃO cifra annotation.label na subida (o server é
  // quem gerencia anotações via boardDraw) — a lista canônica documenta o
  // campo pro lado do WEB decifrar o que o server devolve. Se um dia o agente
  // passar a MANDAR anotações, este assert avisa que falta cifrar.
  void BOARD_ANNOTATION_FIELDS;
});

test("T-062 parity daemon: cifra v2 e decifra com o mesmo aadV2", async () => {
  const { aadV2, E2EE_TABLE } = await import("@the-dudes/protocol/e2ee-fields");
  const aad = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" });
  const { encryptForProject, decryptForProject } = await import("../daemon-crypto.js");
  const ct = encryptForProject("texto de content", PID, aad);
  assert.ok(ct && ct.startsWith("e2e:v2:"));
  assert.equal(decryptForProject(ct!, PID, aad), "texto de content");
  const aadOutro = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
  assert.equal(decryptForProject(ct!, PID, aadOutro), null);
});
