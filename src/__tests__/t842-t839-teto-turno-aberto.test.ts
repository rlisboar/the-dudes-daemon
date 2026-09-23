/**
 * T-842 × T-839 — o teto do dreno corta um turno ABERTO.
 *
 * O PM condicionou o merge do #839 (teto do dreno) a este teste: no teto o
 * re-exec sai com keepRunning, então a mensagem que estava EM VOO precisa
 * entrar no spool e rodar de novo, UMA vez, no processo novo — nunca sumir e
 * nunca duplicar. Sem o #842 (spool do in-flight) o teto perde a mensagem; sem
 * o #839 não existe teto e o turno infinito segura o re-exec para sempre.
 *
 * Cenário: um agente em turno que não fecha (claude + monitor) e outro ocioso
 * com mensagem na fila. No teto: exit 42, as DUAS mensagens no spool, o
 * processo novo roda cada uma uma vez e o id visto evita o replay duplicado.
 */
import "./scratch-home.js";

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { constants, createHash, createPublicKey, generateKeyPairSync, publicEncrypt, randomBytes, sign as edSign } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t842t839-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t842t839-pkeys-${process.pid}-${Date.now()}.json`);

const { _resetIdleRestartForTest, checkAndApplyUpdate, DRAIN_AFTER_MS, DRAIN_FORCE_MS } = await import("../self-update.js");
const { AgentHost } = await import("../agent-host.js");
const { createDeliveryDeduper, loadDeliverySeen, saveDeliverySeen } = await import("../inbound-dedup.js");
const { getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");

afterEach(() => { _resetIdleRestartForTest(); });

const PID = "proj_t842t839";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}

const OCUPADO = "ag_ocupado";
const OCIOSO = "ag_ocioso";

function signedInstall(daemonBody: string, bridgeBody: string) {
  const pair = generateKeyPairSync("ed25519");
  const pubs = [pair.publicKey.export({ type: "spki", format: "pem" }) as string];
  const bundle = (body: string) => {
    const buf = Buffer.from(body);
    return { buf, sha: createHash("sha256").update(buf).digest("hex"), sig: edSign(null, buf, pair.privateKey).toString("base64") };
  };
  const d = bundle(daemonBody);
  const b = bundle(bridgeBody);
  const map: Record<string, Buffer> = {
    "/install/daemon.cjs.sha256": Buffer.from(`${d.sha}  daemon.cjs\n`),
    "/install/daemon.cjs": d.buf,
    "/install/daemon.cjs.sig": Buffer.from(d.sig),
    "/install/mcp-bridge.cjs.sha256": Buffer.from(`${b.sha}  mcp-bridge.cjs\n`),
    "/install/mcp-bridge.cjs": b.buf,
    "/install/mcp-bridge.cjs.sig": Buffer.from(b.sig),
  };
  const fetchFn = (async (url: string) => {
    const k = Object.keys(map).find((p) => String(url).endsWith(p));
    if (!k) throw new Error(`sem fixture pra ${url}`);
    return { ok: true, arrayBuffer: async () => map[k]! };
  }) as unknown as typeof fetch;
  return { pubs, fetchFn };
}

/** Runner falso: o ocupado tem turno ABERTO com a mensagem em voo. */
function runnerFalso(opts: { ativo?: boolean; emVoo?: string; fila?: string[] }) {
  const pushed: string[] = [];
  let voo = opts.emVoo ?? null;
  const fila = [...(opts.fila ?? [])];
  return {
    pushed,
    pushUserMessage(c: string) { pushed.push(c); },
    isAlive: () => true,
    stop() {},
    isTurnActive: () => !!opts.ativo,
    activeTurnAgeMs: () => (opts.ativo ? 3_600_000 : null),
    turnHoldReason: () => (opts.ativo ? "tool-em-voo-sem-result" : null),
    takeQueuedForDrain: () => fila.splice(0).map((content) => ({ content })),
    // T-842: o in-flight sai no SIGTERM; a segunda chamada devolve null.
    takeInFlightForShutdown: () => {
      if (voo == null) return null;
      const content = voo;
      voo = null;
      return { content, deliveryId: "voo-1" };
    },
  };
}

test("T-842 x T-839: no teto do dreno o turno em voo vai para o spool e roda de novo, uma vez só", async () => {
  const ocupado = runnerFalso({ ativo: true, emVoo: "mensagem em voo" });
  const ocioso = runnerFalso({ fila: ["mensagem na fila"] });
  const logsHost: string[] = [];
  const host = new AgentHost(() => {}, null, null, {} as never, false, false, false, (_l: string, m: string) => { logsHost.push(m); }, () => {});
  const entries = (host as unknown as { entries: Map<string, unknown> }).entries;
  entries.set(OCUPADO, { projectId: PID, runner: ocupado, info: { id: OCUPADO, cliRunner: "claude", state: "thinking" } });
  entries.set(OCIOSO, { projectId: PID, runner: ocioso, info: { id: OCIOSO, cliRunner: "claude", state: "idle" } });

  const dir = mkdtempSync(path.join(os.tmpdir(), "t842t839-spool-"));
  const clock = { t: 0 };
  const ticks: Array<() => void> = [];
  const logs: string[] = [];
  let exit: number | null = null;
  let spooled = -1;
  const dedup = createDeliveryDeduper(500);
  const inst = signedInstall(`#!/usr/bin/env node\nconst DAEMON_BUILD_TS = Number("2000000000000");\n`, "bridge");

  // Antes do dreno: o OCUPADO já abriu turno (a mensagem roda no processo
  // velho e morre com ele); o OCIOSO só tem fila.
  host.send_message(OCUPADO, "mensagem em voo", undefined, "voo-1");
  assert.deepEqual(ocupado.pushed, ["mensagem em voo"], "turno em voo já começou no processo velho");

  const r = await checkAndApplyUpdate({
    orchBase: "http://x",
    selfPath: path.join(mkdtempSync(path.join(os.tmpdir(), "t842t839-bin-")), "daemon.cjs"),
    runningHash: "b".repeat(64),
    runningBuildTs: 1_000_000_000_000,
    log: (_l, m) => { logs.push(m); },
    underLauncher: true,
    fetchFn: inst.fetchFn,
    trustedPubs: inst.pubs,
    isIdle: () => !host.hasActiveTurn(),
    startDrain: () => { assert.equal(host.startDrain("update"), 1, "o ocioso com fila vai para o drainHeld"); },
    drainHolders: () => host.drainHolders(),
    idleRecheckMs: 15_000,
    nowFn: () => clock.t,
    setTimeoutFn: (fn) => { ticks.push(fn); return 0; },
    // Mesmo caminho do main no teto: segura o in-flight, grava o spool e só
    // então os vistos (commitReexecSnapshot).
    prepareReexec: () => {
      assert.equal(host.holdInFlightForShutdown(), 1, "o turno aberto segura a mensagem em voo");
      assert.equal(host.holdInFlightForShutdown(), 0, "captura idempotente");
      spooled = host.writeReexecSpool(dir).spooled;
      dedup.markSeen("voo-1");
      dedup.markSeen("fila-1");
      saveDeliverySeen(dir, dedup.snapshot());
    },
    exitFn: (c) => { exit = c; },
  });
  assert.equal(r, "updated-awaiting-idle");

  const teto = DRAIN_AFTER_MS + DRAIN_FORCE_MS;
  for (let i = 0; i < ticks.length && exit == null && clock.t <= teto; i++) {
    clock.t += 15_000;
    ticks[i]!();
    await new Promise((r2) => setImmediate(r2));
  }

  assert.equal(exit, 42, "no teto o re-exec sai mesmo com o turno aberto");
  assert.equal(clock.t, teto, "sai no teto, nem antes nem depois");
  assert.equal(spooled, 2, "em voo E fila vão para o spool do re-exec");
  assert.ok(logs.some((l) => l.includes("teto do dreno") && l.includes(`agentId=${OCUPADO}`)), logs.join("\n"));
  assert.ok(logsHost.some((l) => l.includes("retida(s) para o spool")));
  assert.deepEqual(ocioso.pushed, [], "o ocioso não abre turno novo no processo velho");

  // Processo novo: o spool entrega as duas, uma vez cada, e o id visto barra o replay.
  const novoOcupado = runnerFalso({});
  const novoOcioso = runnerFalso({});
  const novo = new AgentHost(() => {}, null, null, {} as never, false, false, false, () => {}, () => {});
  const novasEntries = (novo as unknown as { entries: Map<string, unknown> }).entries;
  novasEntries.set(OCUPADO, { projectId: PID, runner: novoOcupado, info: { id: OCUPADO } });
  novasEntries.set(OCIOSO, { projectId: PID, runner: novoOcioso, info: { id: OCIOSO } });
  assert.equal(novo.loadReexecSpool(dir), 2, "as duas mensagens voltam no processo novo");
  novo.flushInboundBuffer(OCUPADO);
  novo.flushInboundBuffer(OCIOSO);
  assert.deepEqual(novoOcupado.pushed, ["mensagem em voo"]);
  assert.deepEqual(novoOcioso.pushed, ["mensagem na fila"]);

  // O replay do server não repete: os dois ids estão nos vistos persistidos.
  const dedupNovo = createDeliveryDeduper(500);
  for (const id of loadDeliverySeen(dir)) dedupNovo.markSeen(id);
  assert.equal(dedupNovo.isSeen("voo-1"), true);
  assert.equal(dedupNovo.isSeen("fila-2") || dedupNovo.isSeen("fila-1"), true);
});

