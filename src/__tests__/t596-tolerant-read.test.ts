/**
 * #596 → T-718: blob TRUNCADO no write NÃO é mais lido "tolerante".
 *
 * As 4 fixtures são blobs REAIS do board (#105/task_9b424641 e #106/task_8dbdaa43): os 2
 * truncados originais (o write cortou o base64 no meio do quantum e levou o
 * tag do GCM) e os 2 reparados (íntegros). A chave AES do projeto é a real,
 * re-embrulhada com a pubkey do daemon de teste — o teste é hermético.
 *
 * O #596 decifrava o corpo sem o tag (update sem final) e devolvia o parcial.
 * Sem tag não há autenticação: o mesmo caminho aceitava AAD errado e
 * ciphertext adulterado (T-709/T-718: 0,05% cada). Contrato agora: autentica
 * ou null. O truncado vira erro VISÍVEL no log (kind/tamanho, sem conteúdo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t596tol-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t596tol-keys-${process.pid}-${Date.now()}.json`);

const { getDaemonPublicKey, rememberProjectKey, decryptForProject } = await import("../daemon-crypto.js");
const { aadV2 } = await import("@the-dudes/protocol/e2ee-fields");

const PID = "proj_d0d9a3f8";
const AAD_DESC = aadV2({ projectId: PID, table: "tasks", field: "description" });

function carrega(pid: string, chaveB64: string): void {
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(chaveB64, "base64"));
  assert.equal(rememberProjectKey(pid, wrap.toString("base64")), true);
}
carrega(PID, "IU4XQywwRRcD5xROC4Tj3WPQzFS5+keLf5iWtT1ISJc=");
carrega("proj-t596-outro", randomBytes(32).toString("base64"));

const T105_TRUNCADO = "e2e:v2:AurxsQaBq6gPo2QzdcNgCGgauSKPlV1qM7y4bCkr08ofelps71trat+1rlFojchNHqYVQ0Qi+y8DhCODE173h3ezZM8plQrX5dzcYywpyFQAgZ1yNPVS8EzdVp2pLMtE+Ba0BgZBjsLMdpc8lbCM2lIescBds6oyCI/0L56QFgmYLVCH+GTUKdEUFblQHq7KsuCf70UeJ7kMO65oWmWvUrmauxF7sCdKN5rrPg50qmufJ3RUjEpkferqaEpnQ/HruBrKiC95jMWeXOb1rpPzs8jHKL9V/bVIzYqWcteuzSbLyREHFNnyYjlNNV221kM51zfkOPZYfvcui+wAJhmZNstiijhVeEvhKkX/BAD1Gtj6vZ6gyOQQCkv+GTxhFFZ8noQ+w4HxzlJMYWI1l7rxGQwzmRJOo/3Bq702yHSz2jsFqKpJJKRBCVOWVhO+k6D35VIDsaLbDm89CJa0pUeQI4VQvsMFNyPjWjS/F5NM4V68oheyFdFYdmkXTCd+V4E5bkF+j5Dxrem6StjW2M04osDL9YdiCfWoLwv2DC/kJUJtHFEI1mQKEYO7wd9ciKXhd0Inz/4zbQ67XtBkb+Y2yOL08y8FrhzUv2sWfV5TUsHJ3iEQvavk8VANM/wGPfhvabVJXtZrKW9iq4fnB1H6pD5qcXf2GtbCiutan8SnHraxmO3yx2Ew4FcJmN2hC4UqeTwqtC/xrQOlJX+MOX1wWcwFneOgDROvOah4XgupRAMgzA/qrOwVky2AgcnyespQQcqqkzxltckfyGlsDqcgjtSCODf8JhLln0XEIOjOWqwYIabZI95dsqKZGAs2TXMYuHI+Dlpn6enXuu+yJlEM4+csvpZYpZKDcVupnyU/VGKpF/eRmtNyr2kUHFnZTXfbGWbycjMYicRABn4ckj7HwuGBg0mMTLBaCCt4+1/mNyfNqt+mzg506GgO2LuPiKJK9KhDaasXvzu1c/52wjqjR+Qxc6RxdeErDLyn1aosU3L+fB79kxbMeN5yHaLiLxykRi87PQ8G9XuofLKPaOb6f78z0TzpfgwKLO7Zjcq8FcW8eImef/eELcnL5xslMg2SddC10OgOsvZjdMRNsn8ATv1JRc9y7WYna5mFoDx/z/dCqSjeJK0JEwK8Serk9MSdg0GDdg4/hYPmQeIOAH/om0jWkpD3VVNc+38aw70LIZHCkvv6O4n73gf6OtXO7mUnVtE8YN9C5l4Kr6ovtbEIMcKuFLXEgewWTc6aK9I2jdNJk+96iyuUjoDeR46uGurHL6h/kEVYdW8YcPE+ly229adrvoq9Inv5JQe30kKrZgUDWoiq6ciDPNQu4N1NpJGah2HLklQFK8ggNXJrroBZtYODi2HIJsVBIdZTQaSCHmtHcegSbMFxKbiHg/0GsLvFNaKiHDuBDmDqBKconr8R/rutrp55DUP4V1qmTxWzhKQ/jWd76F8roA6L/tgSSkiZznbHiJ7e41KzrgSSAI3GaG0Xk1aurbDSKvYNymvE5GxTzHehJIUBv9kSFOd3+QjQmIsGfTYHHsyN/SzSX8aIN52jQPOZ9RlGLwawZ3beeDnK+/B1h3HJsfhpDjIXHg/6BDq/qxp7KdIYYYWp97Z9PBQUcrGrZ/J9rfqokqJb8IYfYsApvePcRPp3FcQl+7qHWhFr3QII0fthBp3Oe0BOGyrwZDQpsVz4D2ZZByerBWrDApySG5Ig/WZoNUCVCmyJ1wUVgpIKYX+aZqynbuAUP6Lv/KiVLP2+fy0mXIwfYGrU3L2J4YO9FIBRLsAqsOj6gaXVdk00y3vxrKrCQXtMxr3xXJHz0SFgfYbldhUGvpGP93lCVXZauz8Y6S5q2qw/S7G9WObrtAiR3IfClHCQTBJXANyVzlz+Ynp+71qz4LgVldTxawRxkSdur7VEg4mYQEYyF1aa68z4VjJXJlPHOw/kNSfIF2UhNojkyzSXpfVqu7/nJX8QlNXuuTAEGI8J91byLRrKD";
const T105_INTACTO = "e2e:v2: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";
const T105_HEAD = "Pré-requisito do T-091 (SEC-05). Decisão PM na QUESTION do F";
const T105_TAIL = "ase f59a710. SEM merge/assinatura/deploy sem GO. DELIVERY→PM";
const T105_LEN = 1456;

const T106_TRUNCADO = "e2e:v2:FJ3VJvvDCezIPUdFcLOQejfV9PYoHn+Qny/Xaae4koNQEp2ZtbsPMrWlZ7kdRHelDrzpgM2eQDAcgvFsDHLlE+Rbp6zDYKTDvTJjDDIC9tVpFL281YwGcD+2lDAIjwJD6fBS0DJXPcY244Xp4n2cin3/Jwux/uW+0bCVjz/MXGTi5JnpjbsWVOhuK27f+zkmTN9LAqQuJJjBvEBKOSPNpqWO37VgLGwGc9IDnGrdZfSrbceHDe8O/Mlmk7MozJF98t4xPL3yuCvKrK3Hi1z0tPtFsAmeiHaan6gZhDdrr3CxwgVf4ulbzuzquUbscspJAcEZDQltAzgQ5L2Fe3Y8WvrcvpI2KlN79nA6K0+4KqZiuRNa1p4VOUY7eAXeV9ZCtSVdGQg0njop6R5hOiJJOh078S41h1MyqBE0b/Hu0hwA1UoCN94aX0+Po2Jfn3BiKDdlrG6KHCkd7yIwZnRuG+AmS/UVmSfYHfy2fSEUwlKwhCvd9iTsTpcPvbkDISW0jTByGIH3VMZdr4FQoBZUyJW/UgRpmsTdcvTIdBAg99Tt3FtAX7gOE2Z9nNuyDgFumvHGF0/RBWznFkTdkN7qLzOsIpTrRzKUkkz9ll0O2bSLV6FyTFO6pGsFD2BJCHul9BY+loO4Mgfo2d1r4Q52De5URvuv/1uCa4JYBdw2I5azNx2eJZOJcyDAJZVz/XAWaRH1LkFhNEyCLYkWAVpaxRMlNzKR0k+j+uFPI+HwlPKsz9IvDe+UDr4mF2XleVWQ8KXrv1kblEe2TnP5IsLgwTFyfi8W8VSXHFRms2pcGFd8jGgr6K9QnhhZSCyiclNTD2WWXTf3GqDH788K6qadMdfT8zoomSLdQezn7hVIMs7u66rkZocsr56iZfkS4/fRaXLR/t8i20dN8ykvDvJtmB6r3Iln2pPSculj6FdM+Kl9lsffbaycP2Oo4VcAbo3jbqYIXVvA5nWvjSa2mn8k07Ha6nBcgPiY9DgaU2q5t3XBcCTwwrwka/Rw4oj13PDPr/Y5Ye5y0/1mKph6jJJq329aE0WVRxlnb3YMaUO8egIFttMDwUxVR/FxJ/dxBprYfUDcEN4eqK1+/rwdGyJUAD1ZL6t7+WTU6nVRVsDva//fl/8UgSu6zJPNDmpKePAZbgMp6/T6NmCF/4w9kAntBTevovX7fGSYAAs3/FgueNgyHRwz00a0stzsjHCYi8fgwSs68y/8OOJO8V7HIYmp3yjT480vJj3vsbvsydrgscwFlOWq3AaAPnf/5k0y5jkMYqVYsVWBxYYuddXufVThIwSnsA8tqnDREiLYvO1zie4a4kDMB8PZanK6OOJF7ifTbXsIOAavGjz2u+WahC5uRkJT49L/OwABhXPny2QyOQ7S+TV/7dzdp0zIsVkU3gjYvrA94yXkz/4af/EC8dd/J33bt7w4dD9oE9iKAXhkgOCNKIvmKyHjhObqikR8obCKEvHRfUhyWx6QlD15tM33N6+4eFPlip4Q2P/19mAT2eWA4/A28uRCXkPfoaym0uKIblm/QG0oYkfoN7bzF9flsj1Ui9aIVWuHhgbkP8SYLaX00YzJJM4/kQlOysN7+v9hnbA6KTqr6z6a37lAuzom7gPlp0OxTn+BISO2nBTFiX0bKNg0MK5Z81mPTKGscZgiuw/T5Men04Wwkk3M3948VL3bOpOfdzfR8XcP+uY97SC2BTmPKFVbBQRUzXnz1JEPyBqA3gh+CAREzRyrwKzmPdsx2rhAbUBYyR0BVsIR1hNMM4aZFCg0YSuUqBArAFN2yfin6RT41xKA/Vquz4FAJEu/5/GnYFFfsG8u8vJ3DlHtZjvt+5bp6SG5N4IaIPIOlZzNofL02GR9rleQjNieZyTUofK9ylCDbEBGWdZYOFGs4wWD6JxsUeV4IgHesYs1D7aj0qLW1hux4ds4wjBEAkZ7sq4eQRj8e1czj8IfBPGXWWXIrYSNXkBwrHvy8lj731SIeq7pN";
const T106_INTACTO = "e2e:v2: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";
const T106_HEAD = "Origem: observações MEDIA/BAIXA do QA no PASS do T-102. Camp";
const T106_TAIL = "base/stack sobre T-102 se precisar do clipCatalog exportado ";
const T106_LEN = 1452;

test("fixtures: os 2 truncados são mesmo truncados (len 2000, base64 %4==1, sem padding)", () => {
  for (const b of [T105_TRUNCADO, T106_TRUNCADO]) {
    assert.equal(b.length, 2000);
    assert.equal((b.length - 7) % 4, 1, "base64 cortado no meio do quantum");
    assert.ok(b.startsWith("e2e:v2:"));
    assert.ok(!b.endsWith("="));
  }
});

function capturaWarn<T>(fn: () => T): { out: T; warns: string[] } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  try { return { out: fn(), warns }; } finally { console.warn = orig; }
}

test("T-718: blob truncado → null + log de erro com kind e tamanho, SEM conteúdo", () => {
  for (const [blob, head, tail] of [[T105_TRUNCADO, T105_HEAD, T105_TAIL], [T106_TRUNCADO, T106_HEAD, T106_TAIL]] as const) {
    const { out, warns } = capturaWarn(() => decryptForProject(blob, PID, AAD_DESC));
    assert.equal(out, null, "sem tag não autentica: nunca devolve texto");
    const w = warns.join("\n");
    assert.match(w, /decrypt failed for proj_d0d9a3f8/);
    assert.match(w, new RegExp(`kind=${AAD_DESC.replace(/\|/g, "\\|")}`), "kind (AAD) no log");
    assert.match(w, /len=2000 /, "tamanho no log");
    assert.match(w, /suspeita=truncado/, "o formato (base64 fora do quantum) aponta o corte");
    assert.ok(!w.includes(head.slice(0, 20)) && !w.includes(tail.slice(-20)), "nenhum conteúdo no log");
  }
});

test("T-718: íntegros (reparados) seguem abrindo pelo caminho autenticado", () => {
  const i105 = decryptForProject(T105_INTACTO, PID, AAD_DESC);
  const i106 = decryptForProject(T106_INTACTO, PID, AAD_DESC);
  assert.equal(i105!.length, T105_LEN);
  assert.ok(i105!.startsWith(T105_HEAD) && i105!.endsWith(T105_TAIL));
  assert.equal(i106!.length, T106_LEN);
  assert.ok(i106!.startsWith(T106_HEAD) && i106!.endsWith(T106_TAIL));
});

test("T-718: corte arbitrário do íntegro → null (não devolve prefixo)", () => {
  // Corta DADO: o padding base64 ('=') não carrega bytes (cortá-lo mantém o blob íntegro).
  const semPad = T105_INTACTO.replace(/=+$/, "");
  for (const corte of [1, 16, 17, 60, 400]) {
    const { out } = capturaWarn(() => decryptForProject(semPad.slice(0, semPad.length - corte), PID, AAD_DESC));
    assert.equal(out, null, `corte de ${corte} chars`);
  }
});

test("T-718: AAD errado e chave errada → null (truncado e íntegro)", () => {
  const aadErrado = aadV2({ projectId: PID, table: "tasks", field: "title" });
  capturaWarn(() => {
    assert.equal(decryptForProject(T105_TRUNCADO, PID, aadErrado), null);
    assert.equal(decryptForProject(T105_INTACTO, PID, aadErrado), null);
    assert.equal(decryptForProject(T105_TRUNCADO, "proj-t596-outro", aadV2({ projectId: "proj-t596-outro", table: "tasks", field: "description" })), null);
  });
});
