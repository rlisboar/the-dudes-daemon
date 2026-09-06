/**
 * T-306 — Precedência de cliPaths na composição de configuração do daemon.
 *
 * Causa-raiz: o literal em parseCli (main.ts) montava cliPaths com TODAS as
 * chaves presentes — valor undefined quando sem flag/env — e o spread do
 * mergeCliConfig clobberava o cliPaths carregado do daemon-config.json
 * (ex.: cliPaths.claude="/tmp/claude" do arquivo virava undefined). Workar-
 * round do QA (T-274) era THE_DUDES_CLAUDE_PATH. Fix: cliPathsFromFlags só
 * emite campos com valor; ausente/undefined não sobrescreve o arquivo.
 *
 * Contrato (PM): precedência = override CLI explícito > daemon-config.json >
 * default. A composição replicada aqui é a mesma de main.ts (mergeCliConfig(
 * loadDaemonCliConfig(path), { cliPaths: cliPathsFromFlags(...) })).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// TEM que vir antes do import de main.js: desliga o SELF_BOOTSTRAP
// (mesmo padrão do t252-delivery-dedup-after-decrypt).
process.env.THE_DUDES_DAEMON_TEST = "1";

const { cliPathsFromFlags } = await import("../main.js");
const { mergeCliConfig, loadDaemonCliConfig, resolveCliCommands } = await import("../cli-config.js");

const NO_FLAGS = { claude: undefined, opencode: undefined, gemini: undefined, codex: undefined, crush: undefined, grok: undefined };
const NO_ENV: NodeJS.ProcessEnv = {};

/** daemon-config.json temporário com cliPaths arbitrários. */
function writeConfigFile(cliPaths: Record<string, string>): { dir: string; configPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "t306-config-"));
  const configPath = path.join(dir, "daemon-config.json");
  writeFileSync(configPath, JSON.stringify({ cliPaths }));
  return { dir, configPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Executável real (shebang + chmod 755) — resolveCliCommands precisa
 *  reportar available=true pro override provado de ponta a ponta. */
function writeExecutable(dir: string, name: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

/** Replica EXATAMENTE a composição de main.ts (args → cliConfig). */
function compose(configPath: string, flags: Record<string, string | undefined>, env: NodeJS.ProcessEnv) {
  const fileConfig = loadDaemonCliConfig(configPath);
  const cliPaths = cliPathsFromFlags(flags as never, env);
  return { cliPaths, cliConfig: mergeCliConfig(fileConfig, { cliPaths }) };
}

/* ---------- (A1) arquivo preservado quando CLI não fornece valor ---------- */

test("T-306 (A1): daemon-config.json com cliPaths.claude + CLI sem flags/envs preserva o valor do arquivo e resolve o runner", async () => {
  const binDir = mkdtempSync(path.join(tmpdir(), "t306-bin-"));
  after(() => rmSync(binDir, { recursive: true, force: true }));
  const realClaude = writeExecutable(binDir, "claude-fixture");
  const { configPath, cleanup } = writeConfigFile({ claude: realClaude });
  after(cleanup);

  const { cliPaths, cliConfig } = compose(configPath, NO_FLAGS, NO_ENV);
  // Objeto de args é esparso: campo ausente nem existe (nada a sobrescrever).
  assert.deepEqual(Object.keys(cliPaths), [], "CLI sem valor → cliPaths vazio");
  assert.equal(cliConfig.cliPaths?.claude, realClaude, "valor do daemon-config.json preservado");
  assert.equal(cliConfig.cliPaths?.grok, undefined);

  const resolved = resolveCliCommands(cliConfig).claude;
  assert.equal(resolved.source, "override", "runner resolvido pelo override do arquivo");
  assert.equal(resolved.command, realClaude);
  assert.equal(resolved.available, true, "executável real → available");
  assert.equal(resolved.resolvedPath, realClaude);
});

test("T-306 (A1 literal): cliPaths.claude=/tmp/claude do arquivo sobrevive sem o arquivo existir como executável", () => {
  const { configPath, cleanup } = writeConfigFile({ claude: "/tmp/claude" });
  after(cleanup);
  const { cliConfig } = compose(configPath, NO_FLAGS, NO_ENV);
  assert.equal(cliConfig.cliPaths?.claude, "/tmp/claude", "/tmp/claude preservado (não clobberado p/ undefined)");
});

/* ---------- (A2) override CLI explícito vence o arquivo ---------- */

test("T-306 (A2): --claude-path explícito diferente substitui o valor do arquivo", () => {
  const binDir = mkdtempSync(path.join(tmpdir(), "t306-bin2-"));
  after(() => rmSync(binDir, { recursive: true, force: true }));
  const fileClaude = writeExecutable(binDir, "claude-do-arquivo");
  const cliClaude = writeExecutable(binDir, "claude-do-cli");
  const { configPath, cleanup } = writeConfigFile({ claude: fileClaude });
  after(cleanup);

  const { cliConfig } = compose(configPath, { ...NO_FLAGS, claude: cliClaude }, NO_ENV);
  assert.equal(cliConfig.cliPaths?.claude, cliClaude, "flag explícita vence o daemon-config.json");

  const resolved = resolveCliCommands(cliConfig).claude;
  assert.equal(resolved.source, "override");
  assert.equal(resolved.command, cliClaude);
  assert.equal(resolved.available, true);
});

test("T-306 (A2 env): THE_DUDES_CLAUDE_PATH também é override explícito (workaround T-274 segue válido)", () => {
  const { configPath, cleanup } = writeConfigFile({ claude: "/tmp/claude" });
  after(cleanup);
  const { cliConfig } = compose(configPath, NO_FLAGS, { THE_DUDES_CLAUDE_PATH: "/opt/claude" });
  assert.equal(cliConfig.cliPaths?.claude, "/opt/claude", "env explícito vence o arquivo");
});

/* ---------- (A3) só um campo CLI fornecido → demais campos do arquivo ficam ---------- */

test("T-306 (A3): só --claude-path fornecido → cliPaths.grok do arquivo permanece", () => {
  const binDir = mkdtempSync(path.join(tmpdir(), "t306-bin3-"));
  after(() => rmSync(binDir, { recursive: true, force: true }));
  const fileGrok = writeExecutable(binDir, "grok-do-arquivo");
  const cliClaude = writeExecutable(binDir, "claude-do-cli");
  const { configPath, cleanup } = writeConfigFile({ claude: "/tmp/claude", grok: fileGrok });
  after(cleanup);

  const { cliConfig } = compose(configPath, { ...NO_FLAGS, claude: cliClaude }, NO_ENV);
  assert.equal(cliConfig.cliPaths?.claude, cliClaude, "campo com flag explícita → override");
  assert.equal(cliConfig.cliPaths?.grok, fileGrok, "campo sem flag → valor do arquivo preservado");

  const grok = resolveCliCommands(cliConfig).grok;
  assert.equal(grok.source, "override");
  assert.equal(grok.available, true);
});

/* ---------- guarda de valores vazios ---------- */

test("T-306: flag vazia/whitespace não é override — valor do arquivo permanece", () => {
  const { configPath, cleanup } = writeConfigFile({ claude: "/tmp/claude" });
  after(cleanup);
  const { cliPaths, cliConfig } = compose(configPath, { ...NO_FLAGS, claude: "   " }, NO_ENV);
  assert.deepEqual(Object.keys(cliPaths), [], "string vazia não entra no cliPaths");
  assert.equal(cliConfig.cliPaths?.claude, "/tmp/claude");
});
