/**
 * T-1072 (nit do QA-A no #1067): o ramo `caps.resume` — peer que anuncia SÓ
 * `sessionCapabilities.resume` — não tinha teste versionado (o QA-A provou por
 * probe). Aqui ele fica travado: com sessão antiga, o driver usa
 * `session/resume` e NUNCA `session/load` (que, para esse peer, nem existe).
 *
 * Também trava o caminho do fake fora de `/tmp` fixo: o modo/log ficam num
 * diretório único por execução (`tmpdir()` do `@the-dudes/test-utils`), passado
 * ao CLI pelo allowlist de env do runner.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { asAny, comFlagAcp, harnessAcp, until } from "./_grok-acp-harness.js";

test("T-1072: peer que só anuncia `resume` usa session/resume e nunca session/load", async (t) => {
  comFlagAcp(t);
  const h = harnessAcp({ caps: "resume" });
  t.after(() => h.runner.stop());
  asAny(h.runner).messageSession.sessionId = "sessao-antiga";

  h.runner.pushUserMessage("primeiro");
  await until(() => h.textos.length > 0, 8_000, "turno com resume");

  const metodos = h.lerLog().map((l) => l.method);
  assert.equal(metodos.filter((m) => m === "session/resume").length, 1, "retomou pelo método do peer");
  assert.equal(metodos.filter((m) => m === "session/load").length, 0, "…e não tentou `load` (inexistente nele)");
  assert.equal(metodos.filter((m) => m === "session/new").length, 0, "não abriu sessão nova");
  assert.equal(asAny(h.runner).messageSession.sessionId, "sessao-antiga", "manteve a MESMA sessão (é o ponto do resume)");
  assert.equal(h.erros.length, 0, "sem erro de método inexistente");

  // 2º turno no mesmo processo: nada de handshake de novo.
  h.runner.pushUserMessage("segundo");
  await until(() => h.textos.length > 1, 8_000, "2º turno");
  const depois = h.lerLog().map((l) => l.method);
  assert.equal(depois.filter((m) => m === "initialize").length, 1, "um handshake só");
  assert.equal(depois.filter((m) => m === "session/resume").length, 1, "um resume só");
});

test("T-1072: o modo/log do fake vivem em diretório único por execução", async (t) => {
  comFlagAcp(t);
  const h = harnessAcp({ caps: "resume" });
  t.after(() => h.runner.stop());
  // Sem caminho fixo em /tmp: o arquivo de modo está DENTRO do dir do harness.
  assert.ok(h.dir.length > 0);
  assert.equal(h.lerLog().length, 0, "log começa vazio (nada de arquivo compartilhado de outra execução)");
  asAny(h.runner).messageSession.sessionId = "sessao-antiga";
  h.runner.pushUserMessage("primeiro");
  await until(() => h.lerLog().length > 0, 8_000, "fake registrou no log do PRÓPRIO dir");
  assert.ok(h.lerLog().some((l) => l.method === "initialize"), "o log é o do dir deste harness");
});