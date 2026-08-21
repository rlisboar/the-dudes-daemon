import { test } from "node:test";
import assert from "node:assert/strict";
import { aadV2, E2EE_TABLE, E2E_V2_PREFIX, isE2eV2, isE2eV1Rejected } from "./e2ee-fields.js";

test("aadV2: string canônica v2|projectId|table|field", () => {
  assert.equal(
    aadV2({ projectId: "p1", table: E2EE_TABLE.TASKS, field: "title" }),
    "v2|p1|tasks|title",
  );
  assert.throws(() => aadV2({ projectId: "", table: "tasks", field: "title" }));
});

test("prefixos de wire", () => {
  assert.equal(E2E_V2_PREFIX, "e2e:v2:");
  assert.equal(isE2eV2("e2e:v2:abc"), true);
  assert.equal(isE2eV2("e2e:abc"), false);
  assert.equal(isE2eV1Rejected("e2e:v1:abc"), true);
  assert.equal(isE2eV1Rejected("e2e:v2:abc"), false);
});

test("T-074 catalogPlainHits: recusa conteúdo em claro; e2e: passa", async () => {
  const { catalogPlainHits } = await import("./e2ee-fields.js");
  assert.deepEqual(catalogPlainHits("add_task", { task: { title: "claro" } }), ["task.title"]);
  assert.deepEqual(catalogPlainHits("add_task", { task: { title: "e2e:blob" } }), []);
  assert.deepEqual(catalogPlainHits("send", { content: "oi" }), ["message.content"]);
  assert.deepEqual(catalogPlainHits("send", { content: "e2e:v2:xx" }), []);
  assert.deepEqual(catalogPlainHits("user_to_agent", { content: "segredo" }), ["message.content"]);
  assert.ok(catalogPlainHits("memory_add", { title: "T", body: "B" }).includes("memory.title"));
  assert.deepEqual(catalogPlainHits("ping", { x: 1 }), []);
});
