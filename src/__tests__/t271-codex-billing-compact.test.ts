/**
 * T-271 — Runner Codex disparava compactação com BILLING antes do poll
 * pós-turno aplicar a ocupação real do rollout.
 *
 * Causa-raiz: handleCodexEvent chamava checkContextUsage(delta, "inclusive")
 * imediatamente ao receber turn.completed. Esse usage.input_tokens é BILLING
 * do turno (soma dos prompts re-enviados a cada step/tool call) e pode atingir
 * 100% do mapa fallback (272k) antes de pollCodexContextOccupancy() ler o
 * rollout — o server então recebia agent:compact cedo. Sessão real do PM
 * (2026-09-06): rollout com model_context_window=828.400 e last_token_usage
 * ~125k–158k, billing do turno maior que a própria janela.
 *
 * Fix: turn.completed NÃO aplica ocupação; o billing fica guardado por epoch
 * e só é usado como fallback se o rollout não der sinal (comportamento
 * anterior preservado). Sinal real (last_token_usage + model_context_window)
 * vence. Contratos AgentUsage/onContextUsage/checkContextUsage intactos.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";

const SID = "0aaaaaaa-0000-7000-8000-000000000271";

/** Rollout sintético estilo sessão real do PM: janela REAL 828.400 e
 *  contexto do último step 158.000 (19% — longe do warn de 85%). */
function rolloutFixture(sid: string, usedTokens = 158000, window = 828400): string {
  const tokenCount = (total: number) =>
    JSON.stringify({
      timestamp: "2026-09-06T00:19:17.208Z",
      ordinal: 1,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: total + 5000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: total + 5110 },
          last_token_usage: { input_tokens: total - 110, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: total },
          model_context_window: window,
        },
      },
    });
  return [
    JSON.stringify({ timestamp: "2026-09-06T00:19:17.081Z", ordinal: 0, type: "session_meta", payload: { id: sid, session_id: sid, cwd: "/tmp", originator: "codex_exec", cli_version: "0.153.0" } }),
    tokenCount(125000),
    tokenCount(usedTokens),
  ].join("\n") + "\n";
}

function makeCodexHome(rollout: string | null): { home: string; cleanup: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), "t271-codex-"));
  const dayDir = path.join(home, "sessions", "2026", "09", "06");
  mkdirSync(dayDir, { recursive: true });
  if (rollout !== null) writeFileSync(path.join(dayDir, `rollout-2026-09-06T00-19-17-${SID}.jsonl`), rollout);
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** CLI codex falso: turno MULTI-STEP (tools + textos) terminando com
 *  turn.completed de BILLING 830.000 — ≥100% tanto do mapa (272k) quanto
 *  da janela real (828.400). É o billing que envenenava a ocupação. */
function writeFakeCodex(dir: string, sid: string, billing = 830000): string {
  const script = path.join(dir, "fake-codex.sh");
  const events = [
    JSON.stringify({ type: "thread.started", thread_id: sid }),
    JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", tool: "read_file", arguments: {} } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "step 1 ok" } }),
    JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", tool: "list_dir", arguments: {} } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "step 2 ok" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: billing, output_tokens: 900, cached_input_tokens: 1000 } }),
  ].map((e) => `'${e}'`).join(" ");
  writeFileSync(script, ["#!/bin/sh", `printf '%s\\n' ${events}`].join("\n"));
  chmodSync(script, 0o755);
  return script;
}

interface Captured { full: number; warnings: number; usage: Array<{ used: number; limit: number }> }

