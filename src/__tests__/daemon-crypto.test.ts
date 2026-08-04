import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";

// Key path isolado ANTES do import (DEFAULT_KEY_PATH é resolvido no load do
// módulo) — não polui ~/.the-dudes nem o CI.
process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-test-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-test-pkeys-${process.pid}-${Date.now()}.json`);
const {
  getDaemonPublicKey, rememberProjectKey, getProjectKey, forgetProjectKey, hasProjectKey,
  encryptForProject, decryptForProject, isE2eEncrypted,
  importProjectKeyRing, countOldProjectKeys,
  rememberCredentialPlaintext, redactCredentials, redactCredentialsDeep,
} = await import("../daemon-crypto.js");
const { createCipheriv } = await import("node:crypto");

/** Wrap uma AES-256 key com a pubkey RSA do daemon (replica o que o web faz
 *  com wrapProjectKeyForUser) e registra no daemon via rememberProjectKey. */
function provisionKey(projectId: string, aes?: Buffer, keyRing?: string[]): Buffer {
  const key = aes ?? randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, key);
  rememberProjectKey(projectId, wrapped.toString("base64"), keyRing);
  return key;
}

/** Cifra UTF-8 com AES-256 raw no wire format e2e: (paridade web/daemon). */
function encryptWithKey(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "e2e:" + Buffer.concat([iv, ct, tag]).toString("base64");
}

/** Entrada do key ring: chave anterior (raw base64) cifrada com a seguinte. */
function ringEntry(prevKey: Buffer, nextKey: Buffer): string {
  return encryptWithKey(prevKey.toString("base64"), nextKey);
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

test("persistência: chave sobrevive a 'restart' (RAM limpa, disco fica)", async () => {
  // O bug real: daemon reiniciava, a chave morria com a RAM e o relay caía no
  // fallback plaintext — tráfego de agente subia em claro até um web abrir.
  const { forgetAllProjectKeys } = await import("../daemon-crypto.js");
  const aes = provisionKey("proj-persist");
  forgetAllProjectKeys(); // simula shutdown: zera RAM, preserva disco
  const held = getProjectKey("proj-persist");
  assert.ok(held, "chave não foi restaurada do disco após limpar a RAM");
  assert.equal(held!.toString("hex"), aes.toString("hex"));
  // encrypt também precisa funcionar direto do disco
  forgetAllProjectKeys();
  const ct = encryptForProject("pós-restart", "proj-persist");
  assert.ok(ct?.startsWith("e2e:"), "encrypt caiu no fallback null pós-restart");
  assert.equal(decryptForProject(ct!, "proj-persist"), "pós-restart");
  forgetProjectKey("proj-persist"); // remoção deliberada limpa o disco
  assert.equal(getProjectKey("proj-persist"), null, "forget deliberado deveria apagar o wrap do disco");
});

test("key ring: histórico legível após DUAS rotações (cadeia k1→k2→k3)", () => {
  // Aceite 1: conteúdo cifrado com chave pré-rotação decifra com sucesso.
  // Ring como o server entrega: mais antiga primeiro; cada entrada = chave
  // anterior cifrada AES-GCM com a que a substituiu.
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const k3 = randomBytes(32);
  const msgK1 = encryptWithKey("era-1", k1);
  const msgK2 = encryptWithKey("era-2", k2);
  const msgK3 = encryptWithKey("era-3", k3);
  const ring = [ringEntry(k1, k2), ringEntry(k2, k3)];

  provisionKey("proj-ring", k3, ring);

  assert.equal(countOldProjectKeys("proj-ring"), 2, "duas chaves antigas no ring");
  assert.equal(decryptForProject(msgK3, "proj-ring"), "era-3");
  assert.equal(decryptForProject(msgK2, "proj-ring"), "era-2");
  assert.equal(decryptForProject(msgK1, "proj-ring"), "era-1", "conteúdo de duas rotações atrás ficou ilegível");
  forgetProjectKey("proj-ring");
});

test("key ring: chave nova NÃO decifra lixo (teste negativo)", () => {
  // Aceite 2: o ring não afrouxa falha real — blob aleatório continua null.
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const ring = [ringEntry(k1, k2)];
  provisionKey("proj-ring-neg", k2, ring);

  const lixo = "e2e:" + randomBytes(40).toString("base64");
  assert.equal(decryptForProject(lixo, "proj-ring-neg"), null, "lixo não deveria abrir");
  // Conteúdo de OUTRO projeto (chave alheia) também falha
  const kAlien = randomBytes(32);
  const alien = encryptWithKey("segredo-alheio", kAlien);
  assert.equal(decryptForProject(alien, "proj-ring-neg"), null, "chave alheia não deveria abrir");
  // mas o conteúdo legítimo da era k1 ainda abre
  assert.equal(decryptForProject(encryptWithKey("ok", k1), "proj-ring-neg"), "ok");
  forgetProjectKey("proj-ring-neg");
});

test("key ring: restart preserva leitura de histórico antigo", async () => {
  // Aceite 3: ring persistido cifrado (mesmo padrão do wrap); forgetAll zera
  // RAM e o restore reabre a cadeia a partir do disco no primeiro decrypt.
  const { forgetAllProjectKeys } = await import("../daemon-crypto.js");
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const k3 = randomBytes(32);
  const msgK1 = encryptWithKey("hist-antigo", k1);
  const msgK2 = encryptWithKey("hist-meio", k2);
  const ring = [ringEntry(k1, k2), ringEntry(k2, k3)];
  provisionKey("proj-ring-persist", k3, ring);
  assert.equal(decryptForProject(msgK1, "proj-ring-persist"), "hist-antigo");

  forgetAllProjectKeys(); // simula restart: RAM limpa, disco fica

  // decrypt força restore do wrap + re-import do ring opaco
  assert.equal(decryptForProject(msgK1, "proj-ring-persist"), "hist-antigo", "histórico k1 sumiu pós-restart");
  assert.equal(decryptForProject(msgK2, "proj-ring-persist"), "hist-meio", "histórico k2 sumiu pós-restart");
  assert.ok(countOldProjectKeys("proj-ring-persist") >= 2, "ring deveria ter voltado do disco");
  forgetProjectKey("proj-ring-persist");
});

test("key ring: auto-promote na rotação online (sem keyRing do server)", () => {
  // Daemon online durante rotação: só recebe a chave nova via
  // project_key:for_daemon; a antiga em RAM vira entrada do ring.
  const k1 = provisionKey("proj-promote");
  const msgK1 = encryptForProject("pré-rotação", "proj-promote")!;
  assert.equal(decryptForProject(msgK1, "proj-promote"), "pré-rotação");

  const k2 = randomBytes(32);
  provisionKey("proj-promote", k2); // sem keyRing — promove k1
  assert.ok(countOldProjectKeys("proj-promote") >= 1);
  assert.equal(decryptForProject(msgK1, "proj-promote"), "pré-rotação", "auto-promote falhou");
  // Conteúdo novo usa k2
  const msgK2 = encryptForProject("pós-rotação", "proj-promote")!;
  assert.equal(decryptForProject(msgK2, "proj-promote"), "pós-rotação");
  forgetProjectKey("proj-promote");
});

test("importProjectKeyRing: entrada que não abre interrompe a cadeia", () => {
  const k2 = randomBytes(32);
  const k3 = randomBytes(32);
  // ring[0] cifrado com chave errada — não abre; k2 (mais recente no ring) ainda deve abrir
  const garbage = encryptWithKey(randomBytes(32).toString("base64"), randomBytes(32));
  const ring = [garbage, ringEntry(k2, k3)];
  provisionKey("proj-ring-break", k3, ring);
  // Só a entrada mais recente (k2 cifrada com k3) abre; garbage interrompe o resto
  assert.equal(countOldProjectKeys("proj-ring-break"), 1);
  assert.equal(decryptForProject(encryptWithKey("era-2", k2), "proj-ring-break"), "era-2");
  forgetProjectKey("proj-ring-break");
});
