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
  createActivityClock,
  hangThresholds,
  hardRecoverNotifyPolicy,
  QWEN_HARD_TIMEOUT_MS,
  QWEN_STREAM_MAX_LIFETIME_MS,
  QWEN_TURN_LIFETIME_CAP_MS,
  QWEN_TURN_LIFETIME_MS,
  touchActivityClock,
  turnLifetimeExceeded,
} from "../runners/turn-watchdog.js";
import { TURN_GATE_MAX_HOLD_MS, turnGateStats } from "../runners/turn-gate.js";
import { TextLoopGuard } from "../runners/turn-parsers.js";

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
  infos: string[];
  hungs: string[];
  dir: string;
  argvLines(): string[];
}

/** T-749 (review T-754): MESMO regex do parser de produção
 *  (.worktrees/T-730/.orchestrator/evidence/T-730/lifetime-ceiling.mjs,
 *  KILL_LINE_RE). Se o formato da linha mudar, este teste quebra primeiro —
 *  foi a falta dele que deixou o parser devolver zero. */
const KILL_LINE_RE = /^\[([^\]]+)\].*\[(lifetime|hang):([^\]]+)\] HARD recover: .*turn lifetime (\d+)s ≥ (\d+)s \(runner=([a-z-]+)[^)]*idleMs=(\d+)\)/;