function makeRunner(fakeCodex: string): { runner: AgentRunner; captured: Captured } {
  const captured: Captured = { full: 0, warnings: 0, usage: [] };
  const info = {
    id: "agent_t271", ownerUserId: "user_t271", name: "probe", role: "backend",
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
    onContextFull: () => { captured.full++; },
    onContextWarning: () => { captured.warnings++; },
    onContextUsage: (used: number, limit: number) => { captured.usage.push({ used, limit }); },
    onError: () => {}, onExit: () => {},
  } as never;
  return { runner: new AgentRunner(info, opts), captured };
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

function useCodexHome(home: string): void {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  after(() => {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  });
}

/* ---------- (1) billing ≥100% + rollout sã → ZERO compact ---------- */

test("T-271 (1): billing multi-step 830k ≥100% + rollout 158k/828k → NENHUM context_full/compact, tracker termina no sinal real", async () => {
  const { home, cleanup } = makeCodexHome(rolloutFixture(SID));
  after(cleanup);
  useCodexHome(home);

  const { runner, captured } = makeRunner(writeFakeCodex(home, SID));
  after(() => { runner.stop(); });

  asAny(runner).runCodexMessage("ping");

  const tracker = asAny(runner).contextTracker;
  const ok = await waitFor(() => tracker.lastUsed() === 158000);
  assert.ok(ok, `tracker deveria terminar em 158.000 (last_token_usage); lastUsed=${tracker.lastUsed()}`);
  // Critério binário 1: billing ≥100% do limite NÃO emite context_full nem
  // solicita compact — nem no evento (antes do poll) nem depois.
  assert.equal(captured.full, 0, "billing 830k não pode disparar context_full/compact");
  assert.equal(captured.warnings, 0, "158k de 828k está longe do warn de 85%");
  // Critério 2: UI/threshold usa last_token_usage + model_context_window.
  assert.equal(tracker.limitOut(), 828400, "janela REAL do rollout vence o mapa (272k)");
});

test("T-271 (1b) unitário: turn.completed com billing NÃO aplica ocupação sincronamente (guarda no stash por epoch)", () => {
  const { home, cleanup } = makeCodexHome(null);
  after(cleanup);
  useCodexHome(home);

  const { runner } = makeRunner(writeFakeCodex(home, SID));
  after(() => { runner.stop(); });

  const tracker = asAny(runner).contextTracker;
  assert.equal(tracker.lastUsed(), 0);

  asAny(runner).handleCodexEvent(
    { type: "turn.completed", usage: { input_tokens: 830000, output_tokens: 900, cached_input_tokens: 1000 } },
    0, // epoch 0 = dono num runner fresco
  );

  assert.equal(tracker.lastUsed(), 0, "billing do turn.completed não pode virar ocupação/compact");
  const stash = asAny(runner).codexTurnBilling;
  assert.ok(stash, "billing deve ficar guardado pro fallback do poll");
  assert.equal(stash.epoch, 0);
  assert.equal(stash.delta.input, 830000);
});

/* ---------- (3) sem rollout → fallback billing+mapa permanece ---------- */

test("T-271 (3): rollout ausente → fallback billing (46.995) + janela do mapa (272k), sem full", async () => {
  const { home, cleanup } = makeCodexHome(null);
  after(cleanup);
  useCodexHome(home);

  const { runner, captured } = makeRunner(writeFakeCodex(home, SID, 46995));
  after(() => { runner.stop(); });

  asAny(runner).runCodexMessage("ping");

  const tracker = asAny(runner).contextTracker;
  const ok = await waitFor(() => tracker.lastUsed() === 46995);
  assert.ok(ok, `fallback billing deve aplicar 46.995 via poll; lastUsed=${tracker.lastUsed()}`);
  assert.equal(tracker.limitOut(), 272_000, "fallback: janela do mapa (gpt-5.6-sol)");
  assert.equal(captured.full, 0, "46.995 de 272k não é full");
});

/* ---------- (4) compactação REAL por context_full continua funcionando ---------- */

test("T-271 (4a) regressivo: sem rollout, billing ≥ janela do mapa → context_full dispara (fallback intacto)", async () => {
  const { home, cleanup } = makeCodexHome(null);
  after(cleanup);
  useCodexHome(home);

  const { runner, captured } = makeRunner(writeFakeCodex(home, SID, 400000));
  after(() => { runner.stop(); });

  asAny(runner).runCodexMessage("ping");

  const tracker = asAny(runner).contextTracker;
  const ok = await waitFor(() => captured.full > 0);
  assert.ok(ok, "billing 400k ≥ mapa 272k deve disparar context_full (compact real)");
  assert.equal(tracker.lastUsed(), 272_000, "ocupação clampada no teto do mapa");
});

test("T-271 (4b) regressivo: rollout real ≥ janela → context_full dispara (sinal real intacto)", async () => {
  const { home, cleanup } = makeCodexHome(rolloutFixture(SID, 840000, 828400));
  after(cleanup);
  useCodexHome(home);

  const { runner, captured } = makeRunner(writeFakeCodex(home, SID, 1000));
  after(() => { runner.stop(); });

  asAny(runner).runCodexMessage("ping");

  const tracker = asAny(runner).contextTracker;
  const ok = await waitFor(() => captured.full > 0);
  assert.ok(ok, "last_token_usage 840k ≥ janela 828k deve disparar context_full");
  assert.equal(tracker.lastUsed(), 828_400, "ocupação clampada na janela real");
});

/* ---------- epoch guard: billing de conversa descartada não envenena ---------- */

test("T-271 (5): billing de epoch descartado não é aplicado nem como fallback", async () => {
  const { home, cleanup } = makeCodexHome(null);
  after(cleanup);
  useCodexHome(home);

  const { runner } = makeRunner(writeFakeCodex(home, SID, 400000));
  after(() => { runner.stop(); });

  const tracker = asAny(runner).contextTracker;
  asAny(runner).handleCodexEvent(
    { type: "turn.completed", usage: { input_tokens: 400000, output_tokens: 1, cached_input_tokens: 0 } },
    7, // epoch antigo — sessão já foi resetada (clear/compact)
  );
  assert.equal(asAny(runner).codexTurnBilling, null, "evento de epoch morto não gera stash");

  await asAny(runner).pollCodexContextOccupancy(7);
  assert.equal(tracker.lastUsed(), 0, "billing de conversa descartada não pode envenenar a sessão nova");
});
