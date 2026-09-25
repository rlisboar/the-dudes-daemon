/**
 * T-1063 (reprovação do QA-A no #1060): o driver ACP do grok não pode travar
 * quando o `session/load` falha.
 *
 * Repro original: com sessão antiga e `loadSession` anunciado, um load que
 * reprova (sessão expurgada — o caso clássico pós-restart) deixava o cliente
 * VIVO e SEM sessão. No turno seguinte o handshake era pulado, `prometer()`
 * reprovava com "acp: sem sessão" e isso se repetia para SEMPRE (o
 * `resetForRetry` não recria cliente).
 *
 * Desde a T-1072 este arquivo usa o harness compartilhado (`_grok-acp-harness`),
 * com modo/log em diretório único por execução — nada de caminho fixo em /tmp.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { asAny, comFlagAcp, harnessAcp, until } from "./_grok-acp-harness.js";

test("T-1063: session/load que FALHA cai para sessão nova e não trava o turno seguinte", async (t) => {
  comFlagAcp(t);
  const h = harnessAcp({ falha: "load" });
  t.after(() => h.runner.stop());
  asAny(h.runner).messageSession.sessionId = "sessao-antiga";

  h.runner.pushUserMessage("primeiro");
  await until(() => h.textos.length > 0, 45_000, "turno 1 (com load reprovado)");
  assert.match(h.textos[0]!, /ECO:primeiro/, "o turno COMPLETA mesmo com o load reprovado");
  assert.equal(asAny(h.runner).messageSession.sessionId, "sessao-nova-1", "segue com a sessão NOVA do fallback");
  assert.equal(h.sessoes[h.sessoes.length - 1], "sessao-nova-1", "o server aprende a sessão nova (onSessionId)");
  assert.notEqual(asAny(h.runner).info.sessionId, "sessao-antiga", "o id velho não fica no info (esquecido no fallback)");

  const apos1 = h.lerLog().map((l) => l.method);
  assert.equal(apos1.filter((m) => m === "session/load").length, 1, "tentou o load UMA vez");
  assert.equal(apos1.filter((m) => m === "session/new").length, 1, "e abriu sessão nova no mesmo turno");

  h.runner.pushUserMessage("segundo");
  await until(() => h.textos.length > 1, 45_000, "turno 2");
  const apos2 = h.lerLog().map((l) => l.method);
  assert.equal(apos2.filter((m) => m === "session/load").length, 1, "o turno 2 NÃO repete o load que falha");
  assert.equal(apos2.filter((m) => m === "session/prompt").length, 2, "os dois turnos rodaram no MESMO processo");
  assert.equal(apos2.filter((m) => m === "initialize").length, 1, "um handshake só");
});

test("T-1063: initialize que falha descarta o cliente e o turno seguinte refaz o handshake", async (t) => {
  comFlagAcp(t);
  const h = harnessAcp({ falha: "initialize" });
  t.after(() => h.runner.stop());

  h.runner.pushUserMessage("primeiro");
  await until(() => h.erros.length > 0, 25_000, "erro do initialize"); // T-1157: startup sob concorrência
  await until(() => asAny(h.runner).grokAcp === null, 30_000, "cliente descartado");
  assert.equal(h.textos.length, 0, "sem texto no turno que falhou no handshake");
  assert.equal(asAny(h.runner).ocActiveProc, null, "sem proc pendurado no runner");

  // Segunda tentativa: o fake agora responde o handshake.
  h.modo({ falha: "" });
  h.runner.pushUserMessage("segundo");
  await until(() => h.textos.some((txt) => /ECO:/.test(txt)), 45_000, "resposta após o cliente ser descartado");
  const metodos = h.lerLog().map((l) => l.method);
  assert.ok(metodos.filter((m) => m === "initialize").length >= 2, "o handshake foi REFEITO (era o travamento)");
  assert.ok(asAny(h.runner).grokAcp, "cliente novo vivo");
});
