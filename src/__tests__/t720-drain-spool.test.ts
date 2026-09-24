/**
 * T-720 — self-update nunca aplicava com o time ativo (pendente de 16:09Z a
 * 17:26Z): isIdle() exige ZERO turnos e, com 7 agentes, sempre há um.
 * Agora: passados drainAfterMs sem idle natural, DRENO — nenhum turno novo
 * começa (o host retém as mensagens para um spool CIFRADO), os turnos em
 * curso terminam normalmente e o re-exec sai no primeiro idle.
 */
import "./scratch-home.js";

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign as edSign, randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t720-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t720-pkeys-${process.pid}-${Date.now()}.json`);

const { _resetIdleRestartForTest, checkAndApplyUpdate, runningReleaseInfo, DRAIN_AFTER_MS, DRAIN_FORCE_MS } = await import("../self-update.js");
const { _resetTurnGateForTest } = await import("../runners/turn-gate.js");
const { AgentHost } = await import("../agent-host.js");
const { getDaemonPublicKey, rememberProjectKey, encryptForProject } = await import("../daemon-crypto.js");
const { aadV2 } = await import("@the-dudes/protocol/e2ee-fields");

afterEach(() => { _resetIdleRestartForTest(); _resetTurnGateForTest(); });

function signBundle(body: string, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  const bundle = Buffer.from(body);
  return {
    bundle,
    sha: createHash("sha256").update(bundle).digest("hex"),
    sig: edSign(null, bundle, privateKey).toString("base64"),
  };
}

function fetchMap(map: Record<string, Buffer>): typeof fetch {
  return (async (url: string) => {
    const k = Object.keys(map).find((p) => String(url).endsWith(p));
    if (!k) throw new Error(`sem fixture pra ${url}`);
    return { ok: true, arrayBuffer: async () => map[k]! };
  }) as unknown as typeof fetch;
}

function signedInstall(
  daemonBody: string,
  bridgeBody: string,
): { pubs: string[]; fetchFn: typeof fetch; daemonSha: string } {
  const pair = generateKeyPairSync("ed25519");
  const pubs = [pair.publicKey.export({ type: "spki", format: "pem" }) as string];
  const d = signBundle(daemonBody, pair.privateKey);
  const b = signBundle(bridgeBody, pair.privateKey);
  return {
    pubs,
    daemonSha: d.sha,
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

function daemonSrc(ts: number): string {
  return `#!/usr/bin/env node\nconst DAEMON_BUILD_TS = Number("${ts}");\n`;
}

/* ---------------- (1)/(2): time com turnos contínuos ---------------- */

/** Simula N agentes com turnos contínuos de `turnoMs`: ao terminar um turno,
 *  outro começa (mensagem nova) — a menos que o host esteja drenando. */
function timeContinuo(n: number, turnoMs: number) {
  const fimDoTurno: Array<number | null> = Array.from({ length: n }, (_, i) => (i * turnoMs) / n);
  let draining = false;
  let mortos = 0;
  return {
    avanca(clock: number) {
      for (let i = 0; i < n; i++) {
        const fim = fimDoTurno[i];
        if (fim != null && clock >= fim) fimDoTurno[i] = draining ? null : fim + turnoMs;
        else if (fim == null && !draining) fimDoTurno[i] = clock + turnoMs;
      }
    },
    ativos: () => fimDoTurno.filter((f) => f != null).length,
    startDrain: () => { draining = true; },
    get draining() { return draining; },
    get mortos() { return mortos; },
    matar: () => { mortos += fimDoTurno.filter((f) => f != null).length; },
  };
}

