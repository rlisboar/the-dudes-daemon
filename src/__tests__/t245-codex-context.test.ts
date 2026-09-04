/**
 * T-245 — janela de contexto do runner codex errada.
 *
 * Causa-raiz (2 defeitos, diagnóstico PM com prova empírica — codex-cli
 * 0.153.0, gpt-5.6-sol):
 *   1. Ocupação: parseCodexTurnEvent consumia SÓ turn.completed, cujo
 *      usage.input_tokens é BILLING do turno (soma dos prompts re-enviados
 *      a cada step/tool call) — 46.995 billing vs 15.765 de contexto real.
 *      Caso real (sessão w3block 01a06cb7, ~20 steps): billing 1.216.327 vs
 *      contexto real 49.171 → barra cravada em 100% e falsos context-full.
 *   2. Janela: mapa gpt-5.6-sol → 272.000, mas o codex reporta
 *      model_context_window = 258.400 (272k − 5% de reserve) no rollout.
 *
 * Fonte real: rollout da sessão (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
 * — event_msg token_count com last_token_usage (contexto do ÚLTIMO step) e
 * model_context_window. O stdout de exec --json NÃO emite token_count.
 * Fallback: rollout ausente/ilegível → comportamento atual (billing + mapa).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCodexRolloutSignals, parseCodexRolloutSessionId } from "../runners/turn-parsers.js";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";

const SID = "0aaaaaaa-0000-7000-8000-000000000245";

/** Rollout sintético MULTI-STEP (3 steps de tool call): o billing do turno
 *  seria a soma (5.100+9.900+15.765), o contexto real é o último step. */
function rolloutFixture(sid: string): string {
  const step = (total: number) =>
    JSON.stringify({
      timestamp: "2026-09-04T14:06:07.208Z",
      ordinal: 1,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: total + 110 },
          last_token_usage: { input_tokens: total - 110, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: total },
          model_context_window: 258400,
        },
      },
    });
  return [
    JSON.stringify({ timestamp: "2026-09-04T13:59:03.081Z", ordinal: 0, type: "session_meta", payload: { id: sid, session_id: sid, cwd: "/tmp", originator: "codex_exec", cli_version: "0.153.0" } }),
    JSON.stringify({ timestamp: "2026-09-04T14:00:00.000Z", ordinal: 1, type: "event_msg", payload: { type: "agent_message", message: "oi" } }),
    step(5100),
    "linha malformada {{{ não é json",
    step(9900),
    step(15765),
  ].join("\n") + "\n";
}

function makeCodexHome(withRollout: boolean): { home: string; cleanup: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), "t245-codex-"));
  const dayDir = path.join(home, "sessions", "2026", "09", "04");
  mkdirSync(dayDir, { recursive: true });
  if (withRollout) writeFileSync(path.join(dayDir, `rollout-2026-09-04T10-59-02-${SID}.jsonl`), rolloutFixture(SID));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** CLI codex falso: emite thread.started + turn.completed com BILLING de
 *  46.995 (soma dos steps) — exatamente o cenário da prova do PM. */
function writeFakeCodex(dir: string, sid: string): string {
  const script = path.join(dir, "fake-codex.sh");
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '%s\\n' '{"type":"thread.started","thread_id":"${sid}"}' '{"type":"turn.completed","usage":{"input_tokens":46995,"output_tokens":300,"cached_input_tokens":40000}}'`,
  ].join("\n"));
  chmodSync(script, 0o755);
  return script;
}

function makeRunner(fakeCodex: string): AgentRunner {
  const info = {
    id: "agent_t245", ownerUserId: "user_t245", name: "probe", role: "backend",
    systemPrompt: "", color: "#a78bfa", state: "idle", running: true,
    model: "gpt-5.6-sol",
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const cliCommands = {
    ...resolveCliCommands(),
    codex: { command: fakeCodex, source: "override" as const, available: true },
  };
  const opts = {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "codex", autoApprove: true, workspaceRoot: tmpdir(),
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onExit: () => {},
  } as never;
  return new AgentRunner(info, opts);
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;

/** Espera o poll pós-turno aplicar o sinal do rollout (ou timeout). */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/* ---------- parser puro ---------- */

test("T-245 parser: rollout multi-step → last_token_usage do ÚLTIMO step (não a soma) + janela real", () => {
  const sig = parseCodexRolloutSignals(rolloutFixture(SID));
  assert.ok(sig, "sinal deve existir");
  assert.equal(sig!.usedTokens, 15765, "contexto real do último step (billing seria 30.765)");
  assert.equal(sig!.contextWindow, 258400, "janela real do codex (272k − 5% reserve)");
});

test("T-245 parser: rollout sem token_count → null (fallback)", () => {
  const onlyMeta = JSON.stringify({ type: "session_meta", payload: { id: SID } }) + "\n";
  assert.equal(parseCodexRolloutSignals(onlyMeta), null);
  assert.equal(parseCodexRolloutSignals("nada aqui"), null);
});

test("T-245 parser: session id da 1ª linha (session_meta)", () => {
  assert.equal(parseCodexRolloutSessionId(rolloutFixture(SID)), SID);
});

/* ---------- integração: turno real (CLI falso) + rollout ---------- */

test("T-245 (1): turno com N steps → tracker reflete last_token_usage do último step e limit 258.400", async () => {
  const { home, cleanup } = makeCodexHome(true);
  after(cleanup);
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  after(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
  });

  const runner = makeRunner(writeFakeCodex(home, SID));
  after(() => { runner.stop(); });

  asAny(runner).runCodexMessage("ping");

  const tracker = asAny(runner).contextTracker;
  const ok = await waitFor(() => tracker.lastUsed() === 15765);
  assert.ok(ok, `tracker deveria refletir 15.765 (último step); lastUsed=${tracker.lastUsed()}`);
  assert.equal(tracker.lastUsed(), 15765, "ocupação ABSOLUTA do último step — não billing 46.995");
  assert.equal(tracker.limitOut(), 258400, "janela REAL do rollout vence o mapa (272k)");
});

test("T-245 (2): rollout ausente → fallback comportamento atual (billing do turn.completed + janela do mapa)", async () => {
  const { home, cleanup } = makeCodexHome(false);
  after(cleanup);
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  after(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
  });

  const runner = makeRunner(writeFakeCodex(home, SID));
  after(() => { runner.stop(); });

  asAny(runner).runCodexMessage("ping");

  const tracker = asAny(runner).contextTracker;
  const ok = await waitFor(() => tracker.lastUsed() > 0);
  assert.ok(ok, "billing do turn.completed deve reportar ocupação (comportamento atual)");
  assert.equal(tracker.lastUsed(), 46995, "fallback: billing do turno (sem rollout não há valor melhor)");
  assert.equal(tracker.limitOut(), 272_000, "fallback: janela do mapa (gpt-5.6-sol)");
});