function makeHarness(): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t598-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(path.join(dir, "mode"), "hang");
  const warns: string[] = [];
  const infos: string[] = [];
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
    log: (lvl: string, msg: string) => { if (lvl === "warn") warns.push(msg); if (lvl === "info" && msg.startsWith("[turn-latency]")) infos.push(msg); },
    cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onHung: (h: { reason: string }) => { hungs.push(h.reason); }, onExit: () => {},
  } as never;
  const runner = new AgentRunner(info, runnerOpts);
  return {
    runner,
    warns,
    infos,
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
 *  (pitfall T-376, mesmo dos testes T-417).
 *
 *  T-820: a fonte PRIMÁRIA é o rastreio do próprio runner (`killTrackedTurnPids`,
 *  a mesma lista que o stop usa) — `ps` é NEGADO no sandbox do agente (T-897),
 *  então a varredura por comando voltava 0 e o stub sobrevivia, pendurando a
 *  suíte quando ela roda sem `--test-force-exit`. */
function sweepStubs(dir: string, runner?: AgentRunner): number {
  let vivos = 0;
  if (runner) {
    const matar = asAny(runner).killTrackedTurnPids as ((s: NodeJS.Signals) => number) | undefined;
    if (matar) vivos += matar.call(runner, "SIGKILL");
  }
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

async function until(cond: () => boolean, ms = 20_000, what = "condição"): Promise<void> {
// T-1088: budget LARGO — sob a carga da suíte inteira o spawn do stub passa
// dos 4-8s e o caso virava falso vermelho (família 'timeout aguardando spawn').
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
      if (sweepStubs(h.dir, h.runner) === 0 && !asAny(h.runner).ocActiveProc && turnGateStats().ativos === 0) {
        await new Promise((r) => setTimeout(r, 200));
        if (sweepStubs(h.dir, h.runner) === 0) break;
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
  await until(() => h.argvLines().length === 1, 20_000, "spawn do turno");
  await until(() => typeof asAny(h.runner).messageSession.sessionId === "string", 3000, "sessão adotada do stub");
}

/* ---------- C2: turno saudável de 20min NÃO é morto pelo teto ---------- */

test("T-598 (C2): turno qwen saudável com stream contínuo de 20min sobrevive ao teto antigo (8min)", async () =>
  withHarness(async (h) => {
    await spawnTurnEmVoo(h);
    const a = asAny(h.runner);
    // Stream CONTÍNUO (clock renovado) + turno com 20min de elapsed — no teto
    // antigo (8min) isto era HARD recover; com a janela de 30min não é.
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

/* ---------- T-749: progresso renova a janela; só o cap absoluto a encerra ---------- */

test("T-749 (progresso): passado o teto antigo (30min), turno com eventos segue vivo até o cap", async () =>
  withHarness(async (h) => {
    await spawnTurnEmVoo(h);
    const a = asAny(h.runner);

    // Progresso contínuo (cada evento move lastActivityAt): elapsed bem além
    // dos 30min do T-598 e ainda abaixo do cap — o turno produtivo NÃO morre.
    for (const elapsed of [QWEN_TURN_LIFETIME_MS + 1_000, 45 * 60_000, QWEN_TURN_LIFETIME_CAP_MS - 1_000]) {
      a.activityClock.lastActivityAt = Date.now();
      a.activityClock.turnStartedAt = Date.now() - elapsed;
      tick(h.runner);
      assert.equal(
        h.warns.some((w) => w.includes("HARD recover")),
        false,
        `elapsed=${Math.round(elapsed / 60_000)}min com progresso não podia ser morto: ${h.warns.join(" | ")}`,
      );
    }

    // Contraprova: passado o cap, mesmo com progresso fresco, o turno É morto.
    a.activityClock.lastActivityAt = Date.now();
    a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_CAP_MS + 1_000);
    tick(h.runner);
    assert.ok(
      h.warns.some((w) => w.includes("HARD recover") && w.includes("turn lifetime") && w.includes("cap absoluto")),
      `cap tem de cortar turno que só se renova: ${h.warns.join(" | ")}`,
    );
    assert.equal(a.inflightPerMessage?.attempt, 1, "mensagem re-enfileirada após o corte");
  }));

/* ---------- T-749: sem progresso por 30min a janela vence (antes do cap) ---------- */

test("T-749 (janela): turno sem NENHUM evento semântico há 30min é cortado pela janela, não pelo cap", async () =>
  withHarness(async (h) => {
    await spawnTurnEmVoo(h);
    const a = asAny(h.runner);
    a.activityClock.lastActivityAt = Date.now() - (QWEN_TURN_LIFETIME_MS + 1_000);
    a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_MS + 1_000);

    tick(h.runner);

    assert.ok(
      h.warns.some((w) => w.includes("HARD recover") && w.includes("turn lifetime") && w.includes("sem progresso")),
      `janela tem de cortar turno parado há 30min: ${h.warns.join(" | ")}`,
    );
    const killLine = h.warns.find((w) => w.includes("HARD recover: sem progresso"));
    assert.ok(killLine && KILL_LINE_RE.test(`[2026-01-01T00:00:00.000Z] [warn] ${killLine}`), `linha da janela fora do formato do parser: ${killLine}`);
    const tl = h.infos.map((l) => JSON.parse(l.slice(15))).find((j) => j.endReason === "hard-recover");
    assert.equal(tl?.lifetimeLimit, "progress", "campo separa janela de cap");
  }));

/* ---------- C3/F4: stream que renova o idle para sempre ainda é cortado ---------- */

test("T-598 (C3/F4): stream que renova a atividade para sempre não escapa — o cap o corta", async () =>
  withHarness(async (h) => {
    await spawnTurnEmVoo(h);
    const a = asAny(h.runner);

    // F4: cada tick renova o clock semântico (loop de tokens que nunca
    // termina). soft/hard nunca disparam; só o cap absoluto apanha — a janela
    // renovaria para sempre.
    for (const elapsed of [5 * 60_000, 12 * 60_000, 29 * 60_000, 45 * 60_000]) {
      a.activityClock.lastActivityAt = Date.now();
      a.activityClock.turnStartedAt = Date.now() - elapsed;
      tick(h.runner);
      assert.equal(
        h.warns.some((w) => w.includes("HARD recover")),
        false,
        `elapsed=${elapsed / 60_000}min ainda dentro do cap`,
      );
    }

    a.activityClock.lastActivityAt = Date.now();
    a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_CAP_MS + 1_000);
    tick(h.runner);
    assert.ok(
      h.warns.some((w) => w.includes("HARD recover") && w.includes("turn lifetime") && w.includes("cap absoluto")),
      "loop que renova o idle tem de morrer pelo cap absoluto",
    );
    // T-749 (T-754): linha PINADA no formato do parser de prod + campo próprio.
    const killLine = h.warns.find((w) => w.includes("HARD recover: cap absoluto"));
    assert.ok(killLine && KILL_LINE_RE.test(`[2026-01-01T00:00:00.000Z] [warn] ${killLine}`), `linha de corte fora do formato do parser de prod: ${killLine}`);
    const tl = h.infos.map((l) => JSON.parse(l.slice(15))).find((j) => j.endReason === "hard-recover");
    assert.equal(tl?.recoverKind, "lifetime", "campo separa lifetime de hang");
    assert.equal(tl?.lifetimeLimit, "cap", "campo separa cap de janela (sem depender do texto)");
    // Quem matou: foi o CAP (kind lifetime, motivo "cap absoluto"), não o
    // guard nem o idle — e o turno MORREU com re-fila (busy cai ou o drain
    // já re-pôs a mensagem; mesmo padrão anti-flake do t371 c-integration).
    await until(() => a.messageSession.busy === false || a.inflightPerMessage?.attempt === 1, 3000, "kill do loop pelo cap");
    assert.equal(a.inflightPerMessage?.attempt, 1, "mensagem do loop re-enfileirada pelo corte por cap");
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
    a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_CAP_MS + 1_000);
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
    // 1º corte: suprime, re-enfileira (attempt 1). Cap (não renovável) com
    // progresso fresco — o caso "turno que trabalha mas não converge".
    a.activityClock.lastActivityAt = Date.now();
    a.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_CAP_MS + 1_000);
    tick(h.runner);
    await until(() => h.argvLines().length === 2, 5000, "retry em voo");

    // 2º corte (attempt 1): notifica imediato e re-enfileira de novo (attempt 2)
    const a2 = asAny(h.runner);
    a2.activityClock.lastActivityAt = Date.now();
    a2.activityClock.turnStartedAt = Date.now() - (QWEN_TURN_LIFETIME_CAP_MS + 1_000);
    tick(h.runner);

    assert.equal(a2.inflightPerMessage?.attempt, 2, "segundo corte re-enfileira (attempt 2)");
    assert.ok(
      h.hungs.some((r) => r.startsWith("[lifetime]")),
      `notificação imediata com rótulo próprio: ${h.hungs.join(" | ")}`,
    );
    assert.equal(a2.hardRecoverTimes.length, 0, "janela de hang segue sem eventos de lifetime");
  }));

/* ---------- T-749: semântica pura do teto (janela renovável × cap) ---------- */

test("T-749: turnLifetimeExceeded distingue cap absoluto, janela sem progresso e turno são", () => {
  const t = hangThresholds("qwen");
  const clock = createActivityClock();
  const now = Date.now();

  clock.turnStartedAt = now - (QWEN_TURN_LIFETIME_MS + 1_000);
  clock.lastActivityAt = now - (QWEN_TURN_LIFETIME_MS + 1_000);
  assert.equal(turnLifetimeExceeded(clock, t, now), "progress", "parado além da janela vence pela janela");

  assert.equal(touchActivityClock(clock, now), undefined);
  assert.equal(turnLifetimeExceeded(clock, t, now), null, "evento renova a janela");
  assert.equal(clock.turnStartedAt, now - (QWEN_TURN_LIFETIME_MS + 1_000), "renovar NÃO move o início do turno");

  clock.turnStartedAt = now - (QWEN_TURN_LIFETIME_CAP_MS + 1_000);
  clock.lastActivityAt = now;
  assert.equal(turnLifetimeExceeded(clock, t, now), "cap", "cap absoluto vence mesmo com progresso fresco");

  const semCap = { softMs: 1_000, hardMs: 2_000, deadProcMs: 3_000, toolsHardMs: 4_000, lifetimeMs: 5_000 };
  clock.turnStartedAt = now - 60_000;
  clock.lastActivityAt = now - 6_000;
  assert.equal(turnLifetimeExceeded(clock, semCap, now), "progress");
});

/* ---------- T-749 (C6): os 3 tiers derivados JUNTOS e na ordem obrigatória ---------- */

test("T-749 (C6): janela < cap < hard-timeout < stream-max, todos derivados da janela", () => {
  // Um tier não-renovável abaixo do cap mataria turno vivo pelo tier errado
  // (o cap nunca seria alcançado); a derivação única impede drift de literais.
  assert.equal(QWEN_TURN_LIFETIME_CAP_MS, 2 * QWEN_TURN_LIFETIME_MS, "cap derivado da janela");
  assert.equal(QWEN_HARD_TIMEOUT_MS, QWEN_TURN_LIFETIME_CAP_MS + 5 * 60_000, "hard-timeout derivado do cap");
  assert.equal(QWEN_STREAM_MAX_LIFETIME_MS, QWEN_TURN_LIFETIME_CAP_MS + 10 * 60_000, "guard do CLI derivado do cap");
  assert.ok(QWEN_TURN_LIFETIME_MS < QWEN_TURN_LIFETIME_CAP_MS, "janela (renovável) é o tier mais baixo");
  assert.ok(QWEN_TURN_LIFETIME_CAP_MS < QWEN_HARD_TIMEOUT_MS, "cap abaixo do backstop do processo");
  assert.ok(QWEN_HARD_TIMEOUT_MS < QWEN_STREAM_MAX_LIFETIME_MS, "processo abaixo do guard do CLI");
  assert.ok(TURN_GATE_MAX_HOLD_MS > QWEN_HARD_TIMEOUT_MS, "valve do gate acima do maior tier");
  const t = hangThresholds("qwen");
  assert.equal(t.lifetimeMs, QWEN_TURN_LIFETIME_MS);
  assert.equal(t.lifetimeCapMs, QWEN_TURN_LIFETIME_CAP_MS);
});

/* ---------- T-749 (C7): TextLoopGuard armado com a janela renovando ---------- */

test("T-749 (C7): loop de token é do TextLoopGuard mesmo renovando a janela — não do cap", () => {
  // F4: cada evento renova a janela (turnLifetimeExceeded = null), então o
  // lifetime não corta; quem tem de apanhar é o guard (T-371 (c)), sem esperar
  // o cap. Integração do guard com o driver real: t371 (c-integration).
  const guard = new TextLoopGuard({ minFeedChars: 100, windowChars: 64, maxPeriod: 4, coverage: 0.95 });
  const clock = createActivityClock();
  const t = hangThresholds("qwen");
  const piece = "abcd".repeat(20);
  let caught = false;
  for (let i = 0; i < 50 && !caught; i++) {
    touchActivityClock(clock);
    assert.equal(turnLifetimeExceeded(clock, t), null, "janela renovando: lifetime ainda não corta");
    caught = guard.feed(piece);
  }
  assert.equal(caught, true, "guard tem de acusar o loop com a janela renovando");
});

/* ---------- C5: valor único declarado ---------- */

test("T-598 (C5): o par do CLI sai da MESMA fonte do cap e fica acima dele", () => {
  assert.equal(QWEN_TURN_LIFETIME_MS, 30 * 60_000);
  assert.equal(QWEN_TURN_LIFETIME_CAP_MS, 60 * 60_000, "T-749: cap absoluto = 2× a janela");
  assert.equal(QWEN_STREAM_MAX_LIFETIME_MS, QWEN_TURN_LIFETIME_CAP_MS + 10 * 60_000);
  assert.equal(QWEN_STREAM_MAX_LIFETIME_MS, 70 * 60_000, "valor declarado p/ o daemon.env");
  // O valve anti-deadlock do turn-gate fica ACIMA do maior hold legítimo:
  // senão um turno qwen saudável >15min é liberado à força no meio (log
  // falso de "slot preso") — caso que a T-598 tornou normal.
  assert.ok(
    TURN_GATE_MAX_HOLD_MS > QWEN_HARD_TIMEOUT_MS,
    `valve (${TURN_GATE_MAX_HOLD_MS / 60_000}min) tem de cobrir o backstop do processo (${QWEN_HARD_TIMEOUT_MS / 60_000}min)`,
  );
});