async function armarPendente(opts: {
  isIdle: () => boolean;
  startDrain?: () => void;
  clockRef: { t: number };
  ticks: Array<() => void>;
  onExit: (c: number) => void;
  prepareReexec?: () => void;
  logs: string[];
}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t720-sup-"));
  const selfPath = path.join(dir, "daemon.cjs");
  writeFileSync(selfPath, "ANTIGO");
  const inst = signedInstall(daemonSrc(2_000_000_000_000), "bridge");
  return checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: "b".repeat(64),
    runningBuildTs: 1_000_000_000_000,
    log: (_l, m) => { opts.logs.push(m); },
    underLauncher: true,
    fetchFn: inst.fetchFn, trustedPubs: inst.pubs,
    isIdle: opts.isIdle,
    startDrain: opts.startDrain,
    idleRecheckMs: 15_000,
    nowFn: () => opts.clockRef.t,
    setTimeoutFn: (fn) => { opts.ticks.push(fn); return 0; },
    prepareReexec: opts.prepareReexec,
    exitFn: opts.onExit,
  });
}

test("T-720 (1): time com turnos contínuos → SEM dreno nunca aplica (o bug); COM dreno aplica em ≤ drainAfter + 1 turno", async () => {
  const TURNO = 5 * 60_000;
  for (const comDreno of [false, true]) {
    _resetIdleRestartForTest();
    const time = timeContinuo(7, TURNO);
    const clock = { t: 0 };
    const ticks: Array<() => void> = [];
    const logs: string[] = [];
    let exitEm: number | null = null;
    let ativosNoReexec = -1;
    const r = await armarPendente({
      isIdle: () => time.ativos() === 0,
      startDrain: comDreno ? time.startDrain : undefined,
      clockRef: clock, ticks, logs,
      prepareReexec: () => { ativosNoReexec = time.ativos(); },
      onExit: (c) => { if (c === 42) exitEm = clock.t; },
    });
    assert.equal(r, "updated-awaiting-idle");
    // 3h de relógio simulado em passos de 15s (o recheck do planner).
    for (let i = 0; i < ticks.length && clock.t < 3 * 3600_000 && exitEm == null; i++) {
      clock.t += 15_000;
      time.avanca(clock.t);
      ticks[i]!();
      await new Promise((r2) => setImmediate(r2));
    }
    if (!comDreno) {
      assert.equal(exitEm, null, "sem dreno o time contínuo nunca deixa aplicar (reproduz o incidente)");
      continue;
    }
    assert.ok(exitEm != null, "com dreno aplica");
    assert.ok(exitEm! <= DRAIN_AFTER_MS + TURNO + 15_000, `aplicou em ${exitEm! / 60_000}min (teto ${(DRAIN_AFTER_MS + TURNO) / 60_000}min)`);
    assert.ok(exitEm! >= DRAIN_AFTER_MS, "não drena antes da janela de idle natural");
    assert.equal(ativosNoReexec, 0, "(2) nenhum turno ativo no instante do re-exec");
    assert.ok(logs.some((l) => l.includes("DRENO: nenhum turno novo")));
  }
});

test("T-720 (2) / T-839: turno que não termina NÃO segura o re-exec além do teto do dreno", async () => {
  const clock = { t: 0 };
  const ticks: Array<() => void> = [];
  const logs: string[] = [];
  let exit: number | null = null;
  let drenos = 0;
  let preparou = 0;
  await armarPendente({
    isIdle: () => false, // um turno eterno
    startDrain: () => { drenos++; },
    clockRef: clock, ticks, logs,
    prepareReexec: () => { preparou++; },
    onExit: (c) => { exit = c; },
  });
  const teto = DRAIN_AFTER_MS + DRAIN_FORCE_MS;
  for (let i = 0; i < ticks.length && clock.t < teto && exit == null; i++) {
    clock.t += 15_000;
    ticks[i]!();
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(exit, 42, "no teto o re-exec sai mesmo com turno aberto");
  assert.equal(clock.t, teto, "sai no teto, não antes");
  assert.equal(drenos, 1, "dreno liga uma vez só");
  assert.equal(preparou, 1, "prepareReexec (keepRunning no main) corre no teto");
  assert.ok(logs.some((l) => l.includes("teto do dreno") && l.includes("keepRunning")), "log do teto");
  assert.ok(!logs.some((l) => l.includes("nunca é morto")));
});

test("T-720 (3): health/hello expõem updatePendingSince e updateDraining", async () => {
  const clock = { t: 1_000 };
  const ticks: Array<() => void> = [];
  await armarPendente({
    isIdle: () => false,
    startDrain: () => {},
    clockRef: clock, ticks, logs: [],
    onExit: () => {},
  });
  let info = runningReleaseInfo();
  assert.equal(info.updatePending, true);
  assert.equal(info.updatePendingSince, 1_000);
  assert.equal(info.updateDraining, false);
  clock.t = 1_000 + DRAIN_AFTER_MS;
  ticks[0]!();
  info = runningReleaseInfo();
  assert.equal(info.updateDraining, true);
  _resetIdleRestartForTest();
  assert.equal(runningReleaseInfo().updatePendingSince, null);
});

/* ---------------- spool: retenção, cifra, disco, entrega ---------------- */

const PID = "proj_t720";
const PID_SEM_CHAVE = "proj_t720_semchave";
{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PID, wrap.toString("base64")), true);
}
const SEGREDO = "SEGREDO-T720 cobrança que chegou no dreno";

