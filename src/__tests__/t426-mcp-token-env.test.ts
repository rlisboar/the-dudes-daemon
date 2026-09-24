/**
 * T-426 (A15): token de MCP extra fora de argv (codex) e fora do repo (crush).
 *
 * Evidência de contrato:
 *  1. argv do codex (dump do `$@` pelo CLI falso) NÃO contém o valor do token
 *     e não usa `-c mcp_servers...`; o valor vive no `<CODEX_HOME>/config.toml`
 *     (mode 0600, fora do git worktree);
 *  2. `.crush.json` no workspace só tem `$VAR` para env/headers — nenhum valor
 *     secreto é stagediável (`git add -A` não carrega token);
 *  3. o valor literal chega ao processo (env do crush / config do codex).
 */
import "./scratch-home.js";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";

const SEGREDO = "TOKEN-SECRETO-426";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")} -> ${r.status}`);
  return r.stdout.trim();
}

function workspaceRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "t426-ws-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t426@test"]);
  git(dir, ["config", "user.name", "T426"]);
  writeFileSync(path.join(dir, "README"), "root\n");
  git(dir, ["add", "README"]);
  git(dir, ["commit", "-m", "init"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeRunner(runner: "codex" | "crush", opts: Record<string, unknown>): AgentRunner {
  const info = {
    id: `agent_t426_${runner}`, ownerUserId: "user_t426", name: `probe-${runner}`, role: "backend",
    systemPrompt: "", color: "#a78bfa", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const cliCommands = {
    ...resolveCliCommands(),
    codex: { command: "codex", source: "override" as const, available: true },
    crush: { command: "crush", source: "override" as const, available: true },
  };
  return new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: runner, autoApprove: true, workspaceRoot: tmpdir(),
    cliCommands, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: () => {}, onExit: () => {},
    ...opts,
  } as never);
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;

/** runCodexMessage resolve logo após wire dos listeners — espera o CLI falso. */
// T-1088: 20s — sob carga o CLI falso demora a rodar (era 8s).
async function waitFor(cond: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

test("T-426 codex: token fora do argv; config.toml 0600 fora do worktree", async () => {
  const homeBase = mkdtempSync(path.join(tmpdir(), "t426-codexhome-"));
  const ws = workspaceRepo();
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeBase;
  const argvDump = path.join(homeBase, "argv.txt");
  const fake = path.join(homeBase, "fake-codex.sh");
  // T-897/T-709: publicação ATÔMICA (o `.home` era lido antes de existir — ENOENT
  // no CI e no sandbox). Os dois vão para `.tmp` e o `mv` do argv.txt é o último
  // passo: argv.txt existe ⇒ .home existe.
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvDump}.tmp"\nprintf '%s\\n' "$CODEX_HOME" > "${argvDump}.home.tmp"\nmv "${argvDump}.home.tmp" "${argvDump}.home"\nmv "${argvDump}.tmp" "${argvDump}"\nprintf '%s\\n' '{"type":"thread.started","thread_id":"s426"}' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}'\n`);
  chmodSync(fake, 0o755);

  const runner = makeRunner("codex", {
    workspaceRoot: ws.dir,
    extraMcpServers: { tokensrv: { command: "tool", env: { API_KEY: SEGREDO } } },
    cliCommands: { ...resolveCliCommands(), codex: { command: fake, source: "override", available: true } },
  });
  after(() => { runner.stop(); });

  await Promise.race([
    asAny(runner).runCodexMessage("ping"),
    // T-1088: 8s era apertado sob carga (o CLI falso demora a rodar).
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
  assert.ok(await waitFor(() => existsSync(argvDump)), "CLI falso do codex não rodou");
  const argv = readFileSync(argvDump, "utf8");
  assert.doesNotMatch(argv, new RegExp(SEGREDO), "valor do token vazou no argv do codex");
  assert.doesNotMatch(argv, /mcp_servers\./, "codex ainda usa -c mcp_servers (deveria ser config.toml)");
  assert.doesNotMatch(argv, /^-c$/m, "codex ainda recebe -c");

  const codexHome = readFileSync(`${argvDump}.home`, "utf8").trim();
  const configPath = path.join(codexHome, "config.toml");
  assert.ok(existsSync(configPath), "config.toml do CODEX_HOME não foi criado");
  assert.equal(statSync(configPath).mode & 0o777, 0o600, "config.toml precisa ser 0600");
  assert.match(readFileSync(configPath, "utf8"), new RegExp(SEGREDO), "token deveria estar no config.toml");
  assert.ok(!configPath.startsWith(ws.dir + path.sep), "config.toml não pode viver no git worktree do projeto");

  if (prevHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevHome;
  rmSync(homeBase, { recursive: true, force: true });
  ws.cleanup();
});

test("T-426 crush: .crush.json sem valores, env do processo com os literais, git add -A limpo", async () => {
  const ws = workspaceRepo();
  const runner = makeRunner("crush", {
    workspaceRoot: ws.dir,
    extraMcpServers: {
      tokensrv: { command: "tool", env: { API_KEY: SEGREDO } },
      remote: { type: "http", url: "https://mcp", headers: { Authorization: `Bearer ${SEGREDO}` } },
    },
  });
  after(() => { runner.stop(); });

  asAny(runner).writeCrushConfig();
  const configPath = path.join(ws.dir, ".crush.json");
  assert.ok(existsSync(configPath), ".crush.json não foi escrito");
  const raw = readFileSync(configPath, "utf8");
  assert.doesNotMatch(raw, new RegExp(SEGREDO), "valor do token vazou pro .crush.json (repo)");
  const parsed = JSON.parse(raw) as { mcp: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }> };
  assert.match(parsed.mcp.tokensrv.env!.API_KEY, /^\$THEDUDES_MCP_/, "env do extra deveria ser $VAR");
  assert.match(parsed.mcp.remote.headers!.Authorization, /^\$THEDUDES_MCP_/, "header do extra deveria ser $VAR");

  const env = asAny(runner).crushTurnEnv() as Record<string, string>;
  const ref = parsed.mcp.tokensrv.env!.API_KEY.slice(1);
  assert.equal(env[ref], SEGREDO, "literal precisa chegar no env do processo crush");

  // critério 4: `git add -A` no workspace não stagedia token
  git(ws.dir, ["add", "-A"]);
  const staged = git(ws.dir, ["show", ":.crush.json"]);
  assert.doesNotMatch(staged, new RegExp(SEGREDO), "token stagediado no workspace");
  ws.cleanup();
});