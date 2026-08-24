/**
 * T-103: agent:send entrega imagem UTILIZÁVEL ao CLI a partir de blob v2.
 * PNG 1×1 real — bytes idênticos após decifra; mimeType/name intactos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";
import { aadV2, E2EE_TABLE, MESSAGE_IMAGE_FIELD } from "@the-dudes/protocol/e2ee-fields";
import { buildClaudeUserContent, imageDataUrl } from "../runners/attachments.js";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-img-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-img-pkeys-${process.pid}-${Date.now()}.json`);

const {
  getDaemonPublicKey, rememberProjectKey, forgetProjectKey,
  encryptBytesForProject, encryptImageBase64, decryptImageAttachments,
} = await import("../daemon-crypto.js");

/** PNG 1×1 verdadeiro (assinatura 89 50 4E 47). */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

function provision(projectId: string): void {
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  rememberProjectKey(projectId, wrapped.toString("base64"));
}

test("PNG 1x1 tem magic number real", () => {
  assert.equal(PNG_BYTES[0], 0x89);
  assert.equal(PNG_BYTES.subarray(1, 4).toString("ascii"), "PNG");
  assert.ok(PNG_BYTES.length > 32);
});

test("agent:send: blob v2 → CLI recebe bytes idênticos; mimeType/name claros", () => {
  const pid = "proj-img-send";
  provision(pid);
  const aad = aadV2({ projectId: pid, table: E2EE_TABLE.MESSAGES, field: MESSAGE_IMAGE_FIELD });
  const blob = encryptBytesForProject(PNG_BYTES, pid, aad)!;
  assert.ok(blob.startsWith("e2e:v2:"));
  assert.ok(!blob.includes(PNG_B64.slice(0, 24)), "não cifrar o ASCII do base64");

  const decoded = decryptImageAttachments(
    [{ mimeType: "image/png", base64: blob, name: "dot.png" }],
    pid,
  );
  assert.ok(decoded && decoded.length === 1);
  assert.equal(decoded![0]!.mimeType, "image/png");
  assert.equal(decoded![0]!.name, "dot.png");
  assert.deepEqual(Buffer.from(decoded![0]!.base64, "base64"), PNG_BYTES);

  const url = imageDataUrl(decoded![0]!);
  assert.match(url, /^data:image\/png;base64,/);
  assert.equal(url.slice(url.indexOf(",") + 1), decoded![0]!.base64);

  const claude = buildClaudeUserContent("veja", decoded);
  assert.ok(Array.isArray(claude));
  const imgPart = (claude as Array<Record<string, unknown>>).find((p) => p.type === "image") as {
    source: { type: string; media_type: string; data: string };
  };
  assert.equal(imgPart.source.media_type, "image/png");
  assert.deepEqual(Buffer.from(imgPart.source.data, "base64"), PNG_BYTES);

  forgetProjectKey(pid);
});

test("agent:send: legado claro passa intacto; AAD errado dropa", () => {
  const pid = "proj-img-legacy";
  provision(pid);
  const legado = decryptImageAttachments(
    [{ mimeType: "image/jpeg", base64: PNG_B64, name: "x.jpg" }],
    pid,
  );
  assert.equal(legado![0]!.base64, PNG_B64);
  assert.equal(legado![0]!.mimeType, "image/jpeg");

  const blob = encryptImageBase64(PNG_B64, pid)!;
  assert.equal(decryptImageAttachments([{ mimeType: "image/png", base64: blob }], "sem-chave"), null);
  forgetProjectKey(pid);
});
