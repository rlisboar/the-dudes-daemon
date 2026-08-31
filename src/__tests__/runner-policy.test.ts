import test from "node:test";
import assert from "node:assert/strict";
import { resolveCliCommands, type ResolvedCliCommands } from "../cli-config.js";
import { applyRunnerPolicy, buildInstalledRunnerAvailability, POLICY_GATED_RUNNERS, type InstalledRunnerAvailability } from "../runner-policy.js";

function fakeCommands(installed: Record<string, boolean>): ResolvedCliCommands {
  const mk = (available: boolean) => ({ command: "x", source: "detected" as const, available });
  return {
    claude: mk(installed.claude ?? false),
    opencode: mk(installed.opencode ?? false),
    gemini: mk(installed.gemini ?? false),
    codex: mk(installed.codex ?? false),
    crush: mk(installed.crush ?? false),
    grok: mk(installed.grok ?? false),
    "grok-custom": mk(installed["grok-custom"] ?? false),
    graphify: mk(false),
    graphifyMcp: mk(false),
  };
}

test("installedRunnerAvailability inclui grok-custom com o valor do resolveCliCommands (T-157)", () => {
  // binário garantidamente executável no host: o próprio node
  const resolved = resolveCliCommands({ cliPaths: { "grok-custom": process.execPath, grok: process.execPath } });
  const availability = buildInstalledRunnerAvailability(resolved);
  assert.equal(availability["grok-custom"], resolved["grok-custom"].available);
  assert.equal(availability["grok-custom"], true);
  assert.equal(availability.grok, true);
  // lista de gateados cobre exatamente a família + demais runners
  assert.ok(POLICY_GATED_RUNNERS.includes("grok-custom"));
});

test("runner-policy:set sem grok-custom → indisponível; com grok-custom → disponível (T-157)", () => {
  const installed = buildInstalledRunnerAvailability(fakeCommands({ grok: true, "grok-custom": true })) as InstalledRunnerAvailability;

  // caminho 1: policy NÃO permite grok-custom → available=false mesmo instalado
  const without = fakeCommands({ grok: true, "grok-custom": true });
  applyRunnerPolicy(without, installed, ["claude", "grok"]);
  assert.equal(without["grok-custom"].available, false);
  assert.equal(without.grok.available, true);

  // caminho 2: policy permite grok-custom → available=true (instalado)
  const withRunner = fakeCommands({ grok: true, "grok-custom": true });
  applyRunnerPolicy(withRunner, installed, ["grok-custom"]);
  assert.equal(withRunner["grok-custom"].available, true);

  // guarda: não instalado + permitido → indisponível
  const notInstalled = buildInstalledRunnerAvailability(fakeCommands({})) as InstalledRunnerAvailability;
  const absent = fakeCommands({});
  applyRunnerPolicy(absent, notInstalled, ["grok-custom"]);
  assert.equal(absent["grok-custom"].available, false);
});
