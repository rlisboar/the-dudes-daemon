/**
 * T-1150 (P1 do dono): a fila não pode sumir no stop.
 *
 * O que esta prova trava, do lado do DAEMON:
 *  1. o frame de retenção passa no SCHEMA do protocolo (o `as never` escondia um
 *     formato que o server recusava — `reason`/`cipher` em vez de `source`/`content`);
 *  2. ordem e `source` sobrevivem ao fio, e em projeto E2EE vai CIFRA;
 *  3. `queue_deliver` decifra, entrega NA ORDEM ao runner atual e confirma só o
 *     que aceitou (o resto segue retido);
 *  4. `queue_forget` larga a cópia local;
 *  5. o start NÃO entrega mais sozinho (fim da reentrega automática).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `t1150-key-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `t1150-pkeys-${process.pid}.json`);

const { reter, listar, esquecer, paraFio, _resetFilaRetidaForTest } = await import("../queue-retained.js");
const { AgentHost } = await import("../agent-host.js");
const { daemonWireSchemas, fromOrchSchemas } = await import("@the-dudes/protocol/daemon-wire");
const { encryptForProject, getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");
const { E2EE_TABLE, aadV2 } = await import("@the-dudes/protocol/e2ee-fields");

const Sch = daemonWireSchemas as Record<string, { parse: (x: unknown) => unknown }>;
const SchIn = fromOrchSchemas as Record<string, { parse: (x: unknown) => unknown }>;
const PID = "proj_t1150";
const AG = "ag_t1150";
const aad = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" });

// Chave do projeto SEMEAR antes de qualquer caso: sem chave o item fica local.
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true, "chave do projeto semeada");
}

/** Igual ao mapeamento do host em `enviarFilaRetida` (fonte única do formato). */
function frameDeRetencao(agentId: string, projectId: string, source: string): { type: "agent:queue_retain"; agentId: string; projectId: string; source: string; items: Array<{ id: string; content: string; images?: string[]; ts: number; source?: string }> } {
  const { enviar } = paraFio(agentId, projectId, listar(agentId));
  return {
    type: "agent:queue_retain" as const,
    agentId,
    projectId,
    source,
    items: enviar.map((i) => ({ id: i.deliveryId ?? i.ack, content: i.cipher, images: i.imagesCipher, ts: i.enqueuedAt, source: i.source })),
  };
}

function item(content: string, deliveryId: string) {
  return { content, deliveryId, enqueuedAt: Date.now(), source: "stop" as const };
}

test.beforeEach(() => _resetFilaRetidaForTest());

test("T-1150: o frame de retenção passa no SCHEMA (o `as never` escondia formato errado)", () => {
  const frame = frameDeRetencao(AG, PID, "replace");
  assert.doesNotThrow(() => Sch["agent:queue_retain"].parse(frame), "retenção tem de passar no schema");

  // O formato ANTIGO (`reason` + item com `cipher`) era o que saía: agora falha.
  const antigo = { type: "agent:queue_retain", agentId: AG, projectId: PID, reason: "stop", items: [{ cipher: "e2e:x" }] };
  assert.throws(() => Sch["agent:queue_retain"].parse(antigo), "formato antigo não passa mais");

  // Frames novos do contrato existem e validam nos dois sentidos.
  assert.doesNotThrow(() => Sch["agent:queue_delivered"].parse({ type: "agent:queue_delivered", agentId: AG, ids: ["d1"] }));
  assert.doesNotThrow(() => SchIn["agent:queue_deliver"].parse({ type: "agent:queue_deliver", agentId: AG, items: [{ id: "d1", content: "e2e:x", ts: 1 }] }));
  assert.doesNotThrow(() => SchIn["agent:queue_forget"].parse({ type: "agent:queue_forget", agentId: AG }));
});

test("T-1150: retenção preserva ORDEM e source, e em E2EE vai cifra (nunca claro)", () => {
  reter(AG, [item("um", "d1"), item("dois", "d2"), item("tres", "d3")]);
  const frame = frameDeRetencao(AG, PID, "loop-stop");
  const tipos = frame.items as Array<{ id: string; content: string; source?: string }>;
  assert.equal(frame.source, "loop-stop");
  assert.deepEqual(tipos.map((i) => i.id), ["d1", "d2", "d3"], "ordem preservada");
  for (const i of tipos) {
    assert.ok(i.content.startsWith("e2e:"), "conteúdo cifrado no fio");
    assert.equal(i.source, "stop", "source do item preservado");
  }
});

