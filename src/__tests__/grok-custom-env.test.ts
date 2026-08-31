import test from "node:test";
import assert from "node:assert/strict";
import { buildGrokEnv } from "../runners/env.js";

const base = { PATH: "/usr/bin", HOME: "/home/u" };

test("buildGrokEnv com runner grok-custom NÃO seta GROK_HOME (T-164)", () => {
  const env = buildGrokEnv({
    base,
    tokenFile: "/tmp/token",
    features: { THE_DUDES_FEATURES: "tasks" },
    grokHome: "/home/u/.the-dudes/grok",
    runner: "grok-custom",
  });
  assert.equal("GROK_HOME" in env, false);
  // demais chaves intactas
  assert.equal(env.THE_DUDES_AGENT_TOKEN_FILE, "/tmp/token");
  assert.equal(env.THE_DUDES_FEATURES, "tasks");
  assert.equal(env.GROK_DISABLE_AUTOUPDATER, "1");
  assert.equal(env.HOME, "/home/u");
});

test("buildGrokEnv com runner grok continua setando GROK_HOME (isolação por agente, T-164)", () => {
  const env = buildGrokEnv({
    base,
    tokenFile: "/tmp/token",
    features: { THE_DUDES_FEATURES: "tasks" },
    grokHome: "/home/u/.the-dudes/grok",
    runner: "grok",
  });
  assert.equal(env.GROK_HOME, "/home/u/.the-dudes/grok");
  assert.equal(env.GROK_DISABLE_AUTOUPDATER, "1");
  assert.equal(env.THE_DUDES_AGENT_TOKEN_FILE, "/tmp/token");
  assert.equal(env.THE_DUDES_FEATURES, "tasks");
});

test("comportamento legado preservado: sem runner informado, GROK_HOME é setado (T-164)", () => {
  const env = buildGrokEnv({
    base,
    tokenFile: "/tmp/token",
    features: {},
    grokHome: "/home/u/.the-dudes/grok",
  });
  assert.equal(env.GROK_HOME, "/home/u/.the-dudes/grok");
});

test("buildGrokEnv grok-custom apaga GROK_HOME herdado (T-168 residual QA)", () => {
  const env = buildGrokEnv({
    base: { PATH: "/usr/bin", HOME: "/home/u", GROK_HOME: "/home/u/.grok" },
    tokenFile: "/tmp/token",
    features: {},
    grokHome: "/home/u/.the-dudes/grok",
    runner: "grok-custom",
  });
  assert.equal("GROK_HOME" in env, false);
  assert.notEqual(env.GROK_HOME, "/home/u/.grok");
  const official = buildGrokEnv({
    base: { PATH: "/usr/bin", HOME: "/home/u", GROK_HOME: "/stale" },
    tokenFile: "/tmp/token",
    features: {},
    grokHome: "/home/u/.the-dudes/grok",
    runner: "grok",
  });
  assert.equal(official.GROK_HOME, "/home/u/.the-dudes/grok");
});
