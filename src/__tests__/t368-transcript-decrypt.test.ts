/**
 * T-368 — o lado do daemon do canal de transcript, com CHAVE REAL (padrão do
 * ficheiro T-365: keyring em tmpdir próprio, AES-256 wrapped pela pubkey do
 * daemon). O contrato que o premain provou partir-se: blobs CRUS entram, um
 * plaintext por blob sai na ordem; com label na frente o daemon NÃO adivinha
 * que é cifra — é por isso que o server tem de mandar o blob nu.
 *
 * Erros são constantes (TRANSCRIPT_DECRYPT_REASONS): o conteúdo do transcript
 * não entra na resposta nem, por tabela, no log do daemon (H-092).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { aadV2, E2EE_TABLE } from "@the-dudes/protocol/e2ee-fields";

process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(
  os.tmpdir(), `td-t368-pkeys-${process.pid}-${Date.now()}.json`,
);
const { getDaemonPublicKey, rememberProjectKey, encryptForProject, decryptForProject } =
  await import("../daemon-crypto.js");

const { decryptTranscriptBlobs, TRANSCRIPT_DECRYPT_REASONS } = await import("../transcript-decrypt.js");

const PID = "proj-t368";
const PID_SEM_CHAVE = "proj-t368-sem-chave";
{
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt(
    { key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes,
  );
  assert.equal(rememberProjectKey(PID, wrapped.toString("base64")), true, "chave real do teste não entrou no anel");
}

// O AAD com que o WEB sela messages.content — é o que o handler do daemon usa.
const msgAad = (pid: string) => aadV2({ projectId: pid, table: E2EE_TABLE.MESSAGES, field: "content" });

const realDecrypt = (blob: string, pid: string) => decryptForProject(blob, pid, msgAad(pid));
const MARKDOWN = "preciso de X mas decidi Y porque o contrato manda em Z";
const CIFRA = encryptForProject(MARKDOWN, PID, msgAad(PID))!;
const CIFRA_COMPLETA = encryptForProject(MARKDOWN.repeat(400), PID, msgAad(PID))!;

test("T-368: blob cru com a chave real ⇒ plaintext na ordem pedida", () => {
  const clareira = "linha que já estava em claro";
  const r = decryptTranscriptBlobs([clareira, CIFRA], { projectId: PID, hasKey: true, decrypt: realDecrypt });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.lines, [clareira, MARKDOWN], "um plaintext por blob, ordem preservada");
    assert.equal(r.cipherCount, 1);
  }
});

test("T-368: o blob longo vai inteiro — o corte de 2000 do server é do plaintext, não daqui", () => {
  const r = decryptTranscriptBlobs([CIFRA_COMPLETA], { projectId: PID, hasKey: true, decrypt: realDecrypt });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.lines[0].length, MARKDOWN.repeat(400).length, "nada foi cortado na cifra");
});

test("T-368: sem a chave ⇒ falha explícita `no_key`, sem conteúdo na razão", () => {
  const r = decryptTranscriptBlobs([CIFRA], { projectId: PID_SEM_CHAVE, hasKey: false, decrypt: realDecrypt });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "no_key");
    assert.equal(r.index, 0);
    const erro = TRANSCRIPT_DECRYPT_REASONS[r.reason];
    assert.ok(!erro.includes("e2e:") && !/[A-Za-z0-9+/]{16,}/.test(erro),
      "a razão é constante: nenhum byte de cifra ou plaintext");
  }
});

test("T-368: chave certa + blob que não autentica ⇒ `aad_or_data` (não a razão errada de antes)", () => {
  const aadErrado = aadV2({ projectId: PID, table: E2EE_TABLE.SUMMARIES, field: "summary" });
  const cifraOutra = encryptForProject(MARKDOWN, PID, aadErrado)!;
  const r = decryptTranscriptBlobs([cifraOutra], { projectId: PID, hasKey: true, decrypt: realDecrypt });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "aad_or_data", "o pré-premain dizia 'sem chave' quando a chave estava lá");
});

test("T-368 (o premain, travado): blob com label na frente NÃO é cifra para o daemon", () => {
  // É exatamente o que o server mandava: `user: e2e:v2:…`. O daemon trata-o
  // como claro e devolve-o verbatim — o guard do digest é que apanhava a
  // mentira. Este teste fixa o contrato pelo lado do daemon: quem quer o
  // decriptado manda o blob cru; o teste server garante que ele manda.
  const suja = `user: ${CIFRA}`;
  const r = decryptTranscriptBlobs([suja], { projectId: PID, hasKey: true, decrypt: realDecrypt });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.lines, [suja], "verbatim, como apanhámos no log do premain");
    assert.ok(r.lines[0].includes("e2e:"), "e é isto que o guard do digest rebentava — honesto");
    assert.equal(r.cipherCount, 0);
  }
});

test("T-368 (3): o handler do daemon LOGA o result nos dois caminhos, com corrId", () => {
  const src = readFileSync(path.join(import.meta.dirname, "../main.ts"), "utf8");
  const bloco = src.slice(src.indexOf('case "transcript:request"'), src.indexOf('case "daemon:logs:get"'));
  assert.ok(bloco.includes('log("warn", `transcript:result corrId='), "falha logada com corrId");
  assert.ok(bloco.includes('log("info", `transcript:result corrId='), "sucesso logado com corrId (antes era mudo)");
  assert.ok(!/log\([^)]*\$\{C/.test(bloco), "nenhum conteúdo no log — só corrId e contagens");
});
