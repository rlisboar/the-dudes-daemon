/**
 * T-812: dashboard de debug local do daemon — store, sondas, amostrador de
 * processos, diagnóstico automático, servidor loopback (auth/Host/Origin/CSP)
 * e a página embutida (JS válido, sem crase/"${", sem style inline).
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import {
  _resetDebugStoreForTest, aggregateTurns, dist, liveTurnsSnapshot, queryLogs, recentTurns, recordDebugLog,
  recordSpawn, recordStall, recordSyncOp, recordTurnEnd, Ring, spawnsSnapshot, stallsSnapshot, summarizeArgs,
  syncOpsSnapshot, unwrapCommand, recordCliIo, cliIoCounters, cliCaptureSnapshot, setCliCapture, setDebugScrubber,
  recordAgentState, agentStateInfo, recordRelayRequest, relaySnapshot, recordWsHandler, recordWsIn, wsSnapshot,
} from "../debug/store.js";
import { TurnLatency } from "../runners/turn-latency.js";
import { _resetTurnGateForTest, acquireTurnSlot, turnGateDebug } from "../runners/turn-gate.js";
import { ProcSampler, isToolOrphanCandidate, parsePsTable } from "../debug/proc-sampler.js";
import { diagnose, redactedEnv, summarizeCpuProfile } from "../debug/index.js";
import { startDebugHttpServer } from "../debug/server.js";
import { _dashboardAssetsForTest, dashboardHtml } from "../debug/dashboard-html.js";
import { installSyncProbes } from "../debug/probes.js";

beforeEach(() => {
  _resetDebugStoreForTest();
  _resetTurnGateForTest();
});

/* ───────────── store ───────────── */

test("T-812 Ring: teto, ordem (mais antigo primeiro) e total da vida", () => {
  const r = new Ring<number>(3);
  for (let i = 1; i <= 5; i++) r.push(i);
  assert.deepEqual(r.toArray(), [3, 4, 5]);
  assert.deepEqual(r.last(2), [4, 5]);
  assert.equal(r.size, 3);
  assert.equal(r.total, 5);
  r.clear();
  assert.deepEqual(r.toArray(), []);
});

test("T-812 dist: percentis ignoram null/NaN", () => {
  const d = dist([null, 10, 20, NaN, 30, 40, undefined]);
  assert.equal(d.n, 4);
  assert.equal(d.p50, 20);
  assert.equal(d.max, 40);
  assert.equal(dist([]).p50, null);
});

test("T-812 logs: filtros por nível, texto e sinceSeq; issues sobrevivem num ring próprio", () => {
  recordDebugLog("info", "boot ok");
  recordDebugLog("warn", "[hang:BACKEND] sem atividade");
  recordDebugLog("error", "ws error: ECONNRESET");
  recordDebugLog("info", "agent_abc spawn");
  assert.equal(queryLogs().lines.length, 4);
  assert.deepEqual(queryLogs({ level: "issues" }).lines.map((l) => l.level), ["warn", "error"]);
  assert.deepEqual(queryLogs({ level: "error" }).lines.map((l) => l.msg), ["ws error: ECONNRESET"]);
  assert.deepEqual(queryLogs({ q: "AGENT_ABC" }).lines.map((l) => l.msg), ["agent_abc spawn"]);
  const since = queryLogs({ sinceSeq: 2 });
  assert.deepEqual(since.lines.map((l) => l.seq), [3, 4]);
  assert.deepEqual(since.counts, { info: 2, warn: 1, error: 1 });
});

test("T-812 turnos: agregado por runner ignora descartes de fila e conta problemas", () => {
  const base = { turnId: "t", attempt: 0, queueMs: 1, gateWaitMs: 5, firstEventMs: 100, acceptMs: null, bootMs: null };
  recordTurnEnd("a1", "grok", { ...base, durationMs: 1000, endReason: "completed" });
  recordTurnEnd("a1", "grok", { ...base, durationMs: 3000, endReason: "hard-recover", killedBy: "watchdog" });
  recordTurnEnd("a2", "claude", { ...base, durationMs: 500, endReason: "completed" });
  recordTurnEnd("a2", "claude", { ...base, durationMs: null, endReason: "queue-cleared" });
  const byRunner = Object.fromEntries(aggregateTurns("runner").map((a) => [a.key, a]));
  assert.equal(byRunner.grok!.count, 2);
  assert.equal(byRunner.grok!.problems, 1);
  assert.deepEqual(byRunner.grok!.endReasons, { completed: 1, "hard-recover": 1 });
  assert.equal(byRunner.claude!.count, 1, "queue-cleared não é turno executado");
  assert.equal(recentTurns({ runner: "grok" }).length, 2);
  assert.equal(recentTurns().at(-1)!.endReason, "queue-cleared", "o registro cru guarda tudo");
});

