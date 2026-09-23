/**
 * T-839 — o dreno do self-update não fica refém de um turno que não fecha.
 *
 * Um agente em turno "infinito" (claude + monitor, sem evento result) e outro
 * ocioso: a mensagem do ocioso fica retida até o teto, o re-exec sai com
 * keepRunning, e o processo novo entrega essa mensagem pelo spool. O log
 * nomeia o agentId e a idade de quem segura.
 */
import "./scratch-home.js";

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createHash, generateKeyPairSync, sign as edSign, randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t839-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t839-pkeys-${process.pid}-${Date.now()}.json`);

const { _resetIdleRestartForTest, checkAndApplyUpdate, DRAIN_AFTER_MS, DRAIN_FORCE_MS, LONG_TURN_MS } = await import("../self-update.js");
const { AgentHost } = await import("../agent-host.js");
const { AgentRunner } = await import("../agent-runner.js");
const { getDaemonPublicKey, rememberProjectKey } = await import("../daemon-crypto.js");
const { diagnose } = await import("../debug/index.js");

afterEach(() => { _resetIdleRestartForTest(); });

const PID = "proj_t839";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}

const OCUPADO = "agent_cf403b73";
const OCIOSO = "agent_ocioso";

function signBundle(body: string, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  const bundle = Buffer.from(body);
  return { bundle, sha: createHash("sha256").update(bundle).digest("hex"), sig: edSign(null, bundle, privateKey).toString("base64") };
}

function fetchMap(map: Record<string, Buffer>): typeof fetch {
  return (async (url: string) => {
    const k = Object.keys(map).find((p) => String(url).endsWith(p));
    if (!k) throw new Error(`sem fixture pra ${url}`);
    return { ok: true, arrayBuffer: async () => map[k]! };
  }) as unknown as typeof fetch;
}

function signedInstall(daemonBody: string, bridgeBody: string) {
  const pair = generateKeyPairSync("ed25519");
  const pubs = [pair.publicKey.export({ type: "spki", format: "pem" }) as string];
  const d = signBundle(daemonBody, pair.privateKey);
  const b = signBundle(bridgeBody, pair.privateKey);
  return {
    pubs,
    fetchFn: fetchMap({
      "/install/daemon.cjs.sha256": Buffer.from(`${d.sha}  daemon.cjs\n`),
      "/install/daemon.cjs": d.bundle,
      "/install/daemon.cjs.sig": Buffer.from(d.sig),
      "/install/mcp-bridge.cjs.sha256": Buffer.from(`${b.sha}  mcp-bridge.cjs\n`),
      "/install/mcp-bridge.cjs": b.bundle,
      "/install/mcp-bridge.cjs.sig": Buffer.from(b.sig),
    }),
  };
}

type Fake = {
  pushed: string[];
  pushUserMessage(c: string): void;
  isAlive(): boolean;
  stop(): void;
  isTurnActive(): boolean;
  activeTurnAgeMs(): number | null;
  turnHoldReason(): string | null;
  takeQueuedForDrain(): Array<{ content: string }>;
};

function fakeRunner(opts: { ativo?: boolean; idadeMs?: number }): Fake {
  return {
    pushed: [],
    pushUserMessage(c) { this.pushed.push(c); },
    isAlive: () => true,
    stop() {},
    isTurnActive: () => !!opts.ativo,
    activeTurnAgeMs: () => (opts.ativo ? (opts.idadeMs ?? 0) : null),
    turnHoldReason: () => (opts.ativo ? "tool-em-voo-sem-result" : null),
    takeQueuedForDrain: () => [],
  };
}

function hostCom(agentes: Record<string, { projectId: string; runner: Fake; cliRunner?: string; state?: string }>) {
  const logs: string[] = [];
  const host = new AgentHost(() => {}, null, null, {} as never, false, false, false, (_l: string, m: string) => { logs.push(m); }, () => {});
  const entries = (host as unknown as { entries: Map<string, unknown> }).entries;
  for (const [id, a] of Object.entries(agentes)) {
    entries.set(id, { projectId: a.projectId, runner: a.runner, info: { id, name: id, cliRunner: a.cliRunner ?? "claude", state: a.state ?? "idle" } });
  }
  return { host, logs, entries };
}

test("T-839: turno infinito segura só a si; no teto o re-exec sai e a mensagem do ocioso é entregue pelo spool", async () => {
  const ocupado = fakeRunner({ ativo: true, idadeMs: 2 * 3_600_000 });
  const ocioso = fakeRunner({});
  const { host, logs: hostLogs } = hostCom({
    [OCUPADO]: { projectId: PID, runner: ocupado, state: "thinking" },
    [OCIOSO]: { projectId: PID, runner: ocioso, state: "idle" },
  });
  const holders = host.drainHolders();
  assert.deepEqual(holders.map((h) => h.agentId), [OCUPADO], "ocioso não segura o dreno");
  assert.ok(holders[0]!.turnAgeMs >= LONG_TURN_MS);
  assert.equal(holders[0]!.reason, "tool-em-voo-sem-result");

  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "t839-spool-")), "sp");
  const clock = { t: 0 };
  const ticks: Array<() => void> = [];
  const logs: string[] = [];
  let exit: number | null = null;
  let spoolN = -1;
  const inst = signedInstall(`#!/usr/bin/env node\nconst DAEMON_BUILD_TS = Number("2000000000000");\n`, "bridge");
  const r = await checkAndApplyUpdate({
    orchBase: "http://x",
    selfPath: path.join(mkdtempSync(path.join(os.tmpdir(), "t839-bin-")), "daemon.cjs"),
    runningHash: "b".repeat(64),
    runningBuildTs: 1_000_000_000_000,
    log: (_l, m) => { logs.push(m); },
    underLauncher: true,
    fetchFn: inst.fetchFn,
    trustedPubs: inst.pubs,
    isIdle: () => !host.hasActiveTurn(),
    startDrain: () => { host.startDrain(); },
    drainHolders: () => host.drainHolders(),
    idleRecheckMs: 15_000,
    nowFn: () => clock.t,
    setTimeoutFn: (fn) => { ticks.push(fn); return 0; },
    prepareReexec: () => { spoolN = host.writeReexecSpool(dir).spooled; },
    exitFn: (c) => { exit = c; },
  });
  assert.equal(r, "updated-awaiting-idle");

  let enviou = false;
  const teto = DRAIN_AFTER_MS + DRAIN_FORCE_MS;
  for (let i = 0; i < ticks.length && exit == null && clock.t <= teto; i++) {
    clock.t += 15_000;
    ticks[i]!();
    await new Promise((r2) => setImmediate(r2));
    if (!enviou && clock.t >= DRAIN_AFTER_MS) {
      assert.equal(exit, null, "antes do teto o turno infinito ainda segura o re-exec");
      host.send_message(OCIOSO, "oi-ocioso", undefined, "d-ocioso");
      host.send_message(OCUPADO, "oi-ocupado", undefined, "d-ocupado");
      assert.deepEqual(ocioso.pushed, [], "ocioso não recebe no processo velho");
      assert.deepEqual(ocupado.pushed, [], "ocupado também não começa turno novo");
      enviou = true;
    }
  }
  assert.equal(enviou, true);
  assert.equal(exit, 42);
  assert.equal(clock.t, teto);
  assert.equal(spoolN, 2, "as duas mensagens vão no spool do re-exec");
  assert.ok(logs.some((l) => l.includes(`agentId=${OCUPADO}`) && l.includes("idade=") && l.includes("turno-longo")), logs.join("\n"));
  assert.ok(logs.some((l) => l.includes("teto do dreno") && l.includes("keepRunning") && l.includes(`agentId=${OCUPADO}`)));
  assert.ok(hostLogs.some((l) => l.includes(`agentId=${OCUPADO}`)));

  const entregue = fakeRunner({});
  const novo = hostCom({});
  assert.equal(novo.host.loadReexecSpool(dir), 2);
  novo.entries.set(OCIOSO, { projectId: PID, runner: entregue, info: { id: OCIOSO } });
  novo.entries.set(OCUPADO, { projectId: PID, runner: fakeRunner({ ativo: false }), info: { id: OCUPADO } });
  novo.host.flushInboundBuffer(OCIOSO);
  assert.deepEqual(entregue.pushed, ["oi-ocioso"], "no processo novo o ocioso recebe a mensagem");
});