type FakeRunner = { pushed: string[]; pushUserMessage(c: string): void; isAlive(): boolean; stop(): void; isTurnActive(): boolean; takeQueuedForDrain(): Array<{ content: string }> };
function fakeRunner(fila: string[] = []): FakeRunner {
  return {
    pushed: [],
    pushUserMessage(c) { this.pushed.push(c); },
    isAlive: () => true, stop() {}, isTurnActive: () => false,
    takeQueuedForDrain() { const out = fila.map((content) => ({ content })); fila.length = 0; return out; },
  };
}
function hostCom(agentes: Record<string, { projectId: string; runner: FakeRunner | null }>) {
  const logs: string[] = [];
  const host = new AgentHost(() => {}, null, null, {} as never, false, false, false, (_l: string, m: string) => { logs.push(m); }, () => {});
  const entries = (host as unknown as { entries: Map<string, unknown> }).entries;
  for (const [id, a] of Object.entries(agentes)) entries.set(id, { projectId: a.projectId, runner: a.runner, info: { id } });
  return { host, logs, entries };
}

test("T-720 spool: dreno retém send_message e tira a fila NÃO iniciada do runner; o turno em curso não é tocado", () => {
  const fila = ["fila-1", "fila-2"];
  const r = fakeRunner(fila);
  const { host } = hostCom({ ag: { projectId: PID, runner: r } });
  assert.equal(host.startDrain(), 2, "fila não iniciada sai do runner");
  host.send_message("ag", SEGREDO, undefined, "d1");
  assert.deepEqual(r.pushed, [], "nada novo chega ao runner no dreno");
  const dir = mkdtempSync(path.join(os.tmpdir(), "t720-spool-"));
  const out = host.writeReexecSpool(path.join(dir, "sp"));
  assert.equal(out.spooled, 3);
  assert.equal(out.lost, 0);
});

test("T-720 spool: arquivo 0600 em dir 0700, ZERO plaintext em disco, só blobs e2e:v2", () => {
  const { host } = hostCom({ ag: { projectId: PID, runner: fakeRunner() } });
  host.startDrain();
  host.send_message("ag", SEGREDO, undefined, "d1");
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "t720-spool-")), "sp");
  const out = host.writeReexecSpool(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700, "diretório 0700");
  assert.equal(statSync(out.path!).mode & 0o777, 0o600, "arquivo 0600");
  const bruto = readFileSync(out.path!, "utf8");
  assert.ok(!bruto.includes("SEGREDO") && !bruto.includes("cobrança"), "nenhum plaintext no disco");
  const recs = JSON.parse(bruto).records as Array<{ blob: string }>;
  assert.equal(recs.length, 1);
  assert.ok(recs.every((x) => x.blob.startsWith("e2e:v2:")));
  assert.deepEqual(readdirSync(dir), ["reexec-spool.json"], "sem .tmp esquecido");
});

