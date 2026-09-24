/**
 * T-1000 — ordem da conversa depois do reinício.
 *
 * Achado na prova de reinício do #824 (perfil isolado, cenários 1, 2 e 3): o
 * turno que estava em voo no SIGTERM era reexecutado uma vez (correto), mas
 * DEPOIS de mensagens mais novas. Duas causas:
 *  1. no spool, o dreno tirava a fila do runner primeiro e o em-voo entrava
 *     atrás dela;
 *  2. no boot, a mensagem nova que chega enquanto o spawn do replay sobe ia
 *     direto ao runner, antes do spool (entregue só no flush pós-spawn).
 *
 * Contrato: em-voo → fila → retidas no dreno → mensagens novas, na ordem de
 * chegada.
 */
import "./scratch-home.js";

import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t1000-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t1000-pkeys-${process.pid}-${Date.now()}.json`);

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { AgentHost } = await import("../agent-host.js");
const { getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");

const PID = "proj_t1000";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}

const quieto = () => new AgentHost(() => {}, null, null, {} as never, false, false, false, () => {}, () => {});
const entradas = (h: InstanceType<typeof AgentHost>) => (h as unknown as { entries: Map<string, unknown> }).entries;

/** Processo "velho": turno em voo + 1 na fila do runner + 1 que chega no dreno. */
function spoolDoProcessoVelho(): string {
  const velho = quieto();
  let fila = [{ content: "fila-1", deliveryId: "d-fila" }];
  let emVoo: { content: string; deliveryId: string } | null = { content: "em-voo", deliveryId: "d-voo" };
  entradas(velho).set("ag", {
    projectId: PID, info: { id: "ag" },
    runner: {
      pushUserMessage() {}, isAlive: () => true, stop() {}, isTurnActive: () => true,
      activeTurnAgeMs: () => 60_000, turnHoldReason: () => "teste",
      takeQueuedForDrain() { const out = fila; fila = []; return out; },
      takeInFlightForShutdown() { const m = emVoo; emVoo = null; return m; },
    },
  });
  // Mesma sequência do shutdown por sinal (main.ts): dreno → em-voo → spool.
  velho.startDrain("shutdown");
  velho.send_message("ag", "retida-no-dreno", undefined, "d-retida");
  assert.equal(velho.holdInFlightForShutdown(), 1);
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "t1000-")), "sp");
  assert.equal(velho.writeReexecSpool(dir).spooled, 3);
  return dir;
}

function processoNovo(dir: string) {
  const novo = quieto();
  const recebidas: string[] = [];
  entradas(novo).set("ag", {
    projectId: PID, info: { id: "ag" },
    runner: { pushUserMessage(c: string) { recebidas.push(c); }, isAlive: () => true, stop() {}, isTurnActive: () => false, takeQueuedForDrain: () => [] },
  });
  assert.equal(novo.loadReexecSpool(dir), 3);
  return { novo, recebidas };
}

test("T-1000: no spool, o turno em voo vem antes da fila tirada pelo dreno", () => {
  const { novo, recebidas } = processoNovo(spoolDoProcessoVelho());
  novo.flushInboundBuffer("ag");
  assert.deepEqual(recebidas, ["em-voo", "fila-1", "retida-no-dreno"]);
});

test("T-1000: mensagem nova durante o spawn do replay espera o spool (ordem de chegada)", () => {
  const { novo, recebidas } = processoNovo(spoolDoProcessoVelho());
  // O runner já existe (spawn subindo), o flush ainda não rodou.
  novo.send_message("ag", "nova-no-boot", undefined, "d-nova");
  assert.deepEqual(recebidas, [], "nada passa na frente do spool");
  novo.flushInboundBuffer("ag");
  assert.deepEqual(recebidas, ["em-voo", "fila-1", "retida-no-dreno", "nova-no-boot"]);
  // Spool entregue: dali em diante a entrega volta a ser direta.
  novo.send_message("ag", "depois", undefined, "d-depois");
  assert.deepEqual(recebidas.at(-1), "depois");
});
