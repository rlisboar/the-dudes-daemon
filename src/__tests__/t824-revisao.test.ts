import { semPs } from "./env-exigido.js";
/**
 * T-824 (revisão independente): o SIGTERM passou a manter os agentes running,
 * o que levou todo reinício por caminhos que já estavam com defeito:
 *  - retidas voltavam 2× (spool + replay do server com resumeFromSeq=0) e
 *    mensagem já processada voltava 1× — os ids vistos morriam com o processo;
 *  - os dois perfis da máquina dividiam o mesmo spool;
 *  - dois reinícios seguidos perdiam as retidas ainda não entregues;
 *  - o instalador rodado por um agente matava a si mesmo;
 *  - SIGTERM no dreno do update mantinha o aviso "Não precisa reiniciar".
 */
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t824r-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t824r-pkeys-${process.pid}-${Date.now()}.json`);

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");
const { AgentHost, reexecSpoolDir } = await import("../agent-host.js");
const { createDeliveryDeduper, loadDeliverySeen, saveDeliverySeen, DELIVERY_SEEN_TTL_MS } = await import("../inbound-dedup.js");

const PID = "proj_t824r";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}

type FakeRunner = { pushed: string[]; pushUserMessage(c: string): void; isAlive(): boolean; stop(): void; isTurnActive(): boolean; takeQueuedForDrain(): Array<{ content: string }> };
function fakeRunner(): FakeRunner {
  return {
    pushed: [],
    pushUserMessage(c) { this.pushed.push(c); },
    isAlive: () => true, stop() {}, isTurnActive: () => false,
    takeQueuedForDrain: () => [],
  };
}
function hostCom(agentes: Record<string, FakeRunner | null>) {
  const out: Array<Record<string, unknown>> = [];
  const host = new AgentHost((m) => { out.push(m as Record<string, unknown>); }, null, null, {} as never, false, false, false, () => {}, () => {});
  const entries = (host as unknown as { entries: Map<string, unknown> }).entries;
  for (const [id, r] of Object.entries(agentes)) entries.set(id, { projectId: PID, runner: r, info: { id } });
  return { host, entries, out };
}

test("revisão T-824: ids de entrega vistos atravessam o reinício (dedup do replay do server)", () => {
  const dedup = createDeliveryDeduper(500);
  for (const id of ["d1", "d2", "d3"]) dedup.markSeen(id);
  const dir = mkdtempSync(path.join(os.tmpdir(), "t824r-seen-"));
  saveDeliverySeen(dir, dedup.snapshot(), 1_000);
  assert.deepEqual(loadDeliverySeen(dir, 1_000 + 60_000), ["d1", "d2", "d3"]);
  const novo = createDeliveryDeduper(500);
  for (const id of loadDeliverySeen(dir, 1_000 + 60_000)) novo.markSeen(id);
  assert.equal(novo.isSeen("d2"), true, "o replay de d2 é descartado no processo novo");
  assert.deepEqual(loadDeliverySeen(dir, 1_000 + DELIVERY_SEEN_TTL_MS + 1), [], "vencido não vale");
  writeFileSync(path.join(dir, "delivery-seen.json"), "{lixo");
  assert.deepEqual(loadDeliverySeen(dir), [], "arquivo corrompido não derruba o boot");
});

test("revisão T-824: spool é por perfil (os dois daemons da máquina não dividem o arquivo)", () => {
  const prevBin = process.env.THE_DUDES_DAEMON_BIN;
  const prevDir = process.env.THE_DUDES_REEXEC_SPOOL_DIR;
  delete process.env.THE_DUDES_REEXEC_SPOOL_DIR;
  try {
    process.env.THE_DUDES_DAEMON_BIN = "/Users/x/.the-dudes-mac/daemon.cjs";
    assert.equal(reexecSpoolDir(), "/Users/x/.the-dudes-mac/reexec-spool");
    process.env.THE_DUDES_DAEMON_BIN = "/Users/x/.the-dudes/daemon.cjs";
    assert.equal(reexecSpoolDir(), "/Users/x/.the-dudes/reexec-spool");
  } finally {
    if (prevBin === undefined) delete process.env.THE_DUDES_DAEMON_BIN; else process.env.THE_DUDES_DAEMON_BIN = prevBin;
    if (prevDir !== undefined) process.env.THE_DUDES_REEXEC_SPOOL_DIR = prevDir;
  }
});

test("revisão T-824: dois reinícios seguidos não perdem a retida que ainda não foi entregue", () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "t824r-spool-")), "sp");
  // 1º processo retém "m1" para um agente e sai.
  const { host: p1 } = hostCom({ ag: fakeRunner() });
  p1.startDrain();
  p1.send_message("ag", "m1", undefined, "d1");
  p1.writeReexecSpool(dir);
  // 2º processo carrega o spool, mas o agente não sobe a tempo; chega "m2"
  // para outro agente e ele também sai.
  const { host: p2 } = hostCom({ outro: fakeRunner() });
  assert.equal(p2.loadReexecSpool(dir), 1);
  p2.startDrain();
  p2.send_message("outro", "m2", undefined, "d2");
  const saida = p2.writeReexecSpool(dir);
  assert.equal(saida.spooled, 2, "a retida do boot anterior segue junto (antes o rename a sobrescrevia)");
  // 3º processo entrega as duas.
  const rAg = fakeRunner();
  const rOutro = fakeRunner();
  const { host: p3, entries } = hostCom({});
  assert.equal(p3.loadReexecSpool(dir), 2);
  entries.set("ag", { projectId: PID, runner: rAg, info: { id: "ag" } });
  entries.set("outro", { projectId: PID, runner: rOutro, info: { id: "outro" } });
  p3.flushInboundBuffer("ag");
  p3.flushInboundBuffer("outro");
  assert.deepEqual([rAg.pushed, rOutro.pushed], [["m1"], ["m2"]]);
  assert.ok(!existsSync(path.join(dir, "reexec-spool.json")), "drenado, o arquivo some");
});

test("revisão T-824: SIGTERM no meio do dreno do update troca o aviso para o de reinício", () => {
  const { host, out, entries } = hostCom({});
  // Projeto sem chave: o aviso sai em claro e dá para ler o texto.
  entries.set("ag", { projectId: "proj_t824r_sem_chave", runner: fakeRunner(), info: { id: "ag" } });
  host.startDrain();
  host.setDrainReason("shutdown");
  host.send_message("ag", "durante o reinício", undefined, "d9");
  const avisos = out.filter((o) => o.type === "agent:error").map((o) => String(o.message));
  assert.equal(avisos.length, 1);
  assert.match(avisos[0]!, /daemon reiniciando/);
  assert.doesNotMatch(avisos[0]!, /Não precisa reiniciar/);
});

test("revisão T-824: wiring do shutdown — WS fecha antes, spool/ids antes dos CLIs, marcador de parar de vez", () => {
  const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const sd = src.slice(src.indexOf("private async shutdown()"));
  const iClose = sd.indexOf('this.ws?.close(1000, "shutdown")');
  const iPrep = sd.indexOf("prepareReexec({ keepRunning: true, porSinal: true })");
  assert.ok(iClose > 0 && iPrep > 0 && iClose < iPrep, "no sinal o WS fecha ANTES do prepareReexec");
  assert.match(sd, /STOP_AGENTS_MARKER/, "uninstall pede parada definitiva pelo marcador");
  const pr = src.slice(src.indexOf("private async prepareReexec("), src.indexOf("private gravarSpoolEVistos("));
  const iGravar = pr.indexOf('this.gravarSpoolEVistos("[shutdown]")');
  const iHost = pr.indexOf("await this.host.shutdown(");
  assert.ok(iGravar > 0 && iGravar < iHost, "no sinal, spool e ids vistos são gravados antes de matar os CLIs");
  assert.match(src, /loadDeliverySeen\(profileHome\(\)\)/, "boot carrega os ids vistos antes de conectar");
});

test("revisão T-824: o instalador não se inclui (nem pais nem filhos) no snapshot de órfãos do daemon", { skip: semPs() }, async () => {
  const script = readFileSync(fileURLToPath(new URL("../../scripts/install-launchagent.sh", import.meta.url)), "utf8");
  const fn = /\nsnapshot_descendants\(\) \{[\s\S]*?\n\}\n/.exec(script);
  assert.ok(fn, "função snapshot_descendants presente no instalador");
  // Runner do "daemon" (este processo): um neto destacado que TEM de entrar.
  const runner = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  try {
    const bash = [
      "set -euo pipefail",
      fn![0],
      "sleep 60 & filho=$!",
      `snap="$(snapshot_descendants "${process.pid}")"`,
      'echo "SELF=$$ FILHO=$filho"',
      'echo "SNAP=$(echo "$snap" | cut -d"|" -f1 | tr "\\n" " ")"',
      'kill "$filho"',
    ].join("\n");
    const r = spawnSync("/bin/bash", ["-c", bash], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    const self = /SELF=(\d+)/.exec(r.stdout)![1]!;
    const filho = /FILHO=(\d+)/.exec(r.stdout)![1]!;
    const snap = (/SNAP=(.*)/.exec(r.stdout)![1] ?? "").trim().split(/\s+/);
    assert.ok(!snap.includes(self), `o instalador não entra (${self} em ${snap.join(",")})`);
    assert.ok(!snap.includes(filho), "nem os filhos dele");
    assert.ok(snap.includes(String(runner.pid)), "o runner do daemon entra");
  } finally {
    try { runner.kill("SIGKILL"); } catch { /* já saiu */ }
  }
});