test("T-720 spool: projeto SEM chave → mensagem NÃO vai para o disco (perda declarada no log)", () => {
  const { host, logs } = hostCom({ ag: { projectId: PID_SEM_CHAVE, runner: fakeRunner() } });
  host.startDrain();
  host.send_message("ag", SEGREDO, undefined, "d1");
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "t720-spool-")), "sp");
  const out = host.writeReexecSpool(dir);
  assert.equal(out.spooled, 0);
  assert.equal(out.lost, 1);
  assert.equal(out.path, null);
  assert.ok(!existsSync(path.join(dir, "reexec-spool.json")), "nada escrito");
  assert.ok(logs.some((l) => l.includes("sem chave do projeto") && l.includes("NÃO gravada em claro")));
  assert.ok(!logs.join("\n").includes("SEGREDO"), "conteúdo não vai para o log");
});

test("T-720 spool: processo novo carrega, entrega no spawn (ordem) e REMOVE o arquivo quando drenado", () => {
  const { host: velho } = hostCom({ ag: { projectId: PID, runner: fakeRunner(["m1"]) } });
  velho.startDrain();
  velho.send_message("ag", "m2", undefined, "d2");
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "t720-spool-")), "sp");
  const file = velho.writeReexecSpool(dir).path!;

  const r = fakeRunner();
  const { host: novo, entries } = hostCom({});
  assert.equal(novo.loadReexecSpool(dir), 2);
  assert.ok(existsSync(file), "fica no disco até entregar");
  entries.set("ag", { projectId: PID, runner: r, info: { id: "ag" } });
  novo.flushInboundBuffer("ag"); // mesmo ponto do fim do spawn
  assert.deepEqual(r.pushed, ["m1", "m2"], "fila antiga antes das novas");
  assert.ok(!existsSync(file), "removido depois de drenado");
  assert.equal(novo.spoolPendingCount(), 0);
});

test("T-720 spool: registro em CLARO ou adulterado no arquivo é rejeitado (não vira prompt)", () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "t720-spool-")), "sp");
  const { host: velho } = hostCom({ ag: { projectId: PID, runner: fakeRunner() } });
  velho.startDrain();
  velho.send_message("ag", "legitima", undefined, "d1");
  const file = velho.writeReexecSpool(dir).path!;
  const j = JSON.parse(readFileSync(file, "utf8"));
  const b = Buffer.from(j.records[0].blob.slice(7), "base64");
  b[14] ^= 1;
  j.records.push({ agentId: "ag", projectId: PID, enqueuedAt: Date.now(), blob: "INJETADO em claro" });
  j.records.push({ agentId: "ag", projectId: PID, enqueuedAt: Date.now(), blob: "e2e:v2:" + b.toString("base64") });
  // blob de OUTRO kind (catálogo) com a mesma chave também não abre com o AAD do spool
  j.records.push({ agentId: "ag", projectId: PID, enqueuedAt: Date.now(), blob: encryptForProject(JSON.stringify({ content: "outro-kind" }), PID, aadV2({ projectId: PID, table: "messages", field: "content" })) });
  writeFileSync(file, JSON.stringify(j));
  const r = fakeRunner();
  const { host: novo, entries } = hostCom({});
  const orig = console.warn; console.warn = () => {};
  try {
    novo.loadReexecSpool(dir);
    entries.set("ag", { projectId: PID, runner: r, info: { id: "ag" } });
    novo.flushInboundBuffer("ag");
  } finally { console.warn = orig; }
  assert.deepEqual(r.pushed, ["legitima"], "só o blob autêntico do spool é entregue");
});

test("T-720 spool: registro vencido (> TTL) não é entregue", () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "t720-spool-")), "sp");
  const { host: velho } = hostCom({ ag: { projectId: PID, runner: fakeRunner() } });
  velho.startDrain();
  velho.send_message("ag", "velha", undefined, "d1");
  velho.writeReexecSpool(dir);
  const { host: novo } = hostCom({});
  assert.equal(novo.loadReexecSpool(dir, Date.now() + 2 * 3600_000), 0);
});

