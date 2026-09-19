/**
 * T-690: runner dsh (DeepSeek Harness via ACP v1 stdio) — registro e contrato
 * declarado. Este arquivo cobre a parte sem processo (catálogo, adapters,
 * thresholds); o turn handler e o cliente ACP têm testes próprios quando o
 * módulo existir.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNNER_ADAPTERS, isGrokFamily, isPerMessageRunner, runnerAdapter, compatibleSessionId } from "../runners/index.js";
import { hangThresholds } from "../runners/turn-watchdog.js";
import { RUNNER_CATALOG, isKnownCliRunner } from "@the-dudes/protocol";
import { resolveCliCommands } from "../cli-config.js";
import { helloRunnerLists } from "../runner-policy.js";
import { DSH_ACP_ARGS, DSH_DEFAULT_MODEL } from "../runners/turns/dsh.js";

test("T-690: dsh está no catálogo único e é runner conhecido", () => {
  assert.ok(RUNNER_CATALOG.some((r) => r.value === "dsh"), "dsh no catálogo");
  assert.equal(isKnownCliRunner("dsh"), true);
});

test("T-690: adapter do dsh é persistent com resume durável (sem re-injeção)", () => {
  const a = runnerAdapter("dsh");
  assert.equal(a.execution, "persistent");
  assert.equal(a.resumedSessionAlreadyHasSystemPrompt, true, "resume não re-injeta system prompt");
  assert.equal(isPerMessageRunner("dsh"), false);
  // sessão = UUID do session/new; lixo não passa
  assert.ok(compatibleSessionId("dsh", "57eb3eca-8c9d-4e9a-9b1a-1a2b3c4d5e6f"));
  assert.equal(compatibleSessionId("dsh", "ses_nao-uuid"), undefined);
  assert.equal(isGrokFamily("dsh"), false, "dsh NÃO é família grok");
  assert.equal(RUNNER_ADAPTERS.dsh.id, "dsh");
});

test("T-690: spawn do dsh é `dsh --profile acp`", () => {
  assert.deepEqual([...DSH_ACP_ARGS], ["--profile", "acp"]);
});

test("T-690: default de modelo é dsflash (official sem key falha -32603)", () => {
  assert.equal(DSH_DEFAULT_MODEL, '["dsflash","deepseek-flash-41"]');
});

test("T-690: availableRunners inclui dsh quando o binário está presente", () => {
  // Mesmo padrão do hello-runners (T-159): override aponta a um executável
  // real do host (node) para o teste não depender do dsh instalado no CI.
  const cli = resolveCliCommands({ cliPaths: { dsh: process.execPath } });
  assert.equal(cli.dsh.available, true, cli.dsh.probeReason);
  const hello = helloRunnerLists(cli);
  assert.ok(hello.availableRunners.includes("dsh"), `availableRunners=${hello.availableRunners.join(",")}`);
  assert.ok(hello.installedRunners.includes("dsh"));
});

test("T-690: hangThresholds do dsh é próprio (não-grok; sem hard de 120s; cold ≥5min)", () => {
  const t = hangThresholds("dsh");
  const grok = hangThresholds("grok");
  assert.notEqual(t.hardMs, grok.hardMs, "hard seco de 120s não vale para o dsh");
  assert.equal(t.hardMs, 6 * 60_000);
  assert.equal(t.softMs, 3 * 60_000);
  assert.equal(t.deadProcMs, 15_000);
  assert.equal(t.toolsHardMs, 15 * 60_000);
  assert.ok(t.firstEventMs && t.firstEventMs >= 5 * 60_000, "cold start cobre boot+compose (~20s medido) com margem");
  assert.ok(t.softMs < t.hardMs && t.hardMs < t.toolsHardMs, "ordem dos tetos");
});