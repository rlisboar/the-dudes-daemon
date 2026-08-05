import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import {
  checkAndApplyUpdate,
  signatureAccepted,
  verifyBundle,
  TRUSTED_SIGN_PUBS,
} from "../self-update.js";

/**
 * A chave embutida no módulo é a de produção; o teste NÃO tem a privada dela
 * por default. Estratégia:
 *  - fail-closed (assinatura errada → recusa);
 *  - dual-trust com par efêmero A/B injetado;
 *  - nova chave de T-006 (privada fora do repo) assina e passa no conjunto real;
 *  - se a privada ANTIGA existir em daemon/.signing/sign.key (host de dev),
 *    prova que a antiga ainda é aceita.
 */

const log = () => {};

test("hash publicado igual ao rodando → nada a fazer", async () => {
  const fetchFn = (async (_url: string) => ({
    ok: true,
    arrayBuffer: async () => Buffer.from("a".repeat(64) + "  daemon.cjs\n"),
  })) as unknown as typeof fetch;
  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath: "/tmp/daemon.cjs",
    runningHash: "a".repeat(64), log, underLauncher: true, fetchFn,
  });
  assert.equal(r, "current");
});

test("assinatura inválida → recusa e mantém o binário", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sup-"));
  const selfPath = path.join(dir, "daemon.cjs");
  writeFileSync(selfPath, "BINARIO ORIGINAL");
  const bundle = Buffer.from("BINARIO NOVO MALICIOSO");
  const sha = createHash("sha256").update(bundle).digest("hex");
  const respostas: Record<string, Buffer> = {
    "/install/daemon.cjs.sha256": Buffer.from(`${sha}  daemon.cjs\n`),
    "/install/daemon.cjs": bundle,
    "/install/daemon.cjs.sig": Buffer.from(Buffer.from("assinatura-forjada-64-bytes-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").toString("base64")),
  };
  const fetchFn = (async (url: string) => {
    const k = Object.keys(respostas).find((p) => String(url).endsWith(p));
    if (!k) throw new Error(`sem fixture pra ${url}`);
    return { ok: true, arrayBuffer: async () => respostas[k]! };
  }) as unknown as typeof fetch;

  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: "b".repeat(64), log, underLauncher: true, fetchFn,
    exitFn: () => { throw new Error("NÃO deveria sair — update inválido"); },
  });
  assert.equal(r, "failed");
  assert.equal(readFileSync(selfPath, "utf8"), "BINARIO ORIGINAL", "binário foi trocado com assinatura inválida!");
});

test("verifyBundle: recusa sha divergente mesmo com assinatura válida no conjunto", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bundle = Buffer.from("conteudo do bundle");
  const sig = edSign(null, bundle, privateKey).toString("base64");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  assert.ok(edVerify(null, bundle, pubPem, Buffer.from(sig, "base64")), "primitiva ed25519 quebrada");
  // Contra o conjunto REAL de produção: chave efêmera não está na lista →
  // falha em assinatura (fail-closed) — sha correto sozinho não basta.
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.throws(() => verifyBundle(bundle, sig, sha), /assinatura/);
});

test("dual-trust: assinatura da chave A (antiga) é aceita", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const pubs = [
    a.publicKey.export({ type: "spki", format: "pem" }) as string,
    b.publicKey.export({ type: "spki", format: "pem" }) as string,
  ];
  const bundle = Buffer.from("release-stage-N");
  const sig = edSign(null, bundle, a.privateKey).toString("base64");
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.equal(signatureAccepted(bundle, sig, pubs), true);
  assert.doesNotThrow(() => verifyBundle(bundle, sig, sha, pubs));
});

test("dual-trust: assinatura da chave B (nova) é aceita", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const pubs = [
    a.publicKey.export({ type: "spki", format: "pem" }) as string,
    b.publicKey.export({ type: "spki", format: "pem" }) as string,
  ];
  const bundle = Buffer.from("release-stage-N+1");
  const sig = edSign(null, bundle, b.privateKey).toString("base64");
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.equal(signatureAccepted(bundle, sig, pubs), true);
  assert.doesNotThrow(() => verifyBundle(bundle, sig, sha, pubs));
});

test("dual-trust: assinatura de chave fora do conjunto é rejeitada", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const outsider = generateKeyPairSync("ed25519");
  const pubs = [
    a.publicKey.export({ type: "spki", format: "pem" }) as string,
    b.publicKey.export({ type: "spki", format: "pem" }) as string,
  ];
  const bundle = Buffer.from("forjado");
  const sig = edSign(null, bundle, outsider.privateKey).toString("base64");
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.equal(signatureAccepted(bundle, sig, pubs), false);
  assert.throws(() => verifyBundle(bundle, sig, sha, pubs), /assinatura/);
});

test("TRUSTED_SIGN_PUBS tem exatamente 2 entradas (antiga + nova)", () => {
  assert.equal(TRUSTED_SIGN_PUBS.length, 2);
  for (const p of TRUSTED_SIGN_PUBS) {
    assert.match(p, /BEGIN PUBLIC KEY/);
    assert.match(p, /END PUBLIC KEY/);
  }
});

test("nova chave T-006 assina e passa no conjunto real (dual-trust prod)", () => {
  const newKeyPath = path.join(os.homedir(), ".the-dudes-signing", "sign-new.key");
  assert.ok(existsSync(newKeyPath), `privada nova ausente em ${newKeyPath} — gere com openssl (T-006)`);
  const privateKey = createPrivateKey(readFileSync(newKeyPath));
  const bundle = Buffer.from("t006-new-key-vector");
  const sig = edSign(null, bundle, privateKey).toString("base64");
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.equal(signatureAccepted(bundle, sig), true, "nova deve ser aceita pelo TRUSTED_SIGN_PUBS");
  assert.doesNotThrow(() => verifyBundle(bundle, sig, sha));
});

test("antiga chave (se presente no host) ainda assina e passa no dual-trust", () => {
  // Path canônico legado; em CI sem a privada, o teste é skip lógico.
  const oldKeyPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../.signing/sign.key",
  );
  // fallback: home monorepo worktree → daemon/.signing/sign.key
  const candidates = [
    oldKeyPath,
    path.join(process.cwd(), ".signing", "sign.key"),
    path.join(os.homedir(), "Documents/eonf/projects/claudinhos/daemon/.signing/sign.key"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    // Host sem privada antiga — dual-trust da antiga fica coberto pelo teste
    // efêmero A/B. Não falha a suíte.
    return;
  }
  const privateKey = createPrivateKey(readFileSync(found));
  const bundle = Buffer.from("t006-old-key-vector");
  const sig = edSign(null, bundle, privateKey).toString("base64");
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.equal(signatureAccepted(bundle, sig), true, "antiga deve continuar aceita");
  assert.doesNotThrow(() => verifyBundle(bundle, sig, sha));
});
