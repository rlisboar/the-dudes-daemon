/**
 * T-597 F1 — fallback de abertura por TODAS as chaves detidas.
 *
 * Repro do incidente (daa1b1e6): o remetente selou com o pid de OUTRO projeto
 * (caminho direto do bridge, sem o relay) e a linha ficou no pid REAL — sem o
 * fallback o leitor dropa; com ele a mensagem ENTREGA. Fail-closed no resto.
 * Mesmo primitivo usado pelos dois caminhos do agent:send (content e parts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";
import { aadV2, E2EE_TABLE, agentSendCipherPart } from "@the-dudes/protocol/e2ee-fields";
import { assembleAgentSendParts, contentAadChain, openWithAnyHeldProject } from "../protocol.js";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t597f1-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t597f1-pkeys-${process.pid}-${Date.now()}.json`);

const {
  getDaemonPublicKey, rememberProjectKey, forgetProjectKey,
  encryptForProject, decryptForProject, isE2eEncrypted, listHeldProjectIds,
} = await import("../daemon-crypto.js");

const REAL = "proj-t597-f1-real";
const GHOST = "proj-t597-f1-ghost";
const FORA = "proj-t597-f1-fora";
for (const pid of [REAL, GHOST, FORA]) {
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  assert.equal(rememberProjectKey(pid, wrapped.toString("base64")), true);
}

const msgAad = (pid: string) => aadV2({ projectId: pid, table: E2EE_TABLE.MESSAGES, field: "content" });

/** Mesma chamada do main.ts (content path). */
const openMessage = (blob: string, linePid: string | undefined) =>
  openWithAnyHeldProject(linePid, listHeldProjectIds(), (pid) => decryptForProject(blob, pid, msgAad(pid)));

/** Mesma chamada do main.ts (content path, pós-T-649: cadeia de AAD por candidato). */
const openMessageChained = (blob: string, linePid: string | undefined) => {
  let openedAad: string | null = null;
  const opened = openWithAnyHeldProject(linePid, listHeldProjectIds(), (pid) => {
    for (const aad of contentAadChain(pid)) {
      const v = decryptForProject(blob, pid, aad);
      if (v !== null) { openedAad = aad; return v; }
    }
    return null;
  });
  return opened ? { ...opened, aad: openedAad } : null;
};

/** Mesma chamada do main.ts (parts path). */
const openParts = (parts: Parameters<typeof assembleAgentSendParts>[0], linePid: string | undefined) =>
  openWithAnyHeldProject(linePid, listHeldProjectIds(), (pid) => {
    const a = assembleAgentSendParts(parts, pid, decryptForProject, isE2eEncrypted);
    return a.ok ? a : null;
  });

test("F1: blob selado com pid FANTASMA abre com a linha no pid REAL e devolve o pid que abriu", () => {
  const blob = encryptForProject("SECURITY — mutirao de locks: liberados=4 falhas=0", GHOST, msgAad(GHOST))!;
  // Sem fallback (comportamento pré-F1): o pid da linha não abre.
  assert.equal(decryptForProject(blob, REAL, msgAad(REAL)), null);
  const opened = openMessage(blob, REAL);
  assert.ok(opened, "fallback deve abrir o blob do pid fantasma");
  assert.equal(opened.pid, GHOST);
  assert.equal(opened.value, "SECURITY — mutirao de locks: liberados=4 falhas=0");
});

test("F1: quando a linha abre, o pid da linha vence (candidatos nem são consultados)", () => {
  const blob = encryptForProject("na linha", REAL, msgAad(REAL))!;
  const vistos: string[] = [];
  const opened = openWithAnyHeldProject(REAL, listHeldProjectIds(), (pid) => {
    vistos.push(pid);
    return decryptForProject(blob, pid, msgAad(pid));
  });
  assert.ok(opened);
  assert.equal(opened.pid, REAL);
  assert.deepEqual(vistos, [REAL]);
});

test("F1: fail-closed — nenhum candidato abre → null", () => {
  // Sela com a chave de FORA e depois esquece: o blob fica sem chave detida.
  const blob = encryptForProject("sem chave", FORA, msgAad(FORA))!;
  forgetProjectKey(FORA);
  assert.equal(openMessage(blob, REAL), null);
  assert.equal(openMessage(blob, undefined), null);
});

