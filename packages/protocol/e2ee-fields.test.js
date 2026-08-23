import { test } from "node:test";
import assert from "node:assert/strict";
import { aadV2, aadReadChain, AAD_READ_FALLBACK, E2EE_TABLE, E2E_V2_PREFIX, isE2eV2, isE2eV1Rejected } from "./e2ee-fields.js";

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

test("T-083 catalogPlainHits: plan/mission/schedule kinds recusam claro", async () => {
  const { catalogPlainHits } = await import("./e2ee-fields.js");
  assert.ok(catalogPlainHits("create_plan", { plan: { title: "P" } }).includes("plan.title"));
  assert.ok(catalogPlainHits("plans_create", { title: "P", tasks: [{ title: "T", prompt: "do" }] }).includes("plan_task.prompt"));
  assert.deepEqual(catalogPlainHits("plans_create", { title: "e2e:v2:x" }), []);
  assert.ok(catalogPlainHits("update_plan", { patch: { description: "d" } }).includes("plan.description"));
  assert.ok(catalogPlainHits("apply_plan_tasks", { tasks: [{ title: "claro" }] }).includes("plan_task.title"));
  assert.ok(catalogPlainHits("plans_apply_tasks", { tasks: [{ prompt: "p" }] }).includes("plan_task.prompt"));
  assert.ok(catalogPlainHits("add_plan_task", { title: "n" }).includes("plan_task.title"));
  assert.ok(catalogPlainHits("plans_add_task", { task: { title: "n" } }).includes("plan_task.title"));
  assert.ok(catalogPlainHits("update_plan_task", { patch: { prompt: "x" } }).includes("plan_task.prompt"));
  assert.ok(catalogPlainHits("apply_plan_steps", { steps: [{ title: "s", prompt: "go" }] }).includes("mission_step.prompt"));
  assert.ok(catalogPlainHits("create_mission", { mission: { title: "M", steps: [{ title: "s", prompt: "go" }] } }).includes("mission_step.prompt"));
  assert.ok(catalogPlainHits("update_mission", { patch: { title: "M" } }).includes("mission.title"));
  assert.ok(catalogPlainHits("add_mission_step", { step: { title: "s", prompt: "p" } }).includes("mission_step.title"));
  assert.ok(catalogPlainHits("update_mission_step", { patch: { prompt: "p" } }).includes("mission_step.prompt"));
  assert.ok(catalogPlainHits("add_schedule", { schedule: { title: "s", prompt: "run" } }).includes("schedule.prompt"));
  assert.ok(catalogPlainHits("update_schedule", { patch: { prompt: "x" } }).includes("schedule.prompt"));
  assert.deepEqual(catalogPlainHits("start_plan", { id: "x" }), []);
  assert.deepEqual(catalogPlainHits("plans_start", { id: "x" }), []);
});

test("T-083 AAD_READ_FALLBACK: exatamente 4 pares; destino primeiro", () => {
  assert.equal(AAD_READ_FALLBACK.length, 4);
  assert.deepEqual(
    AAD_READ_FALLBACK.map((p) => `${p.destTable}.${p.destField}->${p.sourceTable}.${p.sourceField}`),
    [
      "missions.title->plans.title",
      "missions.description->plans.description",
      "mission_steps.title->tasks.title",
      "mission_steps.prompt->tasks.description",
    ],
  );
  const chain = aadReadChain({ projectId: "p", table: E2EE_TABLE.MISSIONS, field: "title" });
  assert.deepEqual(chain, [
    aadV2({ projectId: "p", table: E2EE_TABLE.MISSIONS, field: "title" }),
    aadV2({ projectId: "p", table: E2EE_TABLE.PLANS, field: "title" }),
  ]);
  assert.deepEqual(
    aadReadChain({ projectId: "p", table: E2EE_TABLE.MISSIONS, field: "description" }),
    [
      aadV2({ projectId: "p", table: E2EE_TABLE.MISSIONS, field: "description" }),
      aadV2({ projectId: "p", table: E2EE_TABLE.PLANS, field: "description" }),
    ],
  );
  assert.deepEqual(
    aadReadChain({ projectId: "p", table: E2EE_TABLE.GOALS, field: "title" }),
    [aadV2({ projectId: "p", table: E2EE_TABLE.GOALS, field: "title" })],
  );
});
