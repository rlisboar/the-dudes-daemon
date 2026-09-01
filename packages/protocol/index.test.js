import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_WIRE_MESSAGE_BYTES,
  WireMessageTooLargeError,
  base64WireCost,
  parseWireMessage,
  validateWireMessage,
} from "./index.js";
import * as node from "./index.js";
import * as browser from "./index.browser.js";
import { parseWireMessage as parseBrowserWireMessage } from "./index.browser.js";

test("parseWireMessage accepts a valid discriminated object", () => {
  assert.deepEqual(parseWireMessage('{"type":"ping","n":1}'), { type: "ping", n: 1 });
});

test("parseWireMessage rejects arrays, null and invalid discriminators", () => {
  for (const raw of ["[]", "null", "{}", JSON.stringify({ type: "x".repeat(101) })]) {
    assert.throws(() => parseWireMessage(raw));
  }
});

test("parseWireMessage enforces allowlist and frame size", () => {
  assert.throws(() => parseWireMessage('{"type":"unknown"}', { allowedTypes: new Set(["ping"]) }), /unsupported/);
  assert.throws(() => parseWireMessage('{"type":"ping"}', { maxBytes: 4 }), /exceeds/);
  assert.ok(MAX_WIRE_MESSAGE_BYTES >= 1024);
});

test("validateWireMessage validates decoded browser payloads", () => {
  assert.equal(validateWireMessage({ type: "pong" }).type, "pong");
  assert.throws(() => validateWireMessage("pong"));
});

test("browser entry applies the same envelope and size rules without Zod", () => {
  assert.deepEqual(parseBrowserWireMessage('{"type":"ping","n":1}'), { type: "ping", n: 1 });
  assert.throws(() => parseBrowserWireMessage("[]"));
  assert.throws(() => parseBrowserWireMessage('{"type":"ping"}', { maxBytes: 4 }), /exceeds/);
});

/* ---------- orçamento de tamanho do canal ----------
 * Estes testes existem porque os tetos das camadas já divergiram uma vez
 * (cliente 20MB / frame 32MB / parser 8MB) e o resultado foi mensagem com
 * anexo sumindo sem erro. Se alguém mexer num número sem mexer nos outros,
 * a falha aparece aqui e não em produção. */

test("o orçamento de anexos cabe no frame dos dois canais", () => {
  const pior = base64WireCost(node.MAX_ATTACHMENTS_TOTAL_BYTES) + node.WIRE_ENVELOPE_HEADROOM_BYTES;
  assert.ok(
    pior <= node.MAX_WIRE_MESSAGE_BYTES,
    `anexos no fio (${pior}) não cabem no frame web↔orch (${node.MAX_WIRE_MESSAGE_BYTES})`,
  );
  assert.ok(
    pior <= node.MAX_DAEMON_WIRE_MESSAGE_BYTES,
    `anexos no fio (${pior}) não cabem no frame orch↔daemon (${node.MAX_DAEMON_WIRE_MESSAGE_BYTES})`,
  );
});

test("um anexo sozinho nunca estoura o orçamento total", () => {
  assert.ok(node.MAX_ATTACHMENT_BYTES <= node.MAX_ATTACHMENTS_TOTAL_BYTES);
});

test("entrada node e browser declaram o mesmo orçamento", () => {
  for (const k of [
    "MAX_WIRE_MESSAGE_BYTES",
    "MAX_DAEMON_WIRE_MESSAGE_BYTES",
    "MAX_ATTACHMENT_BYTES",
    "MAX_ATTACHMENTS_TOTAL_BYTES",
    "WIRE_ENVELOPE_HEADROOM_BYTES",
  ]) {
    assert.equal(browser[k], node[k], `${k} divergiu entre index.js e index.browser.js`);
  }
});

test("base64WireCost modela a expansão de 4/3", () => {
  assert.equal(base64WireCost(3), 4);
  assert.equal(base64WireCost(1), 4); // padding
  assert.ok(base64WireCost(1_000_000) > 1_000_000);
});

test("estouro de tamanho é distinguível de JSON malformado", () => {
  for (const parse of [parseWireMessage, parseBrowserWireMessage]) {
    assert.throws(
      () => parse('{"type":"ping"}', { maxBytes: 4 }),
      (e) => e instanceof WireMessageTooLargeError || e.name === "WireMessageTooLargeError",
    );
    // JSON quebrado NÃO pode virar WireMessageTooLargeError — o caller usa
    // essa distinção pra decidir entre "avisa o usuário" e "descarta".
    assert.throws(() => parse("{nao é json"), (e) => e.name !== "WireMessageTooLargeError");
  }
});

/* ---------- T-187: catálogo único de runners ---------- */

test("catálogo de runners: 7 runners, valores únicos, incluindo grok-custom", () => {
  assert.equal(node.RUNNER_CATALOG.length, 7);
  const values = node.RUNNER_CATALOG.map((r) => r.value);
  assert.equal(new Set(values).size, values.length, "valores duplicados no catálogo");
  for (const value of values) assert.equal(typeof value, "string");
  assert.ok(values.includes("grok-custom"), "grok-custom esquecido de novo?");
  // cada entry tem label não-vazio
  for (const entry of node.RUNNER_CATALOG) {
    assert.equal(typeof entry.label, "string");
    assert.ok(entry.label.length > 0);
  }
});

test("RUNNERS deriva do catálogo na mesma ordem", () => {
  assert.deepEqual([...node.RUNNERS], node.RUNNER_CATALOG.map((r) => r.value));
});

test("isKnownCliRunner aceita os do catálogo e rejeita o resto", () => {
  for (const value of node.RUNNERS) assert.equal(node.isKnownCliRunner(value), true);
  for (const bad of [undefined, null, "", "Claude", "cursor", "aider", ["claude"], 42]) {
    assert.equal(node.isKnownCliRunner(bad), false, `deveria rejeitar ${JSON.stringify(bad)}`);
  }
});

test("parity: CliRunner no index.d.ts cobre exatamente o catálogo", () => {
  // Se este teste falhou, alguém adicionou runner só no .d.ts (ou só no
  // catálogo). A fonte única vale pros DOIS lados — atualize os dois (é a
  // mesma linha) ou, melhor, use RUNNER_CATALOG como fonte e derive o tipo.
  const dts = readFileSync(new URL("./index.d.ts", import.meta.url), "utf8");
  const match = dts.match(/export type CliRunner = ([^;]+);/);
  assert.ok(match, "declaração de CliRunner não encontrada em index.d.ts");
  const typeValues = match[1].split("|").map((s) => s.trim().replaceAll('"', ""));
  assert.deepEqual(typeValues, [...node.RUNNERS]);

  // RUNNERS é tupla literal no .d.ts (z.enum e Record no server/daemon
  // dependem disso) — os elementos da tupla também têm que cobrir o catálogo.
  const tuple = dts.match(/export declare const RUNNERS: readonly \[([^\]]+)\];/);
  assert.ok(tuple, "tupla literal de RUNNERS não encontrada em index.d.ts");
  const tupleValues = tuple[1].split(",").map((s) => s.trim().replaceAll('"', ""));
  assert.deepEqual(tupleValues, [...node.RUNNERS]);
});
