/**
 * T-842 — as duas SONDAS do QA-A (revisão pós-merge do T-824) viram teste
 * versionado, agora contra o comportamento corrigido.
 *
 * Sonda 1 (era o bug): mensagem com turno EM VOO no SIGTERM ficava fora do
 * spool, mas o id ia para os vistos; no boot o replay era descartado e a
 * mensagem sumia. Agora o in-flight entra no spool, o id visto barra o replay
 * e a mensagem roda no processo novo.
 *
 * Sonda 2 (era o bug): o aviso de reinício era emitido depois do ws.close(), e
 * com o socket em CLOSING a fila outbound nunca era drenada — o aviso morria no
 * process.exit. Agora o aviso e o flush saem com o socket OPEN, antes do close.
 */
import "./scratch-home.js";

import os from "node:os";
import path from "node:path";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t842-sonda-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t842-sonda-pkeys-${process.pid}-${Date.now()}.json`);

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");
const { AgentHost } = await import("../agent-host.js");
const { createDeliveryDeduper, loadDeliverySeen, saveDeliverySeen } = await import("../inbound-dedup.js");
const { channelCanSend, createOutboundQueue, flushOutboundQueue, trySendOutbound } = await import("../runners/outbound-delivery.js");

const PID = "proj_t842_sonda";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}

const off = { command: "false", source: "override", available: false };

function hostComCodex(script: string) {
  const out: Array<Record<string, unknown>> = [];
  const host = new AgentHost((m) => out.push(m as Record<string, unknown>), null, null, {
    claude: off, opencode: off, gemini: off, crush: off, qwen: off, grok: off,
    "grok-custom": off, graphify: off, graphifyMcp: off,
    codex: { command: script, source: "override", available: true },
  } as never, false, false, false, () => {}, () => {});
  return { host, out };
}

test("sonda QA-A 1: a mensagem EM VOO no SIGTERM vai para o spool e NÃO some quando o replay é descartado", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t842-sonda-inflight-"));
  // CLI codex falso: anuncia a thread e FICA VIVO (turno em voo, sem close).
  const script = path.join(dir, "fake-codex.sh");
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '%s\\n' '${JSON.stringify({ type: "thread.started", thread_id: "t-sonda" })}'`,
    "sleep 60",
  ].join("\n"));
  chmodSync(script, 0o755);
  const { host } = hostComCodex(script);
  try {
    await host.spawn({
      agent: {
        id: "ag_sonda", ownerUserId: "u", name: "sonda", role: "backend", systemPrompt: "",
        color: "#fff", state: "idle", running: true,
        usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
        ephemeral: false, cliRunner: "codex",
      },
      projectId: PID, basePath: dir, autoApprove: true, agentToken: "tok",
    } as never);
    const runner = (host as unknown as { entries: Map<string, { runner: { messageSession: { busy: boolean } } }> }).entries.get("ag_sonda")?.runner;
    assert.ok(runner, "runner vivo");
    host.send_message("ag_sonda", "mensagem em voo", undefined, "voo-1");
    const t0 = Date.now();
    while (!runner.messageSession.busy && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(runner.messageSession.busy, true, "turno em voo (não iniciado ≠ em voo)");

    // main.ts marca visto no aceite (depois do decrypt), antes do turno iniciar.
    const dedup = createDeliveryDeduper(500);
    dedup.markSeen("voo-1");

    // ---- SIGTERM (prepareReexec porSinal) -------------------------------------------------
    host.startDrain("shutdown");
    assert.equal(host.holdInFlightForShutdown(), 1, "FIX: o in-flight é capturado (antes: spool=0)");
    const spoolDir = path.join(dir, "spool");
    const grav = host.writeReexecSpool(spoolDir);
    saveDeliverySeen(spoolDir, dedup.snapshot());

    assert.equal(grav.spooled, 1, "FIX: a mensagem em voo VAI para o spool");
    assert.deepEqual(loadDeliverySeen(spoolDir), ["voo-1"], "o id segue nos vistos");

    // ---- processo novo ---------------------------------------------------------------------
    const dedupNovo = createDeliveryDeduper(500);
    for (const id of loadDeliverySeen(spoolDir)) dedupNovo.markSeen(id);
    assert.equal(dedupNovo.isSeen("voo-1"), true, "o replay do server (agent:send voo-1) segue descartado");

    const pushed: string[] = [];
    const novo = new AgentHost(() => {}, null, null, {} as never, false, false, false, () => {}, () => {});
    (novo as unknown as { entries: Map<string, unknown> }).entries.set("ag_sonda", {
      projectId: PID,
      info: { id: "ag_sonda" },
      runner: { pushUserMessage(c: string) { pushed.push(c); }, isAlive: () => true, stop() {}, isTurnActive: () => false, takeQueuedForDrain: () => [] },
    });
    assert.equal(novo.loadReexecSpool(spoolDir), 1);
    novo.flushInboundBuffer("ag_sonda");
    assert.deepEqual(pushed, ["mensagem em voo"], "FIX: a mensagem roda uma vez no processo novo (antes sumia)");
  } finally {
    await host.shutdown({ reexec: true });
  }
});

test("sonda QA-A 2: o aviso de reinício sai com o socket OPEN e a fila outbound é drenada antes do close", () => {
  // Com o socket em CLOSING (readyState 2) nada é enviado: a crítica é enfileirada.
  assert.equal(channelCanSend({ readyState: 2, openState: 1, bufferedAmount: 0 }), false);
  const q = createOutboundQueue(80);
  const enviado = trySendOutbound({
    msg: { type: "agent:error" }, json: JSON.stringify({ type: "agent:error" }),
    canSend: channelCanSend({ readyState: 2, openState: 1, bufferedAmount: 0 }),
    send: () => { throw new Error("não devia enviar"); },
    queue: q,
  });
  assert.equal(enviado, false);
  assert.equal(q.items.length, 1, "agent:error é crítica → fica na fila");

  // FIX: o shutdown drena essa fila com o socket ainda OPEN, antes do close.
  const enviados: string[] = [];
  const n = flushOutboundQueue({
    queue: q,
    canSend: () => channelCanSend({ readyState: 1, openState: 1, bufferedAmount: 0 }),
    send: (json) => { enviados.push(json); },
  });
  assert.equal(n, 1, "a crítica é reenviada");
  assert.equal(q.items.length, 0);
  assert.match(enviados[0]!, /agent:error/);

  // Ordem no shutdown: anunciar → flush → close → prepareReexec (que grava o spool).
  const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const ini = src.indexOf("private async shutdown()");
  const bloco = src.slice(ini, src.indexOf("\n  }\n}", ini));
  const iAviso = bloco.indexOf("this.host.announceRestart()");
  const iFlush = bloco.indexOf("this.flushOutboundQueue()");
  const iClose = bloco.indexOf('this.ws?.close(1000, "shutdown")');
  const iPrep = bloco.indexOf("prepareReexec({ keepRunning: true, porSinal: true })");
  assert.ok(iAviso > 0, "aviso presente");
  assert.ok(iFlush > iAviso && iClose > iFlush, "FIX: aviso e flush antes do close");
  assert.ok(iPrep > iClose, "spool e CLIs continuam depois do close (filtro de tokenId do server)");
});