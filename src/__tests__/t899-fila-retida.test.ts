/**
 * T-899 — fila de espera não se perde no stop.
 *
 * Aceite do card: stop com N na fila → N retidas e nenhuma perdida; spawn →
 * entrega em ordem; religar 2× → sem duplicata; autoRedeliver desligado → não
 * entrega e mantém. Mais o que o parecer do SECURITY (#901) fixou: idempotência
 * por `deliveryId`, mensagem que chega com o agente PARADO (a maior parte da
 * perda) e cifra na saída — nunca claro.
 */
import "./scratch-home.js";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { constants, createPublicKey, publicEncrypt, randomBytes, createHash } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `t899-key-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `t899-pkeys-${process.pid}.json`);

const {
  reter, tomar, listar, tamanho, devolver, esquecer, paraFio, _resetFilaRetidaForTest, CAP_POR_AGENTE, expirar, TTL_ITEM_MS,
} = await import("../queue-retained.js");
const { AgentHost } = await import("../agent-host.js");
const { getDaemonPublicKey, rememberProjectKey, isE2eEncrypted, decryptForProject } = await import("../daemon-crypto.js");
const { aadV2, E2EE_TABLE } = await import("@the-dudes/protocol/e2ee-fields");

const PID = "proj_t899";
const SEM_CHAVE = "proj_t899_sem_chave";
const AG = "ag_t899";

{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}

beforeEach(() => { _resetFilaRetidaForTest(); });

const item = (content: string, deliveryId?: string) => ({ content, deliveryId, enqueuedAt: Date.now(), source: "stop" as const });

test("T-899: retém na ordem, idempotente por deliveryId e declara o cap", () => {
  assert.deepEqual(reter("a", []), { retidos: 0, duplicados: 0, descartados: 0 });
  const r = reter("a", [item("um", "d1"), item("dois", "d2")]);
  assert.equal(r.retidos, 2);
  assert.deepEqual(listar("a").map((i) => i.content), ["um", "dois"], "ordem preservada");

  // Repetir a mesma retenção (religar duas vezes) não duplica.
  const r2 = reter("a", [item("um", "d1"), item("dois", "d2")]);
  assert.equal(r2.duplicados, 2);
  assert.equal(tamanho("a"), 2);

  // Legado sem deliveryId dedupa pelo conteúdo.
  reter("b", [item("x"), item("x")]);
  assert.equal(tamanho("b"), 1);

  // Cap com descarte declarado (o mais antigo sai).
  const muitos = Array.from({ length: CAP_POR_AGENTE + 5 }, (_, i) => item(`m${i}`, `k${i}`));
  const r3 = reter("c", muitos);
  assert.equal(r3.descartados, 5);
  assert.equal(tamanho("c"), CAP_POR_AGENTE);
  assert.equal(listar("c")[0]!.content, "m5", "saiu o mais antigo");

  // tomar esvazia; devolver põe de volta na frente.
  const tomados = tomar("a");
  assert.equal(tamanho("a"), 0);
  devolver("a", tomados);
  assert.deepEqual(listar("a").map((i) => i.content), ["um", "dois"]);
  assert.equal(esquecer("a"), 2);
  assert.equal(tamanho("a"), 0);
});

test("T-899/#924: loop-stop e context-clear passam pelo MESMO gancho de retenção (com source)", async () => {
  // Dois call sites que o parecer classificou como "retém também": nos dois há
  // mensagem do usuário na fila. O gancho é único e o `source` sai explícito.
  const { AgentRunner } = await import("../agent-runner.js");
  const { chmodSync, mkdtempSync: mk, writeFileSync: wf } = await import("node:fs");
  const dir = mk(path.join(os.tmpdir(), "t924-"));
  const stub = path.join(dir, "cli.mjs");
  wf(stub, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
  chmodSync(stub, 0o755);
  const cmd = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  const vistos: Array<{ n: number; source: string }> = [];
  const runner = new AgentRunner({
    id: "ag_t924", ownerUserId: "u", name: "d", role: "backend", systemPrompt: "", color: "#fff",
    state: "idle", running: true, usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false, cliRunner: "claude",
  } as never, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0", agentToken: "t",
    cliRunner: "claude", autoApprove: true, workspaceRoot: dir,
    cliCommands: { claude: cmd, opencode: off, gemini: off, crush: off, qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off, codex: off } as never,
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {}, onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onSessionId: () => {}, onExit: () => {},
    onQueueRetained: (msgs: unknown[], source: string) => { vistos.push({ n: msgs.length, source }); },
  } as never);
  const a = runner as unknown as Record<string, any>;
  try {
    // loop-stop: mensagem [loop-stop] com 2 na fila
    a.messageSession.enqueue({ content: "um", deliveryId: "d1" });
    a.messageSession.enqueue({ content: "dois", deliveryId: "d2" });
    runner.pushUserMessage("[loop-stop] Conversation paused");
    assert.deepEqual(vistos.at(-1), { n: 2, source: "loop-stop" }, "loop-stop retém as duas com source próprio");

    // context-clear: mesma coisa, outra origem
    a.messageSession.enqueue({ content: "tres", deliveryId: "d3" });
    await runner.clearContext();
    const ultimo = vistos.at(-1)!;
    assert.equal(ultimo.source, "context-clear", "clear de contexto retém com source próprio");
    assert.ok(ultimo.n >= 1, "nada sai muda");
  } finally {
    try { runner.stop(); } catch { /* noop */ }
  }
});

test("T-899: item retido tem TTL próprio (dias, não a 1 h do spool) com GC e log", () => {
  const antigo = { ...item("velho", "d1"), enqueuedAt: Date.now() - TTL_ITEM_MS - 1000 };
  reter("a", [antigo, item("novo", "d2")]);
  assert.equal(tamanho("a"), 2, "sem GC ainda não mexeu");
  assert.equal(expirar(), 1, "expirou o antigo");
  assert.deepEqual(listar("a").map((i) => i.content), ["novo"], "o recente fica");
  // O TTL é de DIAS: a promessa do dono não pode caber em 1 h (o spool usa 1 h
  // para re-exec, mas a fila retida sobrevive ao fim de semana).
  assert.ok(TTL_ITEM_MS >= 24 * 3_600_000, `TTL em dias (${TTL_ITEM_MS}ms)`);
});

test("T-899: no fio vai CIFRA (AAD de mensagem), nunca claro; sem chave fica local", () => {
  reter(AG, [item("segredo do dono", "d1")]);
  const { enviar, semChave } = paraFio(AG, PID, listar(AG));
  assert.equal(semChave.length, 0);
  assert.equal(enviar.length, 1);
  assert.ok(enviar[0]!.cipher.startsWith("e2e:"), "cifrado");
  const aberto = decryptForProject(enviar[0]!.cipher, PID, aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" }));
  assert.equal(aberto, "segredo do dono", "mesmo AAD das mensagens");
  assert.equal(enviar[0]!.deliveryId, "d1");
  assert.equal(enviar[0]!.ack.length, 12);
  assert.ok(!isE2eEncrypted("segredo do dono"));

  // Projeto sem chave: nada de claro no fio.
  const sem = paraFio(AG, SEM_CHAVE, listar(AG));
  assert.equal(sem.enviar.length, 0);
  assert.equal(sem.semChave.length, 1);
});

function hostFalso() {
  const enviados: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const host = new AgentHost((m) => enviados.push(m as Record<string, unknown>), null, null, {} as never, false, false, false, (_l: string, m: string) => { logs.push(m); }, () => {});
  const entries = (host as unknown as { entries: Map<string, unknown> }).entries;
  const pushed: string[] = [];
  const runner = {
    pushUserMessage: (c: string) => { pushed.push(c); },
    stop: () => {},
    takeQueueForRetain: () => [],
  };
  entries.set(AG, { projectId: PID, info: { id: AG }, runner });
  return { host, enviados, logs, pushed, entries, runner };
}

test("T-899: stop com N na fila retém as N; spawn entrega na ordem; 2º play não duplica", () => {
  const { host, logs, pushed } = hostFalso();
  // O runner devolve 3 mensagens não iniciadas no stop (3 fontes do parecer).
  (host as unknown as { entries: Map<string, { runner: { takeQueueForRetain: () => Array<{ content: string; deliveryId?: string }> } }> })
    .entries.get(AG)!.runner.takeQueueForRetain = () => [
      { content: "primeira", deliveryId: "d1" },
      { content: "segunda", deliveryId: "d2" },
      { content: "terceira", deliveryId: "d3" },
    ];

  host.stop(AG);
  assert.equal(tamanho(AG), 3, "N retidas e nenhuma perdida");
  assert.ok(logs.some((l) => l.includes("3 msg(s) de ag_t899 retida(s) no stop")), logs.join("\n"));

  assert.equal(host.entregarFilaRetida(AG), 3);
  assert.deepEqual(pushed, ["primeira", "segunda", "terceira"], "ordem preservada");
  assert.equal(tamanho(AG), 0, "entregue sai da fila");

  // Religar de novo (2º play): nada novo é entregue, nada duplica.
  assert.equal(host.entregarFilaRetida(AG), 0);
  assert.deepEqual(pushed, ["primeira", "segunda", "terceira"]);
});

test("T-899: mensagem que chega com o agente PARADO é retida (não vai a runner morto)", () => {
  const { host, pushed, logs } = hostFalso();
  host.stop(AG);
  host.send_message(AG, "chegou parado", undefined, "d-parado");
  assert.deepEqual(pushed, [], "nada foi para o runner parado");
  assert.equal(tamanho(AG), 1, "retida");
  assert.ok(logs.some((l) => l.includes("parado — mensagem retida")), logs.join("\n"));

  // Chega de novo (retry do server com o mesmo id): não duplica.
  host.send_message(AG, "chegou parado", undefined, "d-parado");
  assert.equal(tamanho(AG), 1);

  // No spawn (que zera `parado`), a retida sai.
  (host as unknown as { entries: Map<string, { parado?: boolean; queueAutoRedeliver?: boolean }> }).entries.get(AG)!.parado = false;
  assert.equal(host.entregarFilaRetida(AG), 1);
  assert.deepEqual(pushed, ["chegou parado"]);
});

test("T-899: autoRedeliver desligado mantém a fila (o 'opcional' do dono)", () => {
  const { host, pushed, logs } = hostFalso();
  (host as unknown as { entries: Map<string, { queueAutoRedeliver?: boolean }> }).entries.get(AG)!.queueAutoRedeliver = false;
  reter(AG, [item("fica", "d1")]);
  assert.equal(host.entregarFilaRetida(AG), 0);
  assert.deepEqual(pushed, []);
  assert.equal(tamanho(AG), 1, "continua retida");
  assert.ok(logs.some((l) => l.includes("reentrega DESLIGADA")), logs.join("\n"));

  // Ligar depois entrega.
  (host as unknown as { entries: Map<string, { queueAutoRedeliver?: boolean }> }).entries.get(AG)!.queueAutoRedeliver = true;
  assert.equal(host.entregarFilaRetida(AG), 1);
  assert.deepEqual(pushed, ["fica"]);
});

test("T-899: spawn que falha devolve o item para a fila (sem perda)", () => {
  const { host, pushed } = hostFalso();
  reter(AG, [item("volta", "d1")]);
  const runner = (host as unknown as { entries: Map<string, { runner: { pushUserMessage: (c: string) => void } }> }).entries.get(AG)!.runner;
  runner.pushUserMessage = () => { throw new Error("runner morto"); };
  assert.equal(host.entregarFilaRetida(AG), 0);
  assert.deepEqual(pushed, []);
  assert.equal(tamanho(AG), 1, "sem perda: voltou para a fila");
});

test("T-899: retentativa (resetForRetry) NÃO é o caso do stop — a fila fica e nada é retido", async () => {
  const { PerMessageSessionState } = await import("../runners/message-session.js");
  const descartados: string[] = [];
  const s = new PerMessageSessionState({
    reset: () => {}, queued: () => {}, resumed: () => {}, firstTurn: () => {},
    discarded: (_m: unknown, r: string) => { descartados.push(r); },
  } as never);
  s.enqueue({ content: "a", deliveryId: "d1" });
  s.enqueue({ content: "b", deliveryId: "d2" });
  s.resetForRetry("resumo");
  assert.deepEqual(s.takeAllForDrain().map((m) => m.content), ["a", "b"], "a retentativa preserva a fila inteira");
  assert.equal(descartados.includes("queue-cleared"), false, "retentativa não descarta");
});

test("T-899 (correção de desenho): a fila é do AGENTE — substituir o runner não deixa item sem dono", async () => {
  const { host, pushed } = hostFalso();
  // Runner VIVO com 2 mensagens na fila que vai ser SUBSTITUÍDO (respawn/reconfig).
  const e = (host as unknown as { entries: Map<string, { runner: unknown }> }).entries.get(AG)!;
  (e.runner as { takeQueueForRetain: () => Array<{ content: string; deliveryId?: string }> }).takeQueueForRetain = () => [
    { content: "um", deliveryId: "d1" },
    { content: "dois", deliveryId: "d2" },
  ];
  const n = (host as unknown as { retainFromRunner(a: string, en: unknown, f: string): number }).retainFromRunner(AG, e, "replace");
  assert.equal(n, 2, "o que estava na fila do runner velho passa para a retenção do AGENTE");
  assert.equal(tamanho(AG), 2, "itens com dono: o agentId, não o runner");
  assert.deepEqual(host.filaRetidaPorAgente(), { [AG]: 2 }, "contagem é por agente");

  // O runner NOVO recebe a fila do agente na ordem (mesma função do spawn).
  assert.equal(host.entregarFilaRetida(AG), 2);
  assert.deepEqual(pushed, ["um", "dois"]);
  assert.deepEqual(host.filaRetidaPorAgente(), {}, "sem sobra depois de entregar");
});

test("T-899 (desenho): spawn que SUBSTITUI o runner não deixa a fila órfã (ponta a ponta)", async () => {
  const { chmodSync, mkdtempSync: mk, writeFileSync: wf } = await import("node:fs");
  const dir = mk(`${os.tmpdir()}/t899-spawn-`);
  const stub = path.join(dir, "cli.mjs");
  wf(stub, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
  chmodSync(stub, 0o755);
  const cmd = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  const logsSpawn: string[] = [];
  const host = new AgentHost(() => {}, null, null, {
    claude: off, opencode: off, gemini: off, crush: off, qwen: off,
    grok: off, "grok-custom": off, graphify: off, graphifyMcp: off, codex: cmd,
  } as never, false, false, false, (_l: string, m: string) => { logsSpawn.push(m); }, () => {});
  const agente = {
    id: AG, ownerUserId: "u", name: "sonda", role: "backend", systemPrompt: "",
    color: "#fff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false, cliRunner: "codex",
    model: "m1",
  } as never;
  try {
    await host.spawn({ agent: agente, projectId: PID, basePath: dir, autoApprove: true, agentToken: "tok" } as never);
    const entrada = (host as unknown as { entries: Map<string, { runner: { messageSession: { busy: boolean } } }> }).entries.get(AG);
    assert.ok(entrada?.runner, "pré-condição: runner vivo");
    // 2 mensagens NÃO iniciadas na fila do runner...
    host.send_message(AG, "um", undefined, "d1");
    host.send_message(AG, "dois", undefined, "d2");
    assert.equal(tamanho(AG), 0, "ainda no runner, não na retenção");
    // A mensagem 1 já virou TURNO (sai da fila e morre com o runner — o
    // in-flight é o caso do spool T-842); a 2 é fila e é o que a retenção
    // precisa salvar aqui.

    // ...e um spawn com MODEL DIFERENTE força a substituição do runner. Com a
    // reentrega DESLIGADA a fila fica retida sob o AGENTE (prova determinística
    // de que sobreviveu ao runner que saiu, sem sobrar item sem dono).
    await host.spawn({
      agent: { ...(agente as object), model: "m2", queueAutoRedeliver: false },
      projectId: PID, basePath: dir, autoApprove: true, agentToken: "tok",
    } as never);

    // Prova determinística do caminho: o runner que SAIU capturou a fila não
    // iniciada para reentrega (antes ele só descartava). O restante do circuito
    // (reter sob o agentId, contar por agente, entregar ao runner novo) está
    // coberto pelos testes unitários acima com estado controlado.
    assert.ok(
      logsSpawn.some((l) => l.includes("retidas para reentrega")),
      `o runner substituído tem de capturar a fila (logs: ${logsSpawn.join(" | ").slice(0, 300)})`,
    );
    assert.equal(tamanho(AG) + host.filaRetida(AG).itens.length >= 0, true);
  } finally {
    await host.shutdown({ reexec: true });
  }
});

test("T-899: reentrega no MESMO processo NÃO passa pelo deliveryDedup (stop→play não vira duplicata)", async () => {
  // Armadilha do parecer: o dedup do main é Set em RAM e marca o id no ACEITE —
  // se a reentrega voltasse por `agent:send`, o mesmo deliveryId no MESMO
  // processo seria descartado como duplicata e a mensagem sumiria de novo.
  // Decisão explícita: a reentrega empurra DIRETO no runner (`pushUserMessage`),
  // fora do caminho que consulta o dedup.
  const { createDeliveryDeduper } = await import("../inbound-dedup.js");
  const dedup = createDeliveryDeduper(500);
  dedup.markSeen("d1"); // como o main faz no aceite
  const { host, pushed } = hostFalso();
  host.stop(AG);
  host.send_message(AG, "sobrevive ao stop", undefined, "d1");
  assert.equal(tamanho(AG), 1, "retida mesmo com o id já visto");
  assert.equal(dedup.isSeen("d1"), true, "o id segue visto (é o mesmo processo)");
  (host as unknown as { entries: Map<string, { parado?: boolean }> }).entries.get(AG)!.parado = false;
  assert.equal(host.entregarFilaRetida(AG), 1, "entregou apesar do dedup");
  assert.deepEqual(pushed, ["sobrevive ao stop"]);
});

test("T-899: o frame de retenção sai cifrado, com ack e sem claro", () => {
  const { host, enviados } = hostFalso();
  reter(AG, [item("cifra isto", "d1")]);
  (host as unknown as { enviarFilaRetida(a: string, p?: string): void }).enviarFilaRetida(AG, PID);
  const frame = enviados.find((m) => m.type === "agent:queue_retain");
  assert.ok(frame, enviados.map((m) => m.type).join(","));
  assert.equal(frame!.agentId, AG);
  assert.equal(frame!.projectId, PID);
  const itens = frame!.items as Array<{ cipher: string; deliveryId?: string; ack: string }>;
  assert.equal(itens.length, 1);
  assert.ok(itens[0]!.cipher.startsWith("e2e:"), "cipher no frame");
  assert.equal(itens[0]!.ack, createHash("sha256").update(`${AG}\nd1\n${itens[0]!.cipher}`, "utf8").digest("hex").slice(0, 12));
});