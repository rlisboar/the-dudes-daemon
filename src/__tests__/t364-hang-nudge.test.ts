/**
 * T-364 — auto-recover de hard stall com nudge "continue".
 *
 * (a) fila vazia ⇒ respawn + exatamente 1 mensagem sintética; fila com 1 msg
 *     real ⇒ zero sintéticas; 3º dentro da janela ⇒ notifica e não enfileira.
 * (b) fase SOFT nunca arma nudge.
 *
 * Padrão T-240: AgentRunner REAL com tick chamado à mão e drainOcQueue stubado
 * (o stub deixa o respawn observável sem spawnar CLI).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";
import { PerMessageSessionState } from "../runners/message-session.js";
import {
  HANG_RECOVER_NUDGE_FLAG,
  HANG_RECOVER_NUDGE_MAX,
  HANG_RECOVER_NUDGE_TEXT,
  HANG_RECOVER_NUDGE_WINDOW_MS,
  deliverHangRecoverNudge,
  planHangRecoverNudge,
} from "../runners/hang-nudge.js";

const MIN = 60_000;

function makeRunner(cliRunner: string): {
  runner: AgentRunner;
  events: Array<{ soft: boolean; reason: string }>;
  logs: string[];
  drains: { n: number };
} {
  const events: Array<{ soft: boolean; reason: string }> = [];
  const logs: string[] = [];
  const drains = { n: 0 };
  const info = {
    id: "agent_t364", ownerUserId: "user_t364", name: "probe", role: "backend",
    systemPrompt: "", color: "#a78bfa", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const opts = {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner, autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: resolveCliCommands(), verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (_lvl: string, line: string) => { logs.push(line); },
    cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {},
    onHung: (h: { soft: boolean; reason: string }) => { events.push(h); },
    onExit: () => {},
  } as never;
  const runner = new AgentRunner(info, opts);
  // Espelho do stub de T-240: sem isto o drain spawnaria o CLI real no teste.
  (runner as unknown as { drainOcQueue: () => void }).drainOcQueue = () => { drains.n++; };
  // Backoff 0: o teste observa o efeito do plano sem esperar 5s/30s reais.
  const a = runner as unknown as Record<string, unknown>;
  a.hangNudgeBackoffs = [0, 0];
  return { runner, events, logs, drains };
}

const tick = (r: AgentRunner) =>
  (r as unknown as { tickHangWatch: () => void }).tickHangWatch();
const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const settle = () => new Promise((r) => setTimeout(r, 15));

/** Estado de turno morto: busy sem processo, idle > hardMs (codex: 12min). */
function armDeadTurn(a: Record<string, any>, inflight: { content: string; attempt: number } | null): void {
  a.messageSession.busy = true;
  a.toolsInFlight = 0;
  a.ocActiveProc = null;
  a.inflightPerMessage = inflight;
  a.activityClock.lastActivityAt = Date.now() - 13 * MIN;
}

/* ---------- (a) fila vazia ⇒ respawn + exatamente 1 sintética ---------- */

test("T-364 (a1): hard recover com fila vazia ⇒ 1 mensagem sintética no queue + dreno (respawn)", async () => {
  const { runner, events, drains } = makeRunner("codex");
  const a = asAny(runner);
  a.messageSession.sessionId = "sess-antiga";
  armDeadTurn(a, null);

  tick(runner);
  await settle();

  const q = a.messageSession as PerMessageSessionState;
  assert.equal(q.queuedCount(), 1, "exatamente uma mensagem na fila");
  const next = q.dequeue();
  assert.equal(next?.content, HANG_RECOVER_NUDGE_TEXT, "conteúdo exato do contrato");
  assert.equal(next?.synthetic, HANG_RECOVER_NUDGE_FLAG, "flag synthetic=hang-recover");
  assert.ok(drains.n >= 1, "nudge tenta retomar o turno (respawn pelo caminho de já)");
  assert.equal(
    a.messageSession.sessionId, "sess-antiga",
    "respawn mantém a sessão (resume)",
  );
  assert.equal(
    events.filter((e) => /auto-continue/.test(e.reason)).length, 0,
    "orçamento não esgotado: nenhuma notificação de pare-de-automatizar",
  );
});

/* ---------- (a) fila com 1 msg real ⇒ zero sintéticas ---------- */

test("T-364 (a2): hard recover com mensagem real re-enfileirada ⇒ ZERO sintética, sem gastar orçamento", async () => {
  const { runner } = makeRunner("codex");
  const a = asAny(runner);
  armDeadTurn(a, { content: "instrução do user", attempt: 0 });

  tick(runner);
  await settle();

  const q = a.messageSession as PerMessageSessionState;
  assert.equal(q.queuedCount(), 1, "só a mensagem real na fila");
  const next = q.dequeue();
  assert.equal(next?.content, "instrução do user");
  assert.equal(next?.synthetic, undefined, "nada sintético injetado");
  assert.deepEqual(asAny(runner).hangNudgeTimes, [], "fila com trabalho não queima orçamento");
});