/* ---------------- AgentRunner.takeQueuedForDrain (3 filas) ---------------- */

const { AgentRunner } = await import("../agent-runner.js");

function runnerSemStart(cliRunner: string) {
  const info = {
    id: `agent_t720_${cliRunner}`, ownerUserId: "u", name: cliRunner, role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner, autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: {}, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onExit: () => {},
  } as never);
  return { runner, a: runner as unknown as Record<string, any> };
}

test("T-720 takeQueuedForDrain: fila per-message (grok) devolvida em ordem e LIMPA; turno em curso intacto", () => {
  const { runner, a } = runnerSemStart("grok");
  a.drainOcQueue = () => {}; // simula turno em curso: nada sai da fila sozinho
  a.messageSession.busy = true;
  runner.pushUserMessage("g1");
  runner.pushUserMessage("g2");
  a.messageSession.enqueue({ content: "hang", synthetic: "hang-recover" }, 50);
  runner.pushUserMessage("g3");
  assert.deepEqual(runner.takeQueuedForDrain().map((m) => m.content), ["g1", "g2", "g3"], "ordem preservada, sintética fora");
  assert.equal(a.messageSession.queuedCount(), 0, "fila limpa");
  assert.equal(a.messageSession.busy, true, "turno em curso não é tocado");
  assert.deepEqual(runner.takeQueuedForDrain(), []);
});

test("T-720 takeQueuedForDrain: pendingMessages do claude (restart) devolvidas em ordem e LIMPAS", () => {
  const { runner, a } = runnerSemStart("claude");
  a.restarting = true; // pushUserMessage buffera em pendingMessages
  runner.pushUserMessage("c1");
  runner.pushUserMessage("c2");
  assert.equal(a.pendingMessages.length, 2);
  assert.deepEqual(runner.takeQueuedForDrain().map((m) => m.content), ["c1", "c2"]);
  assert.equal(a.pendingMessages.length, 0);
});

test("T-720 takeQueuedForDrain: fila do dsh devolvida em ordem e LIMPA (prompt em voo fica)", () => {
  const { runner, a } = runnerSemStart("dsh");
  a.dshReady = false; // sem handshake: o pump não consome
  runner.pushUserMessage("d1");
  runner.pushUserMessage("d2");
  assert.equal(a.dshQueue.length, 2);
  assert.deepEqual(runner.takeQueuedForDrain().map((m) => m.content), ["d1", "d2"]);
  assert.equal(a.dshQueue.length, 0);
});

/* ---------------- (2) integração: AgentHost real + turno grok em curso ---------------- */

test("T-720 (2) integração: dreno com turno EM CURSO — o turno termina (texto entregue), a msg enfileirada NÃO começa e vai para o spool", async (t) => {
  const { chmodSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "t720-int-"));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  // T-1017: NUNCA rode este teste em paralelo com ele mesmo (10× no mesmo
  // `node --test` ou shell `&`). O stub trava no portão até o teste liberar;
  // 10 cópias travadas acumulam 10 CLIs + 10 turn-gates + 10 AgentHosts no
  // mesmo processo — o spawn do stub (Gatekeeper em /tmp, ~800 ms cada em
  // série) atrasa minutos e os `until` estouram MESMO com a ordem certa.
  // Isolado: 13/13. Carga real (suíte inteira) continua válida.
  const stub = path.join(dir, "cli.mjs");
  const marca = path.join(dir, "turnos.txt");
  // T-1017 (ex-flake sob carga): o turno NÃO tem duração própria — o stub
  // registra que começou e trava até o teste liberar (portão por arquivo).
  // Antes: `setTimeout(800)` corria contra o `startDrain` do teste; sob carga
  // o turno acabava antes do dreno, a 2ª mensagem já tinha virado turno e o
  // `startDrain()` voltava 0 em vez de 1. Agora a ordem é fato, não timing:
  // turno 1 em curso (travado no portão) → dreno → libera → turno termina.
  const portao = path.join(dir, "portao");
  writeFileSync(stub, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(marca)}, "turno\\n");
