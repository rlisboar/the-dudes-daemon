import { test } from "node:test";
import assert from "node:assert/strict";
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
