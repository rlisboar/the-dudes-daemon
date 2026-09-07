/**
 * T-365 — seed de migração sob E2EE, com CHAVE REAL criada no teste.
 *
 * O defeito: o `summarize:result` devolve o digest já cifrado (canal correcto),
 * o server montava a secção com esse ciphertext e entregava o seed cru ao
 * runner — que receberia `<migrated-context>e2e:v2:…</migrated-context>` e
 * responderia a base64. Nada disto disparava nos testes porque nenhum tinha uma
 * chave de projeto no meio; este ficheiro é precisamente a chave no meio.
 *
 * Criterios do contrato: (1) com chave, o primeiro input é markdown em claro sem
 * marcador `e2e:`; (2) sem chave, nada é injectado + warn + 1 evento; (3) o gate
 * de 8 KB é medido no PLAINTEXT e corta no daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aadV2, E2EE_TABLE, MIGRATE_SEED_DROPPED_REASON, MIGRATE_SEED_RESUME_SKIPS_REASON,
  METADATA_AGENT_ERROR_TEXTS, isMetadataAgentErrorText,
} from "@the-dudes/protocol/e2ee-fields";

// Anel de chaves do teste em ficheiro próprio: nada herdado do daemon real.
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(
  os.tmpdir(), `td-t365-pkeys-${process.pid}-${Date.now()}.json`,
);
const { getDaemonPublicKey, rememberProjectKey, encryptForProject, decryptForProject } =
  await import("../daemon-crypto.js");

const PID = "proj-t365";
const PID_SEM_CHAVE = "proj-t365-sem-chave";
{
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt(
    { key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes,
  );
  assert.equal(rememberProjectKey(PID, wrapped.toString("base64")), true, "chave real do teste não entrou no anel");
}

const { migratedSeedFor, MIGRATED_SEED_LIMIT_BYTES, wrapMigratedContext } = await import("../migrated-seed.js");
import type { AgentInfo } from "../types.js";

const FROM = { runner: "claude", model: "sonnet", ts: Date.parse("2026-09-07T05:00:00Z") };
const MARKDOWN = "# Migração de contexto\n\n## Acoes recentes (sumario)\nfez X e decidiu Y";

/** Exatamente o AAD com que o daemon sela o resumo no summarize:result. */
const summaryAad = (pid: string) => aadV2({ projectId: pid, table: E2EE_TABLE.SUMMARIES, field: "summary" });

function agentCom(seedDigest: string): AgentInfo {
  return { id: "a1", name: "a", usage: {}, seedDigest, seedFrom: FROM } as unknown as AgentInfo;
}

const ctxReal = (pid: string = PID) => ({
  projectId: pid,
  decrypt: (blob: string, projectId: string) => decryptForProject(blob, projectId, summaryAad(projectId)),
});

test("T-365: o digest cifrado que o server recebe é mesmo e2e:v2: (é isto que mentia no runner)", () => {
  const blob = encryptForProject(MARKDOWN, PID, summaryAad(PID));
  assert.ok(blob && blob.startsWith("e2e:v2:"), "o canal do summarize não selou como esperado");
});

test("T-365 (1): com chave real, o seed é markdown em claro e a tag cerca o texto, não o base64", () => {
  const blob = encryptForProject(MARKDOWN, PID, summaryAad(PID))!;
  const r = migratedSeedFor(agentCom(blob), undefined, ctxReal());
  assert.equal(r.dropped, false);
  assert.equal(r.truncated, false);
  const seed = r.seed ?? "";
  assert.ok(seed.includes(MARKDOWN), "o runner vê o markdown do digest");
  assert.ok(!seed.includes("e2e:"), "nenhum marcador de cifra chega ao prompt");
  const tag = wrapMigratedContext(MARKDOWN, FROM);
  assert.equal(seed, tag, "o embrulho é do daemon, depois do decripto");
  assert.ok(
    seed.indexOf("<migrated-context") < seed.indexOf("# Migração de contexto"),
    "a tag abre antes do conteúdo — nunca à volta de base64",
  );
});

test("T-365 (1b): a instrução do quem-migrou vai depois do bloco, em claro", () => {
  const blob = encryptForProject(MARKDOWN, PID, summaryAad(PID))!;
  const agent = { ...agentCom(blob), seedInstruction: "retoma a task T-9" } as AgentInfo;
  const r = migratedSeedFor(agent, undefined, ctxReal());
  assert.ok(r.seed!.endsWith("retoma a task T-9"));
  assert.ok(!r.seed!.includes("e2e:"));
});

test("T-365: o AAD é o do summarize — o blob da secção das mensagens não abre", () => {
  const blob = encryptForProject(MARKDOWN, PID, summaryAad(PID))!;
  const aadErrado = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" });
  assert.equal(decryptForProject(blob, PID, aadErrado), null, "AAD errado tinha de falhar");
  const r = migratedSeedFor(agentCom(blob), undefined, {
    projectId: PID,
    decrypt: (b, pid) => decryptForProject(b, pid, aadErrado),
  });
  assert.equal(r.seed, undefined);
  assert.equal(r.dropped, true, "chave certa + AAD errado é queda, não injecta base64");
});