test("T-839: turnElapsedMs do claude é a idade do turno aberto, e o dashboard chama de turno longo", () => {
  const info = {
    id: "agent_t839_claude", ownerUserId: "u", name: "PM", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false, cliRunner: "claude",
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "claude", autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: {}, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onExit: () => {},
  } as never);
  const a = runner as unknown as {
    currentState: string;
    turnActiveSince: number | null;
    toolsInFlight: number;
    activityClock: { turnStartedAt: number };
  };
  const boot = Date.now() - 5 * 3_600_000;
  a.activityClock.turnStartedAt = boot;
  a.currentState = "idle";
  let snap = runner.debugSnapshot();
  assert.equal(snap.turnActive, false);
  assert.equal(snap.turnElapsedMs, null, "ocioso não herda a idade desde o boot");
  assert.equal(snap.longTurn, false);

  a.currentState = "thinking";
  a.turnActiveSince = Date.now() - 2 * 3_600_000;
  snap = runner.debugSnapshot();
  assert.equal(snap.turnActive, true);
  assert.ok(Math.abs((snap.turnElapsedMs as number) - 2 * 3_600_000) < 2_000, "idade do turno, não do boot (5h)");
  assert.equal(snap.longTurn, true);
  assert.equal(snap.turnHoldReason, "stream-sem-result");
  a.toolsInFlight = 1;
  assert.equal(runner.turnHoldReason(), "tool-em-voo-sem-result");

  const alerts = diagnose({
    platform: "linux",
    agents: [{
      agentId: OCUPADO, name: "PM", cliRunner: "claude", hasRunner: true,
      runner: { state: "thinking", turnActive: true, longTurn: true, turnElapsedMs: 2 * 3_600_000, turnHoldReason: "tool-em-voo-sem-result", inTurn: true, idleMs: 1_000, toolsInFlight: 1, queued: 0, busy: false },
    }],
    gate: { pools: { main: { forced: 0 }, bg: { forced: 0 } }, waiters: [] },
    loop: null,
    proc: null,
    ws: { readyState: 1 },
    process: {},
    system: {},
    host: {
      draining: true,
      drainHolders: [{ agentId: OCUPADO, turnAgeMs: 2 * 3_600_000, runner: "claude", state: "thinking", reason: "tool-em-voo-sem-result" }],
    },
  });
  const dreno = alerts.find((x) => x.area === "dreno");
  assert.ok(dreno, alerts.map((x) => x.title).join(" | "));
  assert.equal(dreno!.level, "warn");
  assert.match(dreno!.title, /turno longo/);
  assert.match(dreno!.title, new RegExp(OCUPADO));
  assert.match(dreno!.detail, /result/);
});
