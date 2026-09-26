import assert from "node:assert/strict";
import test from "node:test";

import { mergeQueueDeliveryPayload } from "../runners/queue-delivery.js";

test("T-1306: payload válido conserva content/images/identidade externos e o mesmo deliveryId", () => {
  const images = [{ mimeType: "image/png", base64: "AA==" }];
  const merged = mergeQueueDeliveryPayload({
    id: "queue-row-1",
    content: "outer content",
    images,
    deliveryId: "delivery-1",
    from: { type: "user", id: "member-1", name: "Ana" },
    isAgentOwner: false,
    payload: {
      deliveryId: "delivery-1",
      systemPrefix: "[prefix] ",
      systemSuffix: " [suffix]",
      origin: "system",
      silent: true,
    },
  });

  assert.equal(merged.id, "queue-row-1");
  assert.equal(merged.deliveryId, "delivery-1");
  assert.equal(merged.content, "outer content");
  assert.equal(merged.images, images);
  assert.equal(merged.payload?.systemPrefix, "[prefix] ");
  assert.equal(merged.payload?.origin, "system");
  assert.deepEqual(merged.from, { type: "user", id: "member-1", name: "Ana" });
  assert.equal(merged.isAgentOwner, false);
});

test("T-1306: payload ausente, inválido, com deliveryId divergente ou autoria forjada cai para content-only", () => {
  const base = { id: "queue-row-2", content: "safe outer content", deliveryId: "delivery-2" };
  const absent = mergeQueueDeliveryPayload(base);
  assert.equal(absent.content, base.content);
  assert.equal(absent.payload, undefined);
  assert.equal(absent.deliveryId, base.deliveryId);

  for (const payload of [
    { deliveryId: "delivery-2", systemPrefix: 42 },
    { deliveryId: "other-delivery", systemPrefix: "must not apply" },
  ]) {
    const merged = mergeQueueDeliveryPayload({
      ...base,
      images: [{ mimeType: "image/jpeg", base64: "AQ==" }],
      from: { type: "user", id: "member-1", name: "Ana" },
      isAgentOwner: false,
      payload,
    });
    assert.equal(merged.content, base.content);
    assert.equal(merged.payload, undefined);
    assert.equal(merged.deliveryId, base.deliveryId);
    assert.equal(merged.images?.length, 1);
    assert.equal(merged.isAgentOwner, false);
    assert.equal(merged.from?.id, "member-1");
  }
});

test("T-1306: payload deliveryId é preservado se o item externo tem só o id da linha", () => {
  const merged = mergeQueueDeliveryPayload({
    id: "queue-row-3",
    content: "outer",
    payload: { deliveryId: "delivery-from-payload", taskId: "task-3" },
  });
  assert.equal(merged.deliveryId, "delivery-from-payload");
  assert.equal(merged.payload?.taskId, "task-3");
});

test("T-1306 P3: from/isAgentOwner forjados no payload são ignorados com log e as parts continuam", () => {
  const linhas: Array<[string, string]> = [];
  const merged = mergeQueueDeliveryPayload({
    id: "queue-row-4",
    content: "outer",
    deliveryId: "delivery-4",
    from: { type: "agent", id: "owner-1" },
    isAgentOwner: true,
    payload: {
      deliveryId: "delivery-4",
      from: { type: "user", id: "forged" },
      isAgentOwner: false,
      parts: [{ kind: "plain", text: "corpo retido" }],
      taskId: "task-4",
    },
  }, { log: (level, message) => linhas.push([level, message]) });

  // autoria SEMPRE do frame externo, nunca do payload
  assert.deepEqual(merged.from, { type: "agent", id: "owner-1" });
  assert.equal(merged.isAgentOwner, true);
  // e o resto do payload sobrevive (antes, a chave fora da allowlist derrubava tudo)
  assert.equal(merged.payload?.parts?.length, 1);
  assert.equal(merged.payload?.taskId, "task-4");
  assert.deepEqual(
    linhas.map(([level, message]) => [level, /from/.test(message), /isAgentOwner/.test(message)]),
    [["warn", true, false], ["warn", false, true]],
    JSON.stringify(linhas),
  );
  // o log traz só o NOME da chave, sem o valor
  for (const [, message] of linhas) {
    assert.equal(/owner-1|forged|true|false/.test(message), false, message);
  }
});

test("T-1306 P3: chave desconhecida é ignorada com log e o restante do payload se mantém", () => {
  const linhas: string[] = [];
  const merged = mergeQueueDeliveryPayload({
    id: "queue-row-5",
    content: "outer",
    deliveryId: "delivery-5",
    payload: { deliveryId: "delivery-5", origemNova: 1, silent: true },
  }, { log: (level, message) => linhas.push(`${level}:${message}`) });

  assert.equal(merged.payload?.silent, true);
  assert.equal(linhas.length, 1, JSON.stringify(linhas));
  assert.match(linhas[0]!, /^info:/);
  assert.match(linhas[0]!, /origemNova/);
  assert.equal(linhas[0]!.includes("1"), false, "valor não entra no log");
});
