/**
 * T-371 — hard recover do qwen: parcial neutralizada (a), turno
 * re-enfileirado (b), loop detectado (c), teto de lifetime absoluto (d),
 * round de API como atividade (e).
 *
 * Harness: AgentRunner REAL (padrão T-240/T-251) com CLI stub executável
 * que grava os argv de cada spawn em `argv.log` ao lado do script e escolhe
 * comportamento pelo ficheiro `mode` (hang | loop | usage | done).
 * Asserções de spawn são sobre os ARGV reais do processo seguinte.
 * Cleanup em TODO caminho: um stub vivo prende o stdout do filho e o
 * processo de teste não fecha.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { TextLoopGuard } from "../runners/turn-parsers.js";
import { hangThresholds } from "../runners/turn-watchdog.js";
import { turnGateStats } from "../runners/turn-gate.js";

const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const dir = path.dirname(url.fileURLToPath(import.meta.url));
fs.appendFileSync(path.join(dir, "argv.log"), process.argv.slice(2).join(" ") + "\\n");
const mode = fs.readFileSync(path.join(dir, "mode"), "utf8").trim();
const send = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };
send({ type: "system", subtype: "init", session_id: "stub-sess", cwd: "/tmp", tools: [], model: "stub", permission_mode: "yolo" });
if (mode === "done") {
  send({ type: "result", subtype: "success", session_id: "stub-sess", is_error: false, result: "pronto", usage: { input_tokens: 10, output_tokens: 2 } });
  process.exit(0);
}
if (mode === "usage") {
  send({ type: "assistant", session_id: "stub-sess", message: { role: "assistant", content: [{ type: "thinking", thinking: "a pensar fundo" }], usage: { input_tokens: 100, output_tokens: 5 } } });
  setTimeout(() => send({ type: "assistant", session_id: "stub-sess", message: { content: [{ type: "thinking", thinking: "ainda a pensar" }], usage: { input_tokens: 120, output_tokens: 9 } } }), 300);
  setInterval(() => {}, 1000);
} else if (mode === "hang") {
  send({ type: "assistant", session_id: "stub-sess", message: { content: [{ type: "text", text: "a começar" }], usage: { input_tokens: 5, output_tokens: 1 } } });
  setInterval(() => {}, 1000);
} else if (mode === "loop") {
  setInterval(() => {
    for (let i = 0; i < 25; i++) {
      send({ type: "assistant", session_id: "stub-sess", message: { content: [{ type: "text", text: "ductduct ductduct ductduct " }], usage: { input_tokens: 0, output_tokens: 0 } } });
    }
  }, 10);
}
`;

interface Harness {
  runner: AgentRunner;
  warns: string[];
  setMode(mode: string): void;
  argvLines(): string[];
  killTurnProc(): void;
}

function makeHarness(initialMode: string, opts: { stubDrain?: boolean } = {}): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t371-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(path.join(dir, "mode"), initialMode);
  const warns: string[] = [];
  const cmd = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  const cliCommands = {
    claude: off, opencode: off, gemini: off, codex: off, crush: off,
    qwen: cmd, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
  };
  const info = {
    id: `agent_t371_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t371", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runnerOpts = {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "qwen", autoApprove: true, workspaceRoot: dir,
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (lvl: string, msg: string) => { if (lvl === "warn") warns.push(msg); },
    cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: () => {}, onExit: () => {},
  } as never;
  const runner = new AgentRunner(info, runnerOpts);
  if (opts.stubDrain) {
    (runner as unknown as { drainOcQueue: () => void }).drainOcQueue = () => {};
  }
  return {
    runner,
    warns,
    setMode: (mode) => writeFileSync(path.join(dir, "mode"), mode),
    argvLines: () => {
      try {
        return readFileSync(path.join(dir, "argv.log"), "utf8").split("\n").filter((l) => l.trim());
      } catch {
        return [];
      }
    },
    killTurnProc: () => {
      const p = (runner as unknown as Record<string, any>).ocActiveProc as { kill: (s: string) => void } | null;
      if (p) p.kill("SIGKILL");
    },
  };
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const tick = (r: AgentRunner) => (r as unknown as { tickHangWatch: () => void }).tickHangWatch();

async function until(cond: () => boolean, ms = 5000, what = "condição"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function pauseTurn(h: Harness): Promise<void> {
  h.killTurnProc();
  await until(() => turnGateStats().ativos === 0, 5000, "turn-gate livre");
}

async function finish(h: Harness): Promise<void> {
  h.runner.stop();
  try {
    await until(() => turnGateStats().ativos === 0, 3000, "turn-gate livre");
  } catch { /* melhor esforço — o stop já matou o filho */ }
}

