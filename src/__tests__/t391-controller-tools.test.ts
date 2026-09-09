/**
 * T-391 — Controller no runner/bridge: registo por papel, ops da T-390, env,
 * prompt e relay E2EE.
 *
 * A3/A5: um agente role=backend (ou qualquer não-controller) NÃO recebe
 * save_agent/stop_agent na lista, MESMO com `teammates` ligado no projeto —
 * porque a visibilidade é papel, não feature.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";
import { bridgeToolAllowed, CONTROLLER_ROLE, ROLE_GATED_TOOLS, TOOL_GROUP } from "../bridge-tool-gate.js";
import { buildBridgeEnv } from "../runners/mcp-config.js";
import { buildSystemPromptHeader } from "../runners/prompts.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BRIDGE = readFileSync(join(AQUI, "../mcp-bridge.ts"), "utf8");
const RUNNER = readFileSync(join(AQUI, "../agent-runner.ts"), "utf8");
const RELAY = readFileSync(join(AQUI, "../bridge-relay.ts"), "utf8");

// --- A3/A5: gate de registo (comportamento puro, sem importar o bridge) ----

test("T-391 A3/A5: backend com teammates ligado NÃO recebe save_agent/stop_agent; controller recebe", () => {
  const on = new Set(["teammates", "tasks", "filelock", "memory", "goals", "credentials", "webhooks"]);
  assert.equal(bridgeToolAllowed("save_agent", on, "backend"), false);
  assert.equal(bridgeToolAllowed("stop_agent", on, "backend"), false);
  assert.equal(bridgeToolAllowed("save_agent", on, CONTROLLER_ROLE), true);
  assert.equal(bridgeToolAllowed("stop_agent", on, CONTROLLER_ROLE), true);
  // Daemon velho sem THE_DUDES_FEATURES (grupos=null): papel continua a mandar
  assert.equal(bridgeToolAllowed("save_agent", null, "backend"), false);
  assert.equal(bridgeToolAllowed("save_agent", null, CONTROLLER_ROLE), true);
  // Papel é exacto — nem case, nem prefixo, nem vazio
  assert.equal(bridgeToolAllowed("save_agent", on, "Controller"), false);
  assert.equal(bridgeToolAllowed("stop_agent", on, ""), false);
  // Tools vizinhas inertes ao papel; feature continua a mandar nelas
  assert.equal(bridgeToolAllowed("send_message", on, CONTROLLER_ROLE), true);
  assert.equal(bridgeToolAllowed("send_message", new Set(["tasks"]), CONTROLLER_ROLE), false);
  assert.equal(bridgeToolAllowed("approve_action", new Set(), "member"), true, "approve_action é sempre on");
});

test("T-391 rulings: sem TOOL_GROUP \"control\", sem mapear as ops de papel a \"teammates\", só as duas tools são gated", () => {
  assert.ok(!Object.values(TOOL_GROUP).includes("control"), "grupo \"control\" foi inventado");
  assert.deepEqual(Object.keys(ROLE_GATED_TOOLS).sort(), ["save_agent", "stop_agent"]);
  assert.ok(!("save_agent" in TOOL_GROUP) && !("stop_agent" in TOOL_GROUP), "ops de papel não têm grupo de feature");
  assert.equal(ROLE_GATED_TOOLS.save_agent, CONTROLLER_ROLE);
  assert.equal(CONTROLLER_ROLE, "controller");
});

test("T-391: env do bridge leva o papel só quando o runner o declara (ponto único dos 4 writers)", () => {
  const base = { agentId: "a1", agentName: "a1", orchestratorUrl: "http://x", tokenFile: "/tmp/t" };
  assert.equal(buildBridgeEnv({ ...base, role: "controller" }).THE_DUDES_AGENT_ROLE, "controller");
  assert.equal(buildBridgeEnv({ ...base, role: "backend" }).THE_DUDES_AGENT_ROLE, "backend");
  assert.equal("THE_DUDES_AGENT_ROLE" in buildBridgeEnv(base), false, "sem papel declarado não se injeta vazio");
  // O runner passa this.info.role pelo único funil que os 4 config writers partilham
  assert.match(RUNNER, /buildBridgeEnv\(\{[\s\S]{0,700}role: this\.info\.role,\s*\}\)/);
});

test("T-391: --allowed-tools do claude só lista as tools de controller para quem é controller", () => {
  assert.match(
    RUNNER,
    /if \(this\.info\.role === CONTROLLER_ROLE\) \{\s*baseAllowed\.push\("mcp__the-dudes__save_agent", "mcp__the-dudes__stop_agent"\);\s*\}/,
  );
});

test("T-391: prompt do controller no ponto único, keyed só no papel (teammates off não cega)", () => {
  const com = buildSystemPromptHeader(undefined, { controller: true });
  assert.match(com, /save_agent/);
  assert.match(com, /stop_agent/);
  assert.match(com, /confirmName/);
  assert.match(com, /never starts/i);
  const sem = buildSystemPromptHeader();
  assert.ok(!sem.includes("save_agent"), "não-controller levou prosa de controller");
  const sozinhos = buildSystemPromptHeader({ teammates: false }, { controller: true });
  assert.match(sozinhos, /save_agent/, "teammates desligado cegou a prosa do controller");
});

test("T-391: as tools MCP chamam as ops HTTP da T-390 sem reinventar corpo nem schema", () => {
  assert.match(BRIDGE, /server\.tool\(\s*"save_agent"/);
  assert.match(BRIDGE, /postJSON\("agent_save", \{ spec \}\)/);
  assert.match(BRIDGE, /server\.tool\(\s*"stop_agent"/);
  assert.match(BRIDGE, /postJSON\("agent_stop", \{ name, confirmName \}\)/);
  // O shape É o agentSpec do protocolo, drillado do schema congelado
  assert.match(BRIDGE, /commandSchemas\.save_agent[\s\S]{0,160}\.shape\.spec/);
  // O patch consulta o gate único com o papel vindo do runner
  assert.match(BRIDGE, /const _agentRole = process\.env\.THE_DUDES_AGENT_ROLE/);
  assert.match(BRIDGE, /bridgeToolAllowed\(name, _enabledGroups, _agentRole\)/);
});

test("T-391: kind do relay é o op do path — nunca o nome MCP save_agent; agent_stop não passa do relay", () => {
  assert.match(RELAY, /\| "agent_save"/);
  assert.match(RELAY, /kind === "agent_save"/);
  assert.match(RELAY, /plans_apply_tasks\|agent_save\)\$/);
  assert.ok(!/"save_agent"/.test(RELAY), "string literal \"save_agent\" não pode ser kind do relay");
  assert.ok(!RELAY.includes("agent_stop"), "agent_stop não tem campos de catálogo — não entra no relay");
});

// --- relay ponta-a-ponta: cifra em voo, 409 fail-closed, stop pass-through ---

test("T-391 relay POST: agent_save sobe cifrado, agent_stop passa cru, required sem chave dá 409 sem chegar ao upstream", async () => {
  process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t391-key-${process.pid}-${Date.now()}.pem`);
  process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t391-pkeys-${process.pid}-${Date.now()}.json`);
  process.env.THE_DUDES_PEER_PID_INSECURE = "1"; // self-test false → modo explícito dos testes de relay
  const { getDaemonPublicKey, rememberProjectKey, setE2eeRequired, decryptForProject } = await import("../daemon-crypto.js");
  const { BridgeRelay } = await import("../bridge-relay.js");
  const { aadV2, E2EE_TABLE } = await import("@the-dudes/protocol/e2ee-fields");

  const PID = "t391-proj";
  const PID_SEM_CHAVE = "t391-sem-chave";
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  rememberProjectKey(PID, publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes).toString("base64"));

  const vistos: { path: string; body: string }[] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      vistos.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const porta = (upstream.address() as { port: number }).port;
  const relay = new BridgeRelay(
    `http://127.0.0.1:${porta}`,
    null,
    (aid) => (aid === "a-sem-chave" ? PID_SEM_CHAVE : PID),
    { peerPidSelfTest: async () => false },
  );
  await relay.start();

  const post = (agent: string, op: string, body: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          socketPath: relay.socketPath,
          method: "POST",
          path: `/api/bridge/${agent}/${op}`,
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });

  try {
    // feliz: systemPrompt chega cifrado AO UPSTREAM com o AAD canônico; identificadores ficam crus
    const r1 = await post("a1", "agent_save", { spec: { name: "qa2", role: "qa", systemPrompt: "claro via relay" } });
    assert.equal(r1.status, 200);
    assert.equal(vistos[0]!.path, "/api/bridge/a1/agent_save");
    const corpo = JSON.parse(vistos[0]!.body) as { spec: Record<string, string> };
    assert.ok(String(corpo.spec.systemPrompt).startsWith("e2e:v2:"), "subiu em claro pro server");
    assert.equal(corpo.spec.name, "qa2");
    assert.equal(corpo.spec.role, "qa");
    assert.equal(
      decryptForProject(corpo.spec.systemPrompt, PID, aadV2({ projectId: PID, table: E2EE_TABLE.AGENTS, field: "system_prompt" })),
      "claro via relay",
    );

    // agent_stop: corpo idêntico — nome é identificador, não campo de catálogo
    const r2 = await post("a1", "agent_stop", { name: "qa2", confirmName: "qa2" });
    assert.equal(r2.status, 200);
    assert.deepEqual(JSON.parse(vistos[1]!.body), { name: "qa2", confirmName: "qa2" });

    // e2eeRequired sem chave: 409 do próprio relay, upstream nunca vê o request
    setE2eeRequired(PID_SEM_CHAVE, true);
    try {
      const r3 = await post("a-sem-chave", "agent_save", { spec: { name: "x", role: "r", systemPrompt: "claro" } });
      assert.equal(r3.status, 409);
      assert.equal(vistos.length, 2, "409 vazou pro upstream");
    } finally {
      setE2eeRequired(PID_SEM_CHAVE, false);
    }
  } finally {
    relay.stop();
    upstream.close();
    delete process.env.THE_DUDES_PEER_PID_INSECURE;
  }
});