while (!existsSync(${JSON.stringify(portao)})) await new Promise((r) => setTimeout(r, 25));
process.stdout.write(JSON.stringify({ type: "text", data: "RESPOSTA" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }) + "\\n");
`);
  chmodSync(stub, 0o755);
  const out: Array<Record<string, unknown>> = [];
  const off = { command: "false", source: "override" as const, available: false };
  const host = new AgentHost((m) => { out.push(m as Record<string, unknown>); }, null, null, {
    claude: off, opencode: off, gemini: off, codex: off, crush: off, qwen: off,
    grok: { command: stub, source: "override" as const, available: true }, "grok-custom": off, graphify: off, graphifyMcp: off,
  } as never, false, false, false, () => {}, () => {});
  const id = "agent_t720_int";
  // T-1017: o spawn é async de verdade (prepareGraphify + sonda de runner).
  // Sem o await, sob carga o runner ainda não existe quando a "primeira"
  // chega e ela cai no buffer pré-spawn (T-037) em vez de virar turno.
  const spawnOk = host.spawn({
    agent: { id, ownerUserId: "u", name: "int", role: "backend", systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
      // efêmero = pool `bg` do turn-gate (T-055), que os outros testes do
      // arquivo não usam — o turno 1 nunca fica preso atrás de slots
      // ocupados por vizinhos sob carga.
      ephemeral: true,
      usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, cliRunner: "grok" },
    projectId: PID, basePath: dir, autoApprove: true, agentToken: "tok",
  } as never);
  // O spawn é async de verdade (prepareGraphify + sonda): sem o await, sob
  // carga o runner ainda não existe quando a "primeira" chega.
  await spawnOk;
  const turnos = () => (existsSync(marca) ? readFileSync(marca, "utf8").split("\n").filter(Boolean).length : 0);
  const until = async (c: () => boolean, ms = 60_000) => { const t0 = Date.now(); while (!c()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };
  // Portão na ENTRADA: runner existe (não cai no buffer pré-spawn). Sem
  // runner seria -1; `===0` prova runner vivo com fila vazia. Se a "primeira"
  // chegar antes, ela cai no buffer (T-037) e o flush a entrega sem passar
  // pela fila — o `turnos()===1` nunca aterraria.
  // Timeout de 60 s (era 10 s): sob carga de 10× o spawn do stub (exec novo
  // em /tmp no macOS) atrasa segundos; o portão garante a ORDEM (fatos, não
  // timing), o timeout longo só dá margem ao agendamento.
  await until(() => host.runnerEnfileiradas(id) === 0, 60_000);
  try {
    // T-1017 (ex-flake sob carga): o teste exige turno 1 EM CURSO (stub
    // travado no portão) + "segunda" NA FILA quando o dreno ligar. Depois
    // do portão de entrada acima, a ordem é por fatos: (1) turno 1
    // registrou início no stub; (2) "segunda" estacionou na fila do runner
    // (runnerEnfileiradas===1, turno 1 ainda travado no portão).
    host.send_message(id, "primeira", undefined, "d1");
    await until(() => turnos() === 1);
    host.send_message(id, "segunda", undefined, "d2");
    await until(() => host.runnerEnfileiradas(id) === 1); // "segunda" estacionada, turno 1 ainda travado
    assert.equal(host.startDrain(), 1, "a segunda (não iniciada) sai da fila do runner");
    host.send_message(id, "terceira", undefined, "d3");
    writeFileSync(portao, "vai"); // libera o turno 1: termina e entrega o texto
    await until(() => out.some((m) => m.type === "agent:text"));
    await until(() => !host.hasActiveTurn(), 5_000);
    assert.equal(turnos(), 1, "nenhum turno novo começou no dreno (dreno retém, não precisa de espera fixa)");
    const sp = host.writeReexecSpool(path.join(dir, "sp"));
    assert.equal(sp.spooled, 2, "segunda + terceira vão para o spool cifrado");
  } finally {
    await host.shutdown({ reexec: true });
  }
});
