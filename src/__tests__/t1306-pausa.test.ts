/**
 * T-1306 — estado "Pausado" no daemon.
 *
 * Contrato (server/T-1305): pausado, o agent:send continua chegando e o
 * AgentHost segura tudo, sem parar o runner (o turno em curso termina). No
 * resume o server manda o `agent:queue_deliver` ANTES do `agent:resume`; o
 * daemon entrega fila local + queue_deliver, na ordem e sem duplicar. A pausa
 * atravessa a troca de runner e o re-exec, e o item de não dono segue pelo
 * gate do #1300 na entrega.
 */
import "./scratch-home.js";

import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t1306-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t1306-pkeys-${process.pid}-${Date.now()}.json`);

const { test } = await import("node:test");
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { AgentHost } = await import("../agent-host.js");
const { getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");
const { reter, _resetFilaRetidaForTest } = await import("../queue-retained.js");
type InboundTurnPrincipal = import("../runners/turn-security.js").InboundTurnPrincipal;

const PID = "proj_t1306";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}

type Host = InstanceType<typeof AgentHost>;
type Entrega = { content: string; images?: unknown; deliveryId?: string; principal?: InboundTurnPrincipal };

function novoHost(): { host: Host; erros: string[] } {
  const erros: string[] = [];
  const deliver = (m: { type?: string; message?: string }) => { if (m.type === "agent:error" && m.message) erros.push(m.message); return true; };
  const host = new AgentHost(deliver as never, null, null, {} as never, false, false, false, () => {}, () => {});
  return { host, erros };
}
const entradas = (h: Host) => (h as unknown as { entries: Map<string, unknown> }).entries;

/** Runner fake: fila não iniciada tirável, turno "em curso" e gate de membro. */
function fakeRunner(opts: { fila?: Entrega[]; aceitaMembro?: boolean } = {}) {
  const recebidas: Entrega[] = [];
  let fila = [...(opts.fila ?? [])];
  let parou = 0;
  const runner = {
    pushUserMessage(content: string, images: unknown, _lat: unknown, deliveryId?: string, principal?: InboundTurnPrincipal) {
      recebidas.push({ content, images, deliveryId, principal });
    },
    takeQueuedForDrain() { const out = fila; fila = []; return out; },
    peekQueue: () => fila,
    isAlive: () => true,
    isTurnActive: () => true,
    activeTurnAgeMs: () => 1_000,
    turnHoldReason: () => "teste",
    stop() { parou++; },
    currentRuntimeState: () => "working",
    canAcceptNonOwnerTurn: () => opts.aceitaMembro !== false,
    nonOwnerTurnBlockReason: () => (opts.aceitaMembro === false ? "runner gemini não tem gate de ferramenta pré-execução" : null),
  };
  return { runner, recebidas, parou: () => parou };
}

function comAgente(host: Host, runner: unknown, extra: Record<string, unknown> = {}) {
  entradas(host).set("ag", { projectId: PID, info: { id: "ag", cliRunner: "claude" }, runner, autoApprove: false, ...extra });
}

const DONO: InboundTurnPrincipal = { from: { type: "user", id: "owner", name: "Dono" }, isAgentOwner: true, origin: "user" };
const MEMBRO: InboundTurnPrincipal = { from: { type: "user", id: "member", name: "Ana" }, isAgentOwner: false, origin: "user" };

test.beforeEach(() => _resetFilaRetidaForTest());

test("T-1306: pausado, nenhum caminho de agent:send chega ao runner; o turno em curso não é parado", () => {
  const { host } = novoHost();
  const r = fakeRunner();
  comAgente(host, r.runner);
  host.pause("ag");
  assert.equal(host.isPaused("ag"), true);
  host.send_message("ag", "humano-dono", undefined, "d1", null, DONO);
  host.send_message("ag", "humano-membro", undefined, "d2", null, MEMBRO);
  host.send_message("ag", "de-agente", undefined, "d3", null, { from: { type: "agent", id: "ag-b" }, origin: "agent" });
  host.send_message("ag", "task/agendamento/delegação", undefined, "d4", null, { origin: "system" });
  host.send_message("ag", "legado-sem-principal", undefined, "d5");
  assert.equal(r.recebidas.length, 0, "nada entregue enquanto pausado");
  assert.equal(r.parou(), 0, "pausa não para o runner nem interrompe o turno em curso");
});

test("T-1306: resume entrega a fila em ordem com a proveniência de cada item", () => {
  const { host } = novoHost();
  const r = fakeRunner();
  comAgente(host, r.runner);
  host.pause("ag");
  host.send_message("ag", "a", undefined, "d1", null, DONO);
  host.send_message("ag", "b", undefined, "d2", null, MEMBRO);
  host.send_message("ag", "c", undefined, "d3", null, { origin: "system" });
  host.resume("ag");
  assert.equal(host.isPaused("ag"), false);
  assert.deepEqual(r.recebidas.map((m) => m.content), ["a", "b", "c"]);
  assert.deepEqual(r.recebidas.map((m) => m.deliveryId), ["d1", "d2", "d3"]);
  assert.equal(r.recebidas[0]!.principal?.isAgentOwner, true);
  assert.equal(r.recebidas[1]!.principal?.isAgentOwner, false, "item de não dono continua rebaixado");
  assert.deepEqual(r.recebidas[1]!.principal?.from, MEMBRO.from);
  host.send_message("ag", "depois", undefined, "d4", null, DONO);
  assert.equal(r.recebidas.at(-1)?.content, "depois", "fora da pausa a entrega volta a ser direta");
});

test("T-1306: no resume, item de membro passa pelo gate do #1300 do runner atual", () => {
  const { host, erros } = novoHost();
  const r = fakeRunner({ aceitaMembro: false });
  comAgente(host, r.runner);
  host.pause("ag");
  host.send_message("ag", "dono", undefined, "d1", null, DONO);
  host.send_message("ag", "membro", undefined, "d2", null, MEMBRO);
  host.resume("ag");
  assert.deepEqual(r.recebidas.map((m) => m.content), ["dono"], "runner sem gate não recebe turno de membro");
  assert.equal(erros.length, 1, "o bloqueio é avisado no chat (agent:error cifrado, uma vez)");
  assert.match(erros[0]!, /^e2e:v2:/, "aviso vai cifrado no projeto com chave");
});

test("T-1306: pausar tira do runner o que não virou turno e põe na frente da fila", () => {
  const { host } = novoHost();
  const r = fakeRunner({ fila: [{ content: "fila-1", deliveryId: "f1", principal: MEMBRO }, { content: "fila-2", deliveryId: "f2" }] });
  comAgente(host, r.runner);
  host.pause("ag");
  host.send_message("ag", "nova", undefined, "d1", null, DONO);
  host.resume("ag");
  assert.deepEqual(r.recebidas.map((m) => m.content), ["fila-1", "fila-2", "nova"]);
  assert.equal(r.recebidas[0]!.principal?.isAgentOwner, false, "principal do item tirado do runner é preservado");
});

test("T-1306: queue_deliver durante a pausa é aceito, fica atrás da fila local e não duplica", () => {
  const { host } = novoHost();
  const r = fakeRunner();
  comAgente(host, r.runner);
  host.pause("ag");
  host.send_message("ag", "local", undefined, "d-local", null, DONO);
  const itens = [
    { id: "q1", content: "retida-1", from: { type: "user" as const, id: "owner", name: "Dono" }, isAgentOwner: true },
    { id: "q2", content: "retida-2", from: { type: "user" as const, id: "member", name: "Ana" }, isAgentOwner: false },
  ];
  assert.deepEqual(host.queueDeliver("ag", itens), ["q1", "q2"], "custódia do daemon: ack de tudo");
  assert.deepEqual(host.queueDeliver("ag", [itens[0]!]), ["q1"], "reenvio do mesmo id é aceito sem duplicar");
  assert.equal(r.recebidas.length, 0, "queue_deliver antes do resume não entrega");
  host.resume("ag");
  assert.deepEqual(r.recebidas.map((m) => m.content), ["local", "retida-1", "retida-2"]);
  assert.equal(r.recebidas[2]!.principal?.isAgentOwner, false);
  assert.equal(r.recebidas[2]!.principal?.from?.name, "Ana");
});

test("T-1306: queue_deliver mescla payload válido com dados externos e preserva authorship", () => {
  const { host } = novoHost();
  const r = fakeRunner();
  comAgente(host, r.runner);
  const images = [{ mimeType: "image/png", base64: "AA==" }];
  const aceitos = host.queueDeliver("ag", [{
    id: "queue-row",
    deliveryId: "delivery-real",
    content: "hello {{mem.NAME}}",
    images,
    from: { type: "user", id: "member", name: "Ana" },
    isAgentOwner: false,
    payload: {
      deliveryId: "delivery-real",
      systemPrefix: "[prefix] ",
      systemSuffix: " [suffix]",
      mem: { NAME: "Ada" },
      origin: "system",
      silent: true,
    },
  }]);
  assert.deepEqual(aceitos, ["queue-row"], "ack usa o id da linha de queue_deliver");
  assert.equal(r.recebidas[0]?.content, "[prefix] hello Ada [suffix]");
  assert.equal(r.recebidas[0]?.deliveryId, "delivery-real", "runner usa deliveryId, não id da linha");
  assert.deepEqual(r.recebidas[0]?.images, images);
  assert.equal(r.recebidas[0]?.principal?.isAgentOwner, false);
  assert.equal(r.recebidas[0]?.principal?.origin, "system");
  assert.equal(r.recebidas[0]?.principal?.from?.id, "member", "sender continua no item externo");
});

test("T-1306: payload corrompido não derruba a entrega nem contamina conteúdo/proveniência", () => {
  const { host } = novoHost();
  const r = fakeRunner();
  comAgente(host, r.runner);
  const aceitos = host.queueDeliver("ag", [{
    id: "queue-row-corrupt",
    deliveryId: "delivery-external",
    content: "content-only fallback",
    from: { type: "user", id: "member", name: "Ana" },
    isAgentOwner: false,
    payload: {
      deliveryId: "delivery-external",
      systemPrefix: 42,
      isAgentOwner: true,
      from: { type: "user", id: "forged" },
    },
  }]);
  assert.deepEqual(aceitos, ["queue-row-corrupt"]);
  assert.equal(r.recebidas[0]?.content, "content-only fallback");
  assert.equal(r.recebidas[0]?.deliveryId, "delivery-external");
  assert.equal(r.recebidas[0]?.principal?.isAgentOwner, false);
  assert.equal(r.recebidas[0]?.principal?.from?.id, "member");
});

test("T-1306: a pausa atravessa a troca de runner (migração) e o resume entrega ao runner NOVO", () => {
  const { host } = novoHost();
  const velho = fakeRunner();
  comAgente(host, velho.runner);
  host.pause("ag");
  host.send_message("ag", "antes-da-migracao", undefined, "d1", null, DONO);
  // spawn com outro runner: o Entry é substituído (agent-host.ts spawn) e o
  // flush pós-spawn roda. Nada pode sair enquanto pausado.
  const novo = fakeRunner();
  comAgente(host, novo.runner, { info: { id: "ag", cliRunner: "codex" } });
  host.flushInboundBuffer("ag");
  host.send_message("ag", "depois-da-migracao", undefined, "d2", null, MEMBRO);
  assert.deepEqual([...velho.recebidas, ...novo.recebidas], [], "sem reentrega automática no start pausado");
  host.resume("ag");
  assert.deepEqual(novo.recebidas.map((m) => m.content), ["antes-da-migracao", "depois-da-migracao"]);
  assert.equal(velho.recebidas.length, 0);
});

test("T-1306: resume com o agente parado mantém a fila até o próximo spawn", () => {
  const { host } = novoHost();
  const r = fakeRunner();
  comAgente(host, r.runner);
  host.pause("ag");
  host.send_message("ag", "a", undefined, "d1", null, DONO);
  comAgente(host, r.runner, { parado: true });
  host.resume("ag");
  assert.equal(r.recebidas.length, 0, "parado: nada sai no resume");
  const novo = fakeRunner();
  comAgente(host, novo.runner);
  host.flushInboundBuffer("ag");
  assert.deepEqual(novo.recebidas.map((m) => m.content), ["a"]);
});

test("T-1306: pausa e fila sobrevivem ao re-exec; o spawn pausado não entrega e o resume sim", () => {
  const { host: velho } = novoHost();
  comAgente(velho, fakeRunner().runner);
  velho.pause("ag");
  velho.send_message("ag", "p1", undefined, "d1", null, MEMBRO);
  velho.startDrain("update");
  velho.send_message("ag", "p2-no-dreno", undefined, "d2", null, DONO);
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "t1306-")), "sp");
  assert.equal(velho.writeReexecSpool(dir).spooled, 2);

  const { host: novo } = novoHost();
  const r = fakeRunner();
  comAgente(novo, r.runner);
  // A pausa pode durar horas: o item da pausa não cai no TTL de 60 min do spool.
  assert.equal(novo.loadReexecSpool(dir, Date.now() + 3 * 60 * 60_000), 2);
  novo.pause("ag"); // o spawn do processo novo traz AgentInfo.paused=true
  novo.send_message("ag", "p3-no-boot", undefined, "d3", null, DONO);
  novo.flushInboundBuffer("ag");
  assert.equal(r.recebidas.length, 0, "spawn pausado não entrega o spool");
  novo.resume("ag");
  assert.deepEqual(r.recebidas.map((m) => m.content), ["p1", "p2-no-dreno", "p3-no-boot"]);
  assert.equal(r.recebidas[0]!.principal?.isAgentOwner, false, "principal atravessa o spool cifrado");
});

test("T-1306: spawn traz AgentInfo.paused — re-anúncio pausa e o spawn seguinte sem pausa libera", async () => {
  const { host } = novoHost();
  const r = fakeRunner({ fila: [{ content: "na-fila", deliveryId: "f1" }] });
  const info = { id: "ag", cliRunner: "claude", model: undefined, effort: undefined };
  comAgente(host, r.runner, { info });
  // Reconnect puro (mesma config, runner vivo): só sincroniza o estado.
  await host.spawn({ type: "agent:spawn", agent: { ...info, paused: true }, projectId: PID } as never);
  assert.equal(host.isPaused("ag"), true, "pause perdido com o daemon desconectado volta pelo spawn");
  host.send_message("ag", "nova", undefined, "d1", null, DONO);
  assert.equal(r.recebidas.length, 0);
  await host.spawn({ type: "agent:spawn", agent: { ...info, paused: false }, projectId: PID } as never);
  assert.equal(host.isPaused("ag"), false);
  assert.deepEqual(r.recebidas.map((m) => m.content), ["na-fila", "nova"]);
});

test("T-1306: buffer pré-spawn e fila retida não furam a pausa", () => {
  const { host } = novoHost();
  // Chegou antes de o agente existir no daemon (gap pré-spawn).
  host.send_message("ag", "buffer", undefined, "d0", null, DONO);
  const r = fakeRunner();
  comAgente(host, r.runner);
  host.pause("ag");
  host.flushInboundBuffer("ag");
  reter("ag", [{ content: "retida", deliveryId: "rt", enqueuedAt: Date.now(), source: "stop" }]);
  comAgente(host, r.runner, { queueAutoRedeliver: true });
  assert.equal(host.entregarFilaRetida("ag"), 0, "reentrega legada respeita a pausa");
  assert.equal(r.recebidas.length, 0);
  host.resume("ag");
  assert.deepEqual(r.recebidas.map((m) => m.content), ["buffer"]);
});

test("T-1306: queue_live_remove tira da fila da pausa o item ainda não entregue", () => {
  const { host } = novoHost();
  const r = fakeRunner();
  comAgente(host, r.runner);
  host.pause("ag");
  host.send_message("ag", "fica", undefined, "d1", null, DONO);
  host.send_message("ag", "sai", undefined, "d2", null, DONO);
  assert.equal(host.removerDaFilaViva("ag", "d2"), true);
  host.resume("ag");
  assert.deepEqual(r.recebidas.map((m) => m.content), ["fica"]);
});
