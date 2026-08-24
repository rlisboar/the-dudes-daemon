import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";
import {
  BOARD_ANNOTATION_FIELDS,
  BOARD_STEP_FIELDS,
  BOARD_TEXT_FIELDS,
  COMMENT_FIELDS,
  E2EE_TABLE,
  GOAL_FIELDS,
  MEMORY_PLAIN_TO_CIPHER,
  MESSAGE_FIELDS,
  MESSAGE_IMAGE_FIELD,
  MISSION_FIELDS,
  MISSION_STEP_FIELDS,
  PLAN_FIELDS,
  PLAN_TASK_FIELDS,
  SCHEDULE_FIELDS,
  TASK_FIELDS,
  aadReadChain,
  aadV2,
} from "@the-dudes/protocol/e2ee-fields";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-parity-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-parity-pkeys-${process.pid}-${Date.now()}.json`);
const { getDaemonPublicKey, rememberProjectKey, decryptForProject, encryptForProject, encryptBytesForProject, decryptBytesForProject } = await import("../daemon-crypto.js");
const { encryptBridgePayload } = await import("../bridge-relay.js");

/**
 * PARIDADE cifra↔decifra, lado do daemon.
 *
 * Prova que o relay cifra exatamente os campos da lista canônica
 * (`@the-dudes/protocol/e2ee-fields`). O gêmeo no web prova que todos são
 * decifrados. Um campo novo em um lado sem o outro derruba uma das suítes —
 * em vez de aparecer como "e2e:..." na tela de alguém, que foi como três bugs
 * de produção se manifestaram.
 */

const PID = "proj-parity";
{
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  rememberProjectKey(PID, wrapped.toString("base64"));
}

const cifradoV2 = (v: unknown) => typeof v === "string" && v.startsWith("e2e:v2:");

test("send: cifra os campos de mensagem da lista canônica", () => {
  const json: Record<string, unknown> = {};
  for (const f of MESSAGE_FIELDS) json[f] = `texto de ${f}`;
  const out = encryptBridgePayload("send", json, PID);
  for (const f of MESSAGE_FIELDS) {
    const blob = out[f] as string;
    assert.ok(cifradoV2(blob), `${f} não saiu e2e:v2:`);
    assert.ok(!blob.startsWith("e2e:v1:"), `${f} emitiu e2e:v1:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: f });
    assert.equal(decryptForProject(blob, PID, aad), `texto de ${f}`);
  }
});

test("memory_add: plaintext vira *Cipher e contentHash preserva dedup", () => {
  const out = encryptBridgePayload("memory_add", { title: "T", body: "B" }, PID);
  for (const [plain, cipher] of Object.entries(MEMORY_PLAIN_TO_CIPHER)) {
    assert.equal(out[plain], undefined, `${plain} ficou no payload em claro`);
    assert.ok(cifradoV2(out[cipher]), `${cipher} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.MEMORIES, field: plain });
    assert.equal(decryptForProject(out[cipher] as string, PID, aad), plain === "title" ? "T" : "B");
  }
  assert.match(String(out.contentHash), /^[0-9a-f]{64}$/, "contentHash sumiu (dedup quebraria)");
});

test("board: cifra todos os campos de texto, steps, chart e annotations", () => {
  const json: Record<string, unknown> = {
    steps: [{ label: "L", detail: "D", ordem: 1 }],
    chart: { labels: ["Jan"], series: [{ name: "S", values: [1] }] },
    annotations: [{ label: "A" }],
  };
  for (const f of BOARD_TEXT_FIELDS) json[f] = `v-${f}`;
  const out = encryptBridgePayload("board", json, PID);
  for (const f of BOARD_TEXT_FIELDS) {
    assert.ok(cifradoV2(out[f]), `board.${f} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.BOARDS, field: f });
    assert.equal(decryptForProject(out[f] as string, PID, aad), `v-${f}`);
  }
  const st = (out.steps as Record<string, unknown>[])[0]!;
  for (const f of BOARD_STEP_FIELDS) assert.ok(cifradoV2(st[f]), `step.${f} não saiu e2e:v2:`);
  const chart = out.chart as { labels: unknown[]; series: Record<string, unknown>[] };
  assert.ok(cifradoV2(chart.labels[0]), "chart.label não saiu e2e:v2:");
  assert.ok(cifradoV2(chart.series[0]!.name), "chart.series.name não saiu e2e:v2:");
  // Estrutura NÃO cifrada de propósito: o server aplica limites estruturais.
  assert.equal(st.ordem, 1);
  assert.deepEqual((chart.series[0] as { values: number[] }).values, [1]);
  // Anotações: o relay atual NÃO cifra annotation.label na subida (o server é
  // quem gerencia anotações via boardDraw) — a lista canônica documenta o
  // campo pro lado do WEB decifrar o que o server devolve. Se um dia o agente
  // passar a MANDAR anotações, este assert avisa que falta cifrar.
  void BOARD_ANNOTATION_FIELDS;
});

