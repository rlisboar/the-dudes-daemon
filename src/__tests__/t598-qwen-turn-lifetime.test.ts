/**
 * T-598 — teto de lifetime do turno qwen (8min → 30min) e o que o corte por
 * teto faz: preserva a sessão (retry retoma a parcial), re-enfileira a
 * mensagem e NÃO notifica no 1º attempt (backstop, não hang).
 *
 * Cenários: C2 (turno saudável ≥20min NÃO é morto + contraprova passado o
 * novo teto), C3/F4 (stream que renova o idle para sempre ainda é cortado),
 * C4 (política de notificação: lifetime attempt 0 suprime, attempt≥1 imediato)
 * e o aceite do card (kill por lifetime preserva sessão + re-fila).
 *
 * Harness: AgentRunner REAL com CLI stub (mesmo padrão da T-371).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import {
  hardRecoverNotifyPolicy,
  QWEN_HARD_TIMEOUT_MS,
  QWEN_STREAM_MAX_LIFETIME_MS,
  QWEN_TURN_LIFETIME_MS,
} from "../runners/turn-watchdog.js";
import { TURN_GATE_MAX_HOLD_MS, turnGateStats } from "../runners/turn-gate.js";

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
send({ type: "assistant", session_id: "stub-sess", message: { content: [{ type: "text", text: "a trabalhar" }], usage: { input_tokens: 5, output_tokens: 1 } } });
setInterval(() => {}, 1000);
`;

interface Harness {
  runner: AgentRunner;
  warns: string[];
  hungs: string[];
  dir: string;
  argvLines(): string[];
}

function makeHarness(): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t598-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(path.join(dir, "mode"), "hang");
  const warns: string[] = [];
  const hungs: string[] = [];
  const cmd = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  const cliCommands = {
    claude: off, opencode: off, gemini: off, codex: off, crush: off,
    qwen: cmd, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
  };
  const info = {
    id: `agent_t598_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t598", role: "backend",
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
    onError: () => {}, onHung: (h: { reason: string }) => { hungs.push(h.reason); }, onExit: () => {},
  } as never;
  const runner = new AgentRunner(info, runnerOpts);
  return {
    runner,
    warns,
    hungs,
    dir,
    argvLines: () => {
      try {
        return readFileSync(path.join(dir, "argv.log"), "utf8").split("\n").filter((l) => l.trim());
      } catch {
        return [];
      }
    },
  };
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const tick = (r: AgentRunner) => (r as unknown as { tickHangWatch: () => void }).tickHangWatch();
const killTurnProc = (r: AgentRunner) => {
  const p = asAny(r).ocActiveProc as { kill: (s: string) => void } | null;
  if (p) p.kill("SIGKILL");
};

/** Mata por PID qualquer stub vivo deste harness. O `ocActiveProc` do runner
 *  vira null no close do filho ANTES de o processo morrer, e um drain tardio
 *  pode spawnar DEPOIS do stop — sem a varredura o stub detached (spawnDropped
 *  usa detached:true) + o timer do armHardTimeout prendem o event loop
 *  (pitfall T-376, mesmo dos testes T-417). */
function sweepStubs(dir: string): number {
  let vivos = 0;
  try {
    const out = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
    for (const linha of out.split("\n")) {
      if (!linha.includes(dir) || !linha.includes("cli.mjs")) continue;
      const pid = Number(linha.trim().split(/\s+/)[0]);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      try { process.kill(pid, "SIGKILL"); vivos++; } catch { /* já morto */ }
    }
  } catch { /* ps indisponível: cai no killTurnProc */ }
  return vivos;
}

async function until(cond: () => boolean, ms = 5000, what = "condição"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = makeHarness();
  try {
    await fn(h);
  } finally {
    h.runner.stop();
    // Drain do recover pode estar em voo e spawnar DEPOIS do stop (o
    // runQwenMessage já passou do guard `stopped`). Mata em laço + varredura
    // por PID até estabilizar: sem isso o stub vivo prende o event loop.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      killTurnProc(h.runner);
      if (sweepStubs(h.dir) === 0 && !asAny(h.runner).ocActiveProc && turnGateStats().ativos === 0) {
        await new Promise((r) => setTimeout(r, 200));
        if (sweepStubs(h.dir) === 0) break;
      }
    }
    try {
      await until(() => turnGateStats().ativos === 0, 3000, "turn-gate livre");
    } catch { /* melhor esforço — o stop já matou o filho */ }
  }
}

