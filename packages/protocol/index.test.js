import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_WIRE_MESSAGE_BYTES, parseWireMessage, validateWireMessage } from "./index.js";
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
