/** T-1154: summarizer shadows use the shared client and never wait for Jev. */
import "./scratch-home.js";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { fromOrchSchemas, validateDaemonMessage } from "@the-dudes/protocol/daemon-wire";

const PROJ = "t1154_summarizer_fixture";
const join = (...parts: string[]) => parts.join("");
process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t1154-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t1154-pkeys-${process.pid}.json`);
const crypto = await import("../daemon-crypto.js");
const shadow = await import("../typesafe-summarizer-shadow.js");
const jev = await import("../typesafe-delegate-shadow.js");
const publicKey = createPublicKey({ key: Buffer.from(crypto.getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
const wrapped = publicEncrypt({ key: publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
assert.equal(crypto.rememberProjectKey(PROJ, wrapped.toString("base64")), true);
const MAIN = readFileSync(new URL("../main.ts", import.meta.url), "utf8");

const oldFlag = process.env.TYPESAFE_VOICE_SHADOW;
const oldKey = process.env.TYPESAFE_API_KEY;
function setEnv(flag?: string, key?: string): void {
  if (flag === undefined) delete process.env.TYPESAFE_VOICE_SHADOW;
  else process.env.TYPESAFE_VOICE_SHADOW = flag;
  if (key === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = key;
}

beforeEach(() => {
  shadow._resetSummarizerShadowForTest();
  jev.registrarJevDoProjeto(PROJ, true);
  jev.definirEmissorSombra(null);
  setEnv("true", "synthetic-typesafe-key");
});

afterEach(async () => {
  await shadow.settleSummarizerShadowForTests();
  shadow._resetSummarizerShadowForTest();
  jev.registrarJevDoProjeto(PROJ, false);
  jev.definirEmissorSombra(null);
  setEnv(oldFlag, oldKey);
});

test("T-1154: real sanitized request emits typed verdict and opaque refId", async () => {
  const frames: Array<Record<string, any>> = [];
  const requests: Array<{ url: string; body: string; opts: unknown }> = [];
  jev.definirEmissorSombra((frame) => frames.push(frame as unknown as Record<string, any>));
  shadow.setSummarizerShadowFetchForTests(async (url, init, opts) => {
    requests.push({ url, body: init.body, opts });
    return { status: 200, text: async () => JSON.stringify({ answers: {
      speak_as_is: { type: "noul", noul: 0.91 },
      asks_human: { type: "noul", noul: 0.14 },
    } }) };
  });

  const rawToken = join("sk", "-ant-synthetic_canary_1234567890");
  const text = `Please summarize this update for a human. Token ${rawToken}`;
  const settle = shadow.scheduleSummarizerShadow({ kind: "tts", projectId: PROJ, correlationId: "correlation-private-1", text });
  assert.ok(settle);
  assert.equal(frames.length, 0, "scheduling does not wait for the HTTP request");
  settle("Please summarize this update.");
  await shadow.settleSummarizerShadowForTests();

  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, "https://api.typesafe.ai/v1/systemone");
  assert.deepEqual(request.opts, { timeoutMs: 2500, maxRedirects: 0 });
  const body = JSON.parse(request.body) as Record<string, any>;
  assert.equal(body.questions.speak_as_is.type, "noul");
  assert.equal(body.state.text.includes(rawToken), false);
  assert.match(body.state.text, /Please summarize this update/);
  assert.equal(request.body.includes("correlation-private-1"), false);
  assert.equal(frames.length, 2);
  const [verdict, outcome] = frames;
  assert.deepEqual(validateDaemonMessage(verdict), { ok: true });
  assert.equal(verdict!.source, "tts-summary");
  assert.equal(verdict!.event, "verdict");
  assert.equal(verdict!.speakAsIsNoul, 0.91);
  assert.equal(verdict!.hashKind, "hmac1");
  assert.deepEqual(validateDaemonMessage(outcome), { ok: true });
  assert.equal(outcome!.event, "outcome");
  assert.equal(verdict!.refId, outcome!.refId);
  assert.equal(verdict!.refId, "correlation-private-1");
  assert.deepEqual(outcome!.outcome, { acted: true });
  assert.equal(JSON.stringify(frames).includes("Please summarize"), false);
  assert.equal(JSON.stringify(frames).includes(rawToken), false);
});

test("T-1154: reply-suggest asks its own Noul and does not invent human-use outcome", async () => {
  const frames: Array<Record<string, any>> = [];
  let body = "";
  jev.definirEmissorSombra((frame) => frames.push(frame as unknown as Record<string, any>));
  shadow.setSummarizerShadowFetchForTests(async (_url, init) => {
    body = init.body;
    return { status: 200, text: async () => JSON.stringify({ answers: { asks_human: { type: "noul", noul: 0.72 } } }) };
  });
  const settle = shadow.scheduleSummarizerShadow({ kind: "reply", projectId: PROJ, correlationId: "correlation-private-2", text: "Should we ask the operator to approve the release?" });
  assert.ok(settle);
  settle("Suggestion delivered to the interface.");
  await shadow.settleSummarizerShadowForTests();
  assert.equal(JSON.parse(body).questions.asks_human.type, "noul");
  assert.equal(frames.length, 1, "human use is not observable in the daemon");
  assert.equal(frames[0]!.source, "reply-suggest");
  assert.equal(frames[0]!.asksHumanNoul, 0.72);
  assert.equal(frames[0]!.event, "verdict");
  assert.equal(frames[0]!.refId, "correlation-private-2");
  assert.deepEqual(validateDaemonMessage(frames[0]), { ok: true });
});

test("T-1154: env, project feature, key and source text all fail closed", async () => {
  let requests = 0;
  shadow.setSummarizerShadowFetchForTests(async () => {
    requests++;
    return { status: 200, text: async () => JSON.stringify({ answers: { speak_as_is: { noul: 0.5 } } }) };
  });
  const input = { kind: "tts" as const, projectId: PROJ, correlationId: "c", text: "A useful, readable message for a person." };
  assert.ok(shadow.scheduleSummarizerShadow(input));
  setEnv("true", undefined);
  assert.equal(shadow.scheduleSummarizerShadow({ ...input, correlationId: "no-key" }), null);
  setEnv("true", "synthetic-typesafe-key");
  jev.registrarJevDoProjeto(PROJ, false);
  assert.equal(shadow.scheduleSummarizerShadow({ ...input, correlationId: "jev-off" }), null);
  jev.registrarJevDoProjeto(PROJ, true);
  assert.equal(shadow.scheduleSummarizerShadow({ ...input, correlationId: undefined }), null);
  const privateMarker = join("-----BEGIN ", "PRIVATE ", "KEY-----\nfixture\n-----END ", "PRIVATE ", "KEY-----");
  assert.equal(shadow.scheduleSummarizerShadow({ ...input, correlationId: "pem", text: privateMarker }), null);
  await shadow.settleSummarizerShadowForTests();
  assert.equal(requests, 1);
});

test("T-1154: summary shadow schedules before the one-shot call", () => {
  const scheduled = MAIN.indexOf("scheduleSummarizerShadow({");
  const run = MAIN.indexOf("await runSummarizer(", scheduled);
  assert.ok(scheduled > 0 && run > scheduled);
  assert.match(MAIN, /summarizeKindFromRequest\(msg\.kind\)/);
  assert.equal(shadow.summarizeKindFromRequest("tts"), "tts");
  assert.equal(shadow.summarizeKindFromRequest("reply"), "reply");
  assert.equal(shadow.summarizeKindFromRequest(undefined), undefined);
  assert.equal(shadow.summarizeKindFromRequest("invented"), undefined);
});

test("T-1154: the daemon summarize contract accepts both kinds, legacy omission, and rejects invented kinds", () => {
  const schema = fromOrchSchemas["summarize:request"] as { safeParse: (value: unknown) => { success: boolean } };
  const base = { type: "summarize:request", correlationId: "c", runner: "claude", text: "Safe text." };
  assert.equal(schema.safeParse({ ...base, kind: "tts" }).success, true);
  assert.equal(schema.safeParse({ ...base, kind: "reply" }).success, true);
  assert.equal(schema.safeParse(base).success, true);
  assert.equal(schema.safeParse({ ...base, kind: "invented" }).success, false);
});
