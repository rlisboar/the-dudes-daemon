/** T-1129/#1174: real reflection SystemOne request, privacy, and paired outcome. */
import "./scratch-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t1129-key-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t1129-pkeys-${process.pid}.json`);

const { getDaemonPublicKey, rememberProjectKey, forgetProjectKey } = await import("../daemon-crypto.js");
const { registrarJevDoProjeto, definirEmissorSombra, _resetJevProjetosForTest } = await import("../typesafe-delegate-shadow.js");
const {
  _resetMetricasReflexaoForTest,
  estadoEnxuto,
  metricasReflexao,
  NOUL,
  setReflectShadowFetchForTests,
  settleReflectShadowForTests,
  sombraDaReflexao,
} = await import("../typesafe-reflect-shadow.js");
const { opaqueRefId, prepararTexto, TYPESAFE_MAX_TEXTO_BYTES, TYPESAFE_REFLECT_TITLE_BYTES } = await import("../typesafe-client.js");

const PID = "proj_t1129";
const DELIVERY = "delivery-private-test-42";

function installProjectKey(projectId = PID): void {
  const publicKey = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(projectId, wrap.toString("base64")), true);
}

function habilitar(projectId = PID): void {
  process.env.TYPESAFE_REFLECT_SHADOW = "1";
  process.env.TYPESAFE_API_KEY = "synthetic-api-key";
  _resetJevProjetosForTest();
  registrarJevDoProjeto(projectId, true);
  _resetMetricasReflexaoForTest();
}

function response(probability = 0.73): string {
  return JSON.stringify({ answers: { [NOUL]: { type: "noul", noul: probability } } });
}

test("T-1129: disabled and insufficient/redaction-failed reflections do not call TypeSafe", async () => {
  const calls: unknown[] = [];
  const events: Array<Record<string, unknown>> = [];
  setReflectShadowFetchForTests(async (...args) => {
    calls.push(args);
    return { status: 200, text: async () => response() };
  });
  definirEmissorSombra((message) => events.push(message as unknown as Record<string, unknown>));
  delete process.env.TYPESAFE_REFLECT_SHADOW;
  process.env.TYPESAFE_API_KEY = "synthetic-api-key";
  registrarJevDoProjeto(PID, true);
  sombraDaReflexao({ projectId: PID, agentId: "agent-private", titulo: "A sufficiently useful reflection title" })(undefined);
  await settleReflectShadowForTests();
  assert.equal(calls.length, 0);

  habilitar();
  sombraDaReflexao({ projectId: PID, agentId: "agent-private", titulo: "tiny" })(undefined);
  sombraDaReflexao({ projectId: PID, agentId: "agent-private", descricao: "Authorization: Bearer token-canary-1234567890" })(undefined);
  await settleReflectShadowForTests();
  assert.equal(calls.length, 0, "short and structured-secret states are skipped");
  assert.equal(events.length, 0);
});

