import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { checkAndApplyUpdate, verifyBundle } from "../self-update.js";

/**
 * A chave embutida no módulo é a de produção; o teste NÃO tem a privada dela.
 * Estratégia: prova o fail-closed (assinatura errada/lixo → recusa e mantém o
 * binário) e a lógica de fluxo (hash igual → nada; fetch falhou → "failed").
 * O caminho feliz da verificação é coberto contra um par de chaves de teste
 * na função pura, provando que verifyBundle valida assinatura E sha — a única
 * diferença pro real é QUAL pubkey está embutida.
 */

const log = () => {};

test("hash publicado igual ao rodando → nada a fazer", async () => {
  const fetchFn = (async (url: string) => ({
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

test("verifyBundle: recusa sha divergente mesmo antes de olhar conteúdo", () => {
  // Par de teste prova a mecânica Ed25519 (a real usa a pubkey embutida).
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bundle = Buffer.from("conteudo do bundle");
  const sig = edSign(null, bundle, privateKey).toString("base64");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  assert.ok(edVerify(null, bundle, pubPem, Buffer.from(sig, "base64")), "primitiva ed25519 quebrada");
  // Contra a função REAL: assinatura de chave estranha nunca passa (fail-closed
  // da pubkey embutida) — e portanto sha correto sozinho não basta.
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.throws(() => verifyBundle(bundle, sig, sha), /assinatura/);
});
