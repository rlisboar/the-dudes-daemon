/**
 * T-252 (P1-6 da auditoria T-205): o deliveryId de agent:send era marcado
 * como visto ANTES do decrypt — se o decrypt falhasse (chave em rotação /
 * wrap ainda não entregue), o retry do server (mesmo deliveryId, T-037) era
 * descartado como duplicata e a mensagem se perdia.
 *
 * Guia o DaemonClient REAL (seam THE_DUDES_DAEMON_TEST=1 pula parseCli +
 * bootstrap; módulos com paths de chave isolados no tmp) via handleInner:
 *  1. decrypt falha (sem chave) → deliveryId NÃO fica visto; agent:error sai.
 *  2. retry do server com a mesma deliveryId e a chave boa → processado
 *     (aceite: enfileirado pelo host) e só então marcado como visto.
 *  3. duplicata pós-aceite → continua sendo descartada (dedup T-037 preservado).
 *  4. legado sem deliveryId → sempre processa.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { constants, createPublicKey, publicEncrypt } from "node:crypto";

// Seam + paths isolados ANTES de qualquer import que resolva caminhos no load.
process.env.THE_DUDES_DAEMON_TEST = "1";
process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `t252-key-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `t252-pkeys-${process.pid}.json`);
process.env.THE_DUDES_DAEMON_CONFIG = path.join(os.tmpdir(), `t252-cli-missing-${process.pid}.json`);

const { DaemonClient } = await import("../main.js");
const { getDaemonPublicKey, rememberProjectKey, forgetProjectKey, encryptForProject } = await import("../daemon-crypto.js");
const { resolveCliCommands } = await import("../cli-config.js");
const { aadV2, E2EE_TABLE } = await import("@the-dudes/protocol/e2ee-fields");

const PROJ = "proj_t252";
const AGENT = "agent_t252";
const AAD = aadV2({ projectId: PROJ, table: E2EE_TABLE.MESSAGES, field: "content" });

type ClientInternals = {
  handleInner(msg: Record<string, unknown>): Promise<void>;
  deliveryDedup: { isSeen: (id?: string) => boolean; size: () => number };
  host: { inboundBuffer: { size: (agentId?: string) => number } };
  ws: unknown;
};

type Sent = Record<string, unknown> & { type: string };

function makeClient(sent: Sent[]): ClientInternals {
  const args = {
    orch: "ws://127.0.0.1:1", token: "t252", name: "t252-test", pingMs: 30_000,
    verbose: false, verboseHuman: false, verboseHumanIo: true,
    cliConfigPath: process.env.THE_DUDES_DAEMON_CONFIG!, cliPaths: {},
  } as never;
  const client = new (DaemonClient as unknown as new (a: never, c: never) => ClientInternals)(
    args, resolveCliCommands() as never,
  );
  // ws fake: send() do cliente só precisa de readyState/bufferedAmount/send.
  client.ws = { readyState: 1, bufferedAmount: 0, send: (json: string) => sent.push(JSON.parse(json) as Sent) };
  return client;
}

/** Wrap RSA de uma AES key igual ao web (replica provisionKey do daemon-crypto.test). */
function provisionKey(projectId: string, aes: Uint8Array): void {
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(aes));
  rememberProjectKey(projectId, wrapped.toString("base64"));
}

function agentSend(deliveryId: string | undefined, content: string): Record<string, unknown> {
  return { type: "agent:send", agentId: AGENT, projectId: PROJ, content, deliveryId };
}

test("T-252: decrypt falho não marca deliveryId; retry com chave boa é processado; duplicata pós-aceite é descartada", async () => {
  const sent: Sent[] = [];
  const client = makeClient(sent);

  // Cifra com a AES key do projeto e em seguida RETIRA a chave — replica a
  // janela da rotação em que o daemon recebe o dispatch antes do wrap novo.
  rememberProjectKey(PROJ, (() => {
    const aes = new Uint8Array(32).fill(7);
    const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
    return publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(aes)).toString("base64");
  })());
  const ct = encryptForProject("alvo-t252", PROJ, AAD);
  assert.ok(ct?.startsWith("e2e:"));
  const aes = new Uint8Array(32).fill(7);
  forgetProjectKey(PROJ);

  // 1) primeira tentativa, sem chave: decrypt falha → não pode marcar visto
  await client.handleInner(agentSend("del-t252-1", ct!));
  assert.equal(client.deliveryDedup.isSeen("del-t252-1"), false, "decrypt falho NÃO pode marcar o deliveryId");
  assert.equal(client.deliveryDedup.size(), 0, "nada marcado no dedup");
  assert.equal(client.host.inboundBuffer.size(AGENT), 0, "nada enfileirado quando o dropa");
  assert.ok(sent.some((m) => m.type === "agent:error"), "fallback envia agent:error");

  // 2) retry do server com o MESMO deliveryId e a chave boa → processado
  provisionKey(PROJ, aes);
  await client.handleInner(agentSend("del-t252-1", ct!));
  assert.equal(client.deliveryDedup.isSeen("del-t252-1"), true, "após decrypt+aceite o deliveryId fica visto");
  assert.equal(client.host.inboundBuffer.size(AGENT), 1, "retry processado: mensagem aceita (runner ausente → enfileirada)");

  // 3) duplicata pós-aceite (reentrega T-037 legítima) → descartada
  await client.handleInner(agentSend("del-t252-1", ct!));
  assert.equal(client.host.inboundBuffer.size(AGENT), 1, "duplicata não pode duplicar o aceite");

  // 4) legado sem deliveryId: sempre processa (nunca dedupável)
  await client.handleInner(agentSend(undefined, ct!));
  assert.equal(client.host.inboundBuffer.size(AGENT), 2, "sem deliveryId processa sempre");
});