test("T-1129: calls the fixed endpoint with a sanitized real Noul request and opaque paired refId", async () => {
  installProjectKey();
  habilitar();
  const captured: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }; opts: { timeoutMs: number; maxRedirects: number } }> = [];
  const events: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  setReflectShadowFetchForTests(async (url, init, opts) => {
    captured.push({ url, init, opts });
    return { status: 200, text: async () => response(0.73) };
  });
  definirEmissorSombra((message) => events.push(message as unknown as Record<string, unknown>));
  try {
    const title = `How retries exposed a stable race ${"x".repeat(700)}`;
    const description = `The worker hit a retry boundary and recovered with an idempotent write. ${"d".repeat(2500)}`;
    const summary = `Keep the idempotency guard before retries. ${"s".repeat(2500)}`;
    const registerOutcome = sombraDaReflexao({
      projectId: PID,
      agentId: "agent-id-must-not-leave",
      taskId: "task-id-must-stay-local-to-typesafe",
      deliveryId: DELIVERY,
      titulo: title,
      descricao: description,
      resumo: summary,
      turnos: 3,
      erros: 1,
      retries: 2,
      reaberta: false,
    });
    await settleReflectShadowForTests();

    assert.equal(captured.length, 1);
    const request = captured[0]!;
    assert.equal(request.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.headers.Authorization, "Bearer synthetic-api-key");
    assert.equal(request.opts.timeoutMs, 2500);
    assert.equal(request.opts.maxRedirects, 0);
    assert.equal(request.init.signal instanceof AbortSignal, true);
    assert.ok(Buffer.byteLength(request.init.body, "utf8") <= 8 * 1024);

    const body = JSON.parse(request.init.body) as { model: string; state: Record<string, unknown>; questions: Record<string, { type: string }> };
    assert.equal(body.model, "jev-1.13.0");
    assert.deepEqual(Object.keys(body.state).sort(), ["description", "errors", "reopened", "retries", "summary", "title", "turns"]);
    assert.ok(Buffer.byteLength(String(body.state.title), "utf8") <= TYPESAFE_REFLECT_TITLE_BYTES);
    assert.ok(Buffer.byteLength(String(body.state.description), "utf8") <= TYPESAFE_MAX_TEXTO_BYTES);
    assert.ok(Buffer.byteLength(String(body.state.summary), "utf8") <= TYPESAFE_MAX_TEXTO_BYTES);
    assert.equal((body.questions as Record<string, { type: string }>)[NOUL]!.type, "noul");
    for (const privateValue of ["agent-id-must-not-leave", "task-id-must-stay-local-to-typesafe", DELIVERY, PID]) {
      assert.equal(request.init.body.includes(privateValue), false);
    }

    const refId = opaqueRefId(PID, DELIVERY);
    assert.ok(refId);
    assert.notEqual(refId, DELIVERY);
    assert.equal(events.length, 1, "verdict emitted after the actual SystemOne response");
    assert.equal(events[0]!.source, "reflect");
    assert.equal(events[0]!.event, "verdict");
    assert.equal(events[0]!.hasReusableLessonNoul, 0.73);
    assert.equal(events[0]!.refId, refId);
    assert.equal(JSON.stringify(events[0]).includes(DELIVERY), false);

    registerOutcome("EPISODE_JSON: [{\"title\":\"not sent\",\"body\":\"not sent\"}]");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.length, 2);
    assert.equal(events[1]!.event, "outcome");
    assert.equal(events[1]!.refId, refId);
    assert.deepEqual(events[1]!.outcome, { produced: true });
    assert.equal(JSON.stringify(events).includes("not sent"), false);
    assert.equal(logs.some((line) => line.includes(DELIVERY) || line.includes("synthetic-api-key") || line.includes(description)), false);
    assert.equal(metricasReflexao().memoriaGerada, 1);

    const emptyDelivery = `${DELIVERY}-empty`;
    const finishEmpty = sombraDaReflexao({
      projectId: PID,
      agentId: "agent-id-must-not-leave",
      deliveryId: emptyDelivery,
      titulo: "A useful lesson about an empty reflection result",
    });
    await settleReflectShadowForTests();
    finishEmpty("");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.length, 4);
    assert.equal(events[2]!.event, "verdict");
    assert.equal(events[3]!.event, "outcome");
    assert.equal(events[3]!.refId, opaqueRefId(PID, emptyDelivery));
    assert.deepEqual(events[3]!.outcome, { produced: false });
    assert.equal(metricasReflexao().semLicao, 1);
  } finally {
    console.error = originalError;
    setReflectShadowFetchForTests(null);
    definirEmissorSombra(null);
    forgetProjectKey(PID);
  }
});

test("T-1129: field caps are UTF-8 bytes and no HMAC/refId fallback exists without a project key", async () => {
  const long = "ñ".repeat(5000);
  const state = estadoEnxuto({ projectId: PID, agentId: "agent", titulo: `T${long}`, descricao: `D${long}`, resumo: `S${long}`, turnos: 2, erros: 1, reaberta: true });
  assert.ok(state);
  assert.ok(Buffer.byteLength(String(state.title), "utf8") <= TYPESAFE_REFLECT_TITLE_BYTES);
  assert.ok(String(state.title).endsWith("…"));
  assert.ok(Buffer.byteLength(String(state.description), "utf8") <= TYPESAFE_MAX_TEXTO_BYTES);
  assert.ok(Buffer.byteLength(String(state.summary), "utf8") <= TYPESAFE_MAX_TEXTO_BYTES);
  assert.equal(state.turns, 2);
  assert.equal(state.errors, 1);
  assert.equal(state.reopened, true);
  assert.equal(prepararTexto("benign text", 32), "benign text");

  forgetProjectKey(PID);
  habilitar();
  const events: Array<Record<string, unknown>> = [];
  let body = "";
  setReflectShadowFetchForTests(async (_url, init) => {
    body = init.body;
    return { status: 200, text: async () => response() };
  });
  definirEmissorSombra((message) => events.push(message as unknown as Record<string, unknown>));
  try {
    const finish = sombraDaReflexao({ projectId: PID, agentId: "agent", deliveryId: DELIVERY, descricao: "A sufficiently informative task description to classify safely." });
    await settleReflectShadowForTests();
    finish("");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(body.includes("agent"), false);
    assert.equal(body.includes(PID), false);
    assert.equal(events.length, 1, "no outcome pair without an opaque reference key");
    assert.equal("textSha256" in events[0]!, false);
    assert.equal("hashKind" in events[0]!, false);
    assert.equal("refId" in events[0]!, false);
  } finally {
    setReflectShadowFetchForTests(null);
    definirEmissorSombra(null);
  }
});