test("T-842 x T-839: o caminho do TETO (update, sem sinal) também segura o in-flight", () => {
  // O teto sai por requestReexec → prepareReexec({keepRunning:true}) SEM
  // porSinal. Se a captura do in-flight ficasse só no ramo do sinal, o teto
  // cortaria o turno aberto e a mensagem em voo sumiria (justamente o cenário
  // que o PM mandou cobrir aqui).
  const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const ini = src.indexOf("private async prepareReexec(");
  assert.ok(ini > 0, "prepareReexec presente");
  const bloco = src.slice(ini, src.indexOf("\n  }\n}", ini));
  const iHold = bloco.indexOf("this.host.holdInFlightForShutdown()");
  const iRamoSinal = bloco.indexOf("if (opts.keepRunning && opts.porSinal)");
  assert.ok(iHold > 0, "captura do in-flight presente");
  assert.ok(iHold < iRamoSinal, "captura FORA do ramo do sinal (vale para o teto do update)");
  const antes = bloco.slice(0, iRamoSinal);
  assert.match(antes, /if \(opts\.keepRunning\) \{[^}]*holdInFlightForShutdown/, antes);
  assert.ok(bloco.includes("if (opts.keepRunning && !opts.porSinal) this.gravarSpoolEVistos(\"[self-update]\")"), "spool do update depois do shutdown");
});