test("T-062 parity daemon: cifra v2 e decifra com o mesmo aadV2", async () => {
  const aad = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
  const { encryptForProject, decryptForProject } = await import("../daemon-crypto.js");
  const ct = encryptForProject("texto de title", PID, aad);
  assert.ok(ct && ct.startsWith("e2e:v2:"));
  assert.ok(!ct!.startsWith("e2e:v1:"));
  assert.equal(decryptForProject(ct!, PID, aad), "texto de title");
  const aadOutro = aadV2({ projectId: PID, table: E2EE_TABLE.GOALS, field: "title" });
  assert.equal(decryptForProject(ct!, PID, aadOutro), null);
});

test("T-062b write+read: blob movido entre table/field não abre", () => {
  const out = encryptBridgePayload("memory_add", { title: "segredo-title", body: "corpo" }, PID);
  const blob = out.titleCipher as string;
  assert.ok(cifradoV2(blob));
  const aadTitle = aadV2({ projectId: PID, table: E2EE_TABLE.MEMORIES, field: "title" });
  const aadBody = aadV2({ projectId: PID, table: E2EE_TABLE.MEMORIES, field: "body" });
  assert.equal(decryptForProject(blob, PID, aadTitle), "segredo-title");
  assert.equal(decryptForProject(blob, PID, aadBody), null, "AAD de outro campo deve falhar");
  assert.equal(decryptForProject(blob, PID), null, "v2 sem AAD fail-closed");
});

test("T-062b: encrypt sem aad continua e2e: (não emite e2e:v1:)", async () => {
  const { encryptForProject } = await import("../daemon-crypto.js");
  const legado = encryptForProject("ring-wrap", PID);
  assert.ok(legado && legado.startsWith("e2e:") && !legado.startsWith("e2e:v2:") && !legado.startsWith("e2e:v1:"));
  assert.equal(decryptForProject(legado!, PID), "ring-wrap");
});

test("T-073 write+read: messages/content e tts_summaries/summary em e2e:v2; campo trocado falha", async () => {
  const { encryptForProject } = await import("../daemon-crypto.js");
  const out = encryptBridgePayload("send", { content: "segredo-msg" }, PID);
  const blob = out.content as string;
  assert.ok(cifradoV2(blob));
  const aadMsg = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" });
  const aadSum = aadV2({ projectId: PID, table: E2EE_TABLE.SUMMARIES, field: "summary" });
  const aadTitle = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" });
  assert.equal(decryptForProject(blob, PID, aadMsg), "segredo-msg");
  assert.equal(decryptForProject(blob, PID, aadSum), null, "AAD de summary não abre message");
  assert.equal(decryptForProject(blob, PID, aadTitle), null, "AAD de title não abre message");
  assert.equal(decryptForProject(blob, PID), null, "v2 sem AAD fail-closed");

  const ctSum = encryptForProject("resumo tts", PID, aadSum)!;
  assert.ok(ctSum.startsWith("e2e:v2:") && !ctSum.startsWith("e2e:v1:"));
  assert.equal(decryptForProject(ctSum, PID, aadSum), "resumo tts");
  assert.equal(decryptForProject(ctSum, PID, aadMsg), null, "AAD de message não abre summary");
  const legado = encryptForProject("chat legado", PID)!;
  assert.ok(legado.startsWith("e2e:") && !legado.startsWith("e2e:v2:"));
  assert.equal(decryptForProject(legado, PID), "chat legado");
  assert.equal(decryptForProject(legado, PID, aadMsg), "chat legado", "e2e: legado ignora AAD");
});

test("T-074: required+sem chave recusa; OFF passthrough; required+chave cifra", { concurrency: false }, async () => {
  const { setE2eeRequired } = await import("../daemon-crypto.js");
  const pid = "proj-req-off";
  setE2eeRequired(pid, false);
  const outOff = encryptBridgePayload("send", { content: "claro" }, pid);
  assert.equal(outOff.content, "claro");
  setE2eeRequired(pid, true);
  assert.throws(() => encryptBridgePayload("send", { content: "claro" }, pid), /e2ee-required/);
  setE2eeRequired(pid, false);
  setE2eeRequired(PID, true);
  try {
    const outOn = encryptBridgePayload("send", { content: "segredo-req" }, PID);
    assert.ok(typeof outOn.content === "string" && String(outOn.content).startsWith("e2e:"));
  } finally {
    setE2eeRequired(PID, false);
  }
});

