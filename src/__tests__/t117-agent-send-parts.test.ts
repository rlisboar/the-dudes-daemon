/**
 * T-117: assembleAgentSendParts — AAD declarado, fallback legado, fail-closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";
import { aadV2, E2EE_TABLE, agentSendCipherPart } from "@the-dudes/protocol/e2ee-fields";
import { assembleAgentSendParts, type AgentSendPart } from "../protocol.js";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t117-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t117-pkeys-${process.pid}-${Date.now()}.json`);

const {
  getDaemonPublicKey, rememberProjectKey, forgetProjectKey,
  encryptForProject, decryptForProject, isE2eEncrypted,
} = await import("../daemon-crypto.js");

const PID = "proj-t117-parts";
{
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  assert.equal(rememberProjectKey(PID, wrapped.toString("base64")), true);
}

function run(parts: AgentSendPart[], projectId: string | undefined = PID) {
  return assembleAgentSendParts(parts, projectId, decryptForProject, isE2eEncrypted);
}

test("A1: tasks.title + tasks.description com table/field montam plaintext", () => {
  const titleAad = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
  const descAad = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "description" });
  const title = encryptForProject("T-117 title", PID, titleAad)!;
  const desc = encryptForProject("faça a coisa", PID, descAad)!;
  const got = run([
    { kind: "plain", text: "assign \"" },
    agentSendCipherPart(title, E2EE_TABLE.TASKS, "title"),
    { kind: "plain", text: "\" " },
    agentSendCipherPart(desc, E2EE_TABLE.TASKS, "description"),
  ]);
  assert.equal(got.ok, true);
  if (got.ok) assert.equal(got.content, "assign \"T-117 title\" faça a coisa");
});

test("A2: history misto tasks.* + messages.content reconstrói inteiro", () => {
  const tAad = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
  const mAad = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" });
  const t = encryptForProject("item", PID, tAad)!;
  const m = encryptForProject("oi", PID, mAad)!;
  const got = run([
    { kind: "plain", text: "task=" },
    agentSendCipherPart(t, E2EE_TABLE.TASKS, "title"),
    { kind: "plain", text: " msg=" },
    agentSendCipherPart(m, E2EE_TABLE.MESSAGES, "content"),
  ]);
  assert.equal(got.ok, true);
  if (got.ok) assert.equal(got.content, "task=item msg=oi");
});

test("A3: cipher sem table/field só abre como messages.content", () => {
  const msgAad = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" });
  const taskAad = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
  const okBlob = encryptForProject("TASK_ASSIGN", PID, msgAad)!;
  const taskBlob = encryptForProject("titulo", PID, taskAad)!;
  const ok = run([{ kind: "cipher", text: okBlob }]);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.content, "TASK_ASSIGN");
  const drop = run([{ kind: "cipher", text: taskBlob }]);
  assert.equal(drop.ok, false);
  if (!drop.ok) {
    assert.equal(drop.reason, "decrypt");
    assert.equal(drop.prefix, "e2e:v2");
  }
});

test("A4: metadado parcial/inválido e v2 com AAD divergente dropam sem catálogo", () => {
  const titleAad = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
  const blob = encryptForProject("x", PID, titleAad)!;
  const partial = run([{ kind: "cipher", text: blob, table: E2EE_TABLE.TASKS }]);
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.equal(partial.reason, "partial");
  const invalid = run([{ kind: "cipher", text: blob, table: E2EE_TABLE.BOARDS, field: "title" }]);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.reason, "invalid");
  const wrong = run([agentSendCipherPart(blob, E2EE_TABLE.MESSAGES, "content")]);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, "decrypt");
});

test("A4 content-path: messages.content errado continua fail-closed (não usa parts)", () => {
  const titleAad = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
  const blob = encryptForProject("x", PID, titleAad)!;
  const aadMsg = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" });
  assert.equal(decryptForProject(blob, PID, aadMsg), null);
  assert.equal(decryptForProject(blob, PID, titleAad), "x");
});

test("A5: e2e: legado em parts abre (ignora AAD); e2e:v1 rejeitado", () => {
  const legado = encryptForProject("legado-ok", PID)!;
  assert.ok(legado.startsWith("e2e:"));
  assert.ok(!legado.startsWith("e2e:v2:"));
  const tagged = run([agentSendCipherPart(legado, E2EE_TABLE.TASKS, "title")]);
  assert.equal(tagged.ok, true);
  if (tagged.ok) assert.equal(tagged.content, "legado-ok");
  const untagged = run([{ kind: "cipher", text: legado }]);
  assert.equal(untagged.ok, true);
  if (untagged.ok) assert.equal(untagged.content, "legado-ok");
  const v1 = run([{ kind: "cipher", text: "e2e:v1:AAAA", table: E2EE_TABLE.MESSAGES, field: "content" }]);
  assert.equal(v1.ok, false);
  if (!v1.ok) {
    assert.equal(v1.reason, "decrypt");
    assert.equal(v1.prefix, "e2e:v1");
  }
});

test("memories.title/body e goals.* abrem com o AAD declarado", () => {
  const memT = encryptForProject("título", PID, aadV2({ projectId: PID, table: E2EE_TABLE.MEMORIES, field: "title" }))!;
  const memB = encryptForProject("corpo", PID, aadV2({ projectId: PID, table: E2EE_TABLE.MEMORIES, field: "body" }))!;
  const gT = encryptForProject("meta", PID, aadV2({ projectId: PID, table: E2EE_TABLE.GOALS, field: "title" }))!;
  const got = run([
    agentSendCipherPart(memT, E2EE_TABLE.MEMORIES, "title"),
    { kind: "plain", text: "|" },
    agentSendCipherPart(memB, E2EE_TABLE.MEMORIES, "body"),
    { kind: "plain", text: "|" },
    agentSendCipherPart(gT, E2EE_TABLE.GOALS, "title"),
  ]);
  assert.equal(got.ok, true);
  if (got.ok) assert.equal(got.content, "título|corpo|meta");
});

test("sem projectId em cipher e2e dropa missing_project", () => {
  const blob = encryptForProject("x", PID, aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" }))!;
  const got = assembleAgentSendParts(
    [{ kind: "cipher", text: blob }],
    undefined,
    decryptForProject,
    isE2eEncrypted,
  );
  assert.equal(got.ok, false);
  if (!got.ok) assert.equal(got.reason, "missing_project");
});

test("cleanup T-117 key", () => {
  forgetProjectKey(PID);
});
