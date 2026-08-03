import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandSchemas, validateCommand } from "./commands.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const wire = readFileSync(resolve(root, "packages/protocol/wire.d.ts"), "utf8");

function discriminantesDeClientCommand() {
  const from = wire.indexOf("export type ClientCommand");
  assert.notEqual(from, -1);
  return new Set(
    [...wire.slice(from).matchAll(/type:\s*"([^"]+)"/g)].map((m) => m[1]),
  );
}

test("todo schema registrado corresponde a um comando real", () => {
  // Pega schema escrito com nome errado — validaria nada e daria falsa
  // sensação de cobertura.
  const reais = discriminantesDeClientCommand();
  const fantasmas = Object.keys(commandSchemas).filter((n) => !reais.has(n));
  assert.deepEqual(fantasmas, [], `schemas sem comando correspondente: ${fantasmas.join(", ")}`);
});

test("as famílias de risco estão cobertas", () => {
  // Comando novo de escrita em DB ou de authz tem que entrar deliberadamente.
  // Se este teste quebrar: registre o schema, não relaxe o prefixo.
  const reais = discriminantesDeClientCommand();
  const risco = [...reais].filter((n) =>
    n.startsWith("admin:") ||
    /^(add|update|remove)_member$/.test(n) ||
    /^(create|update|delete)_project$/.test(n),
  );
  const sem = risco.filter((n) => !(n in commandSchemas));
  assert.deepEqual(sem, [], `comandos de risco sem schema: ${sem.join(", ")}`);
});

test("aceita payload correto", () => {
  assert.equal(validateCommand({ type: "add_member", email: "a@b.com", role: "admin" }).ok, true);
  assert.equal(validateCommand({ type: "add_task", task: { title: "x" } }).ok, true);
  assert.equal(validateCommand({ type: "update_task", id: "t1", patch: { status: "done" } }).ok, true);
  assert.equal(validateCommand({ type: "admin:set_disabled", userId: "u1", value: true }).ok, true);
});

test("rejeita exatamente o que passava batido antes", () => {
  // Este é o payload do exemplo: tipos errados chegavam inteiros no handler.
  const r = validateCommand({ type: "add_member", email: {}, role: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /add_member/);

  assert.equal(validateCommand({ type: "add_member", email: "a@b.com", role: "root" }).ok, false);
  assert.equal(validateCommand({ type: "remove_member", userId: 42 }).ok, false);
  assert.equal(validateCommand({ type: "add_task", task: { title: 123 } }).ok, false);
  assert.equal(validateCommand({ type: "add_task", task: {} }).ok, false);
  assert.equal(validateCommand({ type: "update_task", id: "t", patch: { status: "invalido" } }).ok, false);
  assert.equal(validateCommand({ type: "admin:set_super_admin", userId: "u", value: "sim" }).ok, false);
  assert.equal(validateCommand({ type: "update_task", id: "t", patch: { labels: "nao-é-array" } }).ok, false);
});

test("comando sem schema passa — cobertura é allowlist progressivo", () => {
  assert.equal(validateCommand({ type: "ping" }).ok, true);
  assert.equal(validateCommand({ type: "comando_que_nao_existe", x: 1 }).ok, true);
});

test("campo extra não é rejeitado", () => {
  // Sem `.strict()` de propósito: durante deploy escalonado um cliente novo
  // manda campo que o server ainda não conhece, e barrar quebraria a sessão.
  assert.equal(validateCommand({ type: "remove_member", userId: "u1", futuro: true }).ok, true);
});

test("não confunde propriedade herdada de Object com schema", () => {
  // `commandSchemas[cmd.type]` sem hasOwnProperty devolveria a função pra
  // type="constructor" e estouraria no safeParse.
  assert.equal(validateCommand({ type: "constructor" }).ok, true);
  assert.equal(validateCommand({ type: "toString" }).ok, true);
  assert.equal(validateCommand({ type: "__proto__" }).ok, true);
});

test("a mensagem de erro aponta o campo", () => {
  const r = validateCommand({ type: "add_task", task: { title: 1 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /task\.title/);
});
