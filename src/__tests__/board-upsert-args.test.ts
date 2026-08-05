/**
 * T-024: content → body no caminho do bridge (board_upsert_block).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBoardUpsertArgs } from "../board-upsert-args.js";
import { encryptBridgePayload } from "../bridge-relay.js";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";

test("content sozinho vira body; content some do payload", () => {
  const html = "<html><body><h1>T-024</h1></body></html>";
  const out = normalizeBoardUpsertArgs({
    id: "page",
    kind: "html",
    content: html,
  });
  assert.equal(out.body, html, "content deve preencher body pro server");
  assert.equal(out.content, undefined, "content não deve seguir no payload");
  assert.equal(out.kind, "html");
  assert.equal(out.id, "page");
});

test("body direto permanece (não exige content)", () => {
  const out = normalizeBoardUpsertArgs({
    id: "page",
    kind: "html",
    body: "hello",
  });
  assert.equal(out.body, "hello");
  assert.equal(out.content, undefined);
});

test("body vence content quando ambos vêm", () => {
  const out = normalizeBoardUpsertArgs({
    kind: "html",
    body: "oficial",
    content: "alias",
  });
  assert.equal(out.body, "oficial");
  assert.equal(out.content, undefined);
});

test("sem body nem content: payload sem body (server fail-loud)", () => {
  const out = normalizeBoardUpsertArgs({ id: "x", kind: "html", title: "t" });
  assert.equal(out.body, undefined);
  assert.equal(out.content, undefined);
  assert.equal(out.title, "t");
});

// E2EE: content normalizado vira body cifrado no relay (caminho bridge real)
process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(
  os.tmpdir(),
  `td-t024-key-${process.pid}-${Date.now()}.pem`,
);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(
  os.tmpdir(),
  `td-t024-pkeys-${process.pid}-${Date.now()}.json`,
);

const { getDaemonPublicKey, rememberProjectKey, decryptForProject } = await import("../daemon-crypto.js");
const PID = "proj-t024";
{
  const aes = randomBytes(32);
  const pub = createPublicKey({
    key: Buffer.from(getDaemonPublicKey(), "base64"),
    format: "der",
    type: "spki",
  });
  const wrapped = publicEncrypt(
    { key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
    aes,
  );
  rememberProjectKey(PID, wrapped.toString("base64"));
}

test("caminho bridge: content → body → E2EE cifra body (server recebe body cifrado)", () => {
  const html = "<html><body>conteudo do quadro</body></html>";
  // 1) mcp-bridge normaliza
  const payload = normalizeBoardUpsertArgs({
    id: "page",
    kind: "html",
    content: html,
  });
  assert.equal(payload.body, html);
  // 2) relay cifra como board (mesmo path do socket)
  const cifrado = encryptBridgePayload("board", { ...payload }, PID);
  assert.equal(cifrado.content, undefined);
  assert.ok(typeof cifrado.body === "string" && String(cifrado.body).startsWith("e2e:"));
  assert.equal(decryptForProject(cifrado.body as string, PID), html);
});

test("relay sozinho: content cru vira body cifrado (defesa em profundidade)", () => {
  const html = "<p>cru</p>";
  const cifrado = encryptBridgePayload("board", { kind: "html", content: html }, PID);
  assert.equal(cifrado.content, undefined);
  assert.ok(typeof cifrado.body === "string" && String(cifrado.body).startsWith("e2e:"));
  assert.equal(decryptForProject(cifrado.body as string, PID), html);
});
