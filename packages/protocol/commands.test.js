import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandSchemas, DB_WRITE_COMMANDS, sanitizeCommandType, validateCommand } from "./commands.js";

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

test("T-1295: toggle de mensagens de membros tem schema Zod estrito", () => {
  assert.equal(validateCommand({ type: "set_agent_allow_member_messages", id: "a1", value: false }).ok, true);
  assert.equal(validateCommand({ type: "set_agent_allow_member_messages", id: "a1", value: "false" }).ok, false);
  assert.equal(validateCommand({ type: "set_agent_allow_member_messages", id: "a1", value: false, text: "surpresa" }).ok, false);
});

test("T-1305: pause/resume exigem apenas o id do agente", () => {
  for (const type of ["pause_agent", "resume_agent"]) {
    assert.equal(validateCommand({ type, id: "a1" }).ok, true);
    assert.equal(validateCommand({ type }).ok, false);
    assert.equal(validateCommand({ type, id: 42 }).ok, false);
    assert.equal(validateCommand({ type, id: "a1", userId: "forged" }).ok, false);
  }
});

test("T-1295: comandos do chat humano exigem ciphertext e shape estrito", () => {
  assert.equal(validateCommand({ type: "human_chat_send", contentCipher: "e2e:v2:blob" }).ok, true);
  assert.equal(validateCommand({ type: "human_chat_send", content: "plain text" }).ok, false);
  assert.equal(validateCommand({ type: "human_chat_send", contentCipher: "e2e:v2:blob", userId: "spoof" }).ok, false);
  assert.equal(validateCommand({ type: "human_chat_list", beforeId: "m1" }).ok, false);
  assert.equal(validateCommand({ type: "human_chat_list", beforeCreatedAt: "2026-01-01T00:00:00Z", beforeId: "m1" }).ok, true);
  assert.equal(validateCommand({ type: "human_chat_delete", id: "m1" }).ok, true);
  assert.equal(validateCommand({ type: "human_chat_mark_read" }).ok, true);
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

/**
 * T-1249: o `type` ecoado na mensagem de erro passa por `sanitizeCommandType`.
 * O envelope só limita o TAMANHO (1..100) — conteúdo é com este helper: C0/C1/
 * DEL, zero-width/bidi, NFC e espaço colapsado (o tipo é id, não parágrafo).
 */
test("T-1249: sanitizeCommandType limpa controle/bidi e colapsa espaço", () => {
  assert.equal(sanitizeCommandType("a\nb"), "a b");
  assert.equal(sanitizeCommandType("a\u0000b"), "ab");
  assert.equal(sanitizeCommandType("a\tb"), "a b");
  assert.equal(sanitizeCommandType("a\u200bb"), "ab");
  assert.equal(sanitizeCommandType("a\u202eb"), "ab");
  assert.equal(sanitizeCommandType("a\u007fb"), "ab");
  assert.equal(sanitizeCommandType("  a   b  "), "a b");
  // NFC: "cafe" + combining acute vira "café" composto
  assert.equal(sanitizeCommandType("cafe\u0301"), "café");
  // o erro do validateCommand usa o helper (senão o eco vaza controle)
  assert.match(validateCommand({ type: "x\ny\u200b" }).error, /^comando desconhecido: x y — sem schema/);
});

test("T-1249: validateCommand limita o eco de um tipo gigante fora do envelope", () => {
  const r = validateCommand({ type: "x".repeat(9000) });
  assert.equal(r.ok, false);
  assert.equal(r.error.length <= 150, true, `mensagem longa demais (${r.error.length})`);
  assert.equal(r.error, `comando desconhecido: ${"x".repeat(100)} — sem schema no protocolo`);
});

/**
 * T-1232: `kind` no summarize distingue o resumo de voz (`tts`) da sugestão de
 * resposta (`reply`) — quem usa é o daemon (sombra #3 do Jev). Aditivo: cliente
 * antigo não manda e continua válido; valor inventado morre no gate do server,
 * antes de gastar token do one-shot.
 */
test("T-1232: summarize aceita kind tts|reply, recusa inventado e tolera ausente", () => {
  const base = { type: "summarize", correlationId: "c1", runner: "claude", text: "oi" };
  assert.equal(validateCommand(base).ok, true, "sem kind = web antigo, segue válido");
  for (const kind of ["tts", "reply"]) {
    assert.equal(validateCommand({ ...base, kind }).ok, true, `${kind} é do contrato`);
  }
  for (const ruim of ["voz", "", "TTS", 1, null, true]) {
    assert.equal(validateCommand({ ...base, kind: ruim }).ok, false, `${JSON.stringify(ruim)} fora do contrato`);
  }

  // Nit da QA-A: `validateCommand` devolve só `{ok}` e o `cmd()` não é estrito —
  // um `kind` que SUMISSE do schema ainda passaria (chave desconhecida = strip).
  // Aqui o assert é no output do schema, provando que o campo é declarado.
  const parse = (f) => commandSchemas.summarize.safeParse(f);
  for (const kind of ["tts", "reply"]) {
    assert.equal(parse({ ...base, kind }).data.kind, kind, "o campo tem de SAIR do parse");
  }
  assert.equal("kind" in parse(base).data, false, "ausente segue ausente");
});

/**
 * T-1235: `jev:shadow-outcome` — o CLIENTE registra o desfecho da sombra de
 * voz/sugestão (o daemon só manda o veredito). A moldura é ESTREITA de
 * propósito: só o pareamento (refId = correlationId do summarize) e o booleano.
 * Payload folgado (texto junto) tem de ser recusado, não ignorado.
 */
test("T-1235: jev:shadow-outcome aceita o formato exato e recusa folga", () => {
  const bom = { type: "jev:shadow-outcome", projectId: "p1", source: "tts-summary", refId: "c1", outcome: { acted: false } };
  assert.equal(validateCommand(bom).ok, true);
  assert.equal(validateCommand({ ...bom, source: "reply-suggest" }).ok, true);

  // folga: campo extra no topo e dentro do outcome
  assert.equal(validateCommand({ ...bom, texto: "o resumo inteiro" }).ok, false, "texto no topo não entra");
  assert.equal(validateCommand({ ...bom, outcome: { acted: true, produced: true } }).ok, false, "campo extra no outcome");
  assert.equal(validateCommand({ ...bom, outcome: { acted: true, tokens: 10 } }).ok, false);
  // tipos e enums
  assert.equal(validateCommand({ ...bom, outcome: { acted: "true" } }).ok, false);
  assert.equal(validateCommand({ ...bom, source: "reflect" }).ok, false, "source fora das sombras de voz/sugestão");
  assert.equal(validateCommand({ ...bom, refId: 7 }).ok, false);
  assert.equal(validateCommand({ ...bom, outcome: {} }).ok, false, "acted é obrigatório");
  // T-1235 (decisão do PM): o CLIENTE não manda `ok` — quem carimba é o server,
  // para a linha passar no filtro da métrica (que descarta desfecho com ok falso).
  // Então `ok` no frame é campo EXTRA e tem de ser recusado, não ignorado.
  assert.equal(validateCommand({ ...bom, ok: true }).ok, false, "ok extra no frame do cliente");
  assert.equal(validateCommand({ ...bom, ok: false }).ok, false, "nem ok:false — quem decide é o server");

  // obrigatórios
  for (const campo of ["projectId", "source", "refId", "outcome"]) {
    const copia = { ...bom };
    delete copia[campo];
    assert.equal(validateCommand(copia).ok, false, `${campo} é obrigatório`);
  }
});
