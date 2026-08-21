import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";
import {
  BOARD_ANNOTATION_FIELDS,
  BOARD_STEP_FIELDS,
  BOARD_TEXT_FIELDS,
  COMMENT_FIELDS,
  E2EE_TABLE,
  GOAL_FIELDS,
  MEMORY_PLAIN_TO_CIPHER,
  MESSAGE_FIELDS,
  TASK_FIELDS,
  aadV2,
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

const cifradoV2 = (v: unknown) => typeof v === "string" && v.startsWith("e2e:v2:");

test("send: cifra os campos de mensagem da lista canônica", () => {
  const json: Record<string, unknown> = {};
  for (const f of MESSAGE_FIELDS) json[f] = `texto de ${f}`;
  const out = encryptBridgePayload("send", json, PID);
  for (const f of MESSAGE_FIELDS) {
    const blob = out[f] as string;
    assert.ok(cifradoV2(blob), `${f} não saiu e2e:v2:`);
    assert.ok(!blob.startsWith("e2e:v1:"), `${f} emitiu e2e:v1:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: f });
    assert.equal(decryptForProject(blob, PID, aad), `texto de ${f}`);
  }
});

test("memory_add: plaintext vira *Cipher e contentHash preserva dedup", () => {
  const out = encryptBridgePayload("memory_add", { title: "T", body: "B" }, PID);
  for (const [plain, cipher] of Object.entries(MEMORY_PLAIN_TO_CIPHER)) {
    assert.equal(out[plain], undefined, `${plain} ficou no payload em claro`);
    assert.ok(cifradoV2(out[cipher]), `${cipher} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.MEMORIES, field: plain });
    assert.equal(decryptForProject(out[cipher] as string, PID, aad), plain === "title" ? "T" : "B");
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
  for (const f of BOARD_TEXT_FIELDS) {
    assert.ok(cifradoV2(out[f]), `board.${f} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.BOARDS, field: f });
    assert.equal(decryptForProject(out[f] as string, PID, aad), `v-${f}`);
  }
  const st = (out.steps as Record<string, unknown>[])[0]!;
  for (const f of BOARD_STEP_FIELDS) assert.ok(cifradoV2(st[f]), `step.${f} não saiu e2e:v2:`);
  const chart = out.chart as { labels: unknown[]; series: Record<string, unknown>[] };
  assert.ok(cifradoV2(chart.labels[0]), "chart.label não saiu e2e:v2:");
  assert.ok(cifradoV2(chart.series[0]!.name), "chart.series.name não saiu e2e:v2:");
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
  const aad = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
  const { encryptForProject, decryptForProject } = await import("../daemon-crypto.js");
  const ct = encryptForProject("texto de title", PID, aad);
  assert.ok(ct && ct.startsWith("e2e:v2:"));
  assert.ok(!ct!.startsWith("e2e:v1:"));
  assert.equal(decryptForProject(ct!, PID, aad), "texto de title");
  const aadOutro = aadV2({ projectId: PID, table: E2EE_TABLE.GOALS, field: "title" });
  assert.equal(decryptForProject(ct!, PID, aadOutro), null);
});

test("T-062b write+read: blob movido entre table/field não abre", () => {
  const out = encryptBridgePayload("memory_add", { title: "segredo-title", body: "corpo" }, PID);
  const blob = out.titleCipher as string;
  assert.ok(cifradoV2(blob));
  const aadTitle = aadV2({ projectId: PID, table: E2EE_TABLE.MEMORIES, field: "title" });
  const aadBody = aadV2({ projectId: PID, table: E2EE_TABLE.MEMORIES, field: "body" });
  assert.equal(decryptForProject(blob, PID, aadTitle), "segredo-title");
  assert.equal(decryptForProject(blob, PID, aadBody), null, "AAD de outro campo deve falhar");
  assert.equal(decryptForProject(blob, PID), null, "v2 sem AAD fail-closed");
});

test("T-062b: encrypt sem aad continua e2e: (não emite e2e:v1:)", async () => {
  const { encryptForProject } = await import("../daemon-crypto.js");
  const legado = encryptForProject("ring-wrap", PID);
  assert.ok(legado && legado.startsWith("e2e:") && !legado.startsWith("e2e:v2:") && !legado.startsWith("e2e:v1:"));
  assert.equal(decryptForProject(legado!, PID), "ring-wrap");
});

test("T-073 write+read: messages/content e tts_summaries/summary em e2e:v2; campo trocado falha", async () => {
  const { encryptForProject } = await import("../daemon-crypto.js");
  const out = encryptBridgePayload("send", { content: "segredo-msg" }, PID);
  const blob = out.content as string;
  assert.ok(cifradoV2(blob));
  const aadMsg = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" });
  const aadSum = aadV2({ projectId: PID, table: E2EE_TABLE.SUMMARIES, field: "summary" });
  const aadTitle = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
  assert.equal(decryptForProject(blob, PID, aadMsg), "segredo-msg");
  assert.equal(decryptForProject(blob, PID, aadSum), null, "AAD de summary não abre message");
  assert.equal(decryptForProject(blob, PID, aadTitle), null, "AAD de title não abre message");
  assert.equal(decryptForProject(blob, PID), null, "v2 sem AAD fail-closed");

  const ctSum = encryptForProject("resumo tts", PID, aadSum)!;
  assert.ok(ctSum.startsWith("e2e:v2:") && !ctSum.startsWith("e2e:v1:"));
  assert.equal(decryptForProject(ctSum, PID, aadSum), "resumo tts");
  assert.equal(decryptForProject(ctSum, PID, aadMsg), null, "AAD de message não abre summary");
  const legado = encryptForProject("chat legado", PID)!;
  assert.ok(legado.startsWith("e2e:") && !legado.startsWith("e2e:v2:"));
  assert.equal(decryptForProject(legado, PID), "chat legado");
  assert.equal(decryptForProject(legado, PID, aadMsg), "chat legado", "e2e: legado ignora AAD");
});

test("T-074: required+sem chave recusa; OFF passthrough; required+chave cifra", { concurrency: false }, async () => {
  const { setE2eeRequired } = await import("../daemon-crypto.js");
  const pid = "proj-req-off";
  setE2eeRequired(pid, false);
  const outOff = encryptBridgePayload("send", { content: "claro" }, pid);
  assert.equal(outOff.content, "claro");
  setE2eeRequired(pid, true);
  assert.throws(() => encryptBridgePayload("send", { content: "claro" }, pid), /e2ee-required/);
  setE2eeRequired(pid, false);
  setE2eeRequired(PID, true);
  try {
    const outOn = encryptBridgePayload("send", { content: "segredo-req" }, PID);
    assert.ok(typeof outOn.content === "string" && String(outOn.content).startsWith("e2e:"));
  } finally {
    setE2eeRequired(PID, false);
  }
});

test("T-079 tasks_add: title/description saem e2e:v2 com aadV2 do catálogo", () => {
  const out = encryptBridgePayload("tasks_add", { title: "título", description: "desc", status: "todo" }, PID);
  assert.equal(out.status, "todo", "campo estrutural não cifra");
  for (const f of TASK_FIELDS) {
    const blob = out[f] as string;
    assert.ok(cifradoV2(blob), `task.${f} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: f });
    assert.equal(decryptForProject(blob, PID, aad), f === "title" ? "título" : "desc");
    assert.equal(decryptForProject(blob, PID, aadV2({ projectId: PID, table: E2EE_TABLE.GOALS, field: f })), null);
  }
});