test("T-812 TurnLatency: turno em voo aparece no dashboard e sai no fim (com registro estruturado)", () => {
  const logs: string[] = [];
  const lat = new TurnLatency("agent_x", "codex", (_l, m) => logs.push(m));
  const msg = { content: "oi" };
  lat.enqueue(msg);
  const t = lat.activate(msg, "cold");
  t.gateStart();
  assert.equal(liveTurnsSnapshot().length, 1);
  assert.equal(liveTurnsSnapshot()[0]!.phase, "gate");
  t.gateEnd();
  t.start();
  assert.equal(liveTurnsSnapshot()[0]!.phase, "waiting-first-event");
  t.semantic("text");
  assert.equal(liveTurnsSnapshot()[0]!.phase, "streaming");
  t.finish("completed");
  assert.equal(liveTurnsSnapshot().length, 0);
  const rec = recentTurns({ agentId: "agent_x" });
  assert.equal(rec.length, 1);
  assert.equal(rec[0]!.runner, "codex");
  assert.equal(rec[0]!.endReason, "completed");
  assert.equal(rec[0]!.sessionMode, "cold");
  assert.ok(logs.some((l) => l.startsWith("[turn-latency]")), "o log de sempre continua saindo");
});

test("T-812 turn-gate: quem segura, quem espera e estatística de espera", async () => {
  const r1 = await acquireTurnSlot("grok:A");
  const r2 = await acquireTurnSlot("grok:B");
  const r3 = await acquireTurnSlot("grok:C");
  const pending = acquireTurnSlot("codex:D");
  await new Promise((r) => setTimeout(r, 20));
  let d = turnGateDebug();
  assert.equal(d.pools.main.active, 3);
  assert.deepEqual(d.holders.map((h) => h.label).sort(), ["grok:A", "grok:B", "grok:C"]);
  assert.equal(d.waiters.length, 1);
  assert.equal(d.waiters[0]!.label, "codex:D");
  assert.ok(d.waiters[0]!.waitingMs >= 15);
  r1();
  const r4 = await pending;
  d = turnGateDebug();
  assert.equal(d.waiters.length, 0);
  assert.ok(d.holders.some((h) => h.label === "codex:D"));
  assert.equal(d.pools.main.grants, 4);
  assert.equal(d.pools.main.waited, 1, "só a concessão que passou pela fila conta como espera");
  assert.ok((d.pools.main.waitMaxMs ?? 0) >= 15);
  r2(); r3(); r4();
  assert.equal(turnGateDebug().holders.length, 0);
});

test("T-812 spawns: registra comando real (setpriv desembrulhado), exit e NÃO escuta 'error'", () => {
  assert.deepEqual(unwrapCommand("/usr/bin/setpriv", ["setpriv", "--reuid", "501", "--", "/opt/bin/claude", "--print"]), { cmd: "claude", args: ["--print"] });
  const child = Object.assign(new EventEmitter(), { pid: 4242, spawnfile: "/opt/bin/grok", spawnargs: ["/opt/bin/grok", "-p", "x".repeat(500)] });
  recordSpawn(child, { cwd: "/w", env: { THE_DUDES_AGENT_ID: "agent_g" } });
  assert.equal(child.listenerCount("error"), 0, "listener de error engoliria o ENOENT de quem chamou");
  let s = spawnsSnapshot();
  assert.equal(s.live.length, 1);
  assert.equal(s.live[0]!.agentId, "agent_g");
  assert.ok(s.live[0]!.args.length < 300, "argv longo vem resumido");
  child.emit("exit", 1, null);
  child.emit("close", 1, null);
  s = spawnsSnapshot();
  assert.equal(s.live.length, 0);
  assert.equal(s.recent[0]!.exitCode, 1);
  assert.equal(s.byCommand[0]!.cmd, "grok");
  assert.equal(s.byCommand[0]!.nonZeroExit, 1, "exit+close contam uma vez só");

  const bad = Object.assign(new EventEmitter(), { pid: undefined, spawnfile: "nope", spawnargs: ["nope"] });
  recordSpawn(bad, {});
  bad.emit("close", -2, null);
  assert.equal(spawnsSnapshot().byCommand.find((c) => c.cmd === "nope")!.errors, 1);
  assert.ok(summarizeArgs(Array.from({ length: 50 }, () => "y".repeat(40))).includes("+"));
});

