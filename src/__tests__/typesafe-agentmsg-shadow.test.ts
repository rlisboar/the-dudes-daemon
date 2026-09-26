import "./scratch-home.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { validateDaemonMessage } from "@the-dudes/protocol/daemon-wire";

const PROJ = "agent_msg_shadow_fixture";
const join = (...parts: string[]) => parts.join("");
process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-agentmsg-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-agentmsg-pkeys-${process.pid}.json`);

const crypto = await import("../daemon-crypto.js");
const shadow = await import("../typesafe-agentmsg-shadow.js");
const jev = await import("../typesafe-delegate-shadow.js");
const publicKey = createPublicKey({ key: Buffer.from(crypto.getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
const wrapped = publicEncrypt({ key: publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
assert.equal(crypto.rememberProjectKey(PROJ, wrapped.toString("base64")), true);
const MAIN = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const RUNNER = readFileSync(new URL("../agent-runner.ts", import.meta.url), "utf8");
const RELAY = readFileSync(new URL("../bridge-relay.ts", import.meta.url), "utf8");

const originalFlag = process.env.TYPESAFE_AGENTMSG_SHADOW;
const originalApiKey = process.env.TYPESAFE_API_KEY;

function setEnv(flag?: string, apiKey?: string): void {
  if (flag === undefined) delete process.env.TYPESAFE_AGENTMSG_SHADOW;
  else process.env.TYPESAFE_AGENTMSG_SHADOW = flag;
  if (apiKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = apiKey;
}

beforeEach(() => {
  shadow._resetAgentMessageShadowForTest();
  jev.registrarJevDoProjeto(PROJ, true);
  setEnv("true", "synthetic-typesafe-key");
});

afterEach(async () => {
  await shadow.settleAgentMessageShadowForTests();
  shadow._resetAgentMessageShadowForTest();
  jev.registrarJevDoProjeto(PROJ, false);
  jev.definirEmissorSombra(null);
  setEnv(originalFlag, originalApiKey);
});

test("agent-msg fires without waiting, redacts text, and pairs verdict/outcome on opaque refId", async () => {
  const requests: Array<{ url: string; body: string; opts: { timeoutMs: number; maxRedirects: number } }> = [];
  const frames: Array<Record<string, unknown>> = [];
  jev.definirEmissorSombra((frame) => frames.push(frame as unknown as Record<string, unknown>));
  shadow.setAgentMessageShadowFetchForTests(async (url, init, opts) => {
    requests.push({ url, body: init.body, opts });
    return { status: 200, text: async () => JSON.stringify({ answers: { requires_response: { type: "noul", noul: 0.83 } } }) };
  });

  const rawToken = join("sk", "-ant-synthetic_canary_1234567890");
  const message = join("Please review this change and send a decision. Token ", rawToken);
  assert.equal(shadow.scheduleAgentMessageShadow({ projectId: PROJ, agentId: "local-recipient-id", deliveryId: "delivery-secret-id", text: message }), true);
  shadow.markAgentMessageActed("local-recipient-id", "delivery-secret-id");
  shadow.addAgentMessageTokens("local-recipient-id", "delivery-secret-id", { input: 13, output: 7 });
  shadow.settleAgentMessageShadow("local-recipient-id", "delivery-secret-id", 912);
  assert.equal(frames.length, 0, "pending SystemOne call has not been awaited");
  await shadow.settleAgentMessageShadowForTests();

  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0]!.body) as Record<string, any>;
  assert.equal(requests[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.deepEqual(requests[0]!.opts, { timeoutMs: 2500, maxRedirects: 0 });
  assert.match(body.state.message, /Please review this change/);
  assert.equal(requests[0]!.body.includes(rawToken), false);
  assert.equal(requests[0]!.body.includes("local-recipient-id"), false);
  assert.equal(requests[0]!.body.includes("delivery-secret-id"), false);
  assert.equal(body.state.message.includes("[REDACTED]"), true);
  assert.equal(body.agentId, undefined);
  assert.equal(body.deliveryId, undefined);

  assert.equal(frames.length, 2);
  const [verdict, outcome] = frames;
  assert.equal(verdict!.source, "agent-msg");
  assert.deepEqual(validateDaemonMessage(verdict), { ok: true });
  assert.equal(verdict!.event, "verdict");
  assert.equal(verdict!.requiresResponseNoul, 0.83);
  assert.equal(verdict!.hashKind, "hmac1");
  assert.equal(outcome!.source, "agent-msg");
  assert.deepEqual(validateDaemonMessage(outcome), { ok: true });
  assert.equal(outcome!.event, "outcome");
  assert.equal(verdict!.refId, outcome!.refId);
  assert.notEqual(verdict!.refId, "delivery-secret-id");
  assert.deepEqual(outcome!.outcome, { acted: true, tokens: 20, durationMs: 912 });
  assert.equal(JSON.stringify(frames).includes("Please review"), false);
  assert.equal(JSON.stringify(frames).includes(rawToken), false);
  assert.equal(JSON.stringify(frames).includes("delivery-secret-id"), false);
  assert.equal(JSON.stringify(frames).includes("local-recipient-id"), false);
});

test("agent-msg wiring captures only agent-origin plaintext and records observed turn actions", () => {
  const schedule = MAIN.indexOf("scheduleAgentMessageShadow({");
  const delivery = MAIN.indexOf("this.host.send_message(msg.agentId, content, images, msg.deliveryId, wire, principalFromAgentSend(msg))");
  assert.ok(MAIN.includes('msg.origin === "agent"'));
  assert.ok(schedule >= 0 && delivery > schedule, "shadow starts in the decrypted agent:send path before delivery");
  assert.match(MAIN.slice(schedule, delivery), /text: agentMessageText/);
  assert.match(RUNNER, /onTurnSettled\?\.\(this\.currentTurn\.deliveryId, durationMs\)/);
  assert.match(RELAY, /upstream\.status >= 200 && upstream\.status < 300/);
  assert.match(RELAY, /onAgentMessageAction\?\.\(action\[1\]!\)/);
});

test("agent-msg is gated by flag, project feature, key, delivery id, and secret redaction", async () => {
  let calls = 0;
  shadow.setAgentMessageShadowFetchForTests(async () => {
    calls++;
    return { status: 200, text: async () => JSON.stringify({ answers: { requires_response: { noul: 0.5 } } }) };
  });
  assert.equal(shadow.scheduleAgentMessageShadow({ projectId: PROJ, agentId: "a", deliveryId: "d0", text: "A sufficiently useful benign message asking for a response." }), true);
  await shadow.settleAgentMessageShadowForTests();
  assert.equal(calls, 1);

  setEnv("true", undefined);
  assert.equal(shadow.scheduleAgentMessageShadow({ projectId: PROJ, agentId: "a", deliveryId: "d1", text: "A sufficiently useful benign message asking for a response." }), false);
  setEnv("true", "synthetic-typesafe-key");
  jev.registrarJevDoProjeto(PROJ, false);
  assert.equal(shadow.scheduleAgentMessageShadow({ projectId: PROJ, agentId: "a", deliveryId: "d2", text: "A sufficiently useful benign message asking for a response." }), false);
  jev.registrarJevDoProjeto(PROJ, true);
  assert.equal(shadow.scheduleAgentMessageShadow({ projectId: PROJ, agentId: "a", text: "A sufficiently useful benign message asking for a response." }), false);
  const privateKeyMarker = join("-----BEGIN ", "PRIVATE ", "KEY-----\nfixture\n-----END ", "PRIVATE ", "KEY-----");
  assert.equal(shadow.scheduleAgentMessageShadow({ projectId: PROJ, agentId: "a", deliveryId: "d3", text: privateKeyMarker }), false);
  await shadow.settleAgentMessageShadowForTests();
  assert.equal(calls, 1);
});
