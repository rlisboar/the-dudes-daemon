import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveCliCommands } from "../cli-config.js";
import { helloRunnerLists } from "../runner-policy.js";

test("hello inclui grok-custom em availableRunners/installedRunners quando disponível (T-159)", () => {
  // binário garantidamente executável no host: o próprio node
  const cliCommands = resolveCliCommands({ cliPaths: { "grok-custom": process.execPath, grok: process.execPath } });
  const hello = helloRunnerLists(cliCommands);
  assert.ok(hello.availableRunners.includes("grok-custom"));
  assert.ok(hello.installedRunners.includes("grok-custom"));
  // runners existentes intactos quando disponíveis
  assert.ok(hello.availableRunners.includes("grok"));
});

test("hello omite grok-custom quando indisponível (T-159)", () => {
  const cliCommands = resolveCliCommands();
  const hello = helloRunnerLists(cliCommands);
  assert.equal(hello.availableRunners.includes("grok-custom"), cliCommands["grok-custom"].available);
  assert.equal(hello.installedRunners.includes("grok-custom"), cliCommands["grok-custom"].available);
  // listas independentes (sem compartilhamento de referência)
  assert.notEqual(hello.availableRunners, hello.installedRunners);
});

test("hello do main.ts usa a lista compartilhada — sem lista hardcoded paralela (T-159)", () => {
  const mainSource = readFileSync(fileURLToPath(new URL("../main.ts", import.meta.url)), "utf8");
  assert.ok(mainSource.includes("helloRunnerLists(this.cliCommands)"), "hello deve derivar de helloRunnerLists");
  assert.doesNotMatch(mainSource, /availableRunners: \(\[/, "lista hardcoded de runners voltou ao hello");
});