test("T-812 stall: guarda chamadas síncronas e logs da janela", () => {
  recordDebugLog("info", "antes do travamento");
  const end = performance.now();
  recordSyncOp({ ts: Date.now(), endPerf: end, fn: "child_process.spawnSync", target: "ps -axo", ms: 320, status: 0, timedOut: false, stack: "runPs" }, true);
  recordStall(330, end - 400, end + 1);
  const s = stallsSnapshot();
  assert.equal(s.recent.length, 1);
  assert.ok(s.recent[0]!.syncOps[0]!.startsWith("child_process.spawnSync ps -axo"));
  assert.ok(s.recent[0]!.logs.some((l) => l.includes("antes do travamento")));
});

test("T-812 I/O dos CLIs: contadores sempre; captura só ligada e passada pelo scrub", () => {
  recordCliIo("a1", "claude", "stdout", "abc");
  recordCliIo("a1", "claude", "stderr", "erro");
  assert.equal(cliIoCounters("a1")!.stdoutBytes, 3);
  assert.equal(cliCaptureSnapshot().length, 0, "captura desligada por padrão");
  setDebugScrubber((t) => t.replace(/token=\S+/g, "token=[REDACTED]"));
  setCliCapture(true);
  recordCliIo("a1", "claude", "stdout", "url?token=segredo");
  assert.equal(cliCaptureSnapshot()[0]!.text, "url?token=[REDACTED]");
});

test("T-812 estado do agente: transições e tempo acumulado por estado", () => {
  recordAgentState("a1", "idle");
  recordAgentState("a1", "thinking");
  recordAgentState("a1", "thinking");
  const info = agentStateInfo("a1");
  assert.equal(info.state, "thinking");
  assert.ok("idle" in info.timeByState && "thinking" in info.timeByState);
});

test("T-812 relay e WS: agregados por op e por tipo", () => {
  recordRelayRequest({ ts: 1, agentId: "a", op: "tasks_list", method: "POST", status: 200, totalMs: 120, peerMs: 60, upstreamMs: 55, bytesIn: 2, bytesOut: 300, error: null });
  recordRelayRequest({ ts: 2, agentId: "a", op: "tasks_list", method: "POST", status: 502, totalMs: 25000, peerMs: 1, upstreamMs: null, bytesIn: 2, bytesOut: 0, error: "timeout" });
  const r = relaySnapshot() as { byOp: Array<{ op: string; count: number; errors: number; peerMaxMs: number }> };
  assert.equal(r.byOp[0]!.count, 2);
  assert.equal(r.byOp[0]!.errors, 1);
  assert.equal(r.byOp[0]!.peerMaxMs, 60);
  recordWsIn("agent:send", 100);
  recordWsHandler("agent:send", 3, 40);
  const w = wsSnapshot() as { inbound: Array<{ type: string; syncMaxMs: number; handlerMaxMs: number }> };
  assert.equal(w.inbound[0]!.syncMaxMs, 3);
  assert.equal(w.inbound[0]!.handlerMaxMs, 40);
});

/* ───────────── amostrador de processos ───────────── */

const PS1 = [
  "  100     1   100   0   4 Ss   01-00:00:00  10:00.00   1.0  50000 /opt/homebrew/bin/node /Users/u/.the-dudes/daemon.cjs",
  "  200   100   200   0   4 Ss      10:00     01:00.00  20.0 300000 /Users/u/.local/bin/claude --print",
  "  201   200   200   0   4 S       09:00     00:10.00   0.0  60000 node /Users/u/.the-dudes/mcp-bridge.cjs",
  "  300     1   300   0   0 R    06-00:00:00 2000:00.00  24.0   1400 dd if=/dev/zero of=/dev/null bs=1048576",
  "  301     1   301   0  31 Ss   02-00:00:00  00:00.10   0.0  17000 node /tmp/t441-abc/cli.mjs --print",
  "  400     1   400   0  31 Ss   08-00:00:00  50:00.00  60.0 170000 /System/Library/WindowServer -daemon",
].join("\n");