/** Turno real em voo com o stub (proc vivo, stream ativo, sessão adotada). */
async function spawnTurnEmVoo(h: Harness, texto = "trabalho longo"): Promise<void> {
  h.runner.pushUserMessage(texto);
  await until(() => h.argvLines().length === 1, 5000, "spawn do turno");
  await until(() => typeof asAny(h.runner).messageSession.sessionId === "string", 3000, "sessão adotada do stub");
}

/* ---------- C2: turno saudável de 20min NÃO é morto pelo teto ---------- */

test("T-598 (C2): turno qwen saudável com stream contínuo de 20min sobrevive ao teto antigo (8min)", async () =>
  withHarness(async (h) => {
    await spawnTurnEmVoo(h);
    const a = asAny(h.runner);
    // Stream CONTÍNUO (clock renovado) + turno com 20min de elapsed — no teto
    // antigo (8min) isto era HARD recover; com o novo teto (30min) não é.
    a.activityClock.lastActivityAt = Date.now();
    a.activityClock.turnStartedAt = Date.now() - 20 * 60_000;

    tick(h.runner);

    assert.equal(
      h.warns.some((w) => w.includes("HARD recover")),
      false,
      `turno de 20min não podia ser morto: ${h.warns.join(" | ")}`,
    );
    assert.equal(a.messageSession.busy, true, "turno segue vivo");
    assert.equal(a.inflightPerMessage?.attempt, 0, "sem re-fila: o turno não foi cortado");
  }));

/* ---------- C2 contraprova: passado o NOVO teto, o backstop existe ---------- */

test("T-598 (C2 contraprova): passado o novo teto (30min) o turno É morto e re-enfileirado", async () =>
  withHarness(async (h) => {
    await spawnTurnEmVoo(h);
    const a = asAny(h.runner);
    a.activityClock.lastActivityAt = Date.now();
    a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_MS + 1_000);

    tick(h.runner);

    assert.ok(
      h.warns.some((w) => w.includes("HARD recover: turn lifetime")),
      `backstop tem de cortar passado o teto: ${h.warns.join(" | ")}`,
    );
    assert.equal(a.inflightPerMessage?.attempt, 1, "mensagem re-enfileirada após o corte");
  }));

/* ---------- C3/F4: stream que renova o idle para sempre ainda é cortado ---------- */

test("T-598 (C3/F4): stream que renova a atividade para sempre não escapa — o teto o corta", async () =>
  withHarness(async (h) => {
    await spawnTurnEmVoo(h);
    const a = asAny(h.runner);

    // F4: cada tick renova o clock semântico (loop de tokens que nunca
    // termina). soft/hard nunca disparam; só o teto absoluto apanha.
    for (const elapsed of [5 * 60_000, 12 * 60_000, 29 * 60_000]) {
      a.activityClock.lastActivityAt = Date.now();
      a.activityClock.turnStartedAt = Date.now() - elapsed;
      tick(h.runner);
      assert.equal(
        h.warns.some((w) => w.includes("HARD recover")),
        false,
        `elapsed=${elapsed / 60_000}min ainda dentro do teto`,
      );
    }

    a.activityClock.lastActivityAt = Date.now();
    a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_MS + 1_000);
    tick(h.runner);
    assert.ok(
      h.warns.some((w) => w.includes("HARD recover: turn lifetime")),
      "loop que renova o idle tem de morrer pelo teto",
    );
  }));

/* ---------- C4: política de notificação ---------- */

test("T-598 (C4): lifetime em 1º attempt suprime; re-enfileirado (attempt≥1) notifica na hora; hang intacto", () => {
  assert.equal(hardRecoverNotifyPolicy(0, 5, "lifetime"), "suppress", "backstop não acorda o dono");
  assert.equal(hardRecoverNotifyPolicy(1, 0, "lifetime"), "immediate", "turno que não converge avisa");
  assert.equal(hardRecoverNotifyPolicy(2, 0, "lifetime"), "immediate");
  // Regressão do contrato T-240 (d) para hang:
  assert.equal(hardRecoverNotifyPolicy(0, 0, "hang"), "suppress");
  assert.equal(hardRecoverNotifyPolicy(0, 3, "hang"), "summary");
  assert.equal(hardRecoverNotifyPolicy(1, 0, "hang"), "immediate");
  assert.equal(hardRecoverNotifyPolicy(0, 3), "summary", "default = hang");
});

/* ---------- Aceite 1: corte por lifetime preserva a sessão e re-enfileira ---------- */