/** TODO teste passa por aqui: cleanup garantido mesmo em falha. */
async function withHarness(
  mode: string,
  opts: { stubDrain?: boolean },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = makeHarness(mode, opts);
  try {
    await fn(h);
  } finally {
    await finish(h);
  }
}

/* ---------- (b) re-enfileiramento no caminho one-shot per-message ---------- */

test("T-371 (b): hard recover no turno qwen re-enfileira e re-processa a mensagem (inflight do one-shot)", async () =>
  withHarness("hang", {}, async (h) => {
    const a = asAny(h.runner);
    h.runner.pushUserMessage("pergunta do dono");
    await until(() => h.argvLines().length === 1, 5000, "spawn do stub");
    assert.ok(a.messageSession.busy, "turno em voo");
    assert.equal(a.inflightPerMessage?.content, "pergunta do dono", "inflight registrado no spawn");

    a.activityClock.lastActivityAt = Date.now() - (hangThresholds("qwen").hardMs + 5_000);
    tick(h.runner);

    assert.equal(a.inflightPerMessage?.attempt, 1, "mensagem re-enfileirada (attempt 1)");
    assert.ok(
      h.warns.some((w) => w.includes("re-enfileirando mensagem após hard recover")),
      `sem log de re-fila: ${h.warns.join(" | ")}`,
    );
    // o drain do próprio recover consumiu a re-fila e o spawn 2 existe:
    await until(() => h.argvLines().length === 2, 5000, "re-processamento da mensagem re-enfileirada");
    assert.equal(a.messageSession.queuedCount(), 0, "a re-fila foi desenfileirada (turno 2 despachado)");
    assert.ok(a.messageSession.busy, "turno 2 vivo: o close tardio do turno 1 não zerou o estado do turno novo");
  }));

/* ---------- guarda de epoch no close tardio (teste próprio, sem boleia de (b)) ---------- */

test("T-371 guarda: close TARDIO de turno recuperado não zera busy/proc do turno corrente", async () =>
  withHarness("hang", { stubDrain: true }, async (h) => {
    const a = asAny(h.runner);
    void a.runQwenMessage("vitima");
    await until(() => h.argvLines().length === 1, 5000, "spawn do turno vitimado");
    const proc1 = a.ocActiveProc as { kill: (s: string) => void; emit: (e: string, c: null) => void };
    assert.ok(proc1, "turno vitimado tem proc");
    await new Promise((r) => setTimeout(r, 150)); // eventos do stub assentam

    // o bookkeeping de um hard recover, sem o tick (o que se testa é o close):
    a.messageSession.bumpEpoch(); // turno 1 perde a posse
    const proc2 = { kill: () => {}, emit: () => {} }; // proc do turno NOVO que o drain do recover pôs em voo
    a.ocActiveProc = proc2;
    a.messageSession.busy = true;

    proc1.kill("SIGKILL");
    proc1.emit("close", null); // o close tardio chega DEPOIS do turno novo existir

    assert.equal(a.ocActiveProc, proc2, "close velho não pode apagar o proc do turno corrente");
    assert.equal(a.messageSession.busy, true, "close velho não pode zerar o busy do turno corrente");
  }));

/* ---------- (a) sessão neutralizada: argv do spawn seguinte ---------- */

test("T-371 (a): após hard recover, spawn seguinte abre --session-id novo e NÃO -r da sessão velha", async () =>
  withHarness("hang", { stubDrain: true }, async (h) => {
    const a = asAny(h.runner);
    a.messageSession.sessionId = "sess-velha-degenerada";
    void a.runQwenMessage("primeira");
    await until(() => h.argvLines().length === 1, 5000, "spawn 1");
    assert.match(h.argvLines()[0]!, /-r sess-velha-degenerada/, "turno 1 retoma a sessão existente (pré-condição)");
    a.messageSession.busy = true;
    await new Promise((r) => setTimeout(r, 150)); // deixar eventos do stub assentarem

    a.activityClock.lastActivityAt = Date.now() - (hangThresholds("qwen").hardMs + 5_000);
    tick(h.runner);
    assert.equal(a.messageSession.sessionId, undefined, "hard recover neutralizou a sessão");
    assert.ok(h.warns.some((w) => w.includes("neutralizando sessão qwen")));
    await pauseTurn(h);

    // turno seguinte (disparo direto — (a) não depende do re-enfileiramento de (b))
    h.setMode("done");
    void a.runQwenMessage("segunda");
    await until(() => h.argvLines().length === 2, 5000, "spawn 2");
    const argv2 = h.argvLines()[1]!;
    assert.match(argv2, /--session-id [0-9a-f-]{36}/, `spawn 2 tem de abrir sessão nova: ${argv2}`);
    assert.ok(!argv2.includes("sess-velha-degenerada"), `spawn 2 não pode retomar a sessão velha: ${argv2}`);
  }));