test("T-812 ps: parse com ni/pri", () => {
  const rows = parsePsTable(PS1);
  assert.equal(rows.length, 6);
  assert.equal(rows[0]!.pri, 4);
  assert.equal(rows[3]!.command.startsWith("dd "), true);
  assert.equal(rows[3]!.elapsedMs, 6 * 86_400_000);
});

test("T-812 ProcSampler: árvore do daemon, dono do galho, CPU por delta, órfãos e órfãos quentes", async () => {
  let text = PS1;
  const sampler = new ProcSampler({ selfPid: 100, spawnOwners: () => new Map([[200, { agentId: "agent_c", cmd: "claude" }]]), run: async () => text });
  const s1 = await sampler.sample();
  assert.deepEqual(s1.tree.map((n) => n.pid), [200, 201]);
  assert.equal(s1.tree[1]!.agentId, "agent_c", "filho herda o agente do galho");
  assert.equal(s1.self!.pri, 4);
  assert.deepEqual(s1.priCounts, { 4: 2 });
  assert.deepEqual(s1.orphans.map((o) => o.pid), [301], "fake CLI de teste adotado pelo init");
  assert.deepEqual(s1.hotOrphans.map((o) => o.pid), [300], "dd queimando CPU fora do daemon; /System fica de fora");
  assert.deepEqual(s1.hotKill, ["kill -- -300"], "grupo inteiro órfão → kill de grupo");
  assert.equal(s1.tree[0]!.cpuPct, null, "1ª amostra não tem delta");
  text = PS1.replace("01:00.00  20.0", "01:02.00  20.0").replace("10:00     01:0", "10:02     01:0");
  await new Promise((r) => setTimeout(r, 30));
  const s2 = await sampler.sample();
  assert.ok((s2.tree[0]!.cpuPct ?? 0) > 0, "2ª amostra calcula CPU pelo delta de tempo de CPU");
});

/* ───────────── diagnóstico ───────────── */

const gateVazio = { pools: { main: { max: 3, active: 0, queued: 0, grants: 0, waited: 0, forced: 0, waitP50Ms: null, waitP95Ms: null, waitMaxMs: null }, bg: { max: 2, active: 0, queued: 0, grants: 0, waited: 0, forced: 0, waitP50Ms: null, waitP95Ms: null, waitMaxMs: null } }, holders: [], waiters: [], maxHoldMs: 1 };

test("T-812 órfãos quentes: só ferramentas de dev/teste — nunca apps, serviços do sistema ou o daemon", () => {
  const casos: Array<[string, boolean]> = [
    ["dd if=/dev/zero of=/dev/null bs=1048576", true],
    ["/opt/homebrew/Cellar/node/25.2.1/bin/node --import tsx /x/t431.probe.ts", true],
    ["node /tmp/t417-abc/cli.mjs run --quiet", true],
    ["/Users/u/Applications/iTerm.app/Contents/MacOS/iTerm2", false],
    ["/Applications/WhatsApp.app/Contents/MacOS/WhatsApp", false],
    ["/usr/libexec/logd", false],
    ["/opt/homebrew/bin/node /Users/u/.the-dudes/daemon.cjs", false],
    ["/opt/homebrew/bin/bash /Users/u/.the-dudes/run-daemon.sh env", false],
    ["/opt/homebrew/opt/postgresql@16/bin/postgres -D /x", false],
  ];
  for (const [cmd, esperado] of casos) assert.equal(isToolOrphanCandidate(cmd), esperado, cmd);
});

test("T-812 órfãos quentes: grupo misto (órfão + processo legítimo) vira kill por pid, não de grupo", async () => {
  const ps = [
    "  100     1   100   0   4 Ss   01-00:00:00  10:00.00   1.0  50000 /opt/homebrew/bin/node /Users/u/.the-dudes/daemon.cjs",
    "  500     1   700   0  31 R    02-00:00:00  900:00.00  30.0   9000 node --import tsx /x/probe.ts",
    "  701     1   700   0  31 S    02-00:00:00  00:00.10   0.0   9000 /Users/u/Applications/iTerm.app/Contents/MacOS/iTerm2",
  ].join("\n");
  const sampler = new ProcSampler({ selfPid: 100, spawnOwners: () => new Map(), run: async () => ps });
  const s = await sampler.sample();
  assert.deepEqual(s.hotOrphans.map((o) => o.pid), [500]);
  assert.deepEqual(s.hotKill, ["kill 500"], "o iTerm2 no mesmo grupo não pode morrer junto");
});