test("T-598 (aceite): kill por lifetime preserva a sessão qwen, re-enfileira e o retry RETOMA a mesma sessão", async () =>
  withHarness(async (h) => {
    const a = asAny(h.runner);
    a.messageSession.sessionId = "sess-t598";
    await spawnTurnEmVoo(h);
    assert.match(h.argvLines()[0]!, /-r sess-t598/, "turno 1 retoma a sessão existente (pré-condição)");
    // O stub ecoa o próprio session_id e o runner o adota — a sessão "viva"
    // do teste é a que o CLI registou.
    await until(() => a.messageSession.sessionId === "stub-sess", 3000, "sessão adotada do stub");
    const sessaoViva = a.messageSession.sessionId as string;

    a.activityClock.lastActivityAt = Date.now();
    a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_MS + 1_000);
    tick(h.runner);

    assert.equal(a.messageSession.sessionId, sessaoViva, "sessão NÃO pode ser neutralizada no corte por teto");
    assert.ok(
      h.warns.some((w) => w.includes("sessão qwen preservada pós-teto")),
      `sem log de sessão preservada: ${h.warns.join(" | ")}`,
    );
    assert.equal(
      h.warns.some((w) => w.includes("neutralizando sessão qwen")),
      false,
      "corte por teto não neutraliza",
    );
    assert.equal(a.inflightPerMessage?.attempt, 1, "mensagem re-enfileirada (attempt 1)");
    assert.ok(
      h.warns.some((w) => w.includes("notificação suprimida")),
      `1º attempt de lifetime não notifica: ${h.warns.join(" | ")}`,
    );
    assert.equal(a.hardRecoverTimes.length, 0, "lifetime não entra na janela de hang");
    assert.equal(h.hungs.length, 0, "nada foi notificado no 1º attempt");

    // O drain do recover põe o retry em voo retomando a MESMA sessão.
    await until(() => h.argvLines().length === 2, 5000, "retry em voo");
    const argv2 = h.argvLines()[1]!;
    assert.ok(argv2.includes(`-r ${sessaoViva}`), `retry tem de retomar a sessão (parcial preservada): ${argv2}`);
    assert.ok(!argv2.includes("--session-id"), `retry não pode abrir sessão nova: ${argv2}`);
  }));

/* ---------- C4 (runner): 2º corte do mesmo turno notifica imediato ---------- */

test("T-598 (C4 runner): re-corte do turno já re-enfileirado notifica na hora com texto [lifetime]", async () =>
  withHarness(async (h) => {
    await spawnTurnEmVoo(h);
    const a = asAny(h.runner);
    // 1º corte: suprime, re-enfileira (attempt 1)
    a.activityClock.lastActivityAt = Date.now();
    a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_MS + 1_000);
    tick(h.runner);
    await until(() => h.argvLines().length === 2, 5000, "retry em voo");

    // 2º corte (attempt 1): notifica imediato e re-enfileira de novo (attempt 2)
    const a2 = asAny(h.runner);
    a2.activityClock.lastActivityAt = Date.now();
    a2.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_MS + 1_000);
    tick(h.runner);

    assert.equal(a2.inflightPerMessage?.attempt, 2, "segundo corte re-enfileira (attempt 2)");
    assert.ok(
      h.hungs.some((r) => r.startsWith("[lifetime]")),
      `notificação imediata com rótulo próprio: ${h.hungs.join(" | ")}`,
    );
    assert.equal(a2.hardRecoverTimes.length, 0, "janela de hang segue sem eventos de lifetime");
  }));

/* ---------- C5: valor único declarado ---------- */

test("T-598 (C5): o par do CLI sai da MESMA fonte do teto e fica acima dele", () => {
  assert.equal(QWEN_TURN_LIFETIME_MS, 30 * 60_000);
  assert.equal(QWEN_STREAM_MAX_LIFETIME_MS, QWEN_TURN_LIFETIME_MS + 10 * 60_000);
  assert.equal(QWEN_STREAM_MAX_LIFETIME_MS, 40 * 60_000, "valor declarado no card p/ o daemon.env");
  // O valve anti-deadlock do turn-gate fica ACIMA do maior hold legítimo:
  // senão um turno qwen saudável >15min é liberado à força no meio (log
  // falso de "slot preso") — caso que a T-598 tornou normal.
  assert.ok(
    TURN_GATE_MAX_HOLD_MS > QWEN_HARD_TIMEOUT_MS,
    `valve (${TURN_GATE_MAX_HOLD_MS / 60_000}min) tem de cobrir o backstop do processo (${QWEN_HARD_TIMEOUT_MS / 60_000}min)`,
  );
});