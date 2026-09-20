/**
 * T-750 — turno do opencode terminava em error sem motivo no log (20/09:
 * durationMs 600.002ms cravados = teto do POST `/session/:id/message`; o run
 * seguia no serve depois do abort). Cobre: motivo visível no log local
 * (padrão T-743 do dsh), texto distinto para timeout do POST e o teto novo
 * acima do toolsHardMs do watchdog.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPENCODE_TURN_TIMEOUT_MS } from "../agent-runner.js";
import { hangThresholds } from "../runners/turn-watchdog.js";
import { ocReportError, ocTurnFailureReason } from "../runners/turns/opencode.js";

test("T-750: erro do opencode vai ao log local E ao chat, com prefixo do runner", () => {
  const logs: Array<{ lvl: string; msg: string }> = [];
  const erros: string[] = [];
  const self = {
    info: { id: "agent_t750" },
    opts: { log: (lvl: string, msg: string) => logs.push({ lvl, msg }), onError: (m: string) => erros.push(m) },
  };
  ocReportError(self, "opencode: turno falhou (exemplo) — retry 1/2");
  assert.equal(logs.length, 1, "onError sozinho não escreve no daemon.log — o fix exige a linha local");
  assert.equal(logs[0]!.lvl, "warn");
  assert.match(logs[0]!.msg, /^\[cli:agent_t750:opencode\] opencode: turno falhou/);
  assert.deepEqual(erros, ["opencode: turno falhou (exemplo) — retry 1/2"], "chat recebe o mesmo texto");
});

test("T-750: timeout do POST ganha motivo próprio (e o run pode seguir no serve)", () => {
  const t = ocTurnFailureReason("timeout 600000ms");
  assert.equal(t.timedOut, true);
  assert.match(t.detail, /teto de 10min do POST excedido/);
  assert.match(t.detail, /run pode seguir no serve/);
  assert.match(t.detail, /timeout 600000ms/, "mensagem crua preservada para diagnóstico");

  const provider = ocTurnFailureReason("AI_APICallError: 429 rate limit");
  assert.equal(provider.timedOut, false);
  assert.equal(provider.detail, "AI_APICallError: 429 rate limit", "erro do provider não é reescrito");
});

test("T-750: teto do POST acima do toolsHardMs do opencode (watchdog apanha travado, não o POST)", () => {
  const t = hangThresholds("opencode");
  assert.ok(
    OPENCODE_TURN_TIMEOUT_MS > t.toolsHardMs,
    `POST (${OPENCODE_TURN_TIMEOUT_MS / 60_000}min) tem de cobrir tool longa (${t.toolsHardMs / 60_000}min)`,
  );
  assert.equal(OPENCODE_TURN_TIMEOUT_MS, 30 * 60_000);
});