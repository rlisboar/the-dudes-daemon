import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandSchemas, DB_WRITE_COMMANDS, validateCommand } from "./commands.js";

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
  const reais = discriminantesDeClientCommand();
  const sem = DB_WRITE_COMMANDS.filter((n) => !(n in commandSchemas));
  assert.deepEqual(sem, [], `writer de DB sem schema: ${sem.join(", ")}`);
  const fora = DB_WRITE_COMMANDS.filter((n) => !reais.has(n));
  assert.deepEqual(fora, [], `DB_WRITE que não é ClientCommand: ${fora.join(", ")}`);
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

test("T-422 fail-closed: comando sem schema é recusado", () => {
  assert.equal(validateCommand({ type: "comando_que_nao_existe", x: 1 }).ok, false);
  const r = validateCommand({ type: "comando_que_nao_existe" });
  assert.match(r.error, /sem schema/);
  // `ping` saiu da lista de sem-schema na T-422.
  assert.equal(validateCommand({ type: "ping" }).ok, true);
});

test("T-422 opt-out explícito do canal daemon (até a T-423)", () => {
  assert.equal(validateCommand({ type: "daemon:hello", name: "d" }, { failClosed: false }).ok, true);
  assert.equal(validateCommand({ type: "comando_que_nao_existe" }, { failClosed: false }).ok, true);
  // Campo errado de um schema conhecido continua recusando mesmo no opt-out.
  assert.equal(validateCommand({ type: "remove_member", userId: 42 }, { failClosed: false }).ok, false);
});

test("T-422: os 44 cases que passavam por fora agora têm schema real", () => {
  const novas = [
    "write_file", "file_operation", "mcp:save", "mcp:delete", "skill:save_file", "skill:delete",
    "inject_chat_history", "permission:respond", "reveal_credential", "graph:reindex",
    "daemon:logs:get", "summarize", "compact_context", "clear_context", "read_file",
    "search_files", "git_log", "git_status", "git_diff", "git_stage", "git_commit",
    "list_files", "list_users", "list_templates", "list_goals", "list_missions", "list_plans",
    "request_skills_scan", "request_mcps_scan", "request_model_catalogs",
    "crypto:get_setup", "crypto:get_recovery_hash", "project_keys:get", "totp:status",
    "user_public_key:get", "daemon_public_key:get", "list_file_locks", "gitlab_test",
    "list_schedule_runs", "get_usage", "list_tts_summaries", "graph:get",
    "clear_context", "compact_context",
  ];
  const sem = novas.filter((n) => !(n in commandSchemas));
  assert.deepEqual(sem, [], `rota sem schema na T-422: ${sem.join(", ")}`);
  // Não é z.any(): campo obrigatório errado tem de recusar.
  assert.equal(validateCommand({ type: "write_file", path: "a", content: 1 }).ok, false);
  assert.equal(validateCommand({ type: "write_file", path: "a", content: "x" }).ok, true);
  assert.equal(validateCommand({ type: "file_operation", op: "tar", path: "a" }).ok, false);
  assert.equal(validateCommand({ type: "summarize", correlationId: "c", runner: "claude", text: "t" }).ok, true);
  assert.equal(validateCommand({ type: "permission:respond", requestId: "r", allow: "sim" }).ok, false);
});

test("campo extra não é rejeitado", () => {
  // Sem `.strict()` de propósito: durante deploy escalonado um cliente novo
  // manda campo que o server ainda não conhece, e barrar quebraria a sessão.
  assert.equal(validateCommand({ type: "remove_member", userId: "u1", futuro: true }).ok, true);
});

test("não confunde propriedade herdada de Object com schema", () => {
  // `commandSchemas[cmd.type]` sem hasOwnProperty devolveria a função pra
  // type="constructor" e estouraria no safeParse. Com fail-closed (T-422)
  // esses types não têm schema e são recusados — nunca chegam ao safeParse.
  assert.equal(validateCommand({ type: "constructor" }).ok, false);
  assert.equal(validateCommand({ type: "toString" }).ok, false);
  assert.equal(validateCommand({ type: "__proto__" }).ok, false);
});

test("a mensagem de erro aponta o campo", () => {
  const r = validateCommand({ type: "add_task", task: { title: 1 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /task\.title/);
});
