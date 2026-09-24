/**
 * T-1005 — fila de espera AO VIVO (`agent:queue_live`).
 *
 * Relato do dono: "a fila de espera não está mostrando as mensagens na fila".
 * O daemon só mandava a fila no stop; com o agente ocupado as mensagens
 * esperando ficavam só na memória do runner. Contrato: snapshot completo do que
 * ainda não virou turno, a cada mudança, com debounce; remover só o que não
 * iniciou; E2EE manda o blob original, nunca o texto claro.
 */
import "./scratch-home.js";

import os from "node:os";
import path from "node:path";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t1005-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t1005-pkeys-${process.pid}-${Date.now()}.json`);

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { AgentHost } = await import("../agent-host.js");
const { AgentRunner } = await import("../agent-runner.js");
const { killProcess } = await import("../runners/process-lifecycle.js");
const { _resetTurnGateForTest } = await import("../runners/turn-gate.js");
const { getDaemonPublicKey, rememberProjectKey, encryptForProject, decryptForProject } = await import("../daemon-crypto.js");
const { aadV2, E2EE_TABLE } = await import("@the-dudes/protocol/e2ee-fields");
const { registroDoFrame, montarSnapshot, QUEUE_LIVE_DEBOUNCE_MS, QUEUE_LIVE_MAX_ITEMS, QUEUE_LIVE_MAX_BYTES } = await import("../queue-live.js");
const protocolo = await import("@the-dudes/protocol/daemon-wire");

const PID = "proj_t1005";
const PID_SEM_CHAVE = "proj_t1005_semchave";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}
const AAD = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" });
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ESPERA = QUEUE_LIVE_DEBOUNCE_MS + 150;

type Frame = { type: string; agentId?: string; projectId?: string; truncated?: boolean; items?: Array<{ deliveryId: string; content: string; origin: string }> };

/** Host com runner falso: uma fila que o teste mexe à mão. */
function hostComFila(projectId = PID) {
  const frames: Frame[] = [];
  const host = new AgentHost((m) => { frames.push(m as Frame); }, null, null, {} as never, false, false, false, () => {}, () => {});
  const fila: Array<{ content: string; deliveryId?: string }> = [];
  (host as unknown as { entries: Map<string, unknown> }).entries.set("ag", {
    projectId, info: { id: "ag" },
    runner: {
      pushUserMessage(content: string, _i: unknown, _l: unknown, deliveryId?: string) { fila.push({ content, deliveryId }); },
      peekQueue: () => fila.map((m) => ({ ...m })),
      removeQueued(id: string) { const i = fila.findIndex((m) => m.deliveryId === id); if (i < 0) return false; fila.splice(i, 1); return true; },
      isAlive: () => true, stop() {}, isTurnActive: () => true, takeQueuedForDrain: () => [],
    },
  });
  const vivos = () => frames.filter((f) => f.type === "agent:queue_live");
  return { host, fila, frames, vivos };
}

const legado = (texto: string) => registroDoFrame({ content: texto, projectId: PID_SEM_CHAVE }, texto, undefined);

test("T-1005: enfileirar publica o snapshot; consumir publica de novo; esvaziar manda lista vazia", async () => {
  const { host, fila, vivos } = hostComFila(PID_SEM_CHAVE);
  host.send_message("ag", "m1", undefined, "d1", legado("m1"));
  host.send_message("ag", "m2", undefined, "d2", legado("m2"));
  await esperar(ESPERA);
  assert.equal(vivos().length, 1, "um snapshot depois do enfileirar");
  assert.deepEqual(vivos()[0]!.items!.map((i) => i.deliveryId), ["d1", "d2"]);
  assert.equal(vivos()[0]!.projectId, PID_SEM_CHAVE);

  fila.shift(); // m1 virou turno
  host.agendarFilaViva("ag"); // o runner avisa (onQueueChanged)
  await esperar(ESPERA);
  assert.deepEqual(vivos().at(-1)!.items!.map((i) => i.deliveryId), ["d2"], "consumir republica");

  fila.shift();
  host.agendarFilaViva("ag");
  await esperar(ESPERA);
  assert.deepEqual(vivos().at(-1)!.items, [], "fila vazia vai como lista vazia");
});

test("T-1005: debounce — rajada vira UM snapshot, e snapshot igual não se repete", async () => {
  const { host, vivos } = hostComFila(PID_SEM_CHAVE);
  for (let i = 0; i < 5; i++) host.send_message("ag", `m${i}`, undefined, `d${i}`, legado(`m${i}`));
  await esperar(QUEUE_LIVE_DEBOUNCE_MS / 2);
  assert.equal(vivos().length, 0, "nada antes do debounce");
  await esperar(ESPERA);
  assert.equal(vivos().length, 1, "5 mudanças em sequência = 1 frame");
  assert.equal(vivos()[0]!.items!.length, 5);
  host.agendarFilaViva("ag");
  await esperar(ESPERA);
  assert.equal(vivos().length, 1, "sem mudança, sem frame novo");
});

test("T-1005: E2EE manda o blob ORIGINAL do server — nunca o texto decifrado", async () => {
  const { host, frames, vivos } = hostComFila(PID);
  const SEGREDO = "SEGREDO-T1005 texto que não pode sair em claro";
  const blob = encryptForProject(SEGREDO, PID, AAD)!;
  const wire = registroDoFrame({ content: blob, projectId: PID }, SEGREDO, undefined);
  host.send_message("ag", SEGREDO, undefined, "dz", wire);
  // Frame em partes (sem blob único) é re-selado; nunca em claro.
  const montado = "[task] SEGREDO-T1005 descrição da task";
  const wire2 = registroDoFrame({ parts: [{ kind: "plain", text: "[task] " }], projectId: PID }, montado, undefined);
  host.send_message("ag", montado, undefined, "dp", wire2);
  await esperar(ESPERA);
  const f = vivos()[0]!;
  assert.equal(f.items![0]!.content, blob, "o blob que veio do server, byte a byte");
  assert.ok(f.items![1]!.content.startsWith("e2e:v2:"), "parts: re-selado");
  assert.equal(decryptForProject(f.items![1]!.content, PID, AAD), montado, "abre com a chave e o AAD do chat");
  assert.ok(!JSON.stringify(frames).includes("SEGREDO-T1005"), "nenhum texto claro no fio");
});

test("T-1005: projeto sem chave manda o texto como chegou; origem pelo frame", () => {
  const r = registroDoFrame({ content: "oi", projectId: PID_SEM_CHAVE }, "oi", undefined, 1);
  assert.deepEqual(r, { content: "oi", images: undefined, enqueuedAt: 1, origin: "user", silent: undefined });
  assert.equal(registroDoFrame({ content: "x", systemPrefix: "[from PM]: ", projectId: PID_SEM_CHAVE }, "x", undefined)!.origin, "agent");
  assert.equal(registroDoFrame({ parts: [{ kind: "plain", text: "t" }], projectId: PID_SEM_CHAVE }, "t", undefined)!.origin, "system");
  assert.equal(registroDoFrame({ content: "x", origin: "system", silent: true, projectId: PID_SEM_CHAVE }, "x", undefined)!.silent, true);
});

test("T-1005: tetos — mais de 200 itens ou do teto de bytes corta os MAIS NOVOS com truncated", () => {
  const regs = new Map();
  const pend = Array.from({ length: 250 }, (_, i) => {
    regs.set(`d${i}`, { content: `m${i}`, enqueuedAt: i, origin: "user" });
    return { content: `m${i}`, deliveryId: `d${i}` };
  });
  const s = montarSnapshot(pend, regs, PID_SEM_CHAVE);
  assert.equal(s.items.length, 200);
  assert.equal(s.truncated, true);
  assert.equal(s.items[0]!.deliveryId, "d0", "os mais antigos ficam");
  const grande = montarSnapshot(pend.slice(0, 3), regs, PID_SEM_CHAVE, { maxBytes: 5 });
  assert.equal(grande.truncated, true);
  assert.ok(grande.items.length < 3);
});

test("T-1005: agrupadas (T-818) aparecem uma a uma; remover qualquer uma tira o item inteiro", () => {
  const regs = new Map([
    ["d1", { content: "m1", enqueuedAt: 1, origin: "user" as const }],
    ["d2", { content: "m2", enqueuedAt: 2, origin: "user" as const }],
  ]);
  const s = montarSnapshot([{ content: "m1\n\nm2", deliveryId: "d1", coalescedIds: ["d2"] }], regs, PID_SEM_CHAVE);
  assert.deepEqual(s.items.map((i) => i.deliveryId), ["d1", "d2"]);
});

test("T-1005: item interno sem registro vai selado (projeto cifrado) ou em claro (sem chave)", () => {
  const regs = new Map([
    ["d1", { content: "m1", enqueuedAt: 1, origin: "user" as const }],
  ]);
  const s = montarSnapshot([{ content: "m1", deliveryId: "d1" }, { content: "resumo interno" }], regs, PID);
  assert.deepEqual(s.items.map((i) => i.deliveryId), ["d1", "sem-id:0"]);
  assert.ok(s.items[1]!.content.startsWith("e2e:v2:"), "interno em projeto cifrado vai selado");
  assert.equal(s.items[1]!.origin, "system");
});

test("T-1005: remover — só o que ainda não iniciou; o resto é ignorado (idempotente)", async () => {
  const { host, vivos } = hostComFila(PID_SEM_CHAVE);
  host.send_message("ag", "a", undefined, "da", legado("a"));
  host.send_message("ag", "b", undefined, "db", legado("b"));
  await esperar(ESPERA);
  assert.equal(host.removerDaFilaViva("ag", "db"), true);
  assert.equal(host.removerDaFilaViva("ag", "db"), false, "segunda vez: já saiu");
  assert.equal(host.removerDaFilaViva("ag", "inexistente"), false);
  await esperar(ESPERA);
  assert.deepEqual(vivos().at(-1)!.items!.map((i) => i.deliveryId), ["da"], "republica sem o removido");
});

/** Runner REAL (per-message codex) com um stub que nunca termina o turno. */
function runnerReal() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t1005-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
  chmodSync(stub, 0o755);
  const off = { command: "false", source: "override" as const, available: false };
  const cmd = { command: stub, source: "override" as const, available: true };
  let avisos = 0;
  const runner = new AgentRunner({
    id: `t1005_${process.pid}_${Math.random().toString(36).slice(2, 7)}`, ownerUserId: "u", name: "t1005", role: "backend",
    systemPrompt: "", color: "#fff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false, cliRunner: "codex",
  } as never, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0", agentToken: "t",
    cliRunner: "codex", autoApprove: true, workspaceRoot: dir,
    cliCommands: { claude: off, opencode: off, qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off, gemini: off, codex: cmd, crush: off },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {}, onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onSessionId: () => {}, onExit: () => {},
    onQueueChanged: () => { avisos++; },
  } as never);
  return { runner, avisos: () => avisos };
}

test("T-1005: runner real — o turno em curso não está na fila; enfileirar e remover avisam o host", async (t) => {
  _resetTurnGateForTest();
  const { runner, avisos } = runnerReal();
  t.after(() => {
    const p = (runner as unknown as { ocActiveProc?: import("node:child_process").ChildProcess }).ocActiveProc;
    if (p) try { killProcess(p, "SIGKILL"); } catch { /* já saiu */ }
    try { runner.stop(); } catch { /* noop */ }
    _resetTurnGateForTest();
  });
  runner.pushUserMessage("turno-1", undefined, undefined, "r1");
  const t0 = Date.now();
  while (!(runner as unknown as { messageSession: { busy: boolean } }).messageSession.busy && Date.now() - t0 < 5_000) await esperar(20);
  runner.pushUserMessage("fila-2", undefined, undefined, "r2");
  runner.pushUserMessage("fila-3", undefined, undefined, "r3");
  assert.ok(avisos() >= 3, `avisou a cada mudança (${avisos()})`);
  assert.deepEqual(runner.peekQueue().map((m) => m.deliveryId), ["r2", "r3"], "o em curso (r1) não aparece");
  assert.equal(runner.removeQueued("r1"), false, "turno já iniciado não sai");
  const antes = avisos();
  assert.equal(runner.removeQueued("r3"), true);
  assert.ok(avisos() > antes, "remover avisa");
  assert.deepEqual(runner.peekQueue().map((m) => m.deliveryId), ["r2"]);
});

test("T-1005: tetos vêm do protocolo — mesmos números do fail-closed do server", async () => {
  const proto = protocolo as unknown as { QUEUE_LIVE_MAX_ITEMS?: unknown; QUEUE_LIVE_MAX_BYTES?: unknown; queueLiveItemBytes?: unknown };
  // O protocolo do server/T-1006 exporta os três; o daemon usa o exportado
  // (sem constante duplicada). Se o protocolo ainda não tem (base antiga),
  // o fallback local vale e o server corta/recusa pelo dele.
  if (proto.QUEUE_LIVE_MAX_ITEMS !== undefined) assert.equal(QUEUE_LIVE_MAX_ITEMS, proto.QUEUE_LIVE_MAX_ITEMS);
  else assert.equal(QUEUE_LIVE_MAX_ITEMS, 200);
  if (proto.QUEUE_LIVE_MAX_BYTES !== undefined) assert.equal(QUEUE_LIVE_MAX_BYTES, proto.QUEUE_LIVE_MAX_BYTES);
  else assert.equal(QUEUE_LIVE_MAX_BYTES, 1024 * 1024);
  const item = { deliveryId: "d", content: "olá ç", images: [{ mimeType: "image/png", base64: "e2e:v2:x", name: "a.png" }], enqueuedAt: 1, origin: "user" as const };
  const regs = new Map([["d", { content: item.content, images: item.images, enqueuedAt: 1, origin: "user" as const }]]);
  const snap = montarSnapshot([{ content: item.content, deliveryId: "d" }], regs, PID_SEM_CHAVE);
  if (typeof proto.queueLiveItemBytes === "function") {
    const { queueLiveItemBytes } = proto as unknown as { queueLiveItemBytes: (it: { content: string; images?: unknown[] }) => number };
    assert.equal(queueLiveItemBytes(snap.items[0]), queueLiveItemBytes(item), "medida do daemon = medida do server");
  } else {
    // Base sem server/T-1006: o fallback local mede UTF-8 de content + images serializado.
    const enc = new TextEncoder();
    const esperado = enc.encode(item.content).length + enc.encode(JSON.stringify(item.images)).length;
    const { QUEUE_LIVE_MAX_BYTES: maxB } = await import("../queue-live.js");
    const cheio = montarSnapshot([{ content: item.content, deliveryId: "d" }], regs, PID_SEM_CHAVE, { maxBytes: esperado - 1 });
    assert.equal(cheio.truncated, true, "fallback mede como o protocolo documenta");
    assert.equal(maxB, 1024 * 1024);
  }
  // Acima de 200 itens corta os MAIS NOVOS com truncated (fail-closed do server aceita).
  const regs2 = new Map<string, { content: string; enqueuedAt: number; origin: "user" }>();
  const pend = Array.from({ length: 250 }, (_, i) => {
    regs2.set(`d${i}`, { content: `m${i}`, enqueuedAt: i, origin: "user" });
    return { content: `m${i}`, deliveryId: `d${i}` };
  });
  const s2 = montarSnapshot(pend, regs2, PID_SEM_CHAVE);
  assert.equal(s2.items.length, 200);
  assert.equal(s2.truncated, true);
  assert.equal(s2.items[0]!.deliveryId, "d0", "os mais antigos ficam");
});

test("T-1005: reemite o snapshot no hello — a desconexão limpa no server", async () => {
  const { host, vivos } = hostComFila(PID_SEM_CHAVE);
  host.send_message("ag", "m1", undefined, "d1", legado("m1"));
  await esperar(ESPERA);
  assert.equal(vivos().length, 1, "snapshot publicado");
  // O hello esquece o último e reagenda: o MESMO snapshot sai de novo para
  // repovoar o server (que limpou na desconexão).
  host.reemitirFilaVivaNoHello();
  await esperar(ESPERA);
  assert.equal(vivos().length, 2, "reemitiu após o hello");
  assert.deepEqual(vivos()[1]!.items!.map((i) => i.deliveryId), ["d1"]);
});

test("T-1005: stop — depois do queue_retain, a fila ao vivo vai vazia", async () => {
  const { host, fila, vivos } = hostComFila(PID_SEM_CHAVE);
  host.send_message("ag", "a", undefined, "da", legado("a"));
  await esperar(ESPERA);
  assert.equal(vivos().at(-1)!.items!.length, 1);
  fila.length = 0; // o stop do runner tira a fila (vai para a retenção)
  host.stop("ag");
  await esperar(ESPERA);
  assert.deepEqual(vivos().at(-1)!.items, []);
});