test("T-1150 §3: queue_deliver decifra, entrega na ORDEM e confirma só o aceito", () => {
  const recebidas: Array<{ texto: string; id?: string; isAgentOwner?: boolean }> = [];
  const fake = {
    entries: new Map([[AG, { projectId: PID, runner: {
      canAcceptNonOwnerTurn: () => true,
      pushUserMessage: (t: string, _i?: unknown, _l?: unknown, id?: string, principal?: { isAgentOwner?: boolean }) => {
        if (id === "d2") throw new Error("recusado");
        recebidas.push({ texto: t, id, isAgentOwner: principal?.isAgentOwner });
      },
    } }]]),
    log: () => {},
    // T-1306: estado de pausa do host (agente não pausado neste caso).
    pausados: new Set<string>(),
    pauseHeld: new Map(),
    filaVivaRegistros: new Map(),
  };
  Object.setPrototypeOf(fake, AgentHost.prototype);
  const itens = [
    { id: "d1", content: encryptForProject("primeiro", PID, aad)!, ts: 1 },
    { id: "d2", content: encryptForProject("explode", PID, aad)!, ts: 2 },
    { id: "d3", content: encryptForProject("terceiro", PID, aad)!, ts: 3 },
  ];
  const aceitos = (AgentHost.prototype as unknown as { queueDeliver: (a: string, i: typeof itens, p?: string) => string[] }).queueDeliver.call(fake, AG, itens, PID);
  assert.deepEqual(aceitos, ["d1", "d3"], "só o que foi ACEITO é confirmado (d2 volta pro server)");
  assert.deepEqual(recebidas.map((r) => r.texto), ["primeiro", "terceiro"], "texto decifrado, na ordem, sem o recusado");
  assert.deepEqual(recebidas.map((r) => r.id), ["d1", "d3"], "deliveryId propagado (idempotência)");
  assert.deepEqual(recebidas.map((r) => r.isAgentOwner), [false, false], "itens legados sem proveniência são rebaixados como não dono");
});

test("T-1150 §4: queue_forget larga a cópia local; agente sem runner não aceita nada", () => {
  reter(AG, [item("um", "d1")]);
  const esquecerSpy: string[] = [];
  const fake = { esquecerFilaRetida: (id: string) => { esquecerSpy.push(id); return esquecer(id); }, log: () => {}, entries: new Map() };
  (AgentHost.prototype as unknown as { queueForget: (a: string) => number }).queueForget.call(fake, AG);
  assert.deepEqual(esquecerSpy, [AG]);
  assert.equal(listar(AG).length, 0, "cópia local sumiu");
  const semRunner = (AgentHost.prototype as unknown as { queueDeliver: (a: string, i: unknown[], p?: string) => string[] }).queueDeliver.call({ entries: new Map(), log: () => {} }, "ag_x", [{ id: "d1", content: "x" }]);
  assert.deepEqual(semRunner, [], "sem runner: nada aceito (fica retido no server)");
});

test("T-1150 §2/§5: host LIGA onQueueRetained e o start não entrega sozinho", () => {
  const host = readFileSync(new URL("../agent-host.ts", import.meta.url), "utf8");
  assert.match(host, /onQueueRetained: \(msgs, source\) => \{ this\.reterDoRunner\(/, "callback ligado em TODOS os caminhos");
  // a reentrega automática saiu do spawn (agora quem manda é o server)
  // T-1157 (reprovação da QA-A): asserção na LINHA DECISIVA — o regex antigo exigia
  // linhas contíguas e havia comentário no meio, então nunca casava (teste vacuoso).
  assert.doesNotMatch(host, /this\.entregarFilaRetida\(msg\.agent\.id\)/, "start não entrega sozinho (a chamada saiu do spawn)");
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(main, /case "agent:queue_deliver": \{/, "dispatch do deliver");
  assert.match(main, /case "agent:queue_forget": \{/, "dispatch do forget");
  assert.match(main, /type: "agent:queue_delivered"/, "confirmação ao server");
});