/* ---------- (c) janela anti-repetição ---------- */

test("T-371 (c): TextLoopGuard corta 'ductduct…' logo após o piso e ignora repetição legítima", () => {
  const guard = new TextLoopGuard();
  const unit = "ductduct ductduct ductduct ";
  let fired = -1;
  for (let i = 0; i < 3_000; i++) {
    if (guard.feed(unit)) { fired = (i + 1) * unit.length; break; }
  }
  assert.ok(fired > 0, "loop sintético tem de ser detectado");
  assert.ok(fired <= 60_000, `detecção tem de vir em ordem de segundos de stream (≤60k chars); veio em ${fired}`);

  // negativo vinculativo: tabela e código repetitivos de BAIXO volume
  const neg = new TextLoopGuard();
  let table = "";
  for (let i = 0; i < 200; i++) table += `| col-${i} | val-${i % 7} |\n`;
  table += "}".repeat(4_000); // código com fecho de chaveta repetido
  assert.equal(neg.feed(table), false, "saída repetitiva de baixo volume NÃO pode disparar");

  // volume alto mas conteúdo VARIADO: período curto nunca cobre a janela
  const varied = new TextLoopGuard();
  let big = "";
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india".split(" ");
  for (let i = 0; i < 6_000; i++) big += `${words[(i * 7) % words.length]}${(i * 31) % 997} `;
  assert.equal(varied.feed(big), false, "prosa longa e variada NÃO pode disparar");
});

test("T-371 (c-integration): turno qwen em loop é abortado pela janela anti-repetição em segundos", async () =>
  withHarness("loop", {}, async (h) => {
    const a = asAny(h.runner);
    h.runner.pushUserMessage("gera texto");
    await until(() => h.argvLines().length === 1, 5000, "spawn do loop");

    await until(
      () => h.warns.some((w) => w.includes("token loop detectado")),
      5000,
      "aborto por janela anti-repetição",
    );
    // o turno abortado foi recuperado (busy cai, ou o drain do recover já
    // re-pôs a mensagem em voo — em ambos os casos o loop acabou):
    assert.ok(
      a.messageSession.busy === false || a.inflightPerMessage?.attempt === 1,
      "loop tem de terminar em hard recover, não em turno eterno",
    );
  }));

/* ---------- (d) teto de lifetime absoluto ---------- */

test("T-371 (d): ramo qwen em hangThresholds declara soft/hard/lifetime e o teto mata turno com clock renovado", () => {
  const q = hangThresholds("qwen");
  assert.equal(q.softMs, 6 * 60_000);
  assert.equal(q.hardMs, 10 * 60_000);
  assert.equal(q.lifetimeMs, 8 * 60_000, "valores declarados no diff");
  assert.equal(hangThresholds("codex").lifetimeMs, undefined, "outros runners ficam como estavam");

  const h = makeHarness("hang");
  try {
    const a = asAny(h.runner);
    a.messageSession.busy = true;
    a.activityClock.lastActivityAt = Date.now(); // o loop renova o clock semântico continuamente
    a.activityClock.turnStartedAt = Date.now() - (q.lifetimeMs! + 1_000);
    a.toolsInFlight = 1;
    a.toolsInFlightSince = Date.now(); // tool viva: não pode adiar o teto absoluto

    tick(h.runner);

    assert.equal(a.messageSession.busy, false, "lifetime absoluto tem de matar o turno mesmo com clock renovado e tool viva");
    assert.equal(a.hardRecoverTimes.length, 1);
  } finally {
    h.runner.stop();
  }
});

/* ---------- (e) round de API conta como atividade ---------- */

test("T-371 (e): round de API intermediário (evento de stream sem texto) repõe o activity clock do qwen", async () =>
  withHarness("usage", {}, async (h) => {
    const a = asAny(h.runner);
    h.runner.pushUserMessage("pensar fundo");
    await until(() => h.argvLines().length === 1, 5000, "spawn do stub");

    a.activityClock.lastActivityAt = Date.now() - 60_000; // thinking profundo: sem eventos, o soft viria
    await until(() => (a.activityClock.lastActivityAt as number) > Date.now() - 55_000, 3000, "round de API intermediário repor o clock");
    assert.ok(a.messageSession.busy, "turno segue vivo — sem soft stall por omissão de atividade");
  }));