test("T-812 diagnose: prioridade de background no macOS, órfãos quentes, loop e agente mudo", async () => {
  const sampler = new ProcSampler({ selfPid: 100, spawnOwners: () => new Map(), run: async () => PS1 });
  const proc = await sampler.sample();
  const alerts = diagnose({
    platform: "darwin",
    agents: [{ agentId: "a1", name: "GROK", cliRunner: "grok", hasRunner: true, runner: { state: "thinking", inTurn: true, idleMs: 5 * 60_000, toolsInFlight: 0, queued: 0, busy: true, thresholds: { softMs: 180_000, hardMs: 300_000 } } }],
    gate: { ...gateVazio, waiters: [{ label: "codex:D", pool: "main", waitingMs: 45_000 }] },
    loop: { window: { p50: 5, p90: 80, p99: 400, max: 1500, mean: 20 }, total: { p50: 1, p99: 50, max: 1500, mean: 2, count: 10 }, eluPct: 40 },
    proc,
    ws: { readyState: 1 },
    process: { cpuPct: 5, memory: { rssMb: 200 }, heap: { usedPct: 10 } },
    system: { load: [25, 24, 24], cpus: 18, loadPerCpu: 1.39, hostMemory: null },
  });
  const titles = alerts.map((a) => `${a.level}|${a.area}|${a.title}`);
  assert.ok(titles.some((t) => t.startsWith("crit|prioridade|") && t.includes("pri 4")), titles.join("\n"));
  assert.ok(titles.some((t) => t.startsWith("crit|event loop|")), "p99 400ms é travamento");
  assert.ok(titles.some((t) => t.includes("|processos|") && t.includes("queimando")), "dd órfão vira alerta");
  assert.ok(titles.some((t) => t.startsWith("warn|gate|")), "espera >30s no gate");
  assert.ok(titles.some((t) => t.includes("GROK") && t.includes("sem atividade")), "turno sem atividade há 5min");
  assert.ok(titles.some((t) => t.startsWith("warn|host|")), "load 1.39/CPU");
  assert.equal(alerts[0]!.level, "crit", "críticos primeiro");
  const linux = diagnose({ platform: "linux", agents: [], gate: gateVazio, loop: null, proc, ws: { readyState: 1 }, process: {}, system: {} });
  assert.ok(!linux.some((a) => a.area === "prioridade"), "pri do macOS não vale em linux");
});

test("T-812 env redatado e resumo do CPU profile", () => {
  const env = redactedEnv({ THE_DUDES_DAEMON_TOKEN: "abcdef", TYPESAFE_API_KEY: "k", THE_DUDES_MAX_CLI_TURNS: "7", OTHER: "x", PATH: "/bin" });
  assert.equal(env.THE_DUDES_DAEMON_TOKEN, "[REDACTED · 6 chars]");
  assert.equal(env.TYPESAFE_API_KEY, "[REDACTED · 1 chars]");
  assert.equal(env.THE_DUDES_MAX_CLI_TURNS, "7");
  assert.equal(env.OTHER, undefined);
  const top = summarizeCpuProfile({
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: 0 } },
      { id: 2, callFrame: { functionName: "readParentPidFromPs", url: "file:///x/daemon.cjs", lineNumber: 9 } },
      { id: 3, callFrame: { functionName: "(idle)", url: "", lineNumber: 0 } },
    ],
    samples: [2, 2, 2, 3],
    timeDeltas: [0, 1000, 1000, 1000],
    startTime: 0,
    endTime: 4000,
  });
  assert.equal(top[0]!.fn, "readParentPidFromPs");
  assert.equal(top[0]!.where, "daemon.cjs:10");
});

/* ───────────── sondas de chamada síncrona ───────────── */

