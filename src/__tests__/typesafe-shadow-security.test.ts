/** Synthetic canaries captured at each shadow's actual serialized HTTP boundary. */
import "./scratch-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

const PROJ = "proj_shadow_security_fixture";
process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-shadow-security-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-shadow-security-pkeys-${process.pid}.json`);

const crypto = await import("../daemon-crypto.js");
const taskShadow = await import("../typesafe-task-shadow.js");
const delegateShadow = await import("../typesafe-delegate-shadow.js");
const reflectShadow = await import("../typesafe-reflect-shadow.js");
const client = await import("../typesafe-client.js");

const publicKey = createPublicKey({ key: Buffer.from(crypto.getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
const projectWrap = publicEncrypt({ key: publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
assert.equal(crypto.rememberProjectKey(PROJ, projectWrap.toString("base64")), true);

const RAW_RESPONSE_CANARY = "RAW_SYSTEMONE_RESPONSE_MUST_NOT_LEAK_8273";
// Keep scanner bait out of source literals while preserving realistic runtime fixtures.
const join = (...parts: string[]) => parts.join("");
const canary = {
  openAi: join("sk", "-", "0123456789abcdef0123456789abcdef"),
  anthropicUpper: join("SK", "-", "ANT", "-", "0123456789ABCDEF0123456789"),
  github: (kind: string) => join("gh", kind, "_0123456789abcdefghijklmnopqrst"),
  githubFine: join("github", "_pat_0123456789abcdefghijklmnopqrst"),
  slack: join("xox", "b-123456789012-abcdef1234567890"),
  gitlab: join("gl", "pat-0123456789abcdef0123456789"),
  npm: join("npm", "_0123456789abcdef0123456789abcdef"),
  pypi: join("py", "pi-0123456789abcdef0123456789abcdef"),
  aws: (kind: string) => join(kind, "IA1234567890ABCDEF"),
  gcp: join("AI", "za", "A".repeat(35)),
  privateKey: join("-----BEGIN ", "PRIVATE ", "KEY-----", "\nsynthetic-private-material\n-----END ", "PRIVATE ", "KEY-----"),
  opensshPrivateKey: join("-----BEGIN OPENSSH ", "PRIVATE ", "KEY-----", "\nsynthetic-private-material\n-----END OPENSSH ", "PRIVATE ", "KEY-----"),
  agePrivateKey: join("AGE-SECRET-", "KEY-1SYNTHETICSECRETKEY"),
  jwt: join("ey", "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.signature-canary-value"),
  urlEncoded: join("url ", Array.from(Buffer.from(join("sk", "-ant-urlencodedcanary0123456789")), (byte) => `%${byte.toString(16).padStart(2, "0")}`).join("")),
  base64: join("base64 ", Buffer.from(join("gh", "p_base64canary0123456789abcdefghijkl")).toString("base64")),
  truncation: join("ordinary ".repeat(225), "sk", "-ant-boundarycanary0123456789"),
  bearerHeader: join("Authorization: ", "Bearer ", "auth-canary-value-123456789"),
  basicHeader: join("authorization: Basic ", Buffer.from(join("canary", ":secret")).toString("base64")),
  cloudAssignment: join("aws_", "secret_access_key=cloud-canary-value-123456"),
  azureKey: join("Account", "Key=azure-canary-value-123456789"),
  envPassword: join("description line\nexport db_", "password='multi-line-canary-123456'\nNEXT=normal"),
  opensshPublicKey: join("ssh-", "ed25519 ", Buffer.from("synthetic-openssh-public-key-fixture").toString("base64"), " fixture"),
  cookieHeader: join("Cookie: ", "session=synthetic-cookie-canary"),
  setCookieField: join('{"Set-', 'Cookie":"session=synthetic-cookie-canary; HttpOnly"}'),
  urlUserInfo: join("https://fixture-user", ":fixture-password@service.invalid/path"),
  databaseUri: join("postgres", "://fixture-user:fixture-password@db.invalid/private"),
  envFile: join("Read .env\nAPP_MODE=fixture\nPUBLIC_", "LABEL=synthetic"),
  sshConfig: join("Read ~/.ssh/", "config\nHost internal\nIdentityFile ~/.ssh/id_fixture"),
};
const fixtures: Array<{ name: string; value: string; action: "redact" | "drop" | "benign" }> = [
  { name: "Authorization bearer header", value: canary.bearerHeader, action: "drop" },
  { name: "Authorization basic header", value: canary.basicHeader, action: "drop" },
  { name: "OpenAI token", value: canary.openAi, action: "redact" },
  { name: "Anthropic token in uppercase", value: canary.anthropicUpper, action: "redact" },
  { name: "GitHub classic token", value: canary.github("p"), action: "redact" },
  { name: "GitHub OAuth token", value: canary.github("o"), action: "redact" },
  { name: "GitHub user token", value: canary.github("u"), action: "redact" },
  { name: "GitHub server token", value: canary.github("s"), action: "redact" },
  { name: "GitHub refresh token", value: canary.github("r"), action: "redact" },
  { name: "GitHub fine-grained token", value: canary.githubFine, action: "redact" },
  { name: "Slack token", value: canary.slack, action: "redact" },
  { name: "GitLab token", value: canary.gitlab, action: "redact" },
  { name: "npm token", value: canary.npm, action: "redact" },
  { name: "PyPI token", value: canary.pypi, action: "redact" },
  { name: "AWS access key", value: canary.aws("AK"), action: "redact" },
  { name: "AWS session key", value: canary.aws("AS"), action: "redact" },
  { name: "Google cloud key", value: canary.gcp, action: "redact" },
  { name: "cloud secret assignment", value: canary.cloudAssignment, action: "drop" },
  { name: "Azure AccountKey", value: canary.azureKey, action: "redact" },
  { name: "multiline lowercase env secret", value: canary.envPassword, action: "drop" },
  { name: "private key marker", value: canary.privateKey, action: "drop" },
  { name: "OpenSSH private key marker", value: canary.opensshPrivateKey, action: "drop" },
  { name: "OpenSSH public key line", value: canary.opensshPublicKey, action: "drop" },
  { name: "age private key marker", value: canary.agePrivateKey, action: "drop" },
  { name: "JWT", value: canary.jwt, action: "redact" },
  { name: "Cookie header", value: canary.cookieHeader, action: "drop" },
  { name: "Set-Cookie JSON field", value: canary.setCookieField, action: "drop" },
  { name: "URL userinfo", value: canary.urlUserInfo, action: "redact" },
  { name: "database URI", value: canary.databaseUri, action: "redact" },
  { name: ".env file contents", value: canary.envFile, action: "drop" },
  { name: "SSH config contents", value: canary.sshConfig, action: "drop" },
  { name: "URL-encoded secret", value: canary.urlEncoded, action: "drop" },
  { name: "base64 secret", value: canary.base64, action: "drop" },
  { name: "truncation-boundary token", value: canary.truncation, action: "redact" },
  { name: "benign prose containing sensitive vocabulary", value: "The token count is shown in the basic security example; no credential is present.", action: "benign" },
];
const rememberedCredential = join("runtime", "-stored-", "credential", "-only-", "4f", "6a", "2c");
crypto.rememberCredentialPlaintext(PROJ, rememberedCredential);
fixtures.push({ name: "project-memory credential (not a token pattern)", value: rememberedCredential, action: "redact" });

function responseDelegate(): string {
  return JSON.stringify({
    id: "synthetic-openrouter-response-id",
    model: "attacker-controlled-model-name-is-ignored",
    provider: "TypeSafe",
    usage: { input_tokens: 17, output_tokens: 3, cost: 0.000001 },
    answers: {
      task_type: { type: "choice", choice: "coding", probabilities: { coding: 0.9, general: 0.1 }, confidence: 0.9 },
      complexity: { type: "choice", choice: "moderate", probabilities: { moderate: 0.9, simple: 0.1 }, confidence: 0.9 },
      domain: { type: "choice", choice: "DAEMON", probabilities: { DAEMON: 0.9, NONE: 0.1 }, confidence: 0.9 },
      destructive: { type: "noul", noul: 0.01 },
    },
    rawEcho: RAW_RESPONSE_CANARY,
  });
}

function responseTask(): string {
  return JSON.stringify({
    id: "synthetic-openrouter-response-id",
    model: "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    usage: { input_tokens: 17, output_tokens: 3, cost: 0.000001 },
    answers: {
      domain: { type: "choice", choice: "DAEMON", probabilities: { DAEMON: 0.9, NONE: 0.1 }, confidence: 0.9 },
      complexity: { type: "choice", choice: "moderate", probabilities: { moderate: 0.9, simple: 0.1 }, confidence: 0.9 },
      destructive: { type: "noul", noul: 0.01 },
      security: { type: "noul", noul: 0.02 },
      acceptance: { type: "noul", noul: 0.8 },
    },
    rawEcho: RAW_RESPONSE_CANARY,
  });
}

function responseReflect(): string {
  return JSON.stringify({
    id: "synthetic-openrouter-response-id",
    model: "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    usage: { input_tokens: 17, output_tokens: 3, cost: 0.000001 },
    answers: { has_reusable_lesson: { type: "noul", noul: 0.8 } },
    rawEcho: RAW_RESPONSE_CANARY,
  });
}

type Shadow = "task" | "delegate" | "reflect";
type ProviderFixture = "typesafe" | "openrouter" | "unknown";
const PROVIDER_SHADOW_FLAGS = [
  "TYPESAFE_TASK_SHADOW",
  "TYPESAFE_DELEGATE_SHADOW",
  "TYPESAFE_REFLECT_SHADOW",
  "TYPESAFE_AGENTMSG_SHADOW",
  "TYPESAFE_VOICE_SHADOW",
] as const;

async function runOne(
  shadow: Shadow,
  value: string,
  serial: number,
  taskTitle = "Retry handling and safe worker recovery",
  provider: ProviderFixture = "typesafe",
  credentials = true,
) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string>; opts: { timeoutMs: number; maxRedirects: number } }> = [];
  const events: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const originals = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  const envBefore = {
    provider: process.env.TYPESAFE_PROVIDER,
    typeSafeKey: process.env.TYPESAFE_API_KEY,
    openRouterKey: process.env.OPENROUTER_API_KEY,
    model: process.env.TYPESAFE_MODEL,
    flags: Object.fromEntries(PROVIDER_SHADOW_FLAGS.map(flag => [flag, process.env[flag]])),
  };
  const typeSafeKey = "synthetic-typesafe-api-key-never-log";
  const openRouterKey = "synthetic-openrouter-api-key-never-log";
  let selectedKey: string | null = null;
  const capture = async (url: string, init: { body: string; headers: Record<string, string> }, opts: { timeoutMs: number; maxRedirects: number }, body: string) => {
    calls.push({ url, body: init.body, headers: init.headers, opts });
    return { status: 200, text: async () => body };
  };
  if (provider === "unknown") {
    process.env.TYPESAFE_PROVIDER = "invalid-provider-fixture";
    process.env.TYPESAFE_API_KEY = typeSafeKey;
    process.env.OPENROUTER_API_KEY = openRouterKey;
  } else if (provider === "openrouter") {
    process.env.TYPESAFE_PROVIDER = "openrouter";
    process.env.TYPESAFE_API_KEY = credentials ? "" : typeSafeKey;
    if (credentials) process.env.OPENROUTER_API_KEY = openRouterKey;
    else delete process.env.OPENROUTER_API_KEY;
    selectedKey = credentials ? openRouterKey : null;
  } else {
    process.env.TYPESAFE_PROVIDER = "typesafe";
    process.env.TYPESAFE_API_KEY = typeSafeKey;
    delete process.env.OPENROUTER_API_KEY;
    selectedKey = typeSafeKey;
  }
  delete process.env.TYPESAFE_MODEL;
  for (const flag of PROVIDER_SHADOW_FLAGS) process.env[flag] = "1";
  if (provider === "openrouter" && !credentials) {
    const detail = `openrouter key required for ${shadow}`;
    for (const flag of PROVIDER_SHADOW_FLAGS) assert.equal(client.typesafeLigado(flag), false, detail);
  }
  taskShadow._resetTaskShadowForTest();
  delegateShadow._resetJevProjetosForTest();
  delegateShadow.registrarJevDoProjeto(PROJ, true);
  delegateShadow.definirEmissorSombra((message) => events.push(message as unknown as Record<string, unknown>));
  const canaryText = `This task documents a normal retry behavior.\n${value}\nKeep the local implementation readable.`;

  taskShadow.setTaskShadowFetch((url, init, opts) => capture(url, init, opts, responseTask()));
  delegateShadow.setDelegateShadowFetch((url, init) => {
    const opts = { timeoutMs: 2500, maxRedirects: 0 };
    return capture(url, init, opts, responseDelegate());
  });
  reflectShadow.setReflectShadowFetchForTests((url, init, opts) => capture(url, init, opts, responseReflect()));

  try {
    if (shadow === "task") {
      taskShadow.scheduleTaskShadow({
        op: "tasks_add",
        projectId: PROJ,
        task: { id: `task-${serial}`, title: taskTitle, description: canaryText, assigneeAgentId: "PRIVATE_AGENT_NAME_CANARY" },
        patch: {},
      });
      taskShadow.flushTaskShadowDebounceForTests();
      await taskShadow.settleTaskShadowForTests();
    } else if (shadow === "delegate") {
      delegateShadow.scheduleDelegateShadow({
        goal: canaryText,
        context: "PRIVATE_CONTEXT_CANARY",
        toolOutput: "PRIVATE_TOOL_OUTPUT_CANARY",
        taskType: "coding",
        complexity: "moderate",
        agentId: "PRIVATE_AGENT_ID_CANARY",
      }, PROJ);
      await delegateShadow.settleDelegateShadowForTests();
    } else {
      const finish = reflectShadow.sombraDaReflexao({
        projectId: PROJ,
        agentId: "PRIVATE_AGENT_ID_CANARY",
        taskId: `task-${serial}`,
        deliveryId: `delivery-canary-${serial}`,
        titulo: "A useful lesson about retry and idempotency",
        descricao: canaryText,
        turnos: 2,
        erros: 1,
        retries: 1,
      });
      await reflectShadow.settleReflectShadowForTests();
      finish("EPISODE_JSON: lesson exists, summary stays local");
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { calls, events, logs, selectedKey };
  } finally {
    console.error = originals.error;
    console.warn = originals.warn;
    console.log = originals.log;
    taskShadow.setTaskShadowFetch(null);
    delegateShadow.setDelegateShadowFetch(null);
    reflectShadow.setReflectShadowFetchForTests(null);
    delegateShadow.definirEmissorSombra(null);
    if (envBefore.provider === undefined) delete process.env.TYPESAFE_PROVIDER; else process.env.TYPESAFE_PROVIDER = envBefore.provider;
    if (envBefore.typeSafeKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = envBefore.typeSafeKey;
    if (envBefore.openRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = envBefore.openRouterKey;
    if (envBefore.model === undefined) delete process.env.TYPESAFE_MODEL; else process.env.TYPESAFE_MODEL = envBefore.model;
    for (const flag of PROVIDER_SHADOW_FLAGS) {
      const previous = envBefore.flags[flag];
      if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous;
    }
  }
}

test("T-1174/T-1285: every credential canary stays redacted or dropped for every shadow and provider", async () => {
  let serial = 0;
  for (const provider of ["typesafe", "openrouter"] as const) {
    for (const shadow of ["task", "delegate", "reflect"] as const) {
      for (const fixture of fixtures) {
        serial++;
        const result = await runOne(shadow, fixture.value, serial, undefined, provider);
        const shouldSend = fixture.action !== "drop";
        assert.equal(result.calls.length, shouldSend ? 1 : 0, `${provider}/${shadow}/${fixture.name}: request count`);
        assert.equal(result.events.length, shouldSend ? (shadow === "reflect" ? 2 : 1) : 0, `${provider}/${shadow}/${fixture.name}: frame count`);
        const captured = JSON.stringify({ calls: result.calls.map(({ url, body, opts }) => ({ url, body, opts })), events: result.events, logs: result.logs });
        assert.equal(captured.includes(fixture.value), fixture.action === "benign", `${provider}/${shadow}/${fixture.name}: canary handling`);
        assert.equal(captured.includes(RAW_RESPONSE_CANARY), false, `${provider}/${shadow}/${fixture.name}: raw response is absent`);
        assert.equal(captured.includes("synthetic-typesafe-api-key-never-log"), false, `${provider}/${shadow}/${fixture.name}: TypeSafe key is absent outside Authorization`);
        assert.equal(captured.includes("synthetic-openrouter-api-key-never-log"), false, `${provider}/${shadow}/${fixture.name}: OpenRouter key is absent outside Authorization`);
        assert.equal(result.logs.some((line) => line.includes(fixture.value)), false, `${provider}/${shadow}/${fixture.name}: logs are sanitized`);
        assert.equal(result.logs.some((line) => line.includes("synthetic-typesafe-api-key-never-log") || line.includes("synthetic-openrouter-api-key-never-log")), false, `${provider}/${shadow}/${fixture.name}: keys are absent from logs`);
        if (shouldSend) {
          const verdict = shadow === "reflect"
            ? result.events.find(event => event.event === "verdict")
            : result.events[0];
          assert.equal(verdict?.ok, true, `${provider}/${shadow}/${fixture.name}: parser accepts response metadata id/provider/usage`);
          if (shadow === "reflect") assert.equal(verdict?.hasReusableLessonNoul, 0.8);
          const request = result.calls[0]!;
          const expectedUrl = provider === "openrouter" ? client.OPENROUTER_DECISIONS_URL : client.TYPESAFE_SYSTEMONE_URL;
          assert.equal(request.url, expectedUrl);
          assert.equal(request.headers.Authorization, `Bearer ${result.selectedKey}`);
          assert.ok(Buffer.byteLength(request.body, "utf8") <= client.TYPESAFE_MAX_BODY_BYTES);
          assert.equal(request.opts.timeoutMs, 2500);
          assert.equal(request.opts.maxRedirects, 0);
          assert.ok(request.body.includes("This task documents a normal retry behavior."));
          assert.equal(request.body.includes("PRIVATE_CONTEXT_CANARY"), false);
          assert.equal(request.body.includes("PRIVATE_TOOL_OUTPUT_CANARY"), false);
          assert.equal(request.body.includes("PRIVATE_AGENT_ID_CANARY"), false);
          const body = JSON.parse(request.body) as { model?: string; state?: unknown; questions?: unknown };
          assert.equal(body.model, provider === "openrouter" ? client.OPENROUTER_DEFAULT_MODEL : client.TYPESAFE_MODEL);
          assert.ok(body.state && body.questions, `${provider}/${shadow}: state and typed questions survive`);
        }
      }
    }
  }
});

test("T-1285: unknown provider fails closed with a generic log; OpenRouter without its key cannot fall back to TypeSafe", async () => {
  const unknown = await runOne("task", "ordinary task text", 5001, undefined, "unknown");
  assert.equal(unknown.calls.length, 0);
  assert.ok(unknown.logs.some((line) => line.includes("unknown TYPESAFE_PROVIDER")));
  assert.equal(unknown.logs.some((line) => line.includes("invalid-provider-fixture")), false);

  let serial = 5002;
  for (const shadow of ["task", "delegate", "reflect"] as const) {
    const missingOpenRouterKey = await runOne(shadow, "ordinary task text", serial++, undefined, "openrouter", false);
    assert.equal(missingOpenRouterKey.calls.length, 0, `${shadow}: missing OpenRouter key disables its gate and fetch`);
  }
});

test("T-1285: remembered project credential is not caught by token-pattern redaction", () => {
  assert.equal(client.prepararTexto(rememberedCredential, client.TYPESAFE_MAX_TEXTO_BYTES, "proj_without_a_remembered_credential"), rememberedCredential);
  assert.equal(client.prepararTexto(rememberedCredential, client.TYPESAFE_MAX_TEXTO_BYTES, PROJ), "");
});

test("T-1285: TYPESAFE_MODEL overrides the OpenRouter default in the request body", async () => {
  const prevProvider = process.env.TYPESAFE_PROVIDER;
  const prevOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const prevDirectKey = process.env.TYPESAFE_API_KEY;
  const prevModel = process.env.TYPESAFE_MODEL;
  const calls: Array<{ url: string; body: string; authorization: string }> = [];
  process.env.TYPESAFE_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "synthetic-openrouter-model-key";
  delete process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_MODEL = "typesafe/jev-fixture-model";
  try {
    const result = await client.chamarSystemOne({ model: client.TYPESAFE_MODEL, state: { text: "benign" }, questions: {} }, async (url, init) => {
      calls.push({ url, body: init.body, authorization: init.headers.Authorization! });
      return { status: 200, text: async () => JSON.stringify({ id: "fixture", provider: "TypeSafe", usage: { cost: 0 }, answers: {} }) };
    });
    assert.equal(result?.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, client.OPENROUTER_DECISIONS_URL);
    assert.equal(calls[0]!.authorization, "Bearer synthetic-openrouter-model-key");
    assert.equal((JSON.parse(calls[0]!.body) as { model: string }).model, "typesafe/jev-fixture-model");
  } finally {
    if (prevProvider === undefined) delete process.env.TYPESAFE_PROVIDER; else process.env.TYPESAFE_PROVIDER = prevProvider;
    if (prevOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevOpenRouterKey;
    if (prevDirectKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prevDirectKey;
    if (prevModel === undefined) delete process.env.TYPESAFE_MODEL; else process.env.TYPESAFE_MODEL = prevModel;
  }
});

test("T-1285: omitting TYPESAFE_PROVIDER keeps the direct TypeSafe endpoint as the default", async () => {
  const prevProvider = process.env.TYPESAFE_PROVIDER;
  const prevOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const prevDirectKey = process.env.TYPESAFE_API_KEY;
  const prevModel = process.env.TYPESAFE_MODEL;
  const calls: Array<{ url: string; body: string; authorization: string }> = [];
  delete process.env.TYPESAFE_PROVIDER;
  process.env.TYPESAFE_API_KEY = "synthetic-typesafe-default-key";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_MODEL;
  try {
    const result = await client.chamarSystemOne({ model: client.TYPESAFE_MODEL, state: { text: "benign" }, questions: {} }, async (url, init) => {
      calls.push({ url, body: init.body, authorization: init.headers.Authorization! });
      return { status: 200, text: async () => "{}" };
    });
    assert.equal(result?.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, client.TYPESAFE_SYSTEMONE_URL);
    assert.equal(calls[0]!.authorization, "Bearer synthetic-typesafe-default-key");
    assert.equal((JSON.parse(calls[0]!.body) as { model: string }).model, client.TYPESAFE_MODEL);
  } finally {
    if (prevProvider === undefined) delete process.env.TYPESAFE_PROVIDER; else process.env.TYPESAFE_PROVIDER = prevProvider;
    if (prevOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevOpenRouterKey;
    if (prevDirectKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prevDirectKey;
    if (prevModel === undefined) delete process.env.TYPESAFE_MODEL; else process.env.TYPESAFE_MODEL = prevModel;
  }
});

test("T-1174: benign prose survives, redaction happens before truncation, and body cap is absolute", async () => {
  const normal = "The token count and basic authentication concepts are discussed without credentials.";
  assert.equal(client.prepararTexto(normal), normal);
  const secret = join("sk", "-ant-truncationboundary0123456789ABCDEF");
  const near = client.prepararTexto(`${"x".repeat(56)} ${secret}`, 64, PROJ);
  assert.ok(near);
  assert.equal(near.includes(secret), false);
  assert.ok(Buffer.byteLength(near, "utf8") <= 64);

  assert.equal(client.serializarRequestSombra({ payload: "x".repeat(9000) }), null);
  const multiByte = client.prepararTexto("é".repeat(1500), 2048, PROJ);
  assert.ok(multiByte);
  assert.ok(Buffer.byteLength(multiByte, "utf8") <= 2048);
});

test("T-1174: task title and description each respect the UTF-8 byte cap on the captured request", async () => {
  const result = await runOne("task", "d".repeat(4000), 998, "t".repeat(4000));
  assert.equal(result.calls.length, 1);
  const body = JSON.parse(result.calls[0]!.body) as { state: { task: { title: string; description: string } } };
  assert.ok(Buffer.byteLength(body.state.task.title, "utf8") <= client.TYPESAFE_MAX_TEXTO_BYTES);
  assert.ok(Buffer.byteLength(body.state.task.description, "utf8") <= client.TYPESAFE_MAX_TEXTO_BYTES);
});
