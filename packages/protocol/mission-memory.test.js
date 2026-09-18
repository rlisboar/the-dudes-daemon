/**
 * T-594: interpolação de `{{mem.NAME}}` — a definição ÚNICA usada pelo server
 * (caminho em claro) e pelo daemon (caminho cifrado). O que se testa aqui é o
 * contrato de substituição; a paridade entre os dois caminhos é medida no
 * server (t594-step-mem-interp) e no daemon (t594-agent-send-mem).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMemPlaceholder, interpolateMissionMemory } from "./mission-memory.js";

test("substitui a chave presente e acha a variante com espaços", () => {
  assert.equal(interpolateMissionMemory("usar {{mem.RESULTADO}} agora", { RESULTADO: "ok" }), "usar ok agora");
  assert.equal(interpolateMissionMemory("usar {{ mem.RESULTADO }} agora", { RESULTADO: "ok" }), "usar ok agora");
  assert.equal(interpolateMissionMemory("{{mem.a_b1}}", { a_b1: "x" }), "x");
});

test("chave ausente resolve para string vazia (não deixa o placeholder)", () => {
  const out = interpolateMissionMemory("antes {{mem.NAO_EXISTE}} depois", { OUTRA: "x" });
  assert.equal(out, "antes  depois");
  assert.ok(!hasMemPlaceholder(out));
});

test("valor não-string vira string vazia; valor string é usado cru", () => {
  assert.equal(interpolateMissionMemory("[{{mem.N}}]", { N: 42 }), "[]");
  assert.equal(interpolateMissionMemory("[{{mem.N}}]", { N: "" }), "[]");
  assert.equal(interpolateMissionMemory("[{{mem.N}}]", { N: "com {{mem.M}}" }), "[com {{mem.M}}]");
});

test("passada única: valor com placeholder não é reexpandido", () => {
  const out = interpolateMissionMemory("{{mem.A}}", { A: "{{mem.B}}", B: "fundo" });
  assert.equal(out, "{{mem.B}}");
});

test("mem ausente/nulo devolve o texto intacto (o daemon só interpola se o campo vier)", () => {
  assert.equal(interpolateMissionMemory("{{mem.X}}", undefined), "{{mem.X}}");
  assert.equal(interpolateMissionMemory("{{mem.X}}", null), "{{mem.X}}");
  assert.equal(interpolateMissionMemory("{{mem.X}}", {}), "");
});

test("sem placeholder o texto passa byte a byte", () => {
  const t = "Passo 1: nada aqui.\n\n<<<STEP_COMPLETE>>>";
  assert.equal(interpolateMissionMemory(t, { X: "y" }), t);
  assert.equal(hasMemPlaceholder(t), false);
});

test("regex não é global-compartilhado (lastIndex não vaza entre chamadas)", () => {
  const mem = { X: "1" };
  assert.equal(interpolateMissionMemory("{{mem.X}} e {{mem.X}}", mem), "1 e 1");
  assert.equal(interpolateMissionMemory("{{mem.X}} e {{mem.X}}", mem), "1 e 1");
  assert.equal(hasMemPlaceholder("{{mem.X}}"), true);
  assert.equal(hasMemPlaceholder("{{mem.X}}"), true);
});

test("não casa `{{mem.}}` vazio nem chave com ponto", () => {
  assert.equal(interpolateMissionMemory("{{mem.}}", { "": "v" }), "{{mem.}}");
  assert.equal(interpolateMissionMemory("{{mem.A.B}}", { "A.B": "v" }), "{{mem.A.B}}");
});