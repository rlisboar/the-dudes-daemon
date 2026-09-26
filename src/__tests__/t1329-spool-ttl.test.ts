/**
 * T-1329 — self-update descartava EM SILÊNCIO mensagens vencidas na fila.
 *
 * Evidência (daemon-prod.log, re-exec das 02:53 de 26/09): 242 msg(s) no spool,
 * das quais 144 "vencidas (> 60min) — descartada". A causa raiz é o T-938:
 * `writeReexecSpool` joga a fila RETIDA no spool, mas o boot aplicava o TTL de
 * 1 h do re-exec — e um item retido (fila do agente parado / do stop) existe
 * justamente para esperar o dono por horas. O daemon re-executa 13-17x/dia.
 *
 * Regra nova: (1) item que JÁ estava na fila retida segue o TTL da retenção
 * (dias); (2) o que vencer de verdade NÃO some — volta para a fila retida com
 * source `inbound-ttl` e motivo `self-update/vencida`, e o dono decide no modal.
 */
import "./scratch-home.js";

import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t1329-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t1329-pkeys-${process.pid}-${Date.now()}.json`);

const { test } = await import("node:test");
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { AgentHost } = await import("../agent-host.js");
const { AgentRunner } = await import("../agent-runner.js");
const { forgetProjectKey, getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");
const { reter, listar, _resetFilaRetidaForTest } = await import("../queue-retained.js");

const PID = "proj_t1329";
function instalarChaveProjeto() {
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}
instalarChaveProjeto();

type Host = InstanceType<typeof AgentHost>;
type Frame = { type?: string; agentId?: string; source?: string; items?: Array<{ id?: string; sender?: { type: string; id: string }; isAgentOwner?: boolean }> };

function novoHost(): { host: Host; frames: Frame[]; logs: string[] } {
  const frames: Frame[] = [];
  const logs: string[] = [];
  const send = (m: Frame) => { frames.push(m); return true; };
  const host = new AgentHost(send as never, null, null, {} as never, false, false, false, (_n, m) => logs.push(String(m)), () => {});
  return { host, frames, logs };
}

const entradas = (h: Host) => (h as unknown as { entries: Map<string, unknown> }).entries;

function comAgente(host: Host) {
  entradas(host).set("ag", {
    projectId: PID,
    info: { id: "ag", cliRunner: "claude" },
    runner: { pushUserMessage() {}, isTurnActive: () => false, canAcceptNonOwnerTurn: () => true, nonOwnerTurnBlockReason: () => null },
    autoApprove: false,
  });
}

const dirNovo = () => path.join(mkdtempSync(path.join(os.tmpdir(), "t1329-")), "sp");
const HORA = 60 * 60_000;

test.beforeEach(() => { _resetFilaRetidaForTest(); instalarChaveProjeto(); });

test("T-1329: msg vencida no boot vai para a fila RETIDA (não é descartada) e o frame sai com source inbound-ttl", () => {
  // Processo velho: dreno do self-update com uma mensagem na mão.
  const { host: velho } = novoHost();
  comAgente(velho);
  (velho as unknown as { drainHeld: Map<string, Array<{ content: string; deliveryId: string; enqueuedAt: number; principal: object }>> }).drainHeld.set("ag", [{
    content: "chegou-antes-do-update", deliveryId: "d1", enqueuedAt: Date.now(),
    principal: { from: { type: "user", id: "member-7" }, isAgentOwner: false, origin: "user" },
  }]);
  const dir = dirNovo();
  assert.equal(velho.writeReexecSpool(dir).spooled, 1);

  // Processo novo, 2 h depois: antes da correção esta mensagem SUMIA.
  const { host: novo, frames, logs } = novoHost();
  comAgente(novo);
  const quando = Date.now() + 2 * HORA;
  assert.equal(novo.loadReexecSpool(dir, quando), 0, "vencida não é entregue automaticamente");

  const retidas = listar("ag");
  assert.equal(retidas.length, 1, "a mensagem vencida foi RETIDA, não perdida");
  assert.equal(retidas[0]!.content, "chegou-antes-do-update");
  assert.equal(retidas[0]!.deliveryId, "d1", "id de entrega preservado (idempotência)");
  assert.equal(retidas[0]!.source, "inbound-ttl");
  assert.deepEqual(retidas[0]!.principal, { from: { type: "user", id: "member-7" }, isAgentOwner: false, origin: "user" });
  assert.ok(retidas[0]!.enqueuedAt <= quando - 2 * HORA + 1_000, "idade real preservada (o TTL da retenção conta daí)");

  assert.ok(logs.some((l) => /fila RETIDA/.test(l) && /self-update\/vencida/.test(l)), `log declarando a retenção: ${logs.join(" | ")}`);
  const estado = novo.debugHostState() as { spoolVencidasRetidas: number; spoolVencidasPerdidas: number; retidoNoBootPendente: string[] };
  assert.equal(estado.spoolVencidasRetidas, 1, "contador de telemetria");
  assert.equal(estado.spoolVencidasPerdidas, 0);
  assert.deepEqual(estado.retidoNoBootPendente, ["ag"]);

  // O frame só é confiável depois do hello: o tipo não é crítico e o WS está fechado no boot.
  assert.equal(novo.reenviarRetidoNoBoot(), 1);
  const retain = frames.filter((f) => f.type === "agent:queue_retain");
  assert.equal(retain.length, 1, "um queue_retain por agente");
  assert.equal(retain[0]!.agentId, "ag");
  assert.equal(retain[0]!.source, "inbound-ttl");
  assert.equal(retain[0]!.items?.[0]?.id, "d1", "item cifrado no fio com o mesmo id");
  assert.deepEqual(retain[0]!.items?.[0]?.sender, { type: "user", id: "member-7" }, "from segue no sender do contrato queue_retain");
  assert.equal(retain[0]!.items?.[0]?.isAgentOwner, undefined, "o daemon não envia status de dono; o server recalcula");
  assert.equal(novo.reenviarRetidoNoBoot(), 0, "reenvio idempotente (mapa esvaziado)");
});

test("T-1329: item que veio da fila retida segue o TTL da RETENÇÃO, não o de 1 h do re-exec", () => {
  const { host: velho } = novoHost();
  comAgente(velho);
  // (a) item que já estava retido (T-938) — dois filhos de fonte diferentes
  reter("ag", [{ content: "da-fila-retida", deliveryId: "rt", enqueuedAt: Date.now() - 2 * HORA, source: "stop" }]);
  // (b) mensagem normal presa no dreno, com a MESMA idade
  velho.startDrain("update");
  velho.send_message("ag", "normal-vencida", undefined, "nv");
  const dir = dirNovo();
  assert.equal(velho.writeReexecSpool(dir).spooled, 2);
  const spoolFile = path.join(dir, "reexec-spool.json");
  const fixture = JSON.parse(readFileSync(spoolFile, "utf8")) as { records: Array<{ enqueuedAt: number }> };
  const mesmoTimestamp = Date.now() - 2 * HORA;
  for (const record of fixture.records) record.enqueuedAt = mesmoTimestamp;
  writeFileSync(spoolFile, JSON.stringify(fixture));

  const { host: novo } = novoHost();
  comAgente(novo);
  assert.equal(novo.loadReexecSpool(dir, Date.now() + 2 * HORA), 1, "só a normal venceu");

  const retidas = listar("ag").map((i) => i.content);
  assert.deepEqual(retidas, ["normal-vencida"], "a retida sobreviveu; a normal foi retida, não sumiu");
  const spool = (novo as unknown as { spooled: Map<string, Array<{ retido?: boolean }>> }).spooled;
  assert.equal(spool.get("ag")?.length, 1);
  assert.equal(spool.get("ag")?.[0]?.retido, true, "o registro seguia vindo da fila retida");
});

test("T-1329 QA P2: vencidas do dono preservam sender sem enviar isAgentOwner ao server", () => {
  const { host: velho } = novoHost();
  comAgente(velho);
  velho.startDrain("update");
  velho.send_message("ag", "dono", undefined, "owner-delivery", undefined, { from: { type: "user", id: "owner" }, isAgentOwner: true, origin: "user" });
  const dir = dirNovo();
  velho.writeReexecSpool(dir);
  const { host: novo, frames } = novoHost();
  comAgente(novo);
  novo.loadReexecSpool(dir, Date.now() + 2 * HORA);
  novo.reenviarRetidoNoBoot();
  const item = frames.find((f) => f.type === "agent:queue_retain")?.items?.[0];
  assert.deepEqual(item?.sender, { type: "user", id: "owner" });
  assert.equal(item?.isAgentOwner, undefined);
  assert.equal(listar("ag")[0]?.principal?.isAgentOwner, true, "a cópia local mantém proveniência autenticada");
});

test("T-1329 QA note: spool vencido sem chave incrementa a telemetria de perda declarada", () => {
  const { host: velho } = novoHost();
  comAgente(velho);
  velho.startDrain("update");
  velho.send_message("ag", "sem-chave", undefined, "missing-key");
  const dir = dirNovo();
  velho.writeReexecSpool(dir);
  forgetProjectKey(PID);
  const { host: novo, logs } = novoHost();
  comAgente(novo);
  novo.loadReexecSpool(dir, Date.now() + 2 * HORA);
  const state = novo.debugHostState() as { spoolVencidasPerdidas: number; spoolVencidasRetidas: number };
  assert.equal(state.spoolVencidasPerdidas, 1);
  assert.equal(state.spoolVencidasRetidas, 0);
  assert.ok(logs.some((line) => /vencida e ilegível \(chave\).*descartada/.test(line)), logs.join("\n"));
});

test("T-1329: nada é perdido se o dono não agir — a fila retida do boot sobrevive ao re-exec seguinte", () => {
  const { host: velho } = novoHost();
  comAgente(velho);
  velho.startDrain("update");
  velho.send_message("ag", "vencida-no-boot-1", undefined, "d1");
  const dir = dirNovo();
  velho.writeReexecSpool(dir);

  const { host: meio } = novoHost();
  comAgente(meio);
  meio.loadReexecSpool(dir, Date.now() + 2 * HORA);
  assert.equal(listar("ag").length, 1);

  // O dono ainda não carregou e o daemon re-executa de novo: a retenção entra
  // no spool novo e, como é `retido`, não cai mais no TTL de 1 h.
  const dir2 = dirNovo();
  assert.equal(meio.writeReexecSpool(dir2).spooled, 1);
  const { host: fim } = novoHost();
  comAgente(fim);
  assert.equal(fim.loadReexecSpool(dir2, Date.now() + 2 * HORA), 1, "não venceu de novo");
  assert.equal(listar("ag").length, 0, "saiu da fila retida para a entrega do spawn");
});

test("T-1329 follow-up: runner no teto recusa queue_deliver para o server manter no modal", () => {
  const logs: string[] = [];
  const avisos: string[] = [];
  const runner = new AgentRunner({
    id: "ag", ownerUserId: "owner", name: "QA", role: "test", systemPrompt: "", color: "#fff",
    state: "idle", running: true, usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0", agentToken: "t",
    cliRunner: "opencode", autoApprove: true, workspaceRoot: os.tmpdir(), cliCommands: {},
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (_level: string, message: string) => logs.push(message), cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {}, onError: (message: string) => avisos.push(message),
    onHung: () => {}, onExit: () => {},
  } as never);
  const raw = runner as unknown as { messageSession: { busy: boolean; queuedCount(): number }; drainOcQueue(): void };
  raw.messageSession.busy = true;
  raw.drainOcQueue = () => {}; // turno longo: manter os 20 slots ocupados
  const owner = { isAgentOwner: true } as const;
  for (let i = 0; i < 20; i++) assert.equal(runner.pushUserMessage(`fila-${i}`, undefined, undefined, `d${i}`, owner), true);
  assert.equal(raw.messageSession.queuedCount(), 20);

  const hostState = novoHost();
  const host = hostState.host;
  entradas(host).set("ag", { projectId: PID, runner, info: { id: "ag" }, autoApprove: true });
  const aceitos = host.queueDeliver("ag", [{
    id: "d-overflow", content: "x".repeat(65_537), from: { type: "user", id: "owner" }, isAgentOwner: true,
  }], PID);

  assert.deepEqual(aceitos, [], "sem ACK, o server mantém a mensagem retida");
  assert.equal(raw.messageSession.queuedCount(), 20, "o item que excede o teto não entrou no runner");
  assert.ok(logs.some((line) => /ocQueue cheia \(20\).*não coalescida/.test(line)), logs.join("\n"));
  assert.ok(hostState.logs.some((line) => /1 recusada\(s\) por capacidade \(mantidas retidas no server\)/.test(line)), hostState.logs.join("\n"));
  assert.equal(avisos.some((line) => /mensagem descartada/.test(line)), false, "não diz que descartou o item retido");
});

test("T-1329 QA P2: 25 queue_deliver pequenos confirmam 20 e deixam 5 retidos", () => {
  const runner = new AgentRunner({
    id: "ag", ownerUserId: "owner", name: "QA", role: "test", systemPrompt: "", color: "#fff",
    state: "idle", running: true, usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0", agentToken: "t",
    cliRunner: "opencode", autoApprove: true, workspaceRoot: os.tmpdir(), cliCommands: {},
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {}, onAssistantText: () => true,
    onToolUse: () => {}, onError: () => {}, onHung: () => {}, onExit: () => {},
  } as never);
  const raw = runner as unknown as { messageSession: { busy: boolean; queuedCount(): number }; drainOcQueue(): void };
  raw.messageSession.busy = true;
  raw.drainOcQueue = () => {};
  const host = novoHost().host;
  entradas(host).set("ag", { projectId: PID, runner, info: { id: "ag" }, autoApprove: true });
  const aceitos = host.queueDeliver("ag", Array.from({ length: 25 }, (_, i) => ({ id: `small-${i}`, content: `small message ${i}`, from: { type: "user" as const, id: "owner" }, isAgentOwner: true })), PID);
  assert.deepEqual(aceitos, Array.from({ length: 20 }, (_, i) => `small-${i}`));
  assert.equal(raw.messageSession.queuedCount(), 20);
});

test("T-1329 QA P2: spool com 25 itens preserva os 5 que o runner não aceita", () => {
  const { host: velho } = novoHost();
  comAgente(velho);
  velho.startDrain("update");
  for (let i = 0; i < 25; i++) velho.send_message("ag", `spooled-${i}`, undefined, `sp-${i}`);
  const dir = dirNovo();
  assert.equal(velho.writeReexecSpool(dir).spooled, 25);

  const accepted: string[] = [];
  let capacity = 20;
  const { host: novo, logs } = novoHost();
  entradas(novo).set("ag", {
    projectId: PID, info: { id: "ag" }, autoApprove: true,
    runner: { pushUserMessage: (_c: string, _i: unknown, _l: unknown, id: string, _p: unknown, own: boolean) => {
      assert.equal(own, true);
      if (capacity <= 0) return false;
      capacity--;
      accepted.push(id);
      return true;
    } },
  });
  novo.loadReexecSpool(dir);
  novo.flushInboundBuffer("ag");
  const spool = (novo as unknown as { spooled: Map<string, Array<{ deliveryId?: string }>> }).spooled;
  assert.equal(spool.get("ag")?.length, 5);
  assert.deepEqual(spool.get("ag")?.map((r) => r.deliveryId), ["sp-20", "sp-21", "sp-22", "sp-23", "sp-24"]);
  assert.deepEqual(accepted, Array.from({ length: 20 }, (_, i) => `sp-${i}`));
  assert.ok(logs.some((line) => /5 msg\(s\).*excederam a capacidade.*continuam no spool/.test(line)), logs.join("\n"));

  // A fila do runner libera cinco posições: o callback do runner deve tentar
  // o spool pendente sem esperar outro spawn ou re-exec.
  capacity = 5;
  (novo as unknown as { onRunnerQueueChanged(agentId: string): void }).onRunnerQueueChanged("ag");
  assert.deepEqual(accepted, Array.from({ length: 25 }, (_, i) => `sp-${i}`));
  assert.equal(spool.has("ag"), false);
  assert.equal(novo.spoolPendingCount(), 0);
});

test("T-1329 follow-up: queue_deliver não confirma quando o runner devolve false", () => {
  const { host, logs } = novoHost();
  entradas(host).set("ag", {
    projectId: PID,
    info: { id: "ag" },
    runner: {
      canAcceptNonOwnerTurn: () => true,
      pushUserMessage: () => false,
    },
  });
  const aceitos = host.queueDeliver("ag", [{ id: "d-retained", content: "fica no server" }], PID);
  assert.deepEqual(aceitos, []);
  assert.ok(logs.some((line) => /1 recusada\(s\) por capacidade \(mantidas retidas no server\)/.test(line)), logs.join("\n"));
});