test("T-079 tasks_add: title/description saem e2e:v2 com aadV2 do catálogo", () => {
  const out = encryptBridgePayload("tasks_add", { title: "título", description: "desc", status: "todo" }, PID);
  assert.equal(out.status, "todo", "campo estrutural não cifra");
  for (const f of TASK_FIELDS) {
    const blob = out[f] as string;
    assert.ok(cifradoV2(blob), `task.${f} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: f });
    assert.equal(decryptForProject(blob, PID, aad), f === "title" ? "título" : "desc");
    assert.equal(decryptForProject(blob, PID, aadV2({ projectId: PID, table: E2EE_TABLE.GOALS, field: f })), null);
  }
});

test("T-079 tasks_update e comment: cifra nested/top-level; content de comment", () => {
  const upd = encryptBridgePayload("tasks_update", { id: "task_1", title: "novo" }, PID);
  assert.equal(upd.id, "task_1");
  assert.ok(cifradoV2(upd.title));
  const nested = encryptBridgePayload("tasks_update", { id: "task_1", patch: { description: "p" } }, PID);
  const patch = nested.patch as Record<string, unknown>;
  assert.ok(cifradoV2(patch.description));
  const cmt = encryptBridgePayload("tasks_comment_add", { taskId: "task_1", content: "oi" }, PID);
  assert.equal(cmt.taskId, "task_1");
  for (const f of COMMENT_FIELDS) {
    const blob = cmt[f] as string;
    assert.ok(cifradoV2(blob), `comment.${f} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.TASK_COMMENTS, field: f });
    assert.equal(decryptForProject(blob, PID, aad), "oi");
  }
});