test("T-365 (2): sem a chave do projeto, nada é injectado — e o host avisa o dono", async () => {
  const blob = encryptForProject(MARKDOWN, PID, summaryAad(PID))!;
  const r = migratedSeedFor(agentCom(blob), undefined, ctxReal(PID_SEM_CHAVE));
  assert.equal(r.seed, undefined, "sem chave não há seed a injetar");
  assert.equal(r.dropped, true, "o chamador tem de saber que caiu, para avisar");

  // O aviso ao dono é no host (não é decidível nesta função pura): travado na
  // estrutura do fonte, mesmo molde de t147-context-unknown.test.ts.
  const src = readFileSync(path.join(import.meta.dirname, "../agent-host.ts"), "utf8");
  const dropped = src.indexOf("seedResult.dropped");
  const flush = src.indexOf("flushInboundBuffer", dropped);
  const warn = src.indexOf('this.log(\n        "warn"', dropped);
  const evento = src.indexOf("MIGRATE_SEED_DROPPED_REASON", dropped);
  assert.ok(dropped > 0 && warn > dropped && warn < flush, "branch do seed caído tem de registar warn");
  assert.ok(evento > dropped && evento < flush,
    "e entregar 1 evento de metadados fixos ao dono, antes do flush da fila");
  assert.ok(src.slice(dropped, flush).includes("MIGRATE_SEED_RESUME_SKIPS_REASON"),
    "T-370: o ramo do resume usa a SUA constante, não a do no_key");
  assert.ok(!src.slice(dropped, flush).includes("this.emitAgentError("),
    "emitAgentError sela — e sem chave o selo falha e o evento era DROPADO; o garantido vai sem selo");
});

test("T-365/H-092: o motivo do evento garantido é constante, e a lista de exceção é fechada", () => {
  assert.ok(!MIGRATE_SEED_DROPPED_REASON.includes("e2e:"),
    "o metadado não carrega marcador de cifra nem parece cifra");
  assert.equal(METADATA_AGENT_ERROR_TEXTS.length, 2,
    "a lista de texto-nu-permitido-em-e2ee-required cresce só com revisão — cada entrada é um furo no guard");
  assert.equal(isMetadataAgentErrorText(MIGRATE_SEED_DROPPED_REASON), true);
  assert.equal(isMetadataAgentErrorText(MIGRATE_SEED_RESUME_SKIPS_REASON), true, "T-370: o primo do no_key");
  assert.equal(isMetadataAgentErrorText(`${MIGRATE_SEED_DROPPED_REASON} ${MARKDOWN}`), false,
    "comparação EXATA: concatenar conteúdo volta a ser claro proibido");
});

test("T-365 (3): o gate de 8 KB é medido no PLAINTEXT e o corte acontece no daemon", () => {
  // Cifrado, este digest cabe nos 8 KB que o server mede; em plaintext estoura.
  const volumoso = `# Migração de contexto\n\n${"linha de contexto de migração, sempre a mesma. ".repeat(400)}`;
  assert.ok(
    Buffer.byteLength(volumoso, "utf8") > MIGRATED_SEED_LIMIT_BYTES,
    "o fixture tinha de estourar o limite em plaintext",
  );
  const r = migratedSeedFor(agentCom("e2e:placeholder"), undefined, {
    projectId: PID,
    decrypt: () => volumoso,
  });
  assert.equal(r.dropped, false);
  assert.equal(r.truncated, true, "tem de reportar o corte, não calado");
  assert.ok(r.seed!.includes("…[cortado]"), "corte visível no que o runner lê");
  const conteudo = r.seed!.replace(/^<migrated-context[^>]*>\n/, "").replace(/\n<\/migrated-context>$/, "");
  assert.ok(
    Buffer.byteLength(conteudo, "utf8") <= MIGRATED_SEED_LIMIT_BYTES + 32,
    `conteúdo injetado tem de caber no limite (foi ${Buffer.byteLength(conteudo, "utf8")})`,
  );
});

test("T-370: sessão viva COM seed pendurado é queda declarada, nunca silêncio", () => {
  const blob = encryptForProject(MARKDOWN, PID, summaryAad(PID))!;
  const r = migratedSeedFor(agentCom(blob), "sessao-viva", ctxReal());
  assert.equal(r.seed, undefined);
  assert.equal(r.dropped, true, "o premain comeu o seed em silêncio exactamente aqui");
  if (!r.dropped) throw new Error("tipo: resume+seed tem de ser queda");
  assert.equal(r.reason, "resume_skips_seed");
  // Sem seed em espera, o resume é o caminho normal (troca só de modelo).
  const semSeed = migratedSeedFor(agentCom(undefined), "sessao-viva", ctxReal());
  assert.equal(semSeed.dropped, false);
});

test("T-365: o servidor deixou de embrulhar — só o daemon escreve a tag", () => {
  const server = readFileSync(
    path.join(import.meta.dirname, "../../../server/src/agent-migrate.ts"), "utf8",
  );
  // Comentários podem FALAR na tag (é assim que a restrição fica documentada);
  // o que não podem é conter o literal em código.
  const code = server.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!code.includes("migrated-context"),
    "se o server voltar a montar a tag, volta a cercar ciphertext sob E2EE");
});
