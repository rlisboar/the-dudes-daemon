/**
 * T-796: em 2026-09-22T15:07:23Z os 8 agentes dsh falharam o prompt em ~180ms
 * (após boot cold de ~54s) com `acp -32603: no API key for provider route
 * "deepseek-official"`. O catálogo ACP do dsh marca o par
 * `["deepseek-official","deepseek-v4-flash"]` como DEFAULT (medido no host:
 * 5 modelos, esse como currentValue) e o agente chegava com esse model
 * preenchido — o runner só caía no dsflash quando o model estava VAZIO.
 *
 * O fake reproduz a rota sem chave (FAKE_ACP_REQUIRE_DSFLASH): o prompt só
 * passa se a sessão tiver sido configurada para dsflash.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRunner } from "../agent-runner.js";
import { DSH_DEFAULT_MODEL, dshModelForTurn, dshModelRoute } from "../runners/turns/dsh.js";
import { resolveRunnerSettings } from "../runner-defaults-local.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-server.mjs", import.meta.url));
const OFICIAL = '["deepseek-official","deepseek-v4-flash"]';

const until = async (fn: () => boolean, ms: number, label: string) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("T-796: policy de modelo — sem model e rota sem chave caem no dsflash; rota com chave é preservada", () => {
  assert.equal(dshModelForTurn(undefined), DSH_DEFAULT_MODEL, "sem model → dsflash");
  assert.equal(dshModelForTurn("   "), DSH_DEFAULT_MODEL, "model em branco → dsflash");
  assert.equal(dshModelForTurn(OFICIAL), DSH_DEFAULT_MODEL, "default official do catálogo → dsflash");
  assert.equal(dshModelForTurn('["deepseek-official","deepseek-v4-pro"]'), DSH_DEFAULT_MODEL, "official sem chave → dsflash");
  assert.equal(dshModelForTurn(DSH_DEFAULT_MODEL), DSH_DEFAULT_MODEL, "dsflash explícito é preservado");
  assert.equal(dshModelForTurn('["dsflash","deepseek-flash-41"]'), DSH_DEFAULT_MODEL);
  assert.equal(dshModelRoute(OFICIAL), "deepseek-official");
  assert.equal(dshModelRoute("value fora do formato par"), null);
});

function makeRunner(dir: string, model?: string) {
  const texts: string[] = [];
  const errors: string[] = [];
  const info = {
    id: "agent_t796dsh", ownerUserId: "u", name: "probe", role: "backend",
    systemPrompt: "sys", color: "#7aa2ff", state: "idle", running: true,
    model, collectThinking: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: ["-e", ""], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "dsh", autoApprove: true, workspaceRoot: dir,
    cliCommands: { dsh: { command: FIXTURE, available: true, source: "override" } },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: (t: string) => { texts.push(t); return true; },
    onThinkingText: () => {}, onToolUse: () => {},
    onError: (m: string) => { errors.push(m); }, onHung: () => {}, onExit: () => {},
  } as never);
  return { runner, texts, errors };
}

const readLog = (p: string) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

async function turnCom(model: string | undefined, requireDsflash = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "t796dsh-"));
  const logPath = path.join(dir, "acp.jsonl");
  const prev = process.env.FAKE_ACP_LOG;
  const prevPass = process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH;
  const prevKey = process.env.FAKE_ACP_REQUIRE_DSFLASH;
  process.env.FAKE_ACP_LOG = logPath;
  process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = "FAKE_ACP_LOG,FAKE_ACP_REQUIRE_DSFLASH";
  if (requireDsflash) process.env.FAKE_ACP_REQUIRE_DSFLASH = "1";
  else delete process.env.FAKE_ACP_REQUIRE_DSFLASH;
  const { runner, texts, errors } = makeRunner(dir, model);
  try {
    await runner.start();
    runner.pushUserMessage("responda OK");
    await until(() => texts.length > 0, 10_000, `turno dsh (model=${model})`);
    const sets = readLog(logPath)
      .filter((e) => e.dir === "recv" && e.method === "session/set_config_option")
      .map((e) => String((e.params as { value?: string })?.value ?? ""));
    return { textos: texts.join(""), sets, errors };
  } finally {
    runner.stop();
    if (prev === undefined) delete process.env.FAKE_ACP_LOG; else process.env.FAKE_ACP_LOG = prev;
    if (prevPass === undefined) delete process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH; else process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = prevPass;
    if (prevKey === undefined) delete process.env.FAKE_ACP_REQUIRE_DSFLASH; else process.env.FAKE_ACP_REQUIRE_DSFLASH = prevKey;
  }
}

test("T-796: agente dsh sem model → sessão em dsflash e o prompt não vai para official", async () => {
  const r = await turnCom(undefined);
  assert.equal(r.textos, "OK", "prompt completou (rota com chave)");
  assert.deepEqual(r.sets, [DSH_DEFAULT_MODEL], "único set_config_option de model é o dsflash");
  assert.equal(r.errors.some((e) => /no API key/.test(e)), false, "sem -32603 da rota official");
});

test("T-796: agente dsh com o default official do catálogo → set_config_option model = dsflash", async () => {
  const r = await turnCom(OFICIAL);
  assert.equal(r.textos, "OK", "prompt completou: a sessão foi movida para dsflash");
  assert.deepEqual(r.sets, [DSH_DEFAULT_MODEL], "o par official do catálogo vira dsflash antes do prompt");
  assert.equal(r.errors.some((e) => /no API key/.test(e)), false);
});

test("T-1336: resolveRunnerSettings keeps the dsh OpenRouter pair through the real ACP turn", async () => {
  const pair = '["openrouter","meta/muse-spark-1.3-contributor"]';
  const settings = resolveRunnerSettings({
    runner: "dsh",
    agent: { model: pair },
    configAliases: { claude: [] },
    home: tmpdir(),
    warn: (message) => { throw new Error(message); },
  });
  assert.equal(settings.model, pair);
  const result = await turnCom(settings.model, false);
  assert.equal(result.textos, "OK", "ACP turno completou usando o modelo resolvido");
  assert.deepEqual(result.sets, [pair], "o par selecionado chegou intacto ao set_config_option model do dsh");
});
