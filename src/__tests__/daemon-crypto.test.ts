import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";

// Key path isolado ANTES do import (DEFAULT_KEY_PATH é resolvido no load do
// módulo) — não polui ~/.the-dudes nem o CI.
process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-test-key-${process.pid}-${Date.now()}.pem`);
const {
  getDaemonPublicKey, rememberProjectKey, getProjectKey, forgetProjectKey, hasProjectKey,
  encryptForProject, decryptForProject, isE2eEncrypted,
  rememberCredentialPlaintext, redactCredentials, redactCredentialsDeep,
} = await import("../daemon-crypto.js");

/** Wrap uma AES-256 key com a pubkey RSA do daemon (replica o que o web faz
 *  com wrapProjectKeyForUser) e registra no daemon via rememberProjectKey. */
function provisionKey(projectId: string): Buffer {
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  rememberProjectKey(projectId, wrapped.toString("base64"));
  return aes;
}

test("rememberProjectKey + getProjectKey: unwrap RSA da AES key", () => {
  const aes = provisionKey("proj-unwrap");
  const held = getProjectKey("proj-unwrap");
  assert.ok(held);
  assert.equal(held!.length, 32);
  assert.equal(held!.toString("hex"), aes.toString("hex"));
  forgetProjectKey("proj-unwrap");
  assert.equal(getProjectKey("proj-unwrap"), null);
});

test("encryptForProject/decryptForProject: round-trip + wire format e2e:", () => {
  provisionKey("proj-rt");
  const plain = "mensagem secreta com acento ção 🔒";
  const ct = encryptForProject(plain, "proj-rt");
  assert.ok(ct);
  assert.ok(ct!.startsWith("e2e:"), "deve ter prefixo e2e:");
  assert.notEqual(ct, plain);
  assert.equal(decryptForProject(ct!, "proj-rt"), plain);
  forgetProjectKey("proj-rt");
});

test("encryptForProject: sem key retorna null; decrypt pass-through em plaintext", () => {
  assert.equal(encryptForProject("x", "proj-inexistente"), null);
  // valor sem prefixo e2e: passa direto (legacy plain)
  provisionKey("proj-pt");
  assert.equal(decryptForProject("texto plano", "proj-pt"), "texto plano");
  // ciphertext e2e: sem key retorna null (caller trata)
  const ct = encryptForProject("y", "proj-pt")!;
  forgetProjectKey("proj-pt");
  assert.equal(decryptForProject(ct, "proj-pt"), null);
});

test("decryptForProject: ciphertext adulterado falha (tag GCM) → null", () => {
  provisionKey("proj-tamper");
  const ct = encryptForProject("original", "proj-tamper")!;
  // flip de 1 char no meio do base64
  const body = ct.slice(4);
  const mid = Math.floor(body.length / 2);
  const flipped = "e2e:" + body.slice(0, mid) + (body[mid] === "A" ? "B" : "A") + body.slice(mid + 1);
  assert.equal(decryptForProject(flipped, "proj-tamper"), null);
  // Key DEVE sobreviver a um blob stale — senão um system prompt antigo
  // derruba decrypt de todos os runners do projeto.
  assert.ok(hasProjectKey("proj-tamper"), "key não deve ser apagada em decrypt fail");
  assert.equal(decryptForProject(ct, "proj-tamper"), "original");
  forgetProjectKey("proj-tamper");
});

test("isE2eEncrypted", () => {
  assert.equal(isE2eEncrypted("e2e:abc"), true);
  assert.equal(isE2eEncrypted("plain"), false);
  assert.equal(isE2eEncrypted(null), false);
  assert.equal(isE2eEncrypted(undefined), false);
});

test("redactCredentials: mascara valor + variantes URL/base64", () => {
  rememberCredentialPlaintext("proj-cred", "super-secret-token-123");
  const out = redactCredentials("proj-cred", "antes super-secret-token-123 depois");
  assert.ok(!out.includes("super-secret-token-123"));
  assert.ok(out.includes("[REDACTED]"));
  // URL-encoded
  const enc = encodeURIComponent("super-secret-token-123");
  assert.ok(!redactCredentials("proj-cred", `x=${enc}`).includes(enc));
  // valor curto (<6) não mascara (evita falso positivo)
  rememberCredentialPlaintext("proj-cred2", "abc");
  assert.equal(redactCredentials("proj-cred2", "abc def"), "abc def");
});

test("redactCredentialsDeep: recursivo em objeto/array", () => {
  rememberCredentialPlaintext("proj-deep", "leaky-value-xyz");
  const out: any = redactCredentialsDeep("proj-deep", {
    a: "tem leaky-value-xyz aqui",
    b: ["nested leaky-value-xyz", 42, { c: "leaky-value-xyz" }],
  });
  assert.ok(!JSON.stringify(out).includes("leaky-value-xyz"));
  assert.equal(out.b[1], 42); // não-strings intactos
});