test("T-812 sondas: spawnSync/execFileSync medidos, transparentes (retorno e throw) e visíveis no import ESM", () => {
  installSyncProbes();
  const r = spawnSync(process.execPath, ["-e", "process.exit(3)"]);
  assert.equal(r.status, 3, "retorno intacto");
  assert.throws(() => execFileSync(process.execPath, ["-e", "process.exit(2)"]), (e: { status?: number }) => e.status === 2);
  const s = syncOpsSnapshot();
  const spawn = s.recent.find((x) => x.fn === "child_process.spawnSync");
  const exec = s.recent.find((x) => x.fn === "child_process.execFileSync");
  assert.ok(spawn && spawn.status === 3 && spawn.ms > 0, JSON.stringify(s.recent));
  assert.ok(exec && exec.status === 2, "status do throw registrado");
  assert.ok(spawn!.stack.length > 0, "stack do chamador registrada");
});

/* ───────────── servidor loopback ───────────── */

function req(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let b = "";
      res.on("data", (c) => { b += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

test("T-812 servidor: token, cookie por porta, Host/Origin, header de POST, CSP com nonce", async () => {
  const token = "t".repeat(32);
  const h = await startDebugHttpServer({
    port: 0, portScan: 0, token, log: () => {},
    html: (nonce) => `<script nonce="${nonce}"></script>`,
    routes: [
      { method: "GET", path: "/api/ping", handler: () => ({ pong: true }) },
      { method: "POST", path: "/api/acao", handler: async ({ body }) => ({ got: await body() }) },
    ],
  });
  try {
    const host = { Host: `127.0.0.1:${h.port}` };
    assert.equal((await req(h.port, "/api/ping", { headers: host })).status, 401);
    assert.equal((await req(h.port, "/api/ping", { headers: { Host: `evil.test:${h.port}`, Authorization: `Bearer ${token}` } })).status, 421, "DNS rebinding");
    const ok = await req(h.port, "/api/ping", { headers: { ...host, Authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { pong: true });
    assert.equal(ok.headers["cache-control"], "no-store");
    const redir = await req(h.port, `/?token=${token}`, { headers: host });
    assert.equal(redir.status, 302);
    const cookie = String(redir.headers["set-cookie"]);
    assert.ok(cookie.includes(`td_debug_${h.port}=`) && cookie.includes("HttpOnly") && cookie.includes("SameSite=Strict"));
    const page = await req(h.port, "/", { headers: { ...host, Cookie: `td_debug_${h.port}=${token}` } });
    assert.equal(page.status, 200);
    const nonce = /nonce="([^"]+)"/.exec(page.body)![1]!;
    assert.ok(String(page.headers["content-security-policy"]).includes(`'nonce-${nonce}'`));
    assert.ok(String(page.headers["content-security-policy"]).includes("default-src 'none'"));
    const auth = { ...host, Authorization: `Bearer ${token}`, "content-type": "application/json" };
    assert.equal((await req(h.port, "/api/acao", { method: "POST", headers: auth, body: "{}" })).status, 403, "sem x-td-debug");
    assert.equal((await req(h.port, "/api/acao", { method: "POST", headers: { ...auth, "x-td-debug": "1", Origin: "http://evil.test" }, body: "{}" })).status, 403, "origin cruzada");
    const post = await req(h.port, "/api/acao", { method: "POST", headers: { ...auth, "x-td-debug": "1", Origin: `http://127.0.0.1:${h.port}` }, body: "{\"on\":true}" });
    assert.equal(post.status, 200);
    assert.deepEqual(JSON.parse(post.body), { got: { on: true } });
    assert.equal((await req(h.port, "/api/nada", { headers: { ...host, Authorization: `Bearer ${token}` } })).status, 404);
  } finally {
    h.stop();
  }
});

/* ───────────── página ───────────── */

test("T-812 página: JS compila, sem crase/\"${\" nos assets e sem style inline (CSP)", () => {
  const { JS, CSS } = _dashboardAssetsForTest;
  assert.doesNotThrow(() => new vm.Script(JS, { filename: "dashboard.js" }));
  for (const [nome, t] of [["JS", JS], ["CSS", CSS]] as const) {
    assert.ok(!t.includes("`"), `${nome} com crase quebra o String.raw`);
    assert.ok(!t.includes("${"), `${nome} com \${ interpola no TS`);
  }
  const html = dashboardHtml("N0NCE");
  assert.equal((html.match(/nonce="N0NCE"/g) ?? []).length, 2, "style e script com o nonce");
  assert.ok(!/ style="/.test(html), "style inline é bloqueado pela CSP");
  assert.ok(!/innerHTML/.test(JS), "texto do daemon entra por textContent");
});

/* ───────────── histórico do log (sobrevive aos re-execs) ───────────── */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeHistory, historyLogFiles, ingestLogLine, normalizeIssue, _histForTest } from "../debug/history.js";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const tl = (msAgo: number, agentId: string, runner: string, endReason: string, extra: Record<string, unknown> = {}) =>
  `[${iso(msAgo)}] [info] [turn-latency] ${JSON.stringify({ agentId, runner, turnId: "t", attempt: 0, phase: "end", queueMs: 5, gateWaitMs: 1, firstEventMs: 900, durationMs: 4000, endReason, ...extra })}`;
const H = 3_600_000;

test("T-812 histórico: linha a linha — turnos, hard/soft, fila cheia, re-exec, launcher, padrões", () => {
  const acc = _histForTest.newAcc();
  const names = new Map<string, string>();
  const L = [
    `[${iso(5 * H)}] [info] spawn PM (agent_aa11) cfg=/w runner=grok`,
    tl(4 * H, "agent_aa11", "grok", "completed"),
    tl(4 * H, "agent_aa11", "grok", "hard-recover", { killedBy: "watchdog" }),
    `[${iso(3 * H)}] [warn] [hang:PM] HARD recover: no activity for 300s (runner=grok idleMs=300123)`,
    `[${iso(3 * H)}] [warn] [hang] sem atividade há 180s (runner=grok) — aguardando… agent=PM`,
    `[${iso(2 * H)}] [warn] [cli:agent_aa11:grok] ocQueue cheia (20) — drop mensagem`,
    `[${iso(2 * H)}] [info] [self-update] release aaaaaaaaaaaa ≠ rodando bbbbbbbbbbbb — baixando`,
    `[${iso(2 * H)}] [info] [self-update] saindo com código 42 — o launcher relança com o binário novo`,
    `[${iso(1 * H).slice(0, 19)}Z] [launcher] daemon saiu com código 0 — encerrando launcher`,
    `[${iso(1 * H)}] [warn] [cli:agent_bb22:dsh] [dsh] prompt: acp -32603: Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"`,
    "linha sem formato de log",
  ];
  for (const l of L) ingestLogLine(l, acc, names);
  const w = _histForTest.windowOf(acc, names);
  assert.equal(w.turns, 2);
  assert.equal(w.byAgent[0]!.key, "PM (grok)", "nome vem do spawn");
  assert.equal(w.byRunner[0]!.failures, 1);
  assert.equal(w.byRunner[0]!.okPct, 50);
  assert.equal(w.hardRecovers[0]!.agent, "PM");
  assert.equal(w.hardRecovers[0]!.reason, "no activity for Ns");
  assert.equal(w.softHangs[0]!.n, 1);
  assert.deepEqual(w.queueFullDrops, [{ agent: "PM", n: 1 }]);
  assert.equal(w.reexecs, 1);
  assert.equal(w.releases, 1);
  assert.equal(w.launcherExits, 1, "linha do launcher tem outro formato de timestamp");
  assert.equal(w.patterns.find((p) => p.id === "dsh-sem-chave")!.n, 1);
  assert.ok(w.topIssues.some((i) => i.msg.includes("agent_*")), "issues normalizadas");
  assert.equal(normalizeIssue("x agent_1a2b 1234 ses_AbC"), "x agent_* N ses_*");
});

test("T-812 histórico: stop/reset não contam como falha; 'últimas 3h' diz se o problema parou", () => {
  const acc = _histForTest.newAcc();
  const names = new Map<string, string>();
  for (let i = 0; i < 6; i++) ingestLogLine(tl(20 * H, "agent_x", "opencode", "error"), acc, names);
  for (let i = 0; i < 3; i++) ingestLogLine(tl(H, "agent_x", "opencode", "completed"), acc, names);
  ingestLogLine(tl(H, "agent_x", "opencode", "stopped"), acc, names);
  const r = _histForTest.windowOf(acc, names).byRunner[0]!;
  assert.equal(r.failures, 6);
  assert.equal(r.okPct, 33.3, "3 ok / (3 ok + 6 falhas); o stopped fica de fora");
  assert.deepEqual(r.recent3h, { count: 3, completed: 3 });
  assert.ok(r.lastProblemTs! < Date.now() - 19 * H);
});

test("T-812 histórico: arquivo real em disco — 24h vs 7d, reexec por dia e env override", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t812h-"));
  const f = join(dir, "daemon-prod.log");
  writeFileSync(f, [
    tl(10 * 86_400_000, "agent_v", "grok", "error"),
    tl(3 * 86_400_000, "agent_v", "grok", "completed"),
    tl(2 * H, "agent_v", "grok", "completed"),
    `[${iso(2 * H)}] [info] [self-update] saindo com código 42 — o launcher relança com o binário novo`,
  ].join("\n") + "\n");
  assert.deepEqual(historyLogFiles(dir), [f]);
  assert.deepEqual(historyLogFiles(dir, { THE_DUDES_DEBUG_LOG_FILES: "/a.log, /b.log" }), ["/a.log", "/b.log"]);
  const hs = await analyzeHistory([f]);
  assert.equal(hs.windows["7d"].turns, 2, "linha de 10 dias atrás fica fora dos 7d");
  assert.equal(hs.windows["24h"].turns, 1);
  assert.equal(Object.values(hs.reexecsByDay).reduce((a, b) => a + b, 0), 1);
  assert.equal(hs.error, null);
});

test("T-812 diagnose com histórico: fila cheia é crítico, re-exec em excesso vira aviso, problema que parou vira info", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t812d-"));
  const f = join(dir, "daemon-prod.log");
  const L: string[] = [];
  for (let i = 0; i < 8; i++) L.push(tl(10 * H, "agent_0c0c", "opencode", "error"));
  for (let i = 0; i < 4; i++) L.push(tl(H, "agent_0c0c", "opencode", "completed"));
  for (let i = 0; i < 16; i++) L.push(`[${iso(30 * H)}] [info] [self-update] saindo com código 42 — o launcher relança com o binário novo`);
  L.push(`[${iso(H)}] [warn] [cli:agent_0c0c:opencode] ocQueue cheia (20) — drop mensagem`);
  writeFileSync(f, L.join("\n") + "\n");
  const history = await analyzeHistory([f]);
  const alerts = diagnose({ platform: "linux", agents: [], gate: gateVazio, loop: null, proc: null, ws: { readyState: 1 }, process: {}, system: {}, history });
  const by = (area: string) => alerts.filter((a) => a.area === area);
  assert.equal(by("fila")[0]!.level, "crit");
  assert.equal(by("fila")[0]!.when, "7d");
  assert.ok(by("fila")[0]!.action, "fila cheia vem com ação sugerida");
  assert.equal(by("reinícios")[0]!.level, "warn");
  const oc = by("runner").find((a) => a.title.includes("opencode"))!;
  assert.equal(oc.level, "info", "voltou a completar nas últimas 3h");
  assert.ok(oc.title.includes("PAROU"));
});

test("T-812 histórico: slot do gate liberado à força e contador de tools inflado viram alerta", () => {
  const acc = _histForTest.newAcc();
  const names = new Map<string, string>();
  const L = [
    `[${iso(H)}] [warn] [turn-gate:main] slot de opencode:QA-A preso há 70min — liberando à força`,
    `[${iso(H)}] [warn] [turn-gate:main] slot de opencode:QA-A preso há 70min — liberando à força`,
    `[${iso(H)}] [warn] [hang:PM] toolsInFlight=155 aberto há 604s (teto absoluto 10min) — tool_result perdido ou teto; reavaliando hang`,
    `[${iso(H)}] [warn] [hang:PM] toolsInFlight=288 aberto há 601s (teto absoluto 10min) — tool_result perdido ou teto; reavaliando hang`,
  ];
  for (const l of L) ingestLogLine(l, acc, names);
  const w = _histForTest.windowOf(acc, names);
  assert.deepEqual(w.gateForced, [{ label: "opencode:QA-A", n: 2 }]);
  assert.deepEqual(w.toolsInflated, [{ agent: "PM", max: 288, n: 2 }]);
  const history = { generatedAt: Date.now(), tookMs: 1, files: [], reexecsByDay: {}, error: null, windows: { "24h": w, "7d": w } };
  const alerts = diagnose({ platform: "linux", agents: [], gate: gateVazio, loop: null, proc: null, ws: { readyState: 1 }, process: {}, system: {}, history });
  assert.ok(alerts.some((a) => a.area === "gate" && a.title.includes("2 slot") && a.action), "gate forçado com ação");
  assert.ok(alerts.some((a) => a.area === "hang" && a.title.includes("até 288")), "tools inflado");
});
