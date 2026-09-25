/**
 * T-1018: o config.toml POR AGENTE (T-426) precisa espelhar as chaves de
 * modelo do config.toml do dono. O CODEX_HOME isolado não herda a config da
 * base — sem o espelho, o codex gerenciado roda com a janela default do
 * catálogo (272k → 258.400 efetivo com 5% de reserve) mesmo com
 * model_context_window maior no config do dono, e a UI (T-245) mostra 258k.
 *
 * Evidência de contrato:
 *  1. extractTopLevelTomlValues pega inteiro (underscore ok, comentário à
 *     direita descartado) e string; ignora chaves DENTRO de [seções] e
 *     formas não re-emissíveis (array, string multilinha, boolean);
 *  2. writeCodexConfig gera o config por agente com as chaves espelhadas
 *     ANTES da primeira seção (TOML válido), MCPs intactos, mode 0600, e
 *     sem arrastar seções do dono;
 *  3. base sem config.toml não quebra — gera só com MCPs.
 */
import "./scratch-home.js";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";
import { CODEX_MODEL_MIRROR_KEYS, extractTopLevelTomlValues } from "../runners/mcp-config.js";

function makeRunner(opts: Record<string, unknown>): AgentRunner {
  const info = {
    id: "agent_t1018_codex", ownerUserId: "user_t1018", name: "probe-t1018", role: "backend",
    systemPrompt: "", color: "#a78bfa", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  return new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "codex", autoApprove: true, workspaceRoot: tmpdir(),
    cliCommands: { ...resolveCliCommands(), codex: { command: "codex", source: "override" as const, available: true } },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onExit: () => {},
    ...opts,
  } as never);
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;

test("T-1018 extractTopLevelTomlValues: int/underscore/comentário e string; seções e formas exóticas ignoradas", () => {
  const src = [
    "# cabeçalho do dono",
    'model = "gpt-6-luna"',
    "model_context_window = 500_000 # janela ampliada",
    'model_reasoning_effort = "medium"',
    "model_auto_compact_token_limit = 400000",
    "",
    "[projects./tmp/x]",
    "trust_level = \"trusted\"",
    "",
    "[mcp_servers.dono]",
    'model_context_window = 999',
    'command = "foo"',
  ].join("\n");
  assert.deepEqual(extractTopLevelTomlValues(src, CODEX_MODEL_MIRROR_KEYS), {
    model_context_window: "500_000",
    model_reasoning_effort: '"medium"',
    model_auto_compact_token_limit: "400000",
  });

  assert.deepEqual(
    extractTopLevelTomlValues(
      ['model_context_window = [1, 2]', 'model_reasoning_effort = """multi"""', "model_auto_compact_token_limit = true"].join("\n"),
      CODEX_MODEL_MIRROR_KEYS,
    ),
    {},
    "array/string multilinha/boolean não são re-emissíveis — ignorar",
  );

  // duplicada no top-level: primeira vence
  assert.deepEqual(
    extractTopLevelTomlValues("model_context_window = 1\nmodel_context_window = 2", CODEX_MODEL_MIRROR_KEYS),
    { model_context_window: "1" },
  );
});

test("T-1018 writeCodexConfig: chaves do dono entram no config por agente, antes da 1ª seção", () => {
  const homeBase = mkdtempSync(path.join(tmpdir(), "t1018-home-"));
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeBase;
  writeFileSync(path.join(homeBase, "config.toml"), [
    'model = "gpt-6-luna"',
    "model_context_window = 500_000",
    "model_auto_compact_token_limit = 400_000",
    'model_reasoning_effort = "medium"',
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    "",
    "[mcp_servers.dono]",
    'command = "deveria-nao-vazar"',
  ].join("\n"));

  const runner = makeRunner({});
  after(() => { runner.stop(); });
  asAny(runner).writeCodexConfig();

  const agentHome = asAny(runner).runtimeFiles.codexHomeDir();
  assert.equal(path.dirname(agentHome), path.join(homeBase, ".the-dudes-agent-homes"), "home por agente fica fora de agents/");
  const configPath = path.join(agentHome, "config.toml");
  assert.ok(existsSync(configPath), "config.toml do agente não foi escrito");
  assert.equal(statSync(configPath).mode & 0o777, 0o600, "config.toml precisa continuar 0600");
  const raw = readFileSync(configPath, "utf8");
  assert.match(raw, /^model_context_window = 500_000$/m, "janela do dono espelhada");
  assert.match(raw, /^model_auto_compact_token_limit = 400_000$/m);
  assert.match(raw, /^model_reasoning_effort = "medium"$/m);
  assert.doesNotMatch(raw, /^sandbox_mode\s*=/m, "config do dono não pode alterar o sandbox do agente");
  assert.doesNotMatch(raw, /^approval_policy\s*=/m, "config do dono não pode alterar a política de aprovação do agente");
  const configLines = raw.split(/\r?\n/);
  const firstSection = configLines.findIndex(line => line.trimStart().startsWith("["));
  const emittedTopLevelKeys = configLines.slice(0, firstSection < 0 ? undefined : firstSection)
    .flatMap(line => line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1] ?? [])
    .sort();
  assert.deepEqual(
    emittedTopLevelKeys,
    [...CODEX_MODEL_MIRROR_KEYS].sort(),
    "o conjunto de chaves espelhadas deve permanecer fechado e exato",
  );
  assert.ok(
    raw.indexOf("model_context_window") < raw.indexOf("["),
    "chaves de modelo precisam vir ANTES da primeira seção (TOML válido)",
  );
  assert.match(raw, /\[mcp_servers\.the-dudes\]/, "bridge MCP continua no config gerado");
  assert.doesNotMatch(raw, /deveria-nao-vazar/, "seções do dono NÃO são copiadas — só chaves de modelo");

  if (prevHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevHome;
  rmSync(homeBase, { recursive: true, force: true });
});

test("T-1018: base sem config.toml não quebra — gera só com MCPs", () => {
  const homeBase = mkdtempSync(path.join(tmpdir(), "t1018-semowner-"));
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeBase;

  const runner = makeRunner({});
  after(() => { runner.stop(); });
  asAny(runner).writeCodexConfig();

  const agentHome = asAny(runner).runtimeFiles.codexHomeDir();
  const raw = readFileSync(path.join(agentHome, "config.toml"), "utf8");
  assert.doesNotMatch(raw, /model_context_window/, "sem config do dono, nada é espelhado");
  assert.match(raw, /\[mcp_servers\.the-dudes\]/);

  if (prevHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevHome;
  rmSync(homeBase, { recursive: true, force: true });
});