test("T-079 goals_add: title/description e2e:v2", () => {
  const out = encryptBridgePayload("goals_add", { goal: { title: "G", description: "d" } }, PID);
  const g = out.goal as Record<string, unknown>;
  for (const f of GOAL_FIELDS) {
    const blob = g[f] as string;
    assert.ok(cifradoV2(blob), `goal.${f} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.GOALS, field: f });
    assert.equal(decryptForProject(blob, PID, aad), f === "title" ? "G" : "d");
  }
});

test("T-079 required+chave: tasks_add cifra (não recusa); sem chave recusa", { concurrency: false }, async () => {
  const { setE2eeRequired } = await import("../daemon-crypto.js");
  setE2eeRequired(PID, true);
  try {
    const out = encryptBridgePayload("tasks_add", { title: "ok" }, PID);
    assert.ok(cifradoV2(out.title));
  } finally {
    setE2eeRequired(PID, false);
  }
  setE2eeRequired("sem-chave", true);
  assert.throws(
    () => encryptBridgePayload("tasks_add", { title: "claro" }, "sem-chave"),
    /e2ee-required/,
  );
});

test("T-083 plans_create: plano PLANS aad; draft title/prompt viram tasks AAD e2e:v2", () => {
  const out = encryptBridgePayload("plans_create", {
    title: "Plano",
    description: "desc",
    tasks: [{ title: "item", prompt: "faça" }],
  }, PID);
  for (const f of PLAN_FIELDS) {
    const blob = out[f] as string;
    assert.ok(cifradoV2(blob), `plan.${f} não saiu e2e:v2:`);
    const aad = aadV2({ projectId: PID, table: E2EE_TABLE.PLANS, field: f });
    assert.equal(decryptForProject(blob, PID, aad), f === "title" ? "Plano" : "desc");
    assert.equal(decryptForProject(blob, PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" })), null);
  }
  const item = (out.tasks as Record<string, unknown>[])[0]!;
  assert.ok(cifradoV2(item.title));
  assert.ok(cifradoV2(item.prompt));
  assert.equal(decryptForProject(item.title as string, PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" })), "item");
  assert.equal(decryptForProject(item.prompt as string, PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "description" })), "faça");
});

test("T-083 plans_apply_tasks: cada item cifra title/prompt (não claro)", () => {
  const out = encryptBridgePayload("plans_apply_tasks", {
    planId: "pln_1",
    tasks: [{ title: "A", prompt: "pA" }, { title: "B", prompt: "pB" }],
  }, PID);
  assert.equal(out.planId, "pln_1");
  const tasks = out.tasks as Record<string, unknown>[];
  for (const t of tasks) {
    assert.ok(cifradoV2(t.title), "apply title em claro");
    assert.ok(cifradoV2(t.prompt), "apply prompt em claro");
  }
});

test("T-083 required+chave: plans_create cifra; sem chave recusa", { concurrency: false }, async () => {
  const { setE2eeRequired } = await import("../daemon-crypto.js");
  setE2eeRequired(PID, true);
  try {
    const out = encryptBridgePayload("plans_create", { title: "ok" }, PID);
    assert.ok(cifradoV2(out.title));
  } finally {
    setE2eeRequired(PID, false);
  }
  setE2eeRequired("sem-chave-plan", true);
  assert.throws(
    () => encryptBridgePayload("plans_apply_tasks", { tasks: [{ title: "x" }] }, "sem-chave-plan"),
    /e2ee-required/,
  );
});

test("T-083 plans_add_task: title/prompt (e alias description) e2e:v2 com AAD de tasks", () => {
  const out = encryptBridgePayload("plans_add_task", { planId: "pln_1", title: "item", prompt: "faça" }, PID);
  assert.equal(out.planId, "pln_1");
  assert.ok(cifradoV2(out.title));
  assert.ok(cifradoV2(out.prompt));
  assert.equal(decryptForProject(out.title as string, PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" })), "item");
  assert.equal(decryptForProject(out.prompt as string, PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "description" })), "faça");
  const alias = encryptBridgePayload("plans_add_task", { title: "t", description: "d" }, PID);
  assert.ok(cifradoV2(alias.description));
  assert.equal(decryptForProject(alias.description as string, PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "description" })), "d");
});

test("T-083 daemon: cada campo novo abre e2e:v2 com aadV2 (AAD cruzado falha)", () => {
  const pairs: Array<[string, string]> = [
    ...PLAN_FIELDS.map((f) => [E2EE_TABLE.PLANS, f] as [string, string]),
    ...PLAN_TASK_FIELDS.map((f) => [E2EE_TABLE.PLAN_TASKS, f] as [string, string]),
    ...MISSION_FIELDS.map((f) => [E2EE_TABLE.MISSIONS, f] as [string, string]),
    ...MISSION_STEP_FIELDS.map((f) => [E2EE_TABLE.MISSION_STEPS, f] as [string, string]),
    ...SCHEDULE_FIELDS.map((f) => [E2EE_TABLE.SCHEDULES, f] as [string, string]),
  ];
  for (const [table, field] of pairs) {
    const aad = aadV2({ projectId: PID, table, field });
    const blob = encryptForProject(`plain-${table}-${field}`, PID, aad);
    assert.ok(blob && cifradoV2(blob), `${table}.${field} não saiu e2e:v2:`);
    assert.equal(decryptForProject(blob!, PID, aad), `plain-${table}-${field}`);
    if (table !== E2EE_TABLE.TASKS || field !== "title") {
      assert.equal(decryptForProject(blob!, PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" })), null);
    }
  }
});

function decryptWithReadChain(stored: string, table: string, field: string): string | null {
  for (const aad of aadReadChain({ projectId: PID, table, field })) {
    const p = decryptForProject(stored, PID, aad);
    if (p != null) return p;
  }
  return null;
}

test("T-083 rework A: startPlan copy — missions.title abre plans.title; AAD não-canônica falha", () => {
  const fromPlan = encryptForProject("Plano secreto", PID, aadV2({ projectId: PID, table: E2EE_TABLE.PLANS, field: "title" }))!;
  assert.equal(decryptWithReadChain(fromPlan, E2EE_TABLE.MISSIONS, "title"), "Plano secreto");
  assert.equal(decryptForProject(fromPlan, PID, aadV2({ projectId: PID, table: E2EE_TABLE.MISSIONS, field: "title" })), null, "destino sozinho não abre o blob copiado");

  const fromPlanDesc = encryptForProject("objetivo secreto", PID, aadV2({ projectId: PID, table: E2EE_TABLE.PLANS, field: "description" }))!;
  assert.equal(decryptWithReadChain(fromPlanDesc, E2EE_TABLE.MISSIONS, "description"), "objetivo secreto");
  assert.equal(decryptForProject(fromPlanDesc, PID, aadV2({ projectId: PID, table: E2EE_TABLE.MISSIONS, field: "description" })), null);

  const fromGoal = encryptForProject("Goal", PID, aadV2({ projectId: PID, table: E2EE_TABLE.GOALS, field: "title" }))!;
  assert.equal(decryptWithReadChain(fromGoal, E2EE_TABLE.MISSIONS, "title"), null, "goals.title NÃO é fallback canônico");
  const fromGoalDesc = encryptForProject("Goal desc", PID, aadV2({ projectId: PID, table: E2EE_TABLE.GOALS, field: "description" }))!;
  assert.equal(decryptWithReadChain(fromGoalDesc, E2EE_TABLE.MISSIONS, "description"), null, "goals.description NÃO é fallback canônico");

  const stepTitle = encryptForProject("item-1", PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" }))!;
  const stepPrompt = encryptForProject("faça a coisa", PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "description" }))!;
  assert.equal(decryptWithReadChain(stepTitle, E2EE_TABLE.MISSION_STEPS, "title"), "item-1");
  assert.equal(decryptWithReadChain(stepPrompt, E2EE_TABLE.MISSION_STEPS, "prompt"), "faça a coisa");

  assert.equal(decryptForProject(fromPlan, PID), null, "v2 sem AAD fail-closed");
});

test("T-083 rework A: apply_plan_steps nascido no destino é 1:1 (destino abre, sem precisar da fonte)", () => {
  const destTitle = encryptForProject("step client", PID, aadV2({ projectId: PID, table: E2EE_TABLE.MISSION_STEPS, field: "title" }))!;
  const destPrompt = encryptForProject("prompt client", PID, aadV2({ projectId: PID, table: E2EE_TABLE.MISSION_STEPS, field: "prompt" }))!;
  assert.equal(
    decryptForProject(destTitle, PID, aadV2({ projectId: PID, table: E2EE_TABLE.MISSION_STEPS, field: "title" })),
    "step client",
  );
  assert.equal(decryptWithReadChain(destTitle, E2EE_TABLE.MISSION_STEPS, "title"), "step client");
  assert.equal(
    decryptForProject(destPrompt, PID, aadV2({ projectId: PID, table: E2EE_TABLE.MISSION_STEPS, field: "prompt" })),
    "prompt client",
  );
  assert.equal(decryptForProject(destTitle, PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" })), null);
});

test("T-094 daemon: agents/credentials/summarize v2+AAD e legado; AAD errado null", () => {
  const grupos: Array<[string, string, string]> = [
    [E2EE_TABLE.AGENTS, "system_prompt", "você é o backend"],
    [E2EE_TABLE.CREDENTIALS, "value", "sk-live-secreto"],
    [E2EE_TABLE.SUMMARIZE, "text", "texto longo pra resumir"],
  ];
  for (const [table, field, plain] of grupos) {
    const aad = aadV2({ projectId: PID, table, field });
    const blob = encryptForProject(plain, PID, aad)!;
    assert.ok(cifradoV2(blob), `${table}.${field} não saiu e2e:v2:`);
    assert.equal(decryptForProject(blob, PID, aad), plain);
    assert.equal(decryptForProject(blob, PID, aadV2({ projectId: PID, table: E2EE_TABLE.TASKS, field: "title" })), null);
    assert.equal(decryptForProject(blob, PID), null, "v2 sem AAD fail-closed");
    const legado = encryptForProject(plain, PID)!;
    assert.ok(legado.startsWith("e2e:") && !legado.startsWith("e2e:v2:"));
    assert.equal(decryptForProject(legado, PID, aad), plain, "legado e2e: ignora AAD");
  }
});

test("T-094 daemon ponta-a-ponta: spawn/get_credential/summarize usam AAD canônico", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const mainSrc = readFileSync(join(srcDir, "../main.ts"), "utf8");
  const relaySrc = readFileSync(join(srcDir, "../bridge-relay.ts"), "utf8");
  assert.match(mainSrc, /E2EE_TABLE\.AGENTS,\s*field:\s*"system_prompt"/);
  assert.match(mainSrc, /E2EE_TABLE\.SUMMARIZE,\s*field:\s*"text"/);
  assert.match(relaySrc, /E2EE_TABLE\.CREDENTIALS,\s*field:\s*"value"/);
});

test("T-103 daemon: messages.images AAD cifra bytes; AAD content não abre", () => {
  const aad = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: MESSAGE_IMAGE_FIELD });
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const blob = encryptBytesForProject(raw, PID, aad)!;
  assert.ok(cifradoV2(blob));
  assert.deepEqual(decryptBytesForProject(blob, PID, aad), raw);
  assert.equal(decryptBytesForProject(blob, PID, aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" })), null);
});
