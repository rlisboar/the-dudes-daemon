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
import { ocReportError, ocTurnFailureReason, runOpenCodeMessageAttached } from "../runners/turns/opencode.js";

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

test("T-750/T-784: timeout do POST ganha motivo próprio e EXIGE abort da sessão no serve", async () => {
  const t = ocTurnFailureReason("timeout 600000ms");
  assert.equal(t.timedOut, true);
  assert.match(t.detail, /teto de 10min do POST excedido/);
  // T-784: a run NÃO pode seguir no serve — o texto novo declara o abort…
  assert.match(t.detail, /sessão abortada no serve/);
  assert.doesNotMatch(t.detail, /run pode seguir no serve/);
  assert.match(t.detail, /timeout 600000ms/, "mensagem crua preservada para diagnóstico");

  const provider = ocTurnFailureReason("AI_APICallError: 429 rate limit");
  assert.equal(provider.timedOut, false);
  assert.equal(provider.detail, "AI_APICallError: 429 rate limit", "erro do provider não é reescrito");

  // …e o caminho REAL do retry cumpre o que o texto diz: abortSession ANTES
  // do re-enfileiramento (o POST estourado deixa a run viva no serve; sem
  // abort o retry dispara turno paralelo na mesma sessão).
  const aborts: string[] = [];
  const ordem: string[] = [];
  let retryEnfileirado = false;
  const self: any = {
    stopped: false,
    info: { id: "agent_t750" },
    opts: { log: (_l: string, m: string) => ordem.push(m), onError: () => {} },
    openCodeTransport: { ready: () => true, abortSession: async (sid: string) => { aborts.push(sid); } },
    messageSession: {
      busy: true, epoch: 7, sessionId: "sess-abc", needsPrime: false,
      owns: () => true,
      restoreFirstTurn: () => {},
      consumeFirstTurnIfNeeded: () => ({ firstTurn: false, pendingSummary: undefined }),
    },
    fetchOcCatalogLimit: () => {},
    traceCli: () => {},
    attachNonImageFiles: (content: string) => ({ content, cleanup: () => {} }),
    scheduleAttachmentCleanup: () => {},
    turnLatency: {
      enqueue: () => { retryEnfileirado = true; },
      activate: () => {},
    },
    ensureRunnerAvailable: () => true,
    runOpenCodeMessage: async () => { throw new Error("não deveria rodar o retry neste teste"); },
  };
  self.ocServeFetch = async () => { throw new Error("timeout 600000ms"); };
  await runOpenCodeMessageAttached(self, "msg", undefined, 0);
  self.stopped = true; // neutraliza o timer do retry agendado
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(aborts, ["sess-abc"], "sessão abortada no serve antes do retry");
  assert.ok(retryEnfileirado, "retry re-enfileirado depois do abort");
  assert.equal(self.messageSession.busy, true, "busy mantido para o turno de retry");
});

test("T-750: teto do POST acima do toolsHardMs do opencode (watchdog apanha travado, não o POST)", () => {
  const t = hangThresholds("opencode");
  assert.ok(
    OPENCODE_TURN_TIMEOUT_MS > t.toolsHardMs,
    `POST (${OPENCODE_TURN_TIMEOUT_MS / 60_000}min) tem de cobrir tool longa (${t.toolsHardMs / 60_000}min)`,
  );
  assert.equal(OPENCODE_TURN_TIMEOUT_MS, 30 * 60_000);
});