test("F1: linha SEM pid também varre os detidos (entry antigo)", () => {
  const blob = encryptForProject("sem pid na linha", GHOST, msgAad(GHOST))!;
  const opened = openMessage(blob, undefined);
  assert.ok(opened);
  assert.equal(opened.pid, GHOST);
  assert.equal(opened.value, "sem pid na linha");
});

test("F1: parts de dispatch seladas com pid fantasma abrem via fallback (mission step)", () => {
  const descAad = aadV2({ projectId: GHOST, table: E2EE_TABLE.TASKS, field: "description" });
  const blob = encryptForProject("faça o passo do dispatch", GHOST, descAad)!;
  const parts = [
    { kind: "plain" as const, text: "dispatch: " },
    agentSendCipherPart(blob, E2EE_TABLE.TASKS, "description"),
  ];
  // Sem fallback: a linha (REAL) não abre o cipher do fantasma.
  const direto = assembleAgentSendParts(parts, REAL, decryptForProject, isE2eEncrypted);
  assert.equal(direto.ok, false);
  const opened = openParts(parts, REAL);
  assert.ok(opened, "fallback deve abrir o dispatch selado com o pid fantasma");
  assert.equal(opened.pid, GHOST);
  assert.equal(opened.value.content, "dispatch: faça o passo do dispatch");
});

test("T-649: content selado em tasks.description abre pela cadeia (dispatch de step)", () => {
  const descAad = aadV2({ projectId: REAL, table: E2EE_TABLE.TASKS, field: "description" });
  const blob = encryptForProject("TASK_ASSIGN — passo do dispatch", REAL, descAad)!;
  // F1 puro (só messages.content): não abre — era o drop do caso vivo.
  assert.equal(openMessage(blob, REAL), null);
  const opened = openMessageChained(blob, REAL);
  assert.ok(opened, "cadeia deve abrir o blob selado com o AAD de tasks.description");
  assert.equal(opened.pid, REAL);
  assert.equal(opened.aad, descAad, "o aad devolvido é o que abriu (para o log)");
  assert.equal(opened.value, "TASK_ASSIGN — passo do dispatch");
});

test("T-649: sem regressão — fantasma d9868ba6 (messages.content) segue abrindo com o aad canônico", () => {
  const blob = encryptForProject("linha do fantasma", GHOST, msgAad(GHOST))!;
  const opened = openMessageChained(blob, REAL);
  assert.ok(opened, "pid fallback segue funcionando junto com a cadeia");
  assert.equal(opened.pid, GHOST);
  assert.equal(opened.aad, msgAad(GHOST), "abre pelo AAD canônico do pid que abriu");
  assert.equal(opened.value, "linha do fantasma");
});

test("T-649: fail-closed — AAD fora do conjunto segue dropando", () => {
  const foraAad = aadV2({ projectId: REAL, table: E2EE_TABLE.TASKS, field: "title" });
  const blob = encryptForProject("title solto", REAL, foraAad)!;
  assert.equal(openMessageChained(blob, REAL), null);
  assert.equal(openMessageChained(blob, undefined), null);
});

test("T-649: canônico vence — messages.content é a 1ª entrada da cadeia", () => {
  assert.equal(contentAadChain(REAL)[0], msgAad(REAL));
  const blob = encryptForProject("canônico", REAL, msgAad(REAL))!;
  const opened = openMessageChained(blob, REAL);
  assert.ok(opened);
  assert.equal(opened.aad, msgAad(REAL));
  assert.equal(opened.value, "canônico");
});

test("F1: ordem — tenta o pid da linha primeiro e não repete candidato igual", () => {
  const vistos: string[] = [];
  const opened = openWithAnyHeldProject("A", ["A", "B", "C"], (pid) => {
    vistos.push(pid);
    return pid === "B" ? "ok" : null;
  });
  assert.ok(opened);
  assert.equal(opened.pid, "B");
  assert.deepEqual(vistos, ["A", "B"]);
});

test("cleanup T-597 F1 keys", () => {
  forgetProjectKey(REAL);
  forgetProjectKey(GHOST);
  forgetProjectKey(FORA);
});