/* ---------- (a) 3º dentro da janela ⇒ notifica e não enfileira ---------- */

test("T-364 (a3): 3º auto-continue na janela de 30min ⇒ notifica o dono, log warn, nada enfileirado", async () => {
  const { runner, events, logs } = makeRunner("codex");
  const a = asAny(runner);
  a.hangNudgeTimes = [Date.now() - 10_000, Date.now() - 20_000];
  armDeadTurn(a, null);

  tick(runner);
  await settle();

  const q = a.messageSession as PerMessageSessionState;
  assert.equal(q.queuedCount(), 0, "orçamento esgotado: sem nudge");
  const notice = events.filter((e) => /auto-continue esgotado/.test(e.reason));
  assert.equal(notice.length, 1, "1 notificação ao dono");
  assert.equal(notice[0]!.soft, false, "notificação de fase hard");
  assert.ok(
    logs.some((l) => /auto-continue esgotado/.test(l)),
    "log warn do orçamento esgotado",
  );
});

test("T-364 (a3b): janela é rolante — timestamps fora dos 30min não contam", () => {
  const now = Date.now();
  const plan = planHangRecoverNudge({
    queueLength: 0,
    now,
    sentTimes: [now - HANG_RECOVER_NUDGE_WINDOW_MS - 1_000, now - 60_000],
  });
  assert.equal(plan.nudge, true, "só 1 nudge dentro da janela → há orçamento");
  assert.equal(plan.used, 2, "o velho caiu da janela");
  assert.equal(plan.sentTimes.length, 2);
});

/* ---------- (b) fase soft nunca arma nudge ---------- */

test("T-364 (b): fase SOFT (idle entre softMs e hardMs) ⇒ stalled sem recover e sem nudge", () => {
  const { runner, events, drains } = makeRunner("codex");
  const a = asAny(runner);
  a.messageSession.busy = true;
  a.toolsInFlight = 0;
  a.ocActiveProc = null;
  a.inflightPerMessage = null;
  // codex: softMs=5min, hardMs=12min.
  a.activityClock.lastActivityAt = Date.now() - 6 * MIN;

  tick(runner);

  assert.equal(a.hangNudgeTimer, null, "soft não arma nudge");
  assert.equal(asAny(runner).messageSession.queuedCount(), 0);
  assert.equal(drains.n, 0, "nenhum respawn disparado");
  assert.equal(events.length, 1, "soft: só o aviso de stalled");
  assert.equal(events[0]!.soft, true, "aviso é da fase soft");
});

test("T-364 (b2): gancho só existe dentro de recoverHungTurn (hard); ramo soft do tick não o chama", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../agent-runner.ts", import.meta.url)),
    "utf8",
  );
  const hard = src.indexOf("private recoverHungTurn(");
  const call = src.indexOf("this.scheduleHangNudge(idleMs)");
  const arm = src.indexOf("private scheduleHangNudge(");
  assert.ok(hard > 0 && call > hard && arm > call, "scheduleHangNudge chamado no fim de recoverHungTurn");

  const soft = src.indexOf('if (phase === "soft"');
  const endOfTick = src.indexOf("/** Hard recover", soft);
  const softBlock = src.slice(soft, endOfTick);
  assert.ok(softBlock.includes("soft: true"), "ramo soft presente");
  assert.ok(!softBlock.includes("recoverHungTurn("), "soft não faz hard recover");
  assert.ok(!softBlock.includes("scheduleHangNudge"), "soft não arma nudge");
});

/* ---------- política pura: orçamento e backoff ---------- */

test("T-364 (c): orçamento 2/30min com backoff 5s depois 30s; 3º só notifica", () => {
  const now = Date.now();
  const p1 = planHangRecoverNudge({ queueLength: 0, now, sentTimes: [] });
  assert.equal(p1.nudge, true);
  assert.equal(p1.backoffMs, 5_000, "1ª tentativa com backoff de 5s");
  assert.equal(p1.used, 1);

  const p2 = planHangRecoverNudge({ queueLength: 0, now: now + 60_000, sentTimes: p1.sentTimes });
  assert.equal(p2.nudge, true);
  assert.equal(p2.backoffMs, 30_000, "2ª tentativa com backoff de 30s");

  const p3 = planHangRecoverNudge({ queueLength: 0, now: now + 120_000, sentTimes: p2.sentTimes });
  assert.equal(p3.nudge, false);
  assert.equal(p3.notify, true);
  assert.equal(p3.sentTimes.length, HANG_RECOVER_NUDGE_MAX, "sem nudge não se acrescenta à janela");
});

test("T-364 (c2): entrega descarta o nudge se chegou trabalho real no backoff", () => {
  const q = new PerMessageSessionState();
  assert.equal(deliverHangRecoverNudge(q, 20), true);
  assert.equal(q.queuedCount(), 1);
  assert.equal(deliverHangRecoverNudge(q, 20), false, "nunca 2 nudges");
  assert.equal(q.dequeue()?.synthetic, HANG_RECOVER_NUDGE_FLAG);
});
