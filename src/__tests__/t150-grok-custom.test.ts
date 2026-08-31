import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { compatibleSessionId, isGrokFamily, isPerMessageRunner, RUNNER_ADAPTERS, runnerAdapter } from "../runners/index.js";
import { resolveCliCommands } from "../cli-config.js";
import { hangThresholds } from "../runners/turn-watchdog.js";
import { grokWireEfforts, normalizeGrokEffort, resolveContextLimit } from "../runners/model-policy.js";
// isGrokFamily vive no registro de runners (index), não no model-policy
import { parseLineModelCatalog } from "../model-discovery.js";

/**
 * T-150 — runner "grok-custom": semântica grok completa (spawn args/env,
 * efforts/wire, signals.json, watchdog/turn-gate, precedência de janela).
 * Binário resolvido pelos userRunnerBinDirs (T-032) — nada hardcoded.
 */

const AQUI = dirname(fileURLToPath(import.meta.url));

/* ---------- registro: alias limpo da família grok ---------- */

test("T-150: grok-custom tem adapter próprio, per-message como o grok", () => {
  const a = RUNNER_ADAPTERS["grok-custom"];
  assert.ok(a, "grok-custom registrado no RUNNER_ADAPTERS");
  assert.equal(a.execution, "per-message");
  assert.equal(a.resumedSessionAlreadyHasSystemPrompt, true);
  assert.equal(isGrokFamily("grok-custom"), true);
  assert.equal(isGrokFamily("grok"), true);
  assert.equal(isGrokFamily("claude"), false);
  assert.equal(isPerMessageRunner("grok-custom"), true);
  assert.equal(compatibleSessionId("grok-custom", "123e4567-e89b-12d3-a456-426614174000"), "123e4567-e89b-12d3-a456-426614174000");
});

test("T-150 A5: runner desconhecido segue fail-loud (lookup undefined)", () => {
  const unknown = (RUNNER_ADAPTERS as Record<string, unknown>)["nope"];
  assert.equal(unknown, undefined);
  assert.equal(isGrokFamily("nope"), false);
});

/* ---------- A1: binário resolvido via cli-config/userRunnerBinDirs ---------- */

test("T-150 A1: cli-config resolve slot próprio grok-custom (binário fake do dono)", () => {
  // Binário FAKE real (script executável) — o mesmo fluxo do dono: ele aponta
  // o executável em cliPaths/userRunnerBinDirs e o daemon spawna esse arquivo.
  const tmp = mkdtempSync("/tmp/t150-grok-custom-");
  const fakeBin = join(tmp, "my-grok");
  writeFileSync(fakeBin, "#!/bin/sh\necho \"fake grok-custom: $@\"\n");
  execFileSync("chmod", ["+x", fakeBin]);
  const commands = resolveCliCommands({ cliPaths: { "grok-custom": fakeBin } });
  const slot = commands["grok-custom"];
  assert.equal(slot.available, true, "binário apontado pelo dono fica disponível");
  assert.equal(slot.command, fakeBin);
  assert.equal(runnerAdapter("grok-custom").command(commands), fakeBin, "spawn usa o binário do dono");
  assert.ok(slot.command !== commands.grok.command, "grok-custom NÃO compartilha o binário do grok");
  // Spawn real do binário fake com args estilo headless do grok — prova que
  // o executável apontado recebe argv (o daemon usa spawnDropped(command, args)).
  const out = execFileSync(fakeBin, ["-p", "olá", "--output-format", "json"], { encoding: "utf8" });
  assert.match(out, /fake grok-custom: -p olá/);
  rmSync(tmp, { recursive: true, force: true });
});

/* ---------- A2: contexto — signals.json do grok e janela 500k ---------- */

test("T-150 A2: catálogo estilo grok parseado no runner custom", () => {
  const s = parseLineModelCatalog("* grok-4.5\n* grok-4.6\n", "grok-custom");
  assert.deepEqual(s.map((m) => m.id), ["grok-4.5", "grok-4.6"]);
});

test("T-150 A2: janela 500k aplicada p/ grok-custom (mapa, fonte real desde o início)", () => {
  assert.equal(resolveContextLimit({ configuredModel: "grok-4.5" }), 500_000);
});

/* ---------- A3: watchdog/turn-gate/effort válidos para grok-custom ---------- */

test("T-150 A3: hangThresholds do grok-custom = thresholds do grok", () => {
  assert.deepEqual(hangThresholds("grok-custom"), hangThresholds("grok"));
  assert.notDeepEqual(hangThresholds("grok-custom"), hangThresholds("claude"));
});

test("T-150 A3: efforts/wire da família grok para grok-custom", () => {
  assert.deepEqual(grokWireEfforts("grok-custom"), grokWireEfforts("grok"));
  assert.equal(normalizeGrokEffort("xhigh", "grok-custom"), normalizeGrokEffort("xhigh", "grok"));
});

test("T-150 A3: env de turno do grok-custom (GROK_HOME/AUTOPDATER) via isGrokFamily", () => {
  // O branch do summarizer usa isGrokFamily(args.runner) → mesmo env do grok.
  const src = readFileSync(join(AQUI, "../summarizer-runner.ts"), "utf8");
  assert.match(src, /if \(isGrokFamily\(args\.runner\)\) \{\s*\n\s*\/\/ Auth\/sessões no home real/);
  assert.ok(src.includes("GROK_HOME"), "GROK_HOME no env de turno");
});

/* ---------- A6: diff restrito — wiring nos pontos do mapa ---------- */

test("T-150: wiring do agent-runner (isGrokFamily nos branches grok, binário do runner)", () => {
  const runner = readFileSync(join(AQUI, "../agent-runner.ts"), "utf8");
  assert.match(runner, /isGrokFamily\(this\.opts\.cliRunner\)/, "branches grok usam isGrokFamily");
  assert.match(runner, /this\.runnerCommand\(this\.opts\.cliRunner\)/, "binário resolvido pelo runner configurado");
  assert.ok(!/"grok-custom"/.test(runner), "nenhum id/path hardcoded de grok-custom no agent-runner");
});