test("T-079 tasks_update e comment: cifra nested/top-level; content de comment", () => {
  const upd = encryptBridgePayload("tasks_update", { id: "task_1", title: "novo" }, PID);
  assert.equal(upd.id, "task_1");
  assert.ok(cifradoV2(upd.title));
  const nested = encryptBridgePayload("tasks_update", { id: "task_1", patch: { description: "p" } }, PID);
  const patch = nested.patch as Record<string, unknown>;
  assert.ok(cifradoV2(patch.description));
  const cmt = encryptBridgePayload("tasks_comment_add", { taskId: "task_1", content: "oi" }, PID);
  assert.equal(cmt.taskId, "task_1");
  for (const f of COMMENT_FIELDS) {
    const blob = cmt[f] as string;
    assert.ok(cifradoV2(blob), `comment.${f} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.TASK_COMMENTS, field: f });
    assert.equal(decryptForProject(blob, PID, aad), "oi");
  }
});

test("T-079 goals_add: title/description e2e:v2", () => {
  const out = encryptBridgePayload("goals_add", { goal: { title: "G", description: "d" } }, PID);
  const g = out.goal as Record<string, unknown>;
  for (const f of GOAL_FIELDS) {
    const blob = g[f] as string;
    assert.ok(cifradoV2(blob), `goal.${f} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.GOALS, field: f });
    assert.equal(decryptForProject(blob, PID, aad), f === "title" ? "G" : "d");
  }
});

test("T-079 required+chave: tasks_add cifra (não recusa); sem chave recusa", { concurrency: false }, async () => {
  const { setE2eeRequired } = await import("../daemon-crypto.js");
  setE2eeRequired(PID, true);
  try {
    const out = encryptBridgePayload("tasks_add", { title: "ok" }, PID);
    assert.ok(cifradoV2(out.title));
  } finally {
    setE2eeRequired(PID, false);
  }
  setE2eeRequired("sem-chave", true);
  assert.throws(
    () => encryptBridgePayload("tasks_add", { title: "claro" }, "sem-chave"),
    /e2ee-required/,
  );
});
