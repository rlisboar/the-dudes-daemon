/**
 * T-842 — SIGTERM no meio do turno.
 *
 * A mensagem em voo entra no spool (o id continua visto, então o replay do
 * server não a roda de novo). O aviso de reinício sai com o WS aberto, antes
 * do close. Spool que falha não grava os vistos.
 */
import "./scratch-home.js";

import os from "node:os";
import path from "node:path";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t842-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t842-pkeys-${process.pid}-${Date.now()}.json`);

const { test } = await import("node:test");
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { readFileSync } = await import("node:fs");
const { getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");
const { AgentHost } = await import("../agent-host.js");
const { createDeliveryDeduper, loadDeliverySeen, saveDeliverySeen } = await import("../inbound-dedup.js");
const { commitReexecSnapshot } = await import("../reexec-snapshot.js");

const PID = "proj_t842";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}

const off = { command: "false", source: "override", available: false };

function hostComCli(script: string) {
  const out: Array<Record<string, unknown>> = [];
  const host = new AgentHost((m) => { out.push(m as unknown as Record<string, unknown>); }, null, null, {
    claude: off, opencode: off, gemini: off, crush: off, qwen: off,
    grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
    codex: { command: script, source: "override", available: true },
  } as never, false, false, false, () => {}, () => {});
  return { host, out };
}

test("T-842: SIGTERM no meio do turno — a mensagem roda de novo, uma vez, no processo novo", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t842-inflight-"));
  const script = path.join(dir, "fake-codex.sh");
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '%s\\n' '${JSON.stringify({ type: "thread.started", thread_id: "t-842" })}'`,
    "sleep 60",
  ].join("\n"));
  chmodSync(script, 0o755);
  const { host } = hostComCli(script);
  try {
    await host.spawn({
      agent: {
        id: "ag_t842", ownerUserId: "u", name: "sonda", role: "backend", systemPrompt: "",
        color: "#fff", state: "idle", running: true,
        usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
        ephemeral: false, cliRunner: "codex",
      },
      projectId: PID, basePath: dir, autoApprove: true, agentToken: "tok",
    } as never);
    // T-1040: anotação explícita — a regra do TS para funções de asserção exige
    // nome declarado com tipo, senão o `assert.ok(runner)` abaixo não estreita.
    const runner: { messageSession: { busy: boolean } } | undefined = (host as unknown as { entries: Map<string, { runner: { messageSession: { busy: boolean } } }> }).entries.get("ag_t842")?.runner;
    assert.ok(runner, "runner vivo");
    host.send_message("ag_t842", "mensagem em voo", undefined, "voo-1");
    const t0 = Date.now();
    while (!runner.messageSession.busy && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(runner.messageSession.busy, true, "turno em voo");

    host.startDrain("shutdown");
    assert.equal(host.holdInFlightForShutdown(), 1, "o in-flight entra no spool");
    assert.equal(host.holdInFlightForShutdown(), 0, "segunda captura não duplica");
    const spoolDir = path.join(dir, "spool");
    const grav = host.writeReexecSpool(spoolDir);
    assert.equal(grav.spooled, 1);

    const dedup = createDeliveryDeduper(500);
    dedup.markSeen("voo-1");
    saveDeliverySeen(spoolDir, dedup.snapshot());

    const pushed: string[] = [];
    const novo = new AgentHost(() => {}, null, null, {} as never, false, false, false, () => {}, () => {});
    const entries = (novo as unknown as { entries: Map<string, unknown> }).entries;
    entries.set("ag_t842", {
      projectId: PID,
      info: { id: "ag_t842" },
      runner: { pushUserMessage(c: string) { pushed.push(c); }, isAlive: () => true, stop() {}, isTurnActive: () => false, takeQueuedForDrain: () => [] },
    });
    assert.equal(novo.loadReexecSpool(spoolDir), 1);
    novo.flushInboundBuffer("ag_t842");
    assert.deepEqual(pushed, ["mensagem em voo"], "o processo novo roda a mensagem uma vez");

    const dedupNovo = createDeliveryDeduper(500);
    for (const id of loadDeliverySeen(spoolDir)) dedupNovo.markSeen(id);
    assert.equal(dedupNovo.isSeen("voo-1"), true, "o replay do server não entra de novo");
    if (!dedupNovo.isSeen("voo-1")) novo.send_message("ag_t842", "mensagem em voo", undefined, "voo-1");
    assert.deepEqual(pushed, ["mensagem em voo"]);
  } finally {
    await host.shutdown({ reexec: true });
  }
});

test("T-842: o aviso de reinício sai antes do close do WS", () => {
  const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const ini = src.indexOf("private async shutdown()");
  const bloco = src.slice(ini, src.indexOf("\n  }\n}", ini));
  const iAviso = bloco.indexOf("this.host.announceRestart()");
  const iFlush = bloco.indexOf("this.flushOutboundQueue()");
  const iClose = bloco.indexOf('this.ws?.close(1000, "shutdown")');
  const iPrep = bloco.indexOf("prepareReexec({ keepRunning: true, porSinal: true })");
  assert.ok(iAviso > 0 && iFlush > iAviso && iClose > iFlush && iPrep > iClose, bloco.slice(0, 900));

  const out: Array<Record<string, unknown>> = [];
  let ready = 1;
  const host = new AgentHost((m) => {
    assert.equal(ready, 1, "o aviso chega com o socket ainda OPEN");
    out.push(m as unknown as Record<string, unknown>);
  }, null, null, {} as never, false, false, false, () => {}, () => {});
  const entries = (host as unknown as { entries: Map<string, unknown> }).entries;
  // O runner do stub responde o que o dreno (T-839) e o SIGTERM (T-842) leem.
  entries.set("ag", {
    projectId: undefined,
    info: { id: "ag" },
    runner: {
      takeInFlightForShutdown: () => ({ content: "em voo" }),
      isTurnActive: () => true,
      activeTurnAgeMs: () => 60_000,
      turnHoldReason: () => "tool-em-voo-sem-result",
    },
  });
  host.startDrain("shutdown");
  host.holdInFlightForShutdown();
  host.announceRestart();
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, "agent:error");
  assert.match(String(out[0]!.message), /daemon reiniciando/);
  ready = 2;
});

test("T-842: spool que falha não grava os ids vistos", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t842-seen-"));
  let saved = false;
  commitReexecSnapshot({
    tag: "[shutdown]",
    writeSpool: () => { throw new Error("disco cheio"); },
    saveSeen: () => { saved = true; saveDeliverySeen(dir, ["voo-1"]); },
    log: () => {},
  });
  assert.equal(saved, false);
  assert.deepEqual(loadDeliverySeen(dir), []);

  commitReexecSnapshot({
    tag: "[shutdown]",
    writeSpool: () => ({ spooled: 1, lost: 0 }),
    saveSeen: () => { saved = true; saveDeliverySeen(dir, ["voo-1"]); },
    log: () => {},
  });
  assert.equal(saved, true);
  assert.deepEqual(loadDeliverySeen(dir), ["voo-1"]);
});
