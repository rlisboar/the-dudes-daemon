/**
 * T-718 (P0, SEGURANÇA E2EE): propriedade — decrypt que não autentica devolve
 * null, SEMPRE. Antes (leitura tolerante #596) 0,05% dos casos com AAD errado
 * ou ciphertext adulterado voltavam como texto (medido na T-709, 20.000 its).
 * 20.000 iterações por classe, sobre as funções reais do daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { constants, createPublicKey, publicEncrypt, randomBytes, randomInt } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t718-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t718-keys-${process.pid}-${Date.now()}.json`);

const c = await import("../daemon-crypto.js");
const { aadV2, E2EE_TABLE } = await import("@the-dudes/protocol/e2ee-fields");

const PID = "proj-t718";
{
  const pub = createPublicKey({ key: Buffer.from(c.getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(c.rememberProjectKey(PID, wrap.toString("base64")), true);
}
const N = 20_000;
const RIGHT = aadV2({ projectId: PID, table: E2EE_TABLE.PLANS, field: "title" });
const WRONG = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
const V2 = "e2e:v2:";

/** Silencia o warn de falha (esperado 20k vezes) e conta as linhas. */
function quiet<T>(fn: () => T): T {
  const orig = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = orig; }
}
const raw = (blob: string) => Buffer.from(blob.slice(V2.length), "base64");
const pack = (b: Buffer) => V2 + b.toString("base64");
/** Texto variado (1-80 chars, com multibyte) para não depender de um plaintext. */
const texto = (i: number) => `Plano ${i} — ação ${"x".repeat(i % 60)}`;

test(`T-718 propriedade: AAD errado → 100% null (${N} iterações)`, () => {
  let aceitos = 0;
  quiet(() => {
    for (let i = 0; i < N; i++) {
      const blob = c.encryptForProject(texto(i), PID, RIGHT) as string;
      if (c.decryptForProject(blob, PID, WRONG) !== null) aceitos++;
    }
  });
  assert.equal(aceitos, 0, `${aceitos}/${N} devolveram texto com AAD errado`);
});

test(`T-718 propriedade: ciphertext adulterado em 1 bit (AAD certo) → 100% null (${N} iterações)`, () => {
  let aceitos = 0;
  quiet(() => {
    for (let i = 0; i < N; i++) {
      const b = raw(c.encryptForProject(texto(i), PID, RIGHT) as string);
      const ctLen = b.length - 12 - 16;
      b[12 + randomInt(ctLen)] ^= 1 << randomInt(8);
      if (c.decryptForProject(pack(b), PID, RIGHT) !== null) aceitos++;
    }
  });
  assert.equal(aceitos, 0, `${aceitos}/${N} adulterados aceitos`);
});

test(`T-718 propriedade: tag adulterada em 1 bit (AAD certo) → 100% null (${N} iterações)`, () => {
  let aceitos = 0;
  quiet(() => {
    for (let i = 0; i < N; i++) {
      const b = raw(c.encryptForProject(texto(i), PID, RIGHT) as string);
      b[b.length - 16 + randomInt(16)] ^= 1 << randomInt(8);
      if (c.decryptForProject(pack(b), PID, RIGHT) !== null) aceitos++;
    }
  });
  assert.equal(aceitos, 0, `${aceitos}/${N} com tag adulterada aceitos`);
});

test(`T-718 propriedade: truncado (tag cortada no todo ou em parte) → 100% null`, () => {
  // Cortar SÓ padding base64 ('='/'==') não muda os bytes decodificados: o
  // blob continua íntegro e autêntico. O corte que conta tira DADO.
  let aceitos = 0, cortesDeDado = 0;
  quiet(() => {
    for (let i = 0; i < 2_000; i++) {
      const blob = c.encryptForProject(texto(i) + " corpo longo o suficiente para cortar", PID, RIGHT) as string;
      const corte = 1 + randomInt(Math.min(40, blob.length - V2.length - 1));
      const cortado = blob.slice(0, blob.length - corte);
      const r = c.decryptForProject(cortado, PID, RIGHT);
      if (raw(cortado).equals(raw(blob))) {
        assert.equal(r, texto(i) + " corpo longo o suficiente para cortar", "só padding cortado: mesmos bytes, autêntico");
        continue;
      }
      cortesDeDado++;
      if (r !== null) aceitos++;
    }
  });
  assert.ok(cortesDeDado > 1_800, `amostra de cortes de dado=${cortesDeDado}`);
  assert.equal(aceitos, 0, `${aceitos}/${cortesDeDado} truncados aceitos`);
});

test("T-718 (vetores da T-719/SECURITY): tag REMOVIDA com base64 re-codificado válido → 100% null, com/sem XOR no corpo, com/sem AAD errado", () => {
  // O vetor real do #596: sem tag nada autentica. O server (sem a chave)
  // apagava a tag e forjava por XOR no corpo, ou movia o blob de campo.
  let aceitos = 0;
  quiet(() => {
    for (let i = 0; i < 5_000; i++) {
      const plain = texto(i) + " — corpo com mais de 16 bytes";
      const b = raw(c.encryptForProject(plain, PID, RIGHT) as string);
      const semTag = Buffer.from(b.subarray(0, b.length - 16));
      const forjado = Buffer.from(semTag);
      forjado[12 + randomInt(semTag.length - 12)] ^= 1 << randomInt(8);
      for (const [blob, aad] of [[semTag, RIGHT], [semTag, WRONG], [forjado, RIGHT]] as const) {
        if (c.decryptForProject(pack(blob), PID, aad) !== null) aceitos++;
      }
    }
  });
  assert.equal(aceitos, 0, `${aceitos}/15000 aceitos sem tag`);
});

test("T-718: anexos (decryptBytesForProject) seguem estritos no mesmo vetor", () => {
  const blob = c.encryptBytesForProject(Buffer.from("imagem-bytes-" + "x".repeat(40)), PID, aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "images" })) as string;
  const b = raw(blob);
  const semTag = pack(b.subarray(0, b.length - 16));
  quiet(() => assert.equal(c.decryptBytesForProject(semTag, PID, aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "images" })), null));
});

test("T-718: controle — íntegro com AAD certo abre (a propriedade não passa por decrypt quebrado)", () => {
  for (let i = 0; i < 200; i++) {
    const blob = c.encryptForProject(texto(i), PID, RIGHT) as string;
    assert.equal(c.decryptForProject(blob, PID, RIGHT), texto(i));
  }
});

test("T-718: decryptPartialWithRawKey não existe mais no daemon (grep)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../daemon-crypto.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /decryptPartialWithRawKey/);
  assert.doesNotMatch(src, /decipher\.update\([^)]*\)\s*\.toString/, "nenhum update() sem final()